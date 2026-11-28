#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const hookBlock = require("./lib/hook-block");
const { scriptPath } = require("./lib/script-path.js");
const stopGuard = require("./lib/stop-guard");
const sessionTranscript = require("./lib/session-transcript.js");
const { envelope } = require("./lib/hook-envelope.js");
const jevLog = require("./lib/jev-log.js");
const { guardDisabled } = require("./lib/workflow-core-config");
const { hasRoundMarker } = require("./lib/round-marker");
const gateway = require("./lib/jev-gateway.js");
const { ignoreFailure, orFallback } = require("./lib/caught.js");
const { noop } = require("./lib/noop.js");
const { parseJsonl } = require("./lib/jsonl.js");

const CHECK_NAME = "jev-advisory";

const ENV_SWITCH = "WFC_JEV_ADVISORY";
const OFF_VALUES = new Set(["0", "false", "off"]);

const WARN_PREFIX = ".jev-advisory-nagged-";

// guess: above the longest flag on record, #285
const TEXT_CAP = 4000;

const WARN_BUDGET = hookBlock.MAX_BLOCKS;

// guess, #200
const OUTAGE_BUDGET = 1;

// guess, #226
const MALFORMED_BUDGET = 1;

// guess, #4144
const REFUSED_BUDGET = 1;

// #174 measured p95 1.6 s, under the 15 s hook timeout
const ABORT_MS = 3000;

/** @returns {number} */
function abortBudget() {
	return gateway.budgetFromEnv("WFC_JEV_ABORT_MS", ABORT_MS);
}

// #255 measured hang rate 6.9%, 4 of 58 calls
const ABORT_RETRIES = 1;

const QUESTION_KEY = "puts_choice";
const LEAVES_KEY = "leaves_problem";
// #200, #5833
const QUESTIONS = {
	[QUESTION_KEY]: {
		type: "boolean",
		instructions:
			"This is a message an assistant is sending to the project founder. Does it put a choice to the founder — two or more alternative courses of action offered for the founder to pick between?",
		criteria: {
			true: "the message offers two or more alternatives and asks or expects the founder to choose one",
			false:
				"the message reports, records a decision already taken, lists findings, or asks a question with no alternatives offered",
		},
	},
	[LEAVES_KEY]: {
		type: "boolean",
		instructions:
			"This is the last message an assistant sent at the end of its turn. Does it name a concrete defect (something broken or wrong in code, docs, tests, CI, config or a ticket, which the message itself treats as real) and leave it open: it says neither that the defect was fixed or reverted, nor that it sits on a numbered issue (filed as #N, commented on #N, put to the founder on #N, or owned by #N)?",
		criteria: {
			true: "at least one defect the message accepts as real is left with no fix and no issue number tied to it",
			false:
				"no defect is named; or each defect named is fixed, reverted, or tied to an issue number; or what is named is not a defect the message accepts: a constraint, a design choice or question put to the founder, or a review finding declined as wrong",
		},
	},
};

// guess, #5833: the lowest threshold its plan judges at
const KEEP_LEAVES_TEXT_AT = 0.5;

// #5833 measured 3 false of 60 judged fires at 0.8
const FIX_THRESHOLD = 0.8;

const FIX_PREFIX = ".fix-or-file-nagged-";

const PENDING_PREFIX = ".fix-or-file-pending-nagged-";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

const ACT_COMMAND =
	/\b(?:file-issue\.js|resolve-ticket\.js|gh\s+issue\s+(?:create|comment|edit|close|reopen)|gh\s+api\b[^\n]*\/comments|git\s+commit)\b/;

const FIX_BUDGET = hookBlock.MAX_BLOCKS;

// guess, #175
const LOG_CAP_BYTES = 2_097_152;

/**
 * @typedef {"skipped-marker"|"skipped-disabled"|"skipped-budget"|
 *   "skipped-no-sdk"|"skipped-redaction"|
 *   "flagged"|"clear"|"outage"|"malformed"|"refused"|
 *   "fix-or-file-followup"} Outcome
 */
const OUTCOMES = [
	"skipped-marker",
	"skipped-disabled",
	"skipped-budget",
	"skipped-no-sdk",
	"skipped-redaction",
	"flagged",
	"clear",
	"outage",
	"malformed",
	"refused",
	"fix-or-file-followup",
];

const VENDOR_OUTCOMES = new Set([
	"flagged",
	"clear",
	"outage",
	"malformed",
	"refused",
]);

/**
 * @param {string} message
 * @returns {string}
 */
function digest(message) {
	return crypto.createHash("sha256").update(message).digest("hex").slice(0, 12);
}

const QUESTION_HASH = digest(JSON.stringify(QUESTIONS));

