// ADR-0010

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
 * @param {string} [only]
 */
function runDispatch(only) {
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
		entryLog(`${caught(e).message} — the entry exits non-zero`);
		throw e;
	}
	if (!payload) return;
	const event = String(payload.hook_event_name ?? "");
	startEntryClock(event);
	const tool = toolOf(payload);
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
