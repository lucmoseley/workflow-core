#!/usr/bin/env node
/*
 * guard-suite-concurrency.js — PreToolUse guard: refuse a test suite launched
 * under the headroom docs/environment.md §6 says it needs resting, sending it
 * to the queue, warn before a build launches under it — and before a watcher
 * launches (mantahostels#1927).
 *
 * Why: admission.js prices a NEW session at dispatch time and holds no memory
 * back for the suites it may run (workflow-core#2305); this covers a test suite or build
 * inside an ALREADY-admitted one, judged against lib/suite-ladder.js's
 * ladder (workflow-core#2795).
 *
 * DENIES-THROUGH: lib/guard-entry.js — `run` writes the core's deny, so the
 * registration carries `"onFailure": "block"` and a crash or timeout refuses.
 *
 * THE MEMORY LADDER QUEUES (workflow-core#2305): a test launch short of its rung is refused,
 * its first line the same launch through the queue, which polls this guard's
 * core (lib/suite-queue.js's gateDenies) until the rung is free. A `--queue`
 * launch and a build are warned, never refused.
 *
 * THE COUNT CAP (workflow-core#2680) refuses a SECOND concurrent whole suite the same way,
 * so no run is stretched by others beside it. The count comes from `ps`, so a
 * dead process leaves no line: there is no lock or latch to clear, and a deny
 * you cannot reproduce has already lifted.
 *
 * THAT COUNT IS READ FROM `ps` AT PreToolUse TIME, SO TWO LAUNCHES INSIDE THE
 * SAME WINDOW EACH SEE THEMSELVES AS FIRST and both are allowed. LEFT OPEN
 * DELIBERATELY (mantahostels#2186, workflow-core#159): a race can land a second whole suite
 * beside the first, which costs both runs wall-clock rather than a wait.
 *
 * THE DENY OPENS WITH THE COMMAND TO RUN INSTEAD (workflow-core#482, workflow-core#519): 86% of refused
 * sessions re-issued with `--queue`, but the fix sat inside up to 2,113 bytes.
 * Line one is the denied launch as typed, with `--queue` appended — `-- --queue`
 * on an npm launch carrying no `--`. It is the SEGMENT, not a compound command's
 * whole, so there line one says to keep the rest. The walker hands the
 * `--queue` and `--` checks the words either side of a redirection (workflow-core#1007,
 * workflow-core#1488), so line one, re-submitted, passes; a quoted `--queue` is not the
 * flag. A non-vitest runner (workflow-core#330), and an npm script that does not run
 * run-vitest.js, is queued by scripts/queue-run.js instead (workflow-core#1776), so its
 * line one is that launch through it. A watcher has no queue: its line one is
 * the wait and then the same launch.
 *
 * ITS ESCAPE IS `WFC_SUITE_CONCURRENT=1` prefixed on the command
 * (mantahostels#2486). Every use of it, prefixed or exported, is recorded
 * (mantahostels#2183) — one JSON line per command stood down, at
 * `.claude/tmp/markers/.suite-standdowns.jsonl`, joined forward by time to the
 * next pass marker its session writes. Only the stand-down is written: a
 * launch allowed for any other reason leaves nothing.
 *
 * TWO RESIDUALS OF ITS OWN. An open watcher counts as the suite already running,
 * so a session holding one can launch nothing until it closes it — the refusal
 * says so. And a build is never counted as a suite, being off the ladder.
 *
 * A BUILD BESIDE A RUNNING `next build`, AND A DEV SERVER BESIDE A RUNNING
 * `next dev`, ARE DENIED (workflow-core#1733, workflow-core#1759), printing
 * docs/agents/rules/build-concurrency.txt. No escape. A build is `npm run
 * build`, `next build`, `npx next build` or a path ending `/next` then
 * `build`, and a dev server the same with `dev`, npm's own flags read as npm
 * reads them. It counts `next build` and `next dev` runners alone, so a script
 * running another tool passes unseen, and a build beside a dev server is not
 * the rule's to refuse.
 *
 * A BARE `tsc` THE TYPE-CHECK SLOT WOULD HOLD IS DENIED (workflow-core#3163): one already
 * running, or MemAvailable under its rung (lib/tsc-slot.js). Line one is the
 * same launch through `queue-run.js --tsc`, which waits for the slot; no
 * escape. `npm run typecheck` holds the slot itself, so it is never judged.
 *
 * SCOPE: `npm run test`, `npm run test:changed`, `npm run test:watch`,
 * `node scripts/run-vitest.js` (mantahostels#2015), a build and a dev server.
 * Also (workflow-core#330) `node --test`, `pytest` and a Python test file run bare, plus the
 * host's declared `suiteRunners`. `npm run test:py` is not judged at launch,
 * its runner being a script, but its `pytest` counts once running; a whole run
 * of it still draws the memory figure (workflow-core#2024).
 *
 * A RUN NAMING ITS TEST FILES IS CHARGED BY THE VITEST WORKERS IT CAN OCCUPY
 * (workflow-core#2558, ruled at workflow-core#2557), as lib/suite-bounded.js reads them: one per file
 * named, up to a whole suite's. A TOUCHED RUN (workflow-core#2935) — one naming its test
 * files, however many, a `--retest`, or the bare `npm run test` under
 * `landing` — is a part-suite, refused under its own rung alone and never at
 * the count cap; the bare one, its selection unresolved, is charged a whole
 * suite's workers. At launch any other run is a whole suite, a bare
 * `test:changed` and a bare `npm run test` with `landing` off among them: a
 * diff's selection has no ceiling before it is resolved, so it is judged on
 * the full-suite ladder, an UPPER BOUND on what it will cost
 * (mantahostels#1906). Once launched, a run is charged by the resolved weight
 * its launch record carries (workflow-core#2931).
 *
 * A LAUNCHER WRAPPER IS STRIPPED before the scope test (mantahostels#2511,
 * mantahostels#2552, shell-words.js's `unwrap`). THE CLASS IS NOT CLOSED: a
 * `sh -c "…"` and a heredoc walk past unjudged (mantahostels#2629). A bare
 * `npx vitest` is counted once running but never judged on the way in. An
 * `npm test -- --watch` is judged only as a one-shot: the watcher limb is
 * decided on the script name alone.
 *
 * A COMPOUND COMMAND GETS ONE MESSAGE, so the watcher limb is decided by a
 * pre-pass over every segment (mantahostels#1978) and rides on whichever
 * warning fires. `||` is flattened like any other separator, so
 * `npm run build || npm run test:watch` hangs the limb off the build's warning.
 *
 * AN OPEN WATCHER COSTS A FULL RUNG FOR AS LONG AS IT IS OPEN
 * (mantahostels#1927). What an IDLE watcher actually dips is UNMEASURED.
 *
 * FAILS OPEN on anything unreadable — no MemAvailable line, a `ps` that will
 * not run — per mantahostels#103 §6, on the guard-error log.
 *
 * It is narrowed to `if: Bash(*npm *)`, `if: Bash(*node *)`, `if: Bash(*next *)`
 * (mantahostels#2811), `if: Bash(*python*)` and `if: Bash(*pytest*)` (workflow-core#330),
 * and `if: Bash(*npx *)`, `if: Bash(*yarn *)`, `if: Bash(*pnpm *)`,
 * `if: Bash(*bun *)`, `if: Bash(*make *)`, `if: Bash(*cargo *)` and
 * `if: Bash(*go test*)`, for a host's declared `commands.test` (workflow-core#2303), and
 * `if: Bash(*tsc*)` (workflow-core#3163).
 * The narrowing is best-effort (hooks.md:448), so the count-cap deny does not
 * rest on it: the core re-reads the command itself.
 *
 * IMPLICIT: on a test launch it lets through without refusing or warning, it
 *   injects the suite-tree-dirty rule as additionalContext and writes a
 *   `.rule-injected-*` latch under .claude/tmp/markers (mantahostels#1805).
 *   On a PLAIN `--full` launch over a tree whose read graph renders it adds a
 *   second notice in that envelope, under a latch of its own: a bare `npm run
 *   test` would be admissible here and would meet the push gate alone (workflow-core#181).
 *   A LADDER WARN ON THE SAME LAUNCH OUTRANKS IT, deliberately, and the limb
 *   lands on the NEXT `--full`.
 *   On a build or a whole-suite launch it injects rule:memory-figure once a
 *   session, behind the MemAvailable reading it judged (workflow-core#2024). On the host's
 *   declared `commands.test` typed bare, with `suites` on, it injects
 *   rule:targeted-runs once a session (workflow-core#2237).
 * JUSTIFIED: fail-safe — a session that cannot tell a neighbour's half-written
 *   file from its own breakage debugs the wrong thing, and the launch is the
 *   last moment before the verdict it will misread. The latch keeps it from
 *   costing bytes on every later run.
 * DEFEAT: `WFC_SUITE_CONCURRENT=1` prefixed on the command stands the ladder
 *   and count-cap denies down for the whole command, as does the same name
 *   exported into the hook's environment; `scripts/clear-rule-latch.sh` clears
 *   the latch and it is said again; deleting the registration from
 *   self-plugin/hooks/hooks.json silences it. And the deny reads the command it
 *   is handed, so a suite launched from INSIDE a script never reaches this
 *   hook — which is why vitest's queue is a flag on the launch
 *   (mantahostels#2024).
 */

const { run } = require("./lib/guard-entry.js");
const { decide } = require("./lib/suite-concurrency.js");
const { buildHostPorts } = require("./lib/suite-concurrency-host.js");
const { readFullLaunchPlain } = require("./lib/full-launch-plain.js");

run({
	field: "command",
	noun: "command",
	decide,
	ports: (env) => ({
		...buildHostPorts(env),
		fullLaunchPlain: readFullLaunchPlain,
	}),
});
