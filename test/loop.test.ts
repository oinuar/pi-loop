/**
 * Unit tests for the /loop extension.
 *
 * The extension factory is driven directly with a mock ExtensionAPI and mock
 * contexts; pi's lifecycle is simulated the same way the runtime drives it:
 * agent_start → agent_end → agent_settled for runs, and for session
 * replacement (ctx.newSession) the full order the runtime emits —
 * session_before_switch → [abort of any in-flight run] → session_shutdown →
 * (old context becomes stale) → session_start → withSession(newCtx). Like
 * real pi, each session replacement re-runs the extension factory (a fresh
 * instance with a fresh handler registry); only the globalThis state record
 * carries the loop across sessions. No real agent, model, or process is
 * involved.
 *
 * Run with: npm test   (or: node --test test/)
 */

import { describe, it } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import loopExtension from "../index.ts";

const BASE_TIME = 1_700_000_000_000;
const TOOL_NAME = "nothing_to_do";
const STALE_ERROR = "This extension ctx is stale after session replacement";

interface SentMessage {
	text: string;
	options: { deliverAs?: string } | undefined;
}

interface Notified {
	message: string;
	type?: string;
}

interface StatusEntry {
	key: string;
	text: string | undefined;
}

/** Build a mock ExtensionAPI + contexts and register the extension. */
function makeHarness(t: TestContext, opts?: { mode?: string; streaming?: boolean }) {
	// Freeze time so iteration durations and the status refresh interval are
	// fully deterministic.
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: BASE_TIME });

	// The loop state lives on globalThis (it must survive pi re-running the
	// extension factory on each session replacement); start each test with a
	// clean record.
	(globalThis as Record<PropertyKey, unknown>)[Symbol.for("pi-loop.shared-state")] = undefined;

	let streaming = opts?.streaming ?? false;
	/** When set, the next newSession() returns { cancelled: true }. */
	let cancelNextNewSession = false;
	/** Optional hook run (awaited) at each phase of the mocked newSession. */
	let onSwapPhase: ((phase: string) => Promise<void> | void) | undefined;
	let sessionCount = 0;
	const sent: SentMessage[] = [];
	const notified: Notified[] = [];
	const statuses: StatusEntry[] = [];
	const activeToolSets: string[][] = [];

	const recordSend = (content: any, options?: any) => {
		// Replicates pi's contract: a plain send while streaming throws, a
		// send with deliverAs queues. If the extension ever posts a plain
		// message during streaming, tests fail here.
		if (streaming && !options?.deliverAs) {
			throw new Error(
				"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
			);
		}
		const text = typeof content === "string" ? content : content.map((p: any) => p.text).join("\n");
		sent.push({ text, options });
		// A user message triggers a run; the test drives it to completion via
		// harness.run().
		streaming = true;
	};

	// One extension instance per session, exactly like real pi: each session
	// replacement re-creates the session runtime and re-runs the extension
	// factory (fresh handler registry, fresh tool registration). Instances
	// share nothing but the globalThis state record.
	const BASE_TOOLS = ["read", "bash", "write"];
	interface Instance {
		handlers: Record<string, Array<(event: any, ctx: any) => unknown>>;
		registeredTools: Record<string, any>;
		commands: Record<
			string,
			{ description?: string; handler: (args: string, ctx: any) => Promise<void> }
		>;
		activeTools: string[];
	}
	const instances: Instance[] = [];
	let current: Instance;
	let currentPi: any;

	const makePi = (instance: Instance): any => ({
		on(event: string, handler: (event: any, ctx: any) => unknown) {
			(instance.handlers[event] ??= []).push(handler);
			return () => {
				const list = instance.handlers[event];
				const i = list.indexOf(handler);
				if (i >= 0) list.splice(i, 1);
			};
		},
		registerCommand(name: string, options: any) {
			instance.commands[name] = options;
		},
		registerTool(tool: any) {
			instance.registeredTools[tool.name] = tool;
		},
		sendUserMessage(content: any, options?: any) {
			recordSend(content, options);
		},
		getActiveTools() {
			return [...instance.activeTools];
		},
		setActiveTools(names: string[]) {
			instance.activeTools = [...names];
			activeToolSets.push([...names]);
		},
	});

	/** Create a fresh extension instance (a factory re-run) and activate it. */
	const createInstance = (): Instance => {
		const instance: Instance = {
			handlers: {},
			registeredTools: {},
			commands: {},
			activeTools: [...BASE_TOOLS],
		};
		instances.push(instance);
		currentPi = makePi(instance);
		loopExtension(currentPi);
		// pi auto-activates every extension-registered tool when the session
		// is (re)built; model that after the factory has registered the tool.
		for (const name of Object.keys(instance.registeredTools)) {
			if (!instance.activeTools.includes(name)) {
				instance.activeTools = [...instance.activeTools, name];
			}
		}
		current = instance;
		return instance;
	};

	// --------------------------------------------------------------- contexts

	/**
	 * One context per session, like pi's. A context becomes stale after its
	 * session is replaced; touching it afterwards throws, exactly like pi.
	 */
	const makeCtx = (): any => {
		const c: any = {
			mode: opts?.mode ?? "tui",
			hasUI: true,
			cwd: "/tmp/pi-loop-test",
			stale: false,
			isIdle: () => !streaming,
			signal: undefined,
		};
		const assertFresh = () => {
			if (c.stale) throw new Error(STALE_ERROR);
		};
		c.ui = {
			// theme.fg mock: strip colors so assertions match plain text.
			theme: { fg: (_color: string, text: string) => text },
			setStatus(key: string, text: string | undefined) {
				assertFresh();
				statuses.push({ key, text });
			},
			notify(message: string, type?: string) {
				assertFresh();
				notified.push({ message, type });
			},
		};
		// Command-capable (like pi's ExtensionCommandContext /
		// ReplacedSessionContext): this is the context the loop keeps for the
		// next fresh-session iteration.
		c.sendUserMessage = (content: any, options?: any) => {
			assertFresh();
			recordSend(content, options);
			return Promise.resolve();
		};
		c.newSession = (options?: any) => swapSession(c, options);
		return c;
	};

	let currentCtx = makeCtx();

	const fire = async (event: string, payload?: any) => {
		for (const handler of current.handlers[event] ?? []) {
			await handler(payload ?? { type: event }, currentCtx);
		}
	};

	const phase = async (name: string) => {
		if (onSwapPhase) await onSwapPhase(name);
	};

	/**
	 * Simulates ctx.newSession(): the exact lifecycle pi's runtime performs —
	 * session_before_switch ("new"), abort of any in-flight run (which
	 * settles before the shutdown), session_shutdown of the outgoing session,
	 * the old context going stale, a fresh extension instance (the factory
	 * re-run) for the new session, its session_start, and the withSession
	 * callback bound to the fresh context.
	 */
	const swapSession = async (oldCtx: any, options?: any) => {
		if (oldCtx.stale) throw new Error(STALE_ERROR);
		await phase("before_switch");
		await fire("session_before_switch", { type: "session_before_switch", reason: "new" });
		if (cancelNextNewSession) {
			cancelNextNewSession = false;
			return { cancelled: true };
		}
		if (streaming) {
			// pi aborts the in-flight run first; the aborted run settles
			// before session_shutdown fires.
			streaming = false;
			await phase("abort");
			await fire("agent_end", {
				type: "agent_end",
				messages: [{ role: "assistant", stopReason: "aborted", content: [], usage: {} }],
			});
			await fire("agent_settled");
		}
		await phase("shutdown");
		await fire("session_shutdown", { type: "session_shutdown", reason: "new" });
		oldCtx.stale = true;
		// pi re-creates the session runtime and re-runs the extension factory
		// for the replacement session.
		createInstance();
		sessionCount++;
		currentCtx = makeCtx();
		await fire("session_start", { type: "session_start", reason: "new" });
		await phase("with_session");
		if (options?.withSession) {
			await options.withSession(currentCtx);
		}
		return { cancelled: false };
	};

	// ---------------------------------------------------------------- harness

	const lastStatus = (): string | undefined => {
		for (let i = statuses.length - 1; i >= 0; i--) {
			if (statuses[i].key === "loop") return statuses[i].text;
		}
		return undefined;
	};

	createInstance(); // the initial session (like pi's process start)

	const harness = {
		get pi() {
			return currentPi;
		},
		get ctx() {
			return currentCtx;
		},
		sent,
		notified,
		statuses,
		activeToolSets,
		get registeredTools() {
			return current.registeredTools;
		},
		get commands() {
			return current.commands;
		},
		streaming: {
			get() {
				return streaming;
			},
			set(v: boolean) {
				streaming = v;
			},
		},
		activeTools: () => [...current.activeTools],
		get sessionCount() {
			return sessionCount;
		},
		/** How many extension instances (factory runs) exist so far. */
		get instanceCount() {
			return instances.length;
		},
		/** Make the next ctx.newSession() return { cancelled: true }. */
		cancelNextNewSession: () => {
			cancelNextNewSession = true;
		},
		/** Hook invoked (awaited) at each phase of the mocked newSession. */
		setOnSwapPhase(fn: ((phase: string) => Promise<void> | void) | undefined) {
			onSwapPhase = fn;
		},
		tool: (name: string) => current.registeredTools[name],
		command: (name: string) => current.commands[name],
		fire,
		lastStatus,
		/**
		 * Let the event loop run so the extension's detached session-swap
		 * tick (setImmediate, scheduled from agent_settled / /loop start)
		 * and its async continuation have completed.
		 */
		flush: async () => {
			for (let i = 0; i < 3; i++) {
				await new Promise((resolve) => setImmediate(resolve));
			}
		},
		/**
		 * Simulate one full agent run: agent_start → (duration elapses) →
		 * agent_end → agent_settled, the order pi emits.
		 */
		run: async (stopReason: "stop" | "error" | "aborted" = "stop", durationMs = 10_000) => {
			streaming = true; // the run owns the session now
			await fire("agent_start");
			t.mock.timers.tick(durationMs);
			await fire("agent_end", {
				type: "agent_end",
				messages: [{ role: "assistant", stopReason, content: [], usage: {} }],
			});
			streaming = false;
			await fire("agent_settled");
		},
	};
	return harness;
}

