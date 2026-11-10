/*
 * guard-probe.js — the refill tick's probe of a served checkout (#3860, #4226,
 * #4914): what fails in it, which lib/repo-holds.js raises and lifts its probe
 * hold on.
 *
 * THE SHARED `.git` must fetch origin and resolve `main`. A ref git says will
 * not resolve is a failure; a failed fetch, or a git that never answered, is an
 * outage, which the hold side lets last a window before it raises (#3899).
 *
 * THE GUARD ENTRY: a self-plugin host's sessions run the guard hook line its
 * `self-plugin/hooks/hooks.json` registers, so the probe runs that line on a
 * benign `Read`, as a session would, whatever code it runs. A failure is run once
 * more after GUARD_PROBE_RETRY_MS, and a second is no outage. A hooks file that
 * will not read, or a matcher that is not a valid regex, is a failure of its own,
 * never a throw, so the hold rises rather than the tick failing (#4907). An
 * adopter loads its guards from its pinned plugin release, so runs no step.
 *
 * A REPLAYED CALL (#4228), one a locked-out session's guards refused, runs the
 * same line.
 */

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { readCommit } = require("./commit-sha.js");
const { spawnChild } = require("./child-spawn.js");
const {
	MatcherError,
	SELF_PLUGIN_HOOKS,
	isToolCovered,
	readHooksAt,
} = require("./core-hooks.js");
const { isLockoutText } = require("./core-fault.js");
const { parseFirstLine } = require("./first-line.js");
const { gitOutcome, gitReader } = require("./git.js");
const { buildHookEnv, selfPluginRoot } = require("./hook-env.js");
const { FETCH_TIMEOUT_MS } = require("./pinned-code.js");
const { sleepSync } = require("./sleep-sync.js");

/**
 * @typedef {{text: string, isOutage: boolean}} ProbeFailure
 * @typedef {import("./block-cause.js").RefusedCall} RefusedCall
 */

/* Untraced: under the hook's own 60 s, and about 200 times a healthy run's
 * 0.05 s, measured on this repo's tree. */
const GUARD_PROBE_TIMEOUT_MS = 10_000;

/* Untraced: long enough for a write in progress to land. */
const GUARD_PROBE_RETRY_MS = 2000;

/**
 * The wait, ms, before the guard-load probe's re-run: `WFC_GUARD_PROBE_RETRY_MS`,
 * which a sandboxed tick sets to 0 (#4282), else GUARD_PROBE_RETRY_MS. Unset,
 * empty, negative or unreadable is the default, as a NaN would never wake
 * sleepSync.
 */
function guardProbeRetryMs() {
	const ms = Number(
		process.env.WFC_GUARD_PROBE_RETRY_MS || GUARD_PROBE_RETRY_MS,
	);
	return Number.isNaN(ms) || ms < 0 ? GUARD_PROBE_RETRY_MS : ms;
}

/* The probe's own, so it leaves no latch on a real session. */
const GUARD_PROBE_SESSION = "refill-loop-guard-probe";

/* The entry the guard hook line runs. */
const GUARD_ENTRY = "guard-dispatch.js";

/**
 * The guard hook line `root`'s `self-plugin/hooks/hooks.json` registers for a
 * PreToolUse call of `tool`, else why there is none to run: a self-plugin host
 * with none runs no guard on the call, which is a fault of its own.
 * @param {string} root
 * @param {string} tool
 * @returns {{line: string}|{why: string}}
 */
function readGuardHookLine(root, tool) {
	let hooks;
	try {
		hooks = readHooksAt(root, SELF_PLUGIN_HOOKS);
	} catch (err) {
		return { why: caught(err).message };
	}
	for (const group of hooks.PreToolUse ?? []) {
		const matcher = group?.matcher == null ? undefined : String(group.matcher);
		try {
			if (!isToolCovered(matcher, tool)) continue;
		} catch (err) {
			if (!(err instanceof MatcherError)) throw err;
			return { why: `${SELF_PLUGIN_HOOKS}: ${err.message}` };
		}
		const line = findGuardLine(group?.hooks);
		if (line) return { line };
	}
	return { why: `${SELF_PLUGIN_HOOKS} registers no guard line for ${tool}` };
}

/**
 * @param {unknown} hooks
 * @returns {string|undefined}
 */
const findGuardLine = (hooks) =>
	(Array.isArray(hooks) ? hooks : []).find(
		(h) => typeof h?.command === "string" && h.command.includes(GUARD_ENTRY),
	)?.command;

/**
 * @param {string} root
 * @returns {RefusedCall}
 */
