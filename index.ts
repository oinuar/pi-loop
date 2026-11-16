/**
 * /loop extension
 *
 * Re-runs a user prompt indefinitely. Every iteration runs in a completely
 * fresh session — as if pi had been started again: when an agent run
 * settles, the current session is replaced with a brand-new one (all
 * conversation context cleared) and the same prompt is posted into it.
 * The loop continues until:
 *
 *  - the agent calls the `quit` tool (it realized there is nothing
 *    left to do), or
 *  - the user types `/loop end`, or
 *  - N consecutive iterations end in an error (safety stop), or
 *  - the user switches sessions (/new, /resume, /fork, /reload).
 *
 * Commands:
 *   /loop start <prompt>  start looping <prompt>
 *   /loop end             stop the current loop
 *   /loop [status]        show the current loop status
 *
 * While a loop is in progress a status line is shown in the footer (the same
 * place as other system state, e.g. "Thinking blocks: visible"):
 *   ● Loop in progress · iter 4 · ~4.2 it/min · 23s into iter
 * Nothing is shown when no loop is active.
 *
 * Implementation notes:
 *  - Session replacement (`ctx.newSession()`) may only be requested from
 *    command contexts — pi forbids it from lifecycle handlers because it can
 *    deadlock the runtime. The loop is therefore driven by a small state
 *    machine: `agent_settled` schedules the next fresh-session iteration on
 *    a detached tick (setImmediate).
 *  - pi's `sendUserMessage()` only returns once the posted run has fully
 *    settled, and `newSession()` only returns after the `withSession`
 *    callback completes — so the loop's `newSession()` call spans the whole
 *    posted iteration: the iteration's own `agent_settled` fires while
 *    `state.replacing` is still true. Handlers therefore identify loop
 *    iterations through `runPosted`/`runCounts`, never through `replacing`.
 *  - Session replacement re-creates the whole session runtime, and pi
 *    re-runs the extension factory for the replacement session (a fresh
 *    module instance — neither closure state nor module state survives).
 *    The loop's state therefore lives in a versioned record on `globalThis`
 *    that every factory run re-binds to. The instance bound to the current
 *    session drives the loop; the instance being replaced hands the new
 *    session's command context over through the shared record inside the
 *    `withSession` callback, where the prompt is posted.
 *  - While a loop is active the `quit` tool is active; pi
 *    auto-activates every extension tool on session (re)start, so the
 *    `session_start` handler hides it again when no loop is in progress.
 */

import { Type } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const QUIT_TOOL_NAME = "quit";
const STATUS_KEY = "loop";
/** Stop the loop after this many consecutive iterations ending in an error. */
const MAX_CONSECUTIVE_ERRORS = 3;
/** Number of most recent iteration durations used for the speed estimate. */
const SPEED_WINDOW = 5;
/** Live-refresh interval for the "Ns into iter" part of the status. */
const STATUS_REFRESH_MS = 1000;

/**
 * The fresh command-capable context that pi passes to the `withSession`
 * callback of `ctx.newSession()` (pi exports it as ReplacedSessionContext,
 * but it is not re-exported from the package root, so derive it here).
 */
type NewSessionOptions = NonNullable<Parameters<ExtensionCommandContext["newSession"]>[0]>;
type FreshSessionContext = Parameters<NonNullable<NewSessionOptions["withSession"]>>[0];

/**
 * The loop state, shared by every extension instance in this process.
 *
 * pi re-creates the session runtime on every session replacement and re-runs
 * the extension factory for the new session (a fresh module instance), so
 * neither the factory's closure state nor module-level state survives across
 * iterations. The record on `globalThis` is the single place the loop lives;
 * every factory run re-binds its command, tool, and event handlers to it.
 */