/** Call the /loop command handler with the given raw args. */
async function runLoopCommand(h: ReturnType<typeof makeHarness>, args: string) {
	await h.command("loop").handler(args, h.ctx);
}

describe("registrations", () => {
	it("registers the /loop command and the nothing_to_do tool", async (t) => {
		const h = makeHarness(t);
		assert.ok(h.command("loop"), "/loop command registered");
		assert.ok(h.command("loop")!.description);
		const tool = h.tool(TOOL_NAME);
		assert.ok(tool, "nothing_to_do tool registered");
		// pi auto-activates the tool on session start; the extension must
		// hide it again until a loop is running.
		assert.equal(h.activeTools().includes(TOOL_NAME), true, "auto-activated on registration");
		await h.fire("session_start");
		assert.equal(h.activeTools().includes(TOOL_NAME), false, "deactivated on session_start");
		assert.equal(tool.label, "Nothing To Do");
		assert.ok(tool.description.includes("no work to do"));
		// TypeBox object schema
		assert.deepEqual(Object.keys(tool.parameters.properties), ["reason"]);
	});
});

describe("/loop start", () => {
	it("starts iteration 1 in a fresh session (followUp post, status, tool active)", async (t) => {
		const h = makeHarness(t);
		await runLoopCommand(h, "start  Keep improving the README until it is perfect ");
		await h.flush();
		assert.equal(h.sessionCount, 1, "the loop's first iteration runs in a new session");
		assert.equal(h.instanceCount, 2, "the replacement session re-runs the factory");
		assert.equal(h.sent.length, 1);
		assert.equal(h.sent[0].text, "Keep improving the README until it is perfect");
		assert.equal(h.sent[0].options?.deliverAs, "followUp");
		assert.ok(h.lastStatus()!.includes("● Loop in progress"));
		assert.ok(h.lastStatus()!.includes("iter 1"));
		assert.equal(h.activeTools().includes(TOOL_NAME), true);
		assert.ok(h.notified.some((n) => n.message.includes("Loop started")));
	});

	it("asks for a prompt when none is given", async (t) => {
		const h = makeHarness(t);
		await runLoopCommand(h, "start");
		await h.flush();
		assert.equal(h.sent.length, 0);
		assert.equal(h.sessionCount, 0);
		assert.equal(h.lastStatus(), undefined, "no status when the loop did not start");
		assert.ok(h.notified.some((n) => n.type === "warning" && n.message.includes("Usage")));
	});

	it("warns on unknown subcommands", async (t) => {
		const h = makeHarness(t);
		await runLoopCommand(h, "bogus");
		assert.ok(h.notified.some((n) => n.type === "warning" && n.message.includes("Usage")));
	});
});