/** @param {string} hash */
function advisory(hash) {
	return (
		"JEV ADVISORY — this turn looks like it put a choice to you in plain prose " +
		"rather than a lettered ❓ **Qn** round, so it carries no options and no " +
		"prices. Nothing was refused, and the session was not told: ask it for the " +
		"lettered priced form if you want one.\n" +
		`  Right or wrong? node ${scriptPath("jev-verdict.js")} ${hash} right|wrong ["why"]\n` +
		"  Judging now is easiest, the turn being on screen; the text is kept, so " +
		`node ${scriptPath("status-report.js")} will quote it back with the same command.`
	);
}

const FIX_OR_FILE_NOTICE =
	"FIX OR FILE (rule:fix-or-file) — this reply looks like it names a problem " +
	"it neither fixed nor recorded on an issue. Fix or file every problem you " +
	"find, whether or not your task owns it: before the turn ends, fix it, " +
	"comment on the open issue that owns it, or file it with " +
	`node ${scriptPath("file-issue.js")} --origin found-in-passing. A problem ` +
	"named only in a reply is lost, and so is one left to a ticket that has " +
	"since closed. Where every problem the reply names is already fixed or on " +
	"an open issue, say which and end the turn: a model raised this, and it " +
	"can be wrong.";

const OUTAGE_NOTICE =
	"JEV ADVISORY — the plain-prose choice check could not reach its vendor this " +
	"session, so silence from it is not a clean bill of health. Said once; " +
	"nothing is refused, and the turn stands.";

const MALFORMED_NOTICE =
	"JEV ADVISORY — the plain-prose choice check's vendor answered this session " +
	"in a shape it cannot read, so the check is not running and its silence is " +
	"not a clean bill of health. This is a repo fix, not an outage, and it does " +
	"not count toward the adoption's reversal (#175). Said once; nothing is refused.";

const REFUSED_NOTICE =
	"JEV ADVISORY — the plain-prose choice check's vendor refused its key this " +
	"session (401 or 403), so the check is not running and its silence is not a " +
	"clean bill of health. Store a working key with " +
	`node ${scriptPath("write-secret.js")} ${gateway.KEY_VAR}. Not an outage, and it does not ` +
	"count toward the adoption's reversal (#175). Said once; nothing is blocked, " +
	"and the turn stands.";

/**
 * @param {string} root
 * @returns {boolean}
 */
function switchedOff(root) {
	const declared = process.env[ENV_SWITCH];
	if (declared !== undefined && OFF_VALUES.has(declared.trim().toLowerCase()))
		return true;
	return guardDisabled(CHECK_NAME, { root });
}

/**
 * @typedef {{outcome: null, key: string, askChoice: boolean,
 *   askLeaves: boolean, held: Outcome|null}} Cleared
 */

/**
 * @param {{message: string, sessionId: string, root: string, active: boolean}} ctx
 * @returns {{outcome: Outcome, why?: string} | Cleared}
 */
function preflight({ message, sessionId, root, active }) {
	if (switchedOff(root)) return { outcome: "skipped-disabled" };
	/** @type {Outcome|null} */
	let held = null;
	if (hasRoundMarker(message)) held = "skipped-marker";
	else if (
		hookBlock.capSpent({ prefix: WARN_PREFIX, sessionId, max: WARN_BUDGET })
	)
		held = "skipped-budget";
	const askLeaves =
		!active &&
		!hookBlock.capSpent({ prefix: FIX_PREFIX, sessionId, max: FIX_BUDGET });
	if (held && !askLeaves) return { outcome: held };
	if (gateway.sdkMissing()) return { outcome: "skipped-no-sdk", why: "sdk" };
	const key = gateway.readKey();
	if (!key) return { outcome: "skipped-no-sdk", why: "key" };
	const refusal = gateway.sweepRefusal({ message });
	if (refusal) return { outcome: "skipped-redaction", why: refusal };
	return { outcome: null, key, askChoice: held === null, askLeaves, held };
}

/** @typedef {import("./lib/jev-gateway.js").Served} Served */

/**
 * @typedef {{outcome: Outcome, why?: string, confidence?: number,
 *   fixOrFileConfidence?: number, fixOrFileTold?: boolean, called?: boolean,
 *   latencyMs?: number, retries?: number, served?: Served,
 *   followUp?: FollowUp}} LineFields
 */

/**
 * @param {Record<string, unknown>} fields
 * @returns {Record<string, unknown>}
 */
const defined = (fields) =>
	Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));

/**
 * @param {LineFields} fields
 * @returns {boolean}
 */
const keepsText = ({ outcome, fixOrFileConfidence = 0 }) =>
	outcome === "flagged" || fixOrFileConfidence >= KEEP_LEAVES_TEXT_AT;

/**
 * @param {{sessionId: string, message: string} & LineFields} spec
 * @returns {Record<string, unknown>}
 */
