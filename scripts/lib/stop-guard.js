const path = require("node:path");
const hookBlock = require("./hook-block");
const hookMessage = require("./hook-message");
const hookRecord = require("./hook-record");
const sessionId = require("./session-id");
const { guardDisabled } = require("./workflow-core-config");
const { ignoreFailure } = require("./caught.js");
const { noop } = require("./noop.js");

// guess: under the Stop guard's 15 s registered timeout, workflow-core#4535
const READ_BUDGET_MS = 10_000;

/**
 * @typedef {{session_id?: string, hook_event_name?: string,
 *   last_assistant_message?: string, transcript_path?: string,
 *   cwd?: unknown, stop_hook_active?: unknown}} StopPayload
 */

/** @returns {(outcome: string, payload?: StopPayload) => void} */
function noteFor() {
	const guard = hookRecord.guardName();
	return (outcome, payload) => {
		hookRecord.record({
			root: hookBlock.repoRoot(),
			guard,
			sessionId: payload?.session_id,
			outcome,
			payload,
		});
	};
}

/** @param {string} root */
function disabled(root) {
	const script = process.argv[1];
	return script ? guardDisabled(path.basename(script), { root }) : false;
}

/**
 * @param {{review: (ctx: {sessionId: string, message: string, root: string,
 *   payload: StopPayload|null}) => void}} spec
 * @returns {void}
 */
function onMessage({ review }) {
	ignoreFailure(() => {
		const ctx = readMessageContext();
		if (ctx) review(ctx);
	});
}

/**
 * @returns {{sessionId: string, message: string, root: string,
 *   payload: StopPayload|null}|null}
 */
function readMessageContext() {
	const root = hookBlock.repoRoot();
	if (disabled(root)) return null;
	const payload = hookMessage.readPayload();
	const found = hookMessage.readMessageFrom(payload, { root });
	if (!found) return null;
	return {
		sessionId: found.sessionId,
		message: found.message,
		root,
		payload,
	};
}

/**
 * @param {{review: (ctx: {sessionId: string, message: string, root: string,
 *   payload: StopPayload|null}) => Promise<void>}} spec
 * @returns {Promise<void>}
 */
async function onMessageAsync({ review }) {
	await (async () => {
		const ctx = readMessageContext();
		if (ctx) await review(ctx);
	})().catch(noop);
}

/**
 * @param {{record?: boolean,
 *   review: (ctx: {sessionId: string, payload: StopPayload, root: string,
 *     note: (outcome: string, payload?: StopPayload) => void}) => void}} spec
 * @returns {void}
 */
function onPayload({ review, record = false }) {
	ignoreFailure(() => {
		const root = hookBlock.repoRoot();
		if (disabled(root)) return;
		const note = record ? noteFor() : noop;
		const payload = hookMessage.readPayload();
		if (!payload) return note("no-payload", undefined);
		const sid = sessionId.fromPayload(payload);
		if (!sid) return note("no-session-id", payload);
		review({ sessionId: sid, payload, root, note });
	});
}

module.exports = { onMessage, onMessageAsync, onPayload, READ_BUDGET_MS };