describe("looping", () => {
	it("runs each iteration in a fresh session, re-posting the same prompt", async (t) => {
		const h = makeHarness(t);
		await runLoopCommand(h, "start do the thing");
		await h.flush();
		assert.equal(h.sent.length, 1, "iteration 1 posted into a fresh session");
		await h.run(); // iteration 1 settles
		await h.flush(); // the loop swaps to a fresh session and posts again
		assert.equal(h.sessionCount, 2);
		assert.equal(h.instanceCount, 3, "every replacement session re-runs the factory");
		assert.equal(h.sent.length, 2);
		assert.equal(h.sent[1].text, "do the thing");
		assert.equal(h.sent[1].options?.deliverAs, "followUp");
		assert.ok(h.lastStatus()!.includes("iter 2"));
		assert.equal(h.activeTools().includes(TOOL_NAME), true, "tool stays active across the swap");
		await h.run();
		await h.flush();
		assert.equal(h.sessionCount, 3);
		assert.equal(h.sent.length, 3);
		assert.equal(h.sent[2].text, "do the thing");
		assert.ok(h.lastStatus()!.includes("iter 3"));
	});

	it("keeps looping across several iterations and shows speed after 2", async (t) => {
		const h = makeHarness(t);
		await runLoopCommand(h, "start go");
		await h.flush();
		await h.run("stop", 10_000); // iteration 1: 10 s
		assert.ok(h.lastStatus()!.includes("estimating speed…"));
		await h.flush();
		await h.run("stop", 20_000); // iteration 2: 20 s → avg 15 s → 4.0 it/min
		const status = h.lastStatus()!;
		assert.ok(status.includes("iter 3"), status);
		assert.ok(status.includes("~4.0 it/min"), status);
	});

	it("every post uses deliverAs followUp, even while streaming", async (t) => {
		const h = makeHarness(t);
		await runLoopCommand(h, "start go");
		await h.flush();
		h.streaming.set(true); // a run is streaming when the user could act
		await h.run("stop", 5_000);
		await h.flush();
		h.streaming.set(true);
		await h.run("stop", 5_000);
		await h.flush();
		assert.ok(h.sent.length >= 3);
		for (const m of h.sent) {
			assert.equal(m.options?.deliverAs, "followUp");
		}
	});

	it("defers the first fresh session while a run is in flight (no duplicate post)", async (t) => {
		const h = makeHarness(t, { streaming: true });
		await runLoopCommand(h, "start go");
		assert.equal(h.sent.length, 0, "nothing posted while the in-flight run owns the queue");
		assert.equal(h.sessionCount, 0);
		assert.ok(h.lastStatus()!.includes("iter 1"), "status shown while waiting to settle");
		await h.run("stop", 8_000); // in-flight run settles
		await h.flush();
		assert.equal(h.sessionCount, 1, "first fresh session starts at settle");
		assert.equal(h.sent.length, 1, "first post happens exactly once");
		assert.equal(h.sent[0].text, "go");
		assert.ok(h.lastStatus()!.includes("iter 1"), "still iteration 1 after the first post");
		await h.run("stop", 8_000);
		await h.flush();
		assert.equal(h.sent.length, 2);
		assert.ok(h.lastStatus()!.includes("iter 2"));
	});

	it("a user run at the iteration boundary is aborted by the swap, loop continues", async (t) => {
		const h = makeHarness(t);
		await runLoopCommand(h, "start go");
		await h.flush(); // iteration 1 posted, run in flight
		await h.run("stop", 4_000); // iteration 1 settles → swap scheduled
		// The user submits a message in the exact moment between iterations;
		// its run starts right before the swap.
		h.streaming.set(true);
		await h.fire("agent_start");
		await h.flush(); // swap: aborts the user's run, fresh session, iter 2
		assert.equal(h.sessionCount, 2);
		assert.equal(h.sent.length, 2, "the user's run produced no loop post; iter 2 posted once");
		assert.equal(h.sent[1].text, "go");
		assert.ok(h.lastStatus()!.includes("iter 2"));
	});

	it("restarting replaces the prompt; the next fresh session starts iteration 1", async (t) => {
		const h = makeHarness(t);
		await runLoopCommand(h, "start prompt A");
		await h.flush();
		await h.run(); // iteration 1 (A) settles
		await h.flush(); // iteration 2 (A) posted
		await runLoopCommand(h, "start prompt B");
		assert.ok(h.notified.some((n) => n.message.includes("restarted")));
		const sentAfterRestart = h.sent.length;
		await h.run(); // the in-flight iteration 2 (A) settles; does not count for the new loop
		await h.flush();
		assert.equal(h.sent.length, sentAfterRestart + 1);
		assert.equal(h.sent[h.sent.length - 1].text, "prompt B");
		assert.ok(h.lastStatus()!.includes("iter 1"), "the new loop starts at iteration 1");
	});
});