interface LoopState {
	/** Bump when the record shape changes; older records are discarded. */
	version: number;
	active: boolean;
	prompt: string;
	/** Current (1-based) iteration number. */
	iteration: number;
	/** When the current iteration's run started, or null while between runs. */
	iterStartedAt: number | null;
	/** Durations (ms) of the most recent completed iterations. */
	durations: number[];
	consecutiveErrors: number;
	/** Set when quit was called during the current run. */
	endRequested: boolean;
	/** Optional reason given by the agent with quit. */
	endReason: string | undefined;
	/**
	 * True once the loop posted its prompt into a fresh session and that run
	 * has not settled yet. A settled run without this flag was not a loop
	 * iteration (e.g. the in-flight run that was already running when
	 * /loop start was issued).
	 */
	runPosted: boolean;
	/**
	 * The in-flight posted run counts as an iteration of the current loop.
	 * A restart while a posted run is in flight clears it: the in-flight run
	 * keeps the old prompt and does not count; the next fresh session starts
	 * iteration 1 with the new prompt.
	 */
	runCounts: boolean;
	/**
	 * True while the loop's own newSession() call is in flight. pi's
	 * newSession() only returns after withSession() completes, and the
	 * loop's withSession callback awaits sendUserMessage(), which awaits the
	 * whole posted run — so this flag is also true during the posted
	 * iteration's run (its agent_settled fires before the flag clears).
	 */
	replacing: boolean;
	/** Deduplicates scheduled iteration starts. */
	swapScheduled: boolean;
	/** Bumped when the loop starts or stops so stale scheduled swaps skip. */
	generation: number;
	/** Latest session context that is safe to use (re-captured on session_start). */
	lastCtx: ExtensionContext | undefined;
	/**
	 * Latest command-capable context; used to request the next fresh session.
	 * Re-captured on every session replacement (in withSession) — the old
	 * instance's closure dies after its replacement, so the hand-off must
	 * go through the shared record.
	 */
	commandCtx: ExtensionCommandContext | FreshSessionContext | undefined;
	/** How the run's final assistant message stopped (set on agent_end). */
	lastRunStopReason: string | undefined;
	/** Resolved when the loop ends (used to hold one-shot modes alive). */
	loopEndWaiters: Set<() => void>;
	/** Status-refresh timer (Node timer ids are process-wide). */
	timer: ReturnType<typeof setInterval> | undefined;
}

const SHARED_STATE_VERSION = 1;
const SHARED_STATE_KEY = Symbol.for("pi-loop.shared-state");

function isLoopState(value: unknown): value is LoopState {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<LoopState>;
	return (
		candidate.version === SHARED_STATE_VERSION &&
		typeof candidate.active === "boolean" &&
		typeof candidate.prompt === "string" &&
		typeof candidate.iteration === "number"
	);
}

/**
 * Look up (or create) the process-wide loop state record. Every factory run
 * — including the fresh instances pi creates for each replacement session —
 * re-binds to the same record, which is how the loop outlives its sessions.
 */
function getSharedState(): LoopState {
	const holder = globalThis as Record<PropertyKey, unknown>;
	const existing = holder[SHARED_STATE_KEY];
	if (isLoopState(existing)) return existing;
	const fresh: LoopState = {
		version: SHARED_STATE_VERSION,
		active: false,
		prompt: "",
		iteration: 0,
		iterStartedAt: null,
		durations: [],
		consecutiveErrors: 0,
		endRequested: false,
		endReason: undefined,
		runPosted: false,
		runCounts: true,
		replacing: false,
		swapScheduled: false,
		generation: 0,
		lastCtx: undefined,
		commandCtx: undefined,
		lastRunStopReason: undefined,
		loopEndWaiters: new Set(),
		timer: undefined,
	};
	holder[SHARED_STATE_KEY] = fresh;
	return fresh;
}