function lineFor({ sessionId, message, served, followUp, ...fields }) {
	return defined({
		at: new Date().toISOString(),
		session: sessionId,
		outcome: fields.outcome,
		why: fields.why || undefined,
		confidence: fields.confidence,
		fixOrFileConfidence: fields.fixOrFileConfidence,
		fixOrFileTold: fields.fixOrFileTold || undefined,
		latencyMs: fields.latencyMs,
		retries: fields.retries || undefined,
		...served,
		...followUp,
		questionHash:
			fields.called || VENDOR_OUTCOMES.has(fields.outcome)
				? QUESTION_HASH
				: undefined,
		messageLen: message.length,
		messageHash: digest(message),
		messageText: keepsText(fields) ? message.slice(0, TEXT_CAP) : undefined,
	});
}

/**
 * @param {{root: string, sessionId: string, message: string} & LineFields} spec
 * @returns {void}
 */
function logGate({ root, ...spec }) {
	if (!OUTCOMES.includes(spec.outcome)) return;
	const file = jevLog.logPath(root);
	ignoreFailure(() => {
		const size = orFallback(() => fs.statSync(file).size, 0);
		if (size >= LOG_CAP_BYTES)
			fs.renameSync(file, jevLog.previousLogPath(root));
		fs.appendFileSync(file, `${JSON.stringify(lineFor(spec))}\n`);
	});
}

/** @param {string} text */
function say(text) {
	deliver({ systemMessage: text });
}

/**
 * @typedef {{log: (rest: LineFields) => void, sessionId: string,
 *   latencyMs: number, retries: number}} FailCtx
 */

/**
 * @param {unknown} e
 * @param {FailCtx} ctx
 */
function failMalformed(e, { log, sessionId, latencyMs, retries }) {
	log({
		outcome: "malformed",
		latencyMs,
		retries,
		served: e instanceof gateway.MalformedReply ? e.served : undefined,
	});
	if (
		hookBlock.charge({
			prefix: ".jev-advisory-malformed-",
			sessionId,
			max: MALFORMED_BUDGET,
		})
	)
		say(MALFORMED_NOTICE);
}

/** @param {FailCtx} ctx */
function failRefused({ log, sessionId, latencyMs, retries }) {
	log({ outcome: "refused", latencyMs, retries });
	if (
		hookBlock.charge({
			prefix: ".jev-advisory-refused-",
			sessionId,
			max: REFUSED_BUDGET,
		})
	)
		say(REFUSED_NOTICE);
}

/** @param {FailCtx} ctx */
function failOutage({ log, sessionId, latencyMs, retries }) {
	log({ outcome: "outage", latencyMs, retries });
	if (
		hookBlock.charge({
			prefix: ".jev-advisory-outage-",
			sessionId,
			max: OUTAGE_BUDGET,
		})
	)
		say(OUTAGE_NOTICE);
}

/**
 * @param {{key: string, message: string, abortMs: number, sessionId: string,
 *   log: (rest: LineFields) => void, started: number}} ctx
 * @returns {Promise<{probabilities: Record<string, number>, served: Served,
 *   retries: number}|null>}
 */
async function askWithRetries({
	key,
	message,
	abortMs,
	sessionId,
	log,
	started,
}) {
	let retries = 0;
	for (;;) {
		const attemptAt = Date.now();
		try {
			const { probabilities, served } = await gateway.askJev({
				key,
				message,
				questions: QUESTIONS,
				questionKey: QUESTION_KEY,
				abortMs,
			});
			return { probabilities, served, retries };
		} catch (e) {
			const latencyMs = Date.now() - started;
			if (gateway.isMalformedReply(e)) {
				failMalformed(e, { log, sessionId, latencyMs, retries });
				return null;
			}
			if (gateway.isRefusedKey(e)) {
				failRefused({ log, sessionId, latencyMs, retries });
				return null;
			}
			// `@ai-sdk/gateway` synthesises a 500 for a refused connection and for an abort alike.
			if (retries < ABORT_RETRIES && Date.now() - attemptAt >= abortMs) {
				retries++;
				continue;
			}
			failOutage({ log, sessionId, latencyMs, retries });
			return null;
		}
	}
}

/** @typedef {import("./lib/stop-guard").StopPayload} StopPayload */

/** @typedef {{firedHash: string, tools: string[], acted: boolean}} FollowUp */

/** @param {string} sessionId */
const pendingPath = (sessionId) =>
	hookBlock.counterPath(PENDING_PREFIX, sessionId);

/**
 * @param {Record<string, any>} row
 * @param {number} since
 * @returns {{name: string, input?: {command?: unknown}}[]}
 */
function callsIn(row, since) {
	if (row.type !== "assistant" || row.isSidechain) return [];
	if (!(Date.parse(row.timestamp ?? "") > since)) return [];
	const content = row.message?.content;
	if (!Array.isArray(content)) return [];
	return content.filter(
		(part) => part?.type === "tool_use" && typeof part.name === "string",
	);
}