describe("user follow-ups mid-loop", () => {
	it("user messages queue into the current iteration; the next iteration is still fresh", async (t) => {
		const h = makeHarness(t);
		await runLoopCommand(h, "start go");
		await h.flush(); // iteration 1 posted, run in flight
		// The user posts their own follow-up while the loop's run is in
		// flight; pi queues it into the current run.
		h.pi.sendUserMessage("user side note", { deliverAs: "followUp" });
		await h.run("stop", 6_000); // run settles; the loop swaps to a fresh session
		await h.flush();
		const order = h.sent.map((m) => m.text);
		assert.deepEqual(order, ["go", "user side note", "go"]);
		assert.ok(h.lastStatus()!.includes("iter 2"));
	});
});

describe("/loop end", () => {
	it("stops the loop and prevents the next fresh session", async (t) => {
		const h = makeHarness(t);
		await runLoopCommand(h, "start go");
		await h.flush();
		await runLoopCommand(h, "end");
		assert.equal(h.lastStatus(), undefined, "status cleared");
		assert.equal(h.activeTools().includes(TOOL_NAME), false, "tool deactivated");
		assert.ok(h.notified.some((n) => n.message.includes("Loop ended by user")));
		const sessionsAfterEnd = h.sessionCount;
		await h.run(); // the in-flight iteration settles
		await h.flush();
		assert.equal(h.sessionCount, sessionsAfterEnd, "no fresh session after /loop end");
		assert.equal(h.sent.length, 1, "no re-post after /loop end");
	});

	it("reports that no loop is in progress when idle", async (t) => {
		const h = makeHarness(t);
		await runLoopCommand(h, "end");
		assert.ok(h.notified.some((n) => n.message.includes("No loop in progress")));
	});

	it("ending the loop mid-swap leaves the fresh session idle", async (t) => {
		const h = makeHarness(t);
		await runLoopCommand(h, "start go");
		await h.flush();
		await h.run(); // iteration 1 settles → swap scheduled
		// End the loop in the exact moment the swap reaches its withSession
		// phase, right before the prompt would be posted.
		h.setOnSwapPhase((name) => {
			if (name === "with_session") {
				return runLoopCommand(h, "end");
			}
			return undefined;
		});
		await h.flush();
		assert.equal(h.sent.length, 1, "no post into the fresh session");
		assert.equal(h.activeTools().includes(TOOL_NAME), false, "tool deactivated");
		h.setOnSwapPhase(undefined);
	});
});

