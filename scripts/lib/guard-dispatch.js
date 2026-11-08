/*
 * guard-dispatch.js — the dispatcher kit's entry: every always-on guard of
 * one hook event runs as a core inside one Node entry,
 * scripts/guard-dispatch.js (#2786, ADR-0010). The guard dispatcher, not
 * subagent dispatch (lib/dispatch-*.js). A plain call starts one Node process
 * for them, and every deny and every context the cap holds still reaches the
 * session as separate hooks would deliver them. lib/guard-judge.js judges the
 * call and merges what the cores answer.
 *
 * THE CORES are lib/guard-cores.json's, per event, in order: each row names
 * the core (its `name` is what `disabled` lists and the error log names), the
 * module under scripts/lib that holds its `field`, `noun`, `decide` and any
 * `top` (the shape lib/guard-entry.js's `run` takes), the tools it judges as a matcher
 * regex, its failure policy, the module that gates it, if any, the module
 * whose `buildHostPorts(root, log)` builds the ports of its own, if any, built only
 * where the core runs, and any `if` clauses narrowing the Bash commands it
 * judges, so a call none admits never loads its module (#3224).
 *
 * Anything lib/guard-judge.js's failure policy does not catch, stdin that
 * will not read included (#4132), crashes the entry, and the registration's
 * `"onFailure": "block"` refuses the call; on PostToolUse, which carries
 * none, the crash shows as a hook error and the call stands.
 */

const { caught } = require("./caught.js");
const { HOOK_GIT_TIMEOUT_MS } = require("./git.js");
const { withGitReadMemo } = require("./git-read-memo.js");
const { startEntryClock } = require("./hook-deadline.js");
const { guardDisabled } = require("./workflow-core-config.js");
const { emit, guardFile, writeLatches } = require("./guard-entry.js");
const { logger, readPayload } = require("./entry-input.js");
const { hostRoot } = require("./host-root.js");
const {
	isAdmitted,
	isCoreFor,
	readDispatchRows,
	toolOf,
} = require("./guard-cores.js");
const { loadCores } = require("./guard-core-load.js");
const { hostAdapters } = require("./guard-host-ports.js");
const { dispatch } = require("./guard-judge.js");

/**
 * The hook entry. `only` runs that core alone, for a hook that hands one
 * core a payload of its own making (inject-tracker-docs.sh's typed
 * /code-review, #1697); a name no core of the event carries runs none, logged.
 * @param {string} [only]
 */
function runDispatch(only) {
	/* Around the whole entry, so the root read shares the cores' memo. */
	withGitReadMemo(() => runEntry(only));
}

/** @param {string} [only] */
function runEntry(only) {
	const root = hostRoot(process.cwd(), { timeoutMs: HOOK_GIT_TIMEOUT_MS });
	if (guardDisabled(guardFile(), { root })) return;
	const entryLog = logger(guardFile(), root);
	let payload;
	try {
		payload = readPayload("call", entryLog);
	} catch (e) {
		/* No core can judge without a payload: the FAILURE POLICY's crash
		 * (#4132). */
		entryLog(`${caught(e).message} — the entry exits non-zero`);
		throw e;
	}
	if (!payload) return;
	const event = String(payload.hook_event_name ?? "");
	startEntryClock(event);
	const tool = toolOf(payload);
	/* dispatch judges each core again; this filter only spares the load. */
	const cores = loadCores(event, {
		keep: (row) =>
			isCoreFor(row, tool) &&
			isAdmitted(row, payload) &&
			(only === undefined || row.name === only),
	});
	if (
		only !== undefined &&
		cores.length === 0 &&
		!readDispatchRows(event).some((r) => r.name === only)
	)
		entryLog(`--only names no ${event} core: ${only} — nothing run`);
	const { output, latches } = dispatch(cores, {
		payload,
		root,
		adapters: hostAdapters(root, entryLog),
		logFor: (name) => logger(name, root),
		disabled: (name) => guardDisabled(name, { root }),
		persistChars: () => require("./rule-emission.js").readHookPersistChars(),
	});
	if (output)
		emit(/** @type {import("./guard-entry.js").HookEvent} */ (event), output);
	for (const { latches: l, log } of latches)
		writeLatches({ root, payload, log }, l);
}

module.exports = { runDispatch };