export default function loopExtension(pi: ExtensionAPI) {
	const state = getSharedState();

	// ---------------------------------------------------------------- status

	function speedLabel(): string | undefined {
		if (state.durations.length === 1) return "estimating speed…";
		if (state.durations.length < 2) return undefined;
		const avg =
			state.durations.reduce((sum, d) => sum + d, 0) / state.durations.length;
		const perMinute = 60000 / avg;
		const label = perMinute >= 10 ? Math.round(perMinute).toString() : perMinute.toFixed(1);
		return `~${label} it/min`;
	}

	function renderStatus(ctx: ExtensionContext): string {
		const { theme } = ctx.ui;
		const parts: string[] = [
			theme.fg("accent", "● Loop in progress"),
			theme.fg("dim", `iter ${state.iteration}`),
		];
		const speed = speedLabel();
		if (speed) parts.push(theme.fg("dim", speed));
		if (state.iterStartedAt !== null) {
			const seconds = Math.max(0, Math.round((Date.now() - state.iterStartedAt) / 1000));
			parts.push(theme.fg("dim", `${seconds}s into iter`));
		}
		if (state.consecutiveErrors > 0) {
			parts.push(
				theme.fg("warning", `⚠ ${state.consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS} consecutive errors`),
			);
		}
		return parts.join(" ");
	}

	function updateStatus(): void {
		const ctx = state.lastCtx;
		if (!ctx) return;
		ctx.ui.setStatus(STATUS_KEY, state.active ? renderStatus(ctx) : undefined);
	}

	function stopTimer(): void {
		if (state.timer !== undefined) {
			clearInterval(state.timer);
			state.timer = undefined;
		}
	}

	function startTimer(): void {
		stopTimer();
		state.timer = setInterval(() => updateStatus(), STATUS_REFRESH_MS);
		// Don't keep the process alive just for the status refresh.
		(state.timer as { unref?: () => void }).unref?.();
	}

	// --------------------------------------------------------------- controls

	function activateTool(): void {
		const tools = pi.getActiveTools();
		if (!tools.includes(QUIT_TOOL_NAME)) {
			pi.setActiveTools([...tools, QUIT_TOOL_NAME]);
		}
	}

	function deactivateTool(): void {
		let tools: string[];
		try {
			tools = pi.getActiveTools();
		} catch {
			// Mid-replacement the shared extension runtime is briefly stale;
			// the next session_start hides the tool if the loop is gone.
			return;
		}
		if (tools.includes(QUIT_TOOL_NAME)) {
			pi.setActiveTools(tools.filter((t) => t !== QUIT_TOOL_NAME));
		}
	}

	function resolveLoopEndWaiters(): void {
		for (const resolve of state.loopEndWaiters) resolve();
		state.loopEndWaiters.clear();
	}

	/** Resolves once the current loop has ended (immediately if none is active). */
	function waitLoopEnd(): Promise<void> {
		return new Promise((resolve) => {
			if (!state.active) {
				resolve();
				return;
			}
			state.loopEndWaiters.add(resolve);
		});
	}

	function stopLoop(reason: string, type: "info" | "warning" | "error"): void {
		state.active = false;
		state.endRequested = false;
		state.endReason = undefined;
		state.iterStartedAt = null;
		state.runPosted = false;
		state.runCounts = true;
		state.swapScheduled = false;
		// Invalidate any swap scheduled before this stop (a quick end/start
		// must not let the old swap run with a stale command context).
		state.generation++;
		stopTimer();
		deactivateTool();
		if (state.lastCtx) {
			state.lastCtx.ui.setStatus(STATUS_KEY, undefined);
			state.lastCtx.ui.notify(reason, type);
		}
		resolveLoopEndWaiters();
	}

	function startLoop(prompt: string): void {
		state.active = true;
		state.prompt = prompt;
		state.iteration = 1;
		state.iterStartedAt = null;
		state.durations = [];
		state.consecutiveErrors = 0;
		state.endRequested = false;
		state.endReason = undefined;
		state.runPosted = false;
		state.runCounts = true;
		state.replacing = false;
		state.swapScheduled = false;
		state.generation++;
		state.lastRunStopReason = undefined;
		activateTool();
		startTimer();
		updateStatus();
	}

	/**
	 * Schedule the next iteration to start in a fresh session.
	 *
	 * Session replacement may not be requested from lifecycle handlers (pi
	 * documents that it can deadlock the runtime), so the actual newSession()
	 * call happens on a detached tick, after the event dispatch that
	 * scheduled it has fully unwound.
	 */
	function scheduleIterationStart(): void {
		if (state.swapScheduled) return;
		state.swapScheduled = true;
		const generation = state.generation;
		setImmediate(() => {
			state.swapScheduled = false;
			// The loop was stopped or restarted since this swap was scheduled;
			// the new loop scheduled its own swap.
			if (generation !== state.generation) return;
			void performIterationStart();
		});
	}

	async function performIterationStart(): Promise<void> {
		if (!state.active || state.replacing) return;
		if (!state.commandCtx) {
			stopLoop("Loop stopped: no session context available", "error");
			return;
		}
		state.replacing = true;
		try {
			const result = await state.commandCtx.newSession({
				withSession: (newCtx) => postPromptIntoSession(newCtx),
			});
			if (result.cancelled) {
				stopLoop("Loop stopped: the new session was cancelled", "warning");
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			stopLoop(`Loop stopped: could not start a fresh session (${message})`, "error");
		} finally {
			state.replacing = false;
		}
	}

	/**
	 * Post the loop prompt into a fresh session.
	 *
	 * Runs inside the newSession `withSession` callback, so `newCtx` is
	 * already bound to the replacement session. The session is idle here, so
	 * posting starts a new run exactly like a plain send.
	 *
	 * pi re-runs this factory for the replacement session, so this closure
	 * dies after the swap: hand the fresh session's command context over
	 * through the shared record for the instance that will drive the next
	 * iteration.
	 */
	async function postPromptIntoSession(newCtx: FreshSessionContext): Promise<void> {
		state.commandCtx = newCtx;
		state.lastCtx = newCtx;
		if (!state.active) {
			// The loop was ended while this session was being created: leave
			// the fresh session idle instead of posting into it.
			stopTimer();
			newCtx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		state.runPosted = true;
		state.runCounts = true;
		await newCtx.sendUserMessage(state.prompt, { deliverAs: "followUp" });
	}

	// ---------------------------------------------------------------- commands

	pi.registerCommand("loop", {
		description:
			"Loop a prompt in fresh sessions until the user ends the loop or the agent calls quit: /loop start <prompt> · /loop end · /loop [status]",
		async handler(args, ctx) {
			state.lastCtx = ctx;
			const trimmed = args.trim();
			const sub = trimmed.split(/\s+/)[0] ?? "";

			if (sub === "start") {
				const prompt = trimmed.slice("start".length).trim();
				if (!prompt) {
					ctx.ui.notify("Usage: /loop start <prompt>", "warning");
					return;
				}
				if (state.active) {
					// Restart: the running loop picks up the new prompt from
					// its next fresh session. The in-flight iteration keeps
					// the old prompt and does not count for the new loop.
					state.prompt = prompt;
					state.iteration = 1;
					state.iterStartedAt = null;
					state.durations = [];
					state.consecutiveErrors = 0;
					state.endRequested = false;
					state.endReason = undefined;
					if (state.runPosted) {
						// A posted run is in flight (its fresh session was
						// just created): it keeps the old prompt and does
						// not count for the new loop. Its settle still
						// starts the swap — it just skips the counting.
						state.runCounts = false;
					}
					state.lastRunStopReason = undefined;
					updateStatus();
					ctx.ui.notify("Loop restarted with new prompt", "info");
					return;
				}
				state.commandCtx = ctx;
				startLoop(prompt);
				ctx.ui.notify("Loop started (iteration 1)", "info");
				// When a run is in flight, the first fresh session starts
				// once it settles (the agent_settled handler schedules it);
				// otherwise start it right away.
				if (ctx.isIdle()) scheduleIterationStart();
				// One-shot modes (print/json) exit as soon as the initial
				// prompt is handled; hold the process until the loop ends.
				if (ctx.mode === "print" || ctx.mode === "json") {
					await waitLoopEnd();
				}
				return;
			}

			if (sub === "end") {
				if (!state.active) {
					ctx.ui.notify("No loop in progress", "info");
					return;
				}
				const iterations = state.iteration;
				stopLoop(
					`Loop ended by user after ${iterations} iteration${iterations === 1 ? "" : "s"}`,
					"info",
				);
				return;
			}

			if (sub === "" || sub === "status") {
				if (!state.active) {
					ctx.ui.notify(
						"No loop in progress. Usage: /loop start <prompt> · /loop end",
						"info",
					);
				} else {
					ctx.ui.notify(renderStatus(ctx), "info");
				}
				return;
			}

			ctx.ui.notify(
				"Usage: /loop start <prompt> · /loop end · /loop [status]",
				"warning",
			);
		},
	});

	// ------------------------------------------------------------------- tool

	pi.registerTool(
		defineTool({
			name: QUIT_TOOL_NAME,
			label: "Quit",
			description:
				"Quits the session. " +
				"Call it only when you realize that there is no work to do in this session.",
			promptSnippet:
				"quit — quits the session when there is nothing to do",
			parameters: Type.Object({
				reason: Type.Optional(
					Type.String({
						description:
							"Short explanation of why you quit this session",
					}),
				),
			}),
			// Not active by default: the runtime re-activates every extension
			// tool on session (re)start, so the session_start handler below
			// hides it again until a loop is actually in progress.
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				state.lastCtx = ctx;
				const loopWasActive = state.active;
				state.endRequested = true;
				state.endReason = params.reason;

				ctx.shutdown();

				return {
					content: [
						{
							type: "text" as const,
							text: "Exiting..."
						},
					],
					details: { loopEnded: loopWasActive, reason: params.reason ?? null },
					// Skip the automatic follow-up model request when this ends a loop.
					terminate: loopWasActive ? true : undefined,
				};
			},
		}),
	);

	// ------------------------------------------------------------------ events

	pi.on("session_start", (_event, ctx) => {
		state.lastCtx = ctx;
		if (state.active) {
			// The loop's own replacement: restore the footer — pi cleared the
			// extension status state while the outgoing session was torn down.
			startTimer();
			updateStatus();
		} else {
			// pi auto-activates every extension tool when the session (re)starts;
			// hide the loop tool again until a loop is actually in progress.
			deactivateTool();
		}
	});

	pi.on("session_before_switch", () => {
		// A user-initiated session switch (/new, /resume, /import) ends the
		// loop before the teardown aborts the in-flight run.
		if (state.active && !state.replacing) {
			stopLoop("Loop ended: the session was switched", "info");
		}
	});

	pi.on("session_before_fork", () => {
		if (state.active && !state.replacing) {
			stopLoop("Loop ended: the session was forked", "info");
		}
	});

	pi.on("agent_start", (_event, ctx) => {
		state.lastCtx = ctx;
		if (state.active && state.runPosted && state.iterStartedAt === null) {
			state.iterStartedAt = Date.now();
			updateStatus();
		}
	});

	pi.on("agent_end", (event) => {
		// Remember how the run's final assistant message stopped (may be used
		// at agent_settled to detect iterations that died on an error).
		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message.role === "assistant") {
				state.lastRunStopReason = message.stopReason;
				break;
			}
		}
	});

	pi.on("agent_settled", (_event, ctx) => {
		state.lastCtx = ctx;
		if (!state.active) return;

		if (state.endRequested) {
			const iterations = state.iteration;
			const reason = state.endReason;
			stopLoop(
				`Loop ended after ${iterations} iteration${iterations === 1 ? "" : "s"}: agent signalled nothing left to do` +
					(reason ? ` (${reason})` : ""),
				"info",
			);
			return;
		}

		if (state.runPosted) {
			// The in-flight swap's posted run has settled. This fires while
			// newSession() is still in flight — pi's sendUserMessage() only
			// returns once the posted run has fully settled, so
			// state.replacing is still true here and must not be used to
			// skip the settle.
			state.runPosted = false;
			if (state.runCounts) {
				if (state.lastRunStopReason === "error") {
					state.consecutiveErrors++;
					if (state.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
						stopLoop(
							`Loop stopped: ${state.consecutiveErrors} consecutive iterations ended in error`,
							"error",
						);
						return;
					}
					ctx.ui.notify(
						`Loop: iteration ${state.iteration} ended in error (${state.consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS})`,
						"warning",
					);
				} else {
					state.consecutiveErrors = 0;
					if (state.iterStartedAt !== null) {
						state.durations.push(Date.now() - state.iterStartedAt);
						if (state.durations.length > SPEED_WINDOW) state.durations.shift();
					}
				}
				state.iteration++;
			}
			state.lastRunStopReason = undefined;
			state.iterStartedAt = null;
			updateStatus();
			scheduleIterationStart();
			return;
		}

		if (state.replacing) {
			// A non-loop run settled while the loop's own replacement was in
			// flight (a run aborted by the swap's teardown). The swap itself
			// posts the next iteration, so there is nothing to do here.
			return;
		}

		// A non-loop run settled outside the swap (e.g. the run that was in
		// flight when /loop start was issued): start the first fresh session
		// now.
		scheduleIterationStart();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (state.active && state.replacing) {
			// The loop's own replacement: the loop continues in the fresh
			// session. Stop the timer now because its context is about to
			// become stale; session_start re-captures the context and
			// restarts it. (pi clears the extension footer state itself
			// during the teardown.)
			stopTimer();
			state.lastCtx = undefined;
			return;
		}
		// Any other shutdown (user session switch, fork, reload, process
		// exit) ends the loop.
		stopTimer();
		state.active = false;
		state.endRequested = false;
		state.endReason = undefined;
		state.iterStartedAt = null;
		state.runPosted = false;
		state.runCounts = true;
		state.lastCtx = undefined;
		deactivateTool();
		resolveLoopEndWaiters();
		if (ctx) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	});
}