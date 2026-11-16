# pi-loop

A [pi](https://pi.dev/) coding agent extension that re-runs
a user prompt indefinitely. **Every iteration runs in a completely fresh
session — as if pi had been started again**: when an agent run settles, the
current session is replaced with a brand-new one (all session context cleared)
and the same prompt is posted into it — until the agent decides there is
nothing left to do, or the user stops it.

## Usage

```
pi --extension /path/to/pi-loop
```

Then, inside pi:

| Command | Effect |
|---|---|
| `/loop start <prompt>` | Start looping `<prompt>`. Every iteration runs in a fresh session. Starting while a loop is active restarts it with the new prompt. |
| `/loop end` | Stop the current loop at any point. |
| `/loop` or `/loop [status]` | Print the current loop status or usage. |

### Fresh sessions per iteration

Each iteration starts with a clean slate, exactly like restarting pi:

- **Cleared**: the entire session context — conversation history, compaction
  state, queued messages. The agent of iteration N+1 does not see iteration
  N's reasoning; it re-derives what to do from the workspace itself.
- **Kept**: everything on disk. File changes made by earlier iterations are
  the only way progress accumulates across the loop, which is the point of the
  pattern (Ralph-Wiggum style): the state lives in the repository, not in the
  conversation.
- **Session files**: each iteration gets its own session file (like pi's own
  `/new`), so you can inspect what any single iteration did.

Because context is cleared between iterations, the prompt should be
self-contained: it should say what to work on *and* how to tell that the work
is done (that is what the agent uses to decide on calling `quit`).

### Loop status

While a loop is in progress, a status line appears in the footer, in the same
place as other system state (e.g. `Thinking blocks: visible`):

```
● Loop in progress · iter 4 · ~4.2 it/min · 23s into iter
```

- **iteration** — the current (1-based) iteration number
- **~N it/min** — estimated iteration speed (average of the last 5 completed
  iterations; shows `estimating speed…` until two iterations are done)
- **Ns into iter** — elapsed time of the current iteration (refreshes once a
  second)
- **⚠ k/3 consecutive errors** — shown when recent iterations ended in errors

Nothing is shown when no loop is in progress.

### The `quit` tool

While a loop is in progress, the agent gets an extra tool:

> **quit** — Quits the session.
> Call it only when you realize that there is no work to do in this session.

It is only declared to the model while a loop runs: the extension activates it
with `pi.setActiveTools()` when the loop starts and hides it again when the
loop ends (pi re-activates every extension tool on session (re)start, so the
`session_start` handler hides it again until a loop is in progress). "This
session" is the iteration's fresh session. When the agent calls it, the loop
stops at the end of the current run (the tool result sets `terminate`, skipping
one redundant follow-up model request). Then it calls `ctx.shutdown()` to quit
the pi process.

### How the loop works

- The next iteration starts at the **`agent_settled`** boundary — the moment
  pi guarantees no automatic retry, compaction, or queued continuation will
  run — so the loop can never race pi's own machinery. Session replacement can
  only be requested from command contexts, so the loop schedules the
  `ctx.newSession()` call on a detached tick right after the settle and posts
  the prompt into the fresh session through its `withSession` callback (the
  command context handed to that callback is kept for the iteration after).
- **Surviving the re-created extension**: pi rebuilds the session runtime on
  every session replacement and re-runs the extension factory for the new
  session (a fresh module instance). The loop's state therefore lives in a
  versioned record on `globalThis` that every factory run re-binds to; the
  instance being replaced hands the new session's command context over
  through that record inside `withSession`.
- The prompt is posted with **`deliverAs: "followUp"`**. Since the fresh
  session is idle, this starts a new run exactly like a plain send.
- **User messages**: typed during an iteration they are queued into that
  iteration's run (normal steering). Typed in the exact moment between
  iterations they may be dropped — the swap to the next fresh session replaces
  whatever session their message started. That is the trade-off of clearing
  the context each iteration.
- If `/loop start` is issued while a run is in flight, the first fresh session
  starts once that run settles — the in-flight run finishes first and does not
  count as a loop iteration.
- **Restarting** (`/loop start <other prompt>` while a loop is active) keeps
  the running loop but points it at the new prompt: the in-flight iteration
  finishes with the old prompt and does not count, and the next fresh session
  starts iteration 1 with the new prompt.
- **Escape/abort does not kill the loop**: an aborted iteration just ends and
  the next iteration starts in a fresh session. Use `/loop end` to stop it.
- **Session switches end the loop**: a user-initiated `/new`, `/resume`,
  `/fork`, or `/reload` stops the loop (it never fights a session change the
  user makes).
- **Error guard**: if 3 consecutive iterations end in an error, the loop stops
  itself with an error notification instead of spinning on the same failure.
  A successful iteration resets the counter.
- In one-shot modes (`pi -p` / `--mode json`) the `/loop start` handler holds
  the process until the loop ends, so one-shot runs can complete the loop
  instead of exiting before it starts (in text mode the final iteration's
  answer is printed as usual).
- Loop state is in-memory: process exit or `/reload` drops an active loop (no
  persistence is attempted).

### Tests

Unit tests drive the extension factory with a mocked `ExtensionAPI` and mock
per-session contexts, and simulate pi's lifecycle exactly as the runtime
emits it — `agent_start` → `agent_end` → `agent_settled` for runs, and
`session_before_switch` → (abort) → `session_shutdown` → stale old context →
fresh extension instance (the factory re-run) → `session_start` →
`withSession` for session replacement. No real agent, model, or process is
involved:

```sh
npm test        # = node --test
```