/**
 * @param {string} text
 * @param {number} since
 * @returns {{tools: string[], acted: boolean}}
 */
function callsSince(text, since) {
	const calls = parseJsonl(text).rows.flatMap((row) => callsIn(row, since));
	return {
		tools: calls.map((c) => c.name),
		acted: calls.some(
			(c) =>
				EDIT_TOOLS.has(c.name) ||
				ACT_COMMAND.test(String(c.input?.command ?? "")),
		),
	};
}

/**
 * @param {{sessionId: string, payload: StopPayload|null}} ctx
 * @returns {FollowUp|null}
 */
function readFollowUp({ sessionId, payload }) {
	const file = pendingPath(sessionId);
	const pending = orFallback(
		() => JSON.parse(fs.readFileSync(file, "utf8")),
		null,
	);
	if (!pending) return null;
	ignoreFailure(() => fs.unlinkSync(file));
	const since = Date.parse(pending.at);
	const transcript = orFallback(() => {
		const found = sessionTranscript.resolve(payload ?? {}, sessionId);
		return found ? sessionTranscript.read(found) : "";
	}, "");
	return {
		firedHash: String(pending.hash),
		...callsSince(transcript, Number.isFinite(since) ? since : 0),
	};
}

/** @param {{sessionId: string, message: string}} ctx */
function markPending({ sessionId, message }) {
	ignoreFailure(() =>
		fs.writeFileSync(
			pendingPath(sessionId),
			JSON.stringify({ at: new Date().toISOString(), hash: digest(message) }),
		),
	);
}

/**
 * @param {{sessionId: string, message: string, root: string,
 *   payload: StopPayload|null}} ctx
 * @returns {Promise<void>}
 */
async function review({ sessionId, message, root, payload }) {
	const log = (/** @type {LineFields} */ rest) =>
		logGate({ root, sessionId, message, ...rest });

	const active = payload?.stop_hook_active === true;
	if (active) {
		const followUp = readFollowUp({ sessionId, payload });
		if (followUp) log({ outcome: "fix-or-file-followup", followUp });
	}

	const cleared = preflight({ message, sessionId, root, active });
	if (cleared.outcome !== null)
		return log({ outcome: cleared.outcome, why: cleared.why });
	const { key } = cleared;

	const abortMs = abortBudget();
	const started = Date.now();
	const answer = await askWithRetries({
		key,
		message,
		abortMs,
		sessionId,
		log,
		started,
	});
	if (!answer) return;
	settle({ ...answer, ...cleared, sessionId, message, log, started });
}

/**
 * @param {Cleared & {probabilities: Record<string, number>, served: Served,
 *   retries: number, sessionId: string, message: string,
 *   log: (rest: LineFields) => void, started: number}} spec
 */
function settle({
	probabilities,
	served,
	retries,
	askChoice,
	askLeaves,
	held,
	sessionId,
	message,
	log,
	started,
}) {
	const probability = probabilities[QUESTION_KEY] ?? 0;
	const leaves = probabilities[LEAVES_KEY] ?? 0;
	const latencyMs = Date.now() - started;
	// #171
	const flagged = askChoice && probability >= 0.5;
	const told =
		askLeaves &&
		leaves >= FIX_THRESHOLD &&
		hookBlock.charge({ prefix: FIX_PREFIX, sessionId, max: FIX_BUDGET });
	log({
		outcome: held ?? (flagged ? "flagged" : "clear"),
		confidence: askChoice ? Number(probability.toFixed(2)) : undefined,
		fixOrFileConfidence: askLeaves ? Number(leaves.toFixed(2)) : undefined,
		fixOrFileTold: told,
		called: true,
		latencyMs,
		retries,
		served,
	});
	const warned =
		flagged &&
		hookBlock.charge({ prefix: WARN_PREFIX, sessionId, max: WARN_BUDGET });
	if (told) markPending({ sessionId, message });
	deliver({
		systemMessage: warned ? advisory(digest(message)) : undefined,
		additionalContext: told ? FIX_OR_FILE_NOTICE : undefined,
	});
}

/**
 * @param {{systemMessage?: string, additionalContext?: string}} spec
 */
function deliver({ systemMessage, additionalContext }) {
	if (!systemMessage && !additionalContext) return;
	process.stdout.write(
		JSON.stringify({
			...(systemMessage ? { systemMessage } : {}),
			...(additionalContext ? envelope("Stop", { additionalContext }) : {}),
		}),
	);
}

/** @returns {Promise<void>} */
async function main() {
	await stopGuard.onMessageAsync({ review });
}

module.exports = {
	main,
	LEAVES_QUESTION: QUESTIONS[LEAVES_KEY],
	LEAVES_KEY,
};

if (require.main === module) main().catch(noop);