const buildBenignRead = (root) => ({
	tool_name: "Read",
	tool_input: { file_path: path.join(root, SELF_PLUGIN_HOOKS), limit: 1 },
});

/**
 * What one run of `root`'s guard hook line on `call` fails on, or null where it
 * lets the call through, run from the main checkout's files, never the loop's code
 * copy, under the probe's own session id. `isAnyDeny`, whether any deny fails
 * it, as for the benign `Read`; else only one for want of a guard that could
 * judge the call, as a replayed call may be refused on its merits.
 * @param {string} root
 * @param {RefusedCall} call
 * @param {boolean} isAnyDeny
 * @returns {string|null}
 */
function readGuardRunFailure(root, call, isAnyDeny) {
	const hookLine = readGuardHookLine(root, String(call.tool_name));
	if ("why" in hookLine) return hookLine.why;
	/* Not under RUN_BUDGETED, which closes stdin, and the payload goes on it. */
	const run = spawnChild("sh", ["-c", hookLine.line], {
		cwd: root,
		env: buildHookEnv(root),
		input: JSON.stringify({
			session_id: GUARD_PROBE_SESSION,
			hook_event_name: "PreToolUse",
			cwd: root,
			...call,
		}),
		timeout: GUARD_PROBE_TIMEOUT_MS,
	});
	if (run.error)
		return caught(run.error).code === "ETIMEDOUT"
			? `outlived ${GUARD_PROBE_TIMEOUT_MS} ms`
			: run.error.message;
	if (run.status !== 0)
		return parseFirstLine(String(run.stderr)) || `exited ${run.status}`;
	const out = readHookOutput(String(run.stdout));
	if (out?.permissionDecision !== "deny") return null;
	const reason = String(out.permissionDecisionReason ?? "");
	if (!isAnyDeny && !isLockoutText(reason)) return null;
	const first = parseFirstLine(reason);
	return `refused a ${isAnyDeny ? "benign " : "replayed "}${call.tool_name}${first ? `: ${first}` : ""}`;
}

/**
 * A hook run's `hookSpecificOutput`, or null where its stdout carries none: plain
 * text on exit 0 refuses nothing.
 * @param {string} stdout
 * @returns {{permissionDecision?: unknown, permissionDecisionReason?: unknown}|null}
 */
function readHookOutput(stdout) {
	try {
		return JSON.parse(stdout)?.hookSpecificOutput ?? null;
	} catch {
		/* Not JSON: no decision, so no refusal (#4226). */
		return null;
	}
}

/**
 * The guard-load probe's failure in `root`, or null where it passes or `root` is
 * no self-plugin host.
 * @param {string} root
 * @returns {ProbeFailure|null}
 */
function readGuardLoadFailure(root) {
	if (!fs.existsSync(selfPluginRoot(root))) return null;
	const read = buildBenignRead(root);
	if (readGuardRunFailure(root, read, true) === null) return null;
	sleepSync(guardProbeRetryMs());
	const failure = readGuardRunFailure(root, read, true);
	return failure === null
		? null
		: { text: `guard entry: ${failure}`, isOutage: false };
}

/**
 * What fails of `root`'s shared `.git` and guard entry, or null where the probe
 * passes. `origin` and `main` are the main checkout's.
 * @param {string} root
 * @returns {ProbeFailure|null}
 */
function readProbeFailure(root) {
	const fetched = gitOutcome(
		["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "origin"],
		[],
		root,
		FETCH_TIMEOUT_MS,
	);
	const refs = [{ name: "main", rev: "refs/heads/main" }];
	const unresolved = refs.flatMap(({ name, rev }) => {
		const read = readCommit(gitReader(root), rev);
		if (!read.ok)
			return [
				{
					text: `resolve ${name}: ${read.why}`,
					isOutage: read.isUnrun === true,
				},
			];
		return read.sha === null
			? [{ text: `resolve ${name}: names no commit`, isOutage: false }]
			: [];
	});
	const failed = [
		...(fetched.ok
			? []
			: [{ text: `fetch origin: ${fetched.why}`, isOutage: true }]),
		...unresolved,
		...[readGuardLoadFailure(root)].filter((f) => f !== null),
	];
	return failed.length > 0
		? {
				text: failed.map((f) => f.text).join("; "),
				isOutage: failed.every((f) => f.isOutage),
			}
		: null;
}

/**
 * @param {string} root
 * @param {RefusedCall} call
 * @returns {string|null}
 */
const readReplayFailure = (root, call) =>
	readGuardRunFailure(root, call, false);

module.exports = { readProbeFailure, readReplayFailure };
