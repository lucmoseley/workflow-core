#!/usr/bin/env node
/*
 * lost-verdict.js — the judgement behind scripts/guard-lost-verdict.sh (workflow-core#1575):
 * given a finished Bash call that launched the suite, is its pass/fail line
 * missing from the output, and if so, what did the run say?
 *
 * Run as `node lost-verdict.js` with the PostToolUse or PostToolUseFailure
 * payload on stdin. Prints one JSON object: `{ context }` to hand the session,
 * `{ why }` where it stays silent for a reason worth logging, or `{}` where it
 * stays silent because nothing was lost.
 *
 * WHICH LOG IS THIS CALL'S, never a neighbour's. The output's own `TEST LOG:`
 * line where it survived; else this session's run record (lib/test-log.js),
 * narrowed to runs inside the call, whose start is the payload's
 * `duration_ms` back from now. Those runs must all come from one runner
 * process — one launch — or the answer is not certain and it stays silent.
 */

const fs = require("node:fs");
const path = require("node:path");
const { hostRoot } = require("./host-root.js");
const { readRuns } = require("./test-log.js");
const { repoRoot } = require("./test-pass-marker.js");

/* vitest's two summary lines, as it prints them to a pipe. */
const VERDICT_RE = /^\s*(Test Files|Tests)\s+\d/m;
const TEST_LOG_RE = /^TEST LOG: (.+)$/gm;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI colour codes
const ANSI_RE = /\u001b\[[0-9;]*m/g;

/* The runner's push-gate and filter lines, as written to the log; their first
 * line only, the rest being explanation. */
const GATE_LINE_RE =
	/^(MEETS THE PUSH GATE|NOT ADMISSIBLE|FILTERED RUN|SUITE STALLED)\b/;
const FAIL_RE = /^\s*FAIL\s/;
/* An empty selection: vitest ran no file, so printed no verdict to lose
 * (workflow-core#1661). `in 0 of`, since a file that failed to collect also counts 0
 * tests, and its red verdict is lost. Copies the wording of
 * formatFilteredRun in lib/test-pass-marker.js. */
const EMPTY_RUN_RE = /^FILTERED RUN — ran 0 of 0 tests in 0 of /m;
/* First guesses, unmeasured: enough to name what failed without the
 * context outgrowing the log it points at. */
const MAX_FAIL_LINES = 10;
const MAX_LINE = 300;
/* A first guess at the hook's own start-up lag, by which `now` trails the
 * call's end; a run of the call starts later than the call by npm's own
 * start-up, which is longer. */
const WINDOW_SLACK_MS = 5000;

/** @param {string} text */
const stripAnsi = (text) => text.replace(ANSI_RE, "");

/**
 * The last `TEST LOG:` path the output still holds, or null.
 * @param {string} output
 * @returns {string|null}
 */
function logFromOutput(output) {
	let last = null;
	for (const [, shown] of stripAnsi(output).matchAll(TEST_LOG_RE))
		if (shown) last = shown.trim();
	return last;
}

/**
 * @param {import("./test-log.js").RunRecord[]} runs
 * @param {number} since epoch ms the call began
 * @param {number} now epoch ms
 * @returns {{ log: string } | { why: string }}
 */
function pickRun(runs, since, now) {
	const inside = runs.filter(
		(r) => Date.parse(r.startedAt) >= since && Date.parse(r.endedAt) <= now,
	);
	const last = inside.at(-1);
	if (last === undefined)
		return { why: "no run in this session's record falls inside the call" };
	const pids = new Set(inside.map((r) => r.pid));
	if (pids.size > 1)
		return {
			why: `${pids.size} launches of this session ran inside the call — which one lost its verdict is uncertain`,
		};
	return { log: last.log };
}

/**
 * The lines of a log that carry its verdict, in the order the log has them.
 * @param {string} text
 * @returns {string[]}
 */
function verdictLines(text) {
	const lines = [];
	let fails = 0;
	for (const raw of stripAnsi(text).split("\n")) {
		const line = raw.trimEnd();
		if (FAIL_RE.test(line)) {
			fails += 1;
			if (fails > MAX_FAIL_LINES) continue;
		} else if (!VERDICT_RE.test(line) && !GATE_LINE_RE.test(line)) continue;
		lines.push(line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line);
	}
	if (fails > MAX_FAIL_LINES)
		lines.push(
			`  … and ${fails - MAX_FAIL_LINES} more FAIL line(s) in the log`,
		);
	return lines;
}

/**
 * @param {string[]} lines
 * @param {string} shown the log's path as the session should read it
 */
function buildMessage(lines, shown) {
	const body =
		lines.length > 0
			? lines.map((l) => `  ${l}`).join("\n")
			: "  (the log holds no pass/fail line — the run ended before vitest printed one)";
	return [
		"This suite run's pass/fail lines were cut from its output — a `grep` or `head` on the output drops them, and the runner's own lines can push them out of a short `tail` (workflow-core#1575). From the run's own log:",
		body,
		`TEST LOG: ${shown}`,
		"Read that log for anything more. Do not re-run the suite to see this verdict again.",
	].join("\n");
}

/**
 * @typedef {{ session_id?: string, duration_ms?: number,
 *   error?: string, is_interrupt?: boolean,
 *   tool_response?: { stdout?: string, stderr?: string, interrupted?: boolean,
 *     backgroundTaskId?: string, timedOutAfterMs?: number } }} Payload
 */

/**
 * @param {Payload} payload
 * @param {string} root
 * @returns {{ log: string } | { why: string }}
 */
function recordedLog(payload, root) {
	const session = payload.session_id;
	const took = payload.duration_ms;
	if (!session || typeof took !== "number")
		return { why: "no session id or duration_ms in the payload" };
	const now = Date.now();
	return pickRun(readRuns(root, session), now - took - WINDOW_SLACK_MS, now);
}

/**
 * The call's output, or null where the call left none a log line repairs: a
 * backgrounded run has not finished, and a killed or timed-out one lost its
 * output whole. A failed call (PostToolUseFailure) carries its output in
 * `error`.
 *
 * @param {Payload} payload
 * @returns {string|null}
 */
function callOutput(payload) {
	if (payload.is_interrupt) return null;
	const response = payload.tool_response;
	if (!response) return payload.error ?? "";
	if (
		response.backgroundTaskId ||
		response.interrupted ||
		response.timedOutAfterMs
	)
		return null;
	return `${response.stdout ?? ""}\n${response.stderr ?? ""}`;
}

/**
 * @param {Payload} payload
 * @returns {{ context?: string, why?: string }}
 */
function judge(payload) {
	const output = callOutput(payload);
	if (output === null || VERDICT_RE.test(stripAnsi(output))) return {};
	/* The canonical checkout, where the runner keeps its logs and records
	 * whichever worktree it ran in. */
	const root = repoRoot(hostRoot()) ?? hostRoot();
	const shownLog = logFromOutput(output);
	const found = shownLog
		? { log: path.resolve(root, shownLog) }
		: recordedLog(payload, root);
	if ("why" in found) return found;
	let text;
	try {
		text = fs.readFileSync(found.log, "utf8");
	} catch (error) {
		return { why: `the run's log is unreadable (${error}): ${found.log}` };
	}
	/* Logged, so the workflow-core#1661 count can tell these apart from lost verdicts. */
	if (EMPTY_RUN_RE.test(stripAnsi(text)))
		return {
			why: "an empty selection — vitest ran no file, so no verdict was lost",
		};
	return {
		context: buildMessage(verdictLines(text), path.relative(root, found.log)),
	};
}

if (require.main === module) {
	let out;
	try {
		out = judge(JSON.parse(fs.readFileSync(0, "utf8")));
	} catch (error) {
		out = { why: `could not judge: ${error}` };
	}
	process.stdout.write(`${JSON.stringify(out)}\n`);
}
