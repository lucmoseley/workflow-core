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

// measured 0.05 s healthy run, guess at 200x headroom, #4226
const GUARD_PROBE_TIMEOUT_MS = 10_000;

// guess, #4226
const GUARD_PROBE_RETRY_MS = 2000;

function guardProbeRetryMs() {
	const ms = Number(
		process.env.WFC_GUARD_PROBE_RETRY_MS || GUARD_PROBE_RETRY_MS,
	);
	return Number.isNaN(ms) || ms < 0 ? GUARD_PROBE_RETRY_MS : ms;
}

const GUARD_PROBE_SESSION = "refill-loop-guard-probe";

const GUARD_ENTRY = "guard-dispatch.js";

/**
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
 * @param {string} root
 * @param {RefusedCall} call
 * @param {boolean} isAnyDeny
 * @returns {string|null}
 */
function readGuardRunFailure(root, call, isAnyDeny) {
	const hookLine = readGuardHookLine(root, String(call.tool_name));
	if ("why" in hookLine) return hookLine.why;
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
 * @param {string} stdout
 * @returns {{permissionDecision?: unknown, permissionDecisionReason?: unknown}|null}
 */
function readHookOutput(stdout) {
	try {
		return JSON.parse(stdout)?.hookSpecificOutput ?? null;
	} catch {
		return null;
	}
}

/**
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
