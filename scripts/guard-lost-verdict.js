#!/usr/bin/env node
/*
 * guard-lost-verdict.js — PostToolUse and PostToolUseFailure hook: after a
 * suite run whose output lost its pass/fail line, hand the session that run's
 * verdict and TEST LOG path, so it reads the log instead of re-running
 * (workflow-core#1575, ruled at workflow-core#1379 Q1 (D)). It does not warn on the pipe itself
 * (workflow-core#1379 Q1 (B)). The core is lib/lost-verdict.js, its ports
 * lib/lost-verdict-host.js.
 *
 * BOTH EVENTS, because a call exiting non-zero — a red suite, or a `grep`
 * whose pattern matched nothing — reaches PostToolUseFailure and never
 * PostToolUse (workflow-core#1575, probed live).
 *
 * SCOPE: a call any of whose segments, read after unwrap's wrapper strip,
 * launches the suite through scripts/run-vitest.js — lib/suite-launch.js's
 * `npm-vitest` and `wrapper` kinds. A direct `npx vitest` writes no TEST LOG.
 *
 * FAILS OPEN (mantahostels#103 §6), recorded: a judge that cannot find this
 * call's log with certainty says nothing and logs why. With no node on PATH
 * the hook line exits 0, unrecorded.
 *
 * LIMITS
 *  - Two launches in one call say nothing, which launch lost its verdict
 *    being uncertain.
 *  - A `head` that closes the pipe early kills the run itself, so no log
 *    holds a verdict and the record has no line for it.
 *
 * Its `if: Bash(*test*)` narrowing, which `npm run test`, `npm test` and
 * `run-vitest` all hold, is unanchored, as unwrap reads past a wrapper prefix
 * the anchored form would not match. ONE registration per event, never two:
 * two both fire on some calls, doubling the context (workflow-core#1661). The narrowing is
 * best-effort, so the core re-reads the command.
 *
 * IMPLICIT: after a suite run whose output shows no pass/fail line, hands the
 *   session that run's verdict lines and TEST LOG path.
 * JUSTIFIED: fail-safe — it adds context and refuses nothing; the re-run it
 *   heads off costs minutes of suite time.
 * DEFEAT: `bash -c`, a script or a heredoc wrapping the launch; deleting the
 *   registration.
 */

const { run } = require("./lib/guard-entry.js");
const { decide } = require("./lib/lost-verdict.js");
const { buildHostPorts } = require("./lib/lost-verdict-host.js");

run({
	field: "command",
	noun: "a suite run's lost verdict",
	event: "PostToolUse",
	decide,
	ports: buildHostPorts,
});