describe("session switches stop the loop", () => {
	it("a user session switch ends the loop before the teardown", async (t) => {
		const h = makeHarness(t);
		await runLoopCommand(h, "start go");
		await h.flush(); // iteration 1 in flight
		await h.fire("session_before_switch", { type: "session_before_switch", reason: "new" });
		assert.equal(h.lastStatus(), undefined, "status cleared");
		assert.equal(h.activeTools().includes(TOOL_NAME), false, "tool deactivated");
		assert.ok(h.notified.some((n) => n.message.includes("session was switched")));
		// The teardown aborts the in-flight run and settles it.
		await h.fire("agent_end", {
			type: "agent_end",
			messages: [{ role: "assistant", stopReason: "aborted", content: [], usage: {} }],
		});
		await h.fire("agent_settled");
		await h.flush();
		assert.equal(h.sent.length, 1, "no fresh session after the user switch");
	});

	it("a fork ends the loop", async (t) => {
		const h = makeHarness(t);
		await runLoopCommand(h, "start go");
		await h.flush();
		await h.fire("session_before_fork", {
			type: "session_before_fork",
			entryId: "e1",
			position: "before",
		});
		assert.ok(h.notified.some((n) => n.message.includes("session was forked")));
		assert.equal(h.activeTools().includes(TOOL_NAME), false);
	});

	it("a cancelled newSession stops the loop with a warning", async (t) => {
		const h = makeHarness(t);
		h.cancelNextNewSession();
		await runLoopCommand(h, "start go");
		await h.flush();
		assert.equal(h.sent.length, 0, "nothing was posted");
		assert.equal(h.lastStatus(), undefined, "status cleared");
		assert.equal(h.activeTools().includes(TOOL_NAME), false);
		assert.ok(
			h.notified.some((n) => n.type === "warning" && n.message.includes("cancelled")),
		);
	});

	it("process/session shutdown ends the loop", async (t) => {
		const h = makeHarness(t);
		await runLoopCommand(h, "start go");
		await h.flush();
		await h.fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
		assert.equal(h.lastStatus(), undefined);
		assert.equal(h.activeTools().includes(TOOL_NAME), false);
		await h.flush();
		assert.equal(h.sent.length, 1, "no re-post after shutdown");
	});
});

