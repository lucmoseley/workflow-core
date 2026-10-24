/*
 * stop-guard.js — the shape of a Stop guard, in one place (mantahostels#1798).
 *
 * Four `Stop` hooks in `scripts/` share a prologue and an epilogue: read the
 * payload off stdin, find the session id, fail open on anything unexpected, and
 * never `process.exit`. All of it is here, so a guard's own file holds its
 * judgement and nothing else.
 *
 * THREE ENTRY POINTS, BECAUSE THERE ARE THREE FAMILIES. `onMessage` serves a
 * guard that judges the outgoing text of the turn it is stopping; `onPayload`
 * serves one that judges the session's state and never reads the message at
 * all; `onMessageAsync` serves the first family where the judgement is `await`ed
 * — today only `guard-jev-advisory.js`, whose verdict is a network call (#204).
 *
 * WHAT THIS DELIBERATELY DOES NOT OWN: the `blockStop` call. A counter prefix
 * has to stay a string literal at the call site — `lib/hook-block.test.ts` reads
 * every prefix off those call sites, and `lib/arbiter-markers.js`'s sweep needs
 * the same list statically, so a prefix reaching `blockStop` through here would
 * sweep nothing and leave a counter per session behind for ever.
 *
 * NO `process.exit(0)` ANYWHERE BELOW, and none in a caller either (§N6): node
 * buffers writes to a pipe and drops whatever is still buffered at
 * `process.exit`, and a block goes out through `process.stdout.write`. Letting
 * the call return drains it, and every registration in `self-plugin/hooks/hooks.json`
 * already ends `|| true`, so the exit code is moot.
 *
 * FAILING OPEN IS THE WHOLE CONTRACT (mantahostels#1731, on the house rule at mantahostels#103 §6):
 * breaking a session is worse than missing one. Both functions swallow
 * everything the guard throws. What they cannot cover is a `require` of this
 * file that itself throws — that predates the try, and the `|| true` in the
 * registration is what answers it.
 */

const path = require("node:path");
const hookBlock = require("./hook-block");
const hookMessage = require("./hook-message");
const hookRecord = require("./hook-record");
const sessionId = require("./session-id");
const { guardDisabled } = require("./workflow-core-config");

/**
 * @typedef {{session_id?: string, hook_event_name?: string,
 *   last_assistant_message?: string, transcript_path?: string,
 *   stop_hook_active?: unknown}} StopPayload
 */

/**
 * A breadcrumb writer bound to one guard — the record that separates "ran and
 * found nothing" from "never fired" (mantahostels#872). Best-effort and never throws.
 *
 * The guard's name is DERIVED from the script the harness ran, never passed, so
 * no guard can name itself wrongly or forget to (`lib/hook-record.js`).
 * @returns {(outcome: string, payload?: StopPayload) => void}
 */
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

/**
 * True where the host's `.claude/workflow-core.json` lists the running guard's
 * file under "disabled" (#2): the guard then stands down before reading stdin.
 * @param {string} root
 */
function disabled(root) {
	const script = process.argv[1];
	return script ? guardDisabled(path.basename(script), { root }) : false;
}

/**
 * Run a guard that judges the turn's outgoing text.
 *
 * `review` is called only where there is a message to judge; every other path
 * has already written its own breadcrumb inside `hook-message.js`.
 * The payload goes through untouched alongside the message: a guard whose
 * judgement needs the transcript resolves it off `transcript_path`, and only
 * this seam ever sees that field (mantahostels#2487).
 * @param {{review: (ctx: {sessionId: string, message: string, root: string,
 *   payload: StopPayload|null}) => void}} spec
 * @returns {void}
 */
function onMessage({ review }) {
	try {
		const ctx = messageContext();
		if (ctx) review(ctx);
	} catch {
		/* Fail open (mantahostels#1731). */
	}
}

/**
 * The prologue both message-family entry points share: the root, the master
 * switch, the payload and the message off it. Null where there is nothing to
 * judge — switched off, or no message in the payload — each of which
 * `hook-message.js` has already crumbed.
 * @returns {{sessionId: string, message: string, root: string,
 *   payload: StopPayload|null}|null}
 */
function messageContext() {
	const root = hookBlock.repoRoot();
	if (disabled(root)) return null;
	const payload = hookMessage.readPayload();
	const found = hookMessage.messageFrom(payload, { root });
	if (!found) return null;
	return {
		sessionId: found.sessionId,
		message: found.message,
		root,
		payload,
	};
}

/**
 * `onMessage` for a guard whose `review` is async.
 *
 * SEPARATE RATHER THAN A WIDENED `onMessage`, because the two cannot share a
 * `catch`: a rejection out of an async `review` escapes the synchronous try
 * above entirely, arriving as an unhandled rejection that would kill the hook
 * process — the opposite of failing open.
 *
 * ITS CALLER MUST HANDLE THE PROMISE. This returns one; a guard using it needs
 * the `module.exports = { main }; if (require.main === module) main().catch(…)`
 * shape, which is also what `lib/run-in-process.js`'s `runInProcessAsync`
 * requires to drive it in the suite.
 * @param {{review: (ctx: {sessionId: string, message: string, root: string,
 *   payload: StopPayload|null}) => Promise<void>}} spec
 * @returns {Promise<void>}
 */
async function onMessageAsync({ review }) {
	try {
		const ctx = messageContext();
		if (ctx) await review(ctx);
	} catch {
		/* Fail open (mantahostels#1731). */
	}
}

/**
 * Run a guard that judges session state rather than the turn's text.
 *
 * @param {{record?: boolean,
 *   review: (ctx: {sessionId: string, payload: StopPayload, root: string,
 *     note: (outcome: string, payload?: StopPayload) => void}) => void}} spec
 *   `record` opts in to a breadcrumb on the two failure paths this owns. It is
 *   opt-in rather than always-on because `check-stop-guard-outcomes.js` reads
 *   every breadcrumb as a rate over invocations, so a guard that
 *   crumbs its failures and not its verdicts would report as permanently blind.
 * @returns {void}
 */
function onPayload({ review, record = false }) {
	try {
		const root = hookBlock.repoRoot();
		if (disabled(root)) return;
		const note = record
			? noteFor()
			: () => {
					/* unrecorded unless the guard asks */
				};
		const payload = hookMessage.readPayload();
		if (!payload) return note("no-payload", undefined);
		const sid = sessionId.fromPayload(payload);
		if (!sid) return note("no-session-id", payload);
		review({ sessionId: sid, payload, root, note });
	} catch {
		/* Fail open (mantahostels#1731). */
	}
}

module.exports = { onMessage, onMessageAsync, onPayload };