describe("nothing_to_do tool", () => {
	it("ends the loop at the next settle and reports the reason", async (t) => {
		const h = makeHarness(t);
		await runLoopCommand(h, "start go");
		await h.flush(); // iteration 1 run in flight
		const result = await h.tool(TOOL_NAME).execute(
			"tc-1",
			{ reason: "all tasks complete" },
			undefined,
			undefined,
			h.ctx,
		);
		assert.equal(result.terminate, true, "skips the automatic follow-up");
		assert.equal(result.details.loopEnded, true);
		assert.equal(result.content[0].text, "OK.");
		await h.run("stop", 4_000);
		assert.equal(h.sent.length, 1, "no fresh session after nothing_to_do");
		assert.equal(h.lastStatus(), undefined, "status cleared");
		assert.equal(h.activeTools().includes(TOOL_NAME), false, "tool deactivated");
		assert.ok(
			h.notified.some(
				(n) =>
					n.message.includes("nothing left to do") &&
					n.message.includes("(all tasks complete)"),
			),
		);
	});

	it("is a no-op when no loop is active", async (t) => {
		const h = makeHarness(t);
		const result = await h.tool(TOOL_NAME).execute("tc-1", {}, undefined, undefined, h.ctx);
		assert.equal(result.terminate, undefined);
		assert.equal(result.details.loopEnded, false);
		assert.equal(result.content[0].text, "OK.");
		// A later loop still works.
		await runLoopCommand(h, "start go");
		await h.flush();
		assert.equal(h.sent.length, 1);
	});
});

describe("status line", () => {
	it("shows nothing when no loop is in progress", async (t) => {
		const h = makeHarness(t);
		await h.run(); // a normal (non-loop) run
		assert.equal(h.statuses.length, 0, "setStatus never called");
	});

	it("shows iteration progress with elapsed time while running", async (t) => {
		const h = makeHarness(t);
		await runLoopCommand(h, "start go");
		await h.flush();
		await h.run("stop", 10_000); // finishes iteration 1
		await h.flush(); // iteration 2 posted
		// The status must survive the session swap (restored on session_start).
		assert.ok(h.lastStatus()!.includes("iter 2"), "status restored after the swap");
		await h.fire("agent_start"); // iteration 2's run starts
		t.mock.timers.tick(1_000); // status refresh interval fires
		const status = h.lastStatus()!;
		assert.ok(status.includes("iter 2"), status);
		assert.ok(status.includes("1s into iter"), status);
	});

	it("shows the error counter when an iteration fails", async (t) => {
		const h = makeHarness(t);
		await runLoopCommand(h, "start go");
		await h.flush();
		await h.run("error", 2_000);
		const status = h.lastStatus()!;
		assert.ok(status.includes("⚠ 1/3 consecutive errors"), status);
		assert.ok(
			h.notified.some((n) => n.type === "warning" && n.message.includes("ended in error")),
		);
	});
});

describe("error guard", () => {
	it("stops the loop after 3 consecutive error iterations", async (t) => {
		const h = makeHarness(t);
		await runLoopCommand(h, "start go");
		await h.flush();
		await h.run("error", 1_000);
		assert.ok(h.lastStatus()!.includes("⚠ 1/3"), h.lastStatus());
		await h.flush();
		await h.run("error", 1_000);
		assert.ok(h.lastStatus()!.includes("⚠ 2/3"), h.lastStatus());
		await h.flush();
		await h.run("error", 1_000);
		assert.equal(h.sent.length, 3, "no fourth post");
		assert.equal(h.sessionCount, 3, "no fourth session");
		assert.equal(h.lastStatus(), undefined, "loop stopped, status cleared");
		assert.equal(h.activeTools().includes(TOOL_NAME), false);
		assert.ok(
			h.notified.some((n) => n.type === "error" && n.message.includes("consecutive iterations ended in error")),
		);
	});

	it("resets the error counter on a successful iteration", async (t) => {
		const h = makeHarness(t);
		await runLoopCommand(h, "start go");
		await h.flush();
		await h.run("error", 1_000);
		await h.flush();
		await h.run("error", 1_000);
		await h.flush();
		await h.run("stop", 1_000); // success resets the counter
		await h.flush();
		await h.run("error", 1_000);
		await h.flush(); // the loop posts the next iteration: it survived
		assert.ok(h.lastStatus()!.includes("iter 5"), h.lastStatus());
		assert.ok(h.lastStatus()!.includes("⚠ 1/3"), h.lastStatus());
		assert.equal(h.sent.length, 5, "loop is still posting");
	});

	it("an aborted iteration is not counted as an error", async (t) => {
		const h = makeHarness(t);
		await runLoopCommand(h, "start go");
		await h.flush();
		await h.run("aborted", 1_000);
		assert.ok(h.lastStatus()!.includes("iter 2"), "the loop continues after an abort");
		assert.ok(!h.lastStatus()!.includes("consecutive errors"));
	});
});

describe("/loop status", () => {
	it("reports the current status while active", async (t) => {
		const h = makeHarness(t);
		await runLoopCommand(h, "start go");
		await h.flush();
		await h.run("stop", 10_000);
		await runLoopCommand(h, "status");
		const last = h.notified[h.notified.length - 1];
		assert.ok(last.message.includes("iter 2"), last.message);
	});

	it("reports usage when no loop is active", async (t) => {
		const h = makeHarness(t);
		await runLoopCommand(h, "");
		assert.ok(
			h.notified.some((n) => n.message.includes("No loop in progress") && n.message.includes("Usage")),
		);
	});
});

describe("one-shot modes (print/json)", () => {
	it("keeps the process alive until the loop ends, then returns", async (t) => {
		const h = makeHarness(t, { mode: "print" });
		const startPromise = h.command("loop").handler("start go", h.ctx);
		// Let the scheduled session swap run; the handler must still be
		// pending, holding the (one-shot) process alive.
		await h.flush();
		assert.equal(h.sent.length, 1, "the loop posted into its fresh session");
		// The agent finishes the loop by calling nothing_to_do.
		await h.tool(TOOL_NAME).execute("tc-1", {}, undefined, undefined, h.ctx);
		await h.run("stop", 2_000);
		await startPromise; // must resolve once the loop has ended
		assert.equal(h.sent.length, 1);
	});

	it("resolves the hold also when the loop is stopped from outside", async (t) => {
		const h = makeHarness(t, { mode: "print" });
		const startPromise = h.command("loop").handler("start go", h.ctx);
		await h.flush();
		// A session shutdown (e.g. the host tearing down) ends the loop.
		await h.fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
		await startPromise;
	});
});
