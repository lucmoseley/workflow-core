#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const hookBlock = require("./lib/hook-block");
const { scriptPath } = require("./lib/script-path.js");
const stopGuard = require("./lib/stop-guard");
const jevLog = require("./lib/jev-log.js");
const { guardDisabled } = require("./lib/workflow-core-config");
const { hasRoundMarker } = require("./lib/round-marker");
const gateway = require("./lib/jev-gateway.js");
const { ignoreFailure, orFallback } = require("./lib/caught.js");
const { noop } = require("./lib/noop.js");

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
// #200
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
};

// guess, #175
const LOG_CAP_BYTES = 2_097_152;

/**
 * @typedef {"skipped-marker"|"skipped-disabled"|"skipped-budget"|
 *   "skipped-no-sdk"|"skipped-redaction"|
 *   "flagged"|"clear"|"outage"|"malformed"|"refused"} Outcome
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
];

const VENDOR_OUTCOMES = new Set(
	OUTCOMES.filter((o) => !o.startsWith("skipped-")),
);

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
 * @param {{message: string, sessionId: string, root: string}} ctx
 * @returns {{outcome: Outcome|null, why?: string, key?: string}}
 */
function preflight({ message, sessionId, root }) {
	if (hasRoundMarker(message)) return { outcome: "skipped-marker" };
	if (switchedOff(root)) return { outcome: "skipped-disabled" };
	if (hookBlock.capSpent({ prefix: WARN_PREFIX, sessionId, max: WARN_BUDGET }))
		return { outcome: "skipped-budget" };
	if (gateway.sdkMissing()) return { outcome: "skipped-no-sdk", why: "sdk" };
	const key = gateway.readKey();
	if (!key) return { outcome: "skipped-no-sdk", why: "key" };
	const refusal = gateway.sweepRefusal({ message });
	if (refusal) return { outcome: "skipped-redaction", why: refusal };
	return { outcome: null, key };
}

/**
 * @typedef {{outcome: Outcome, why?: string, confidence?: number,
 *   latencyMs?: number, retries?: number,
 *   served?: import("./lib/jev-gateway.js").Served}} LineFields
 */

/**
 * @param {{root: string, sessionId: string, message: string} & LineFields} spec
 * @returns {void}
 */
function logGate({
	root,
	sessionId,
	outcome,
	why,
	message,
	confidence,
	latencyMs,
	retries,
	served,
}) {
	if (!OUTCOMES.includes(outcome)) return;
	const file = jevLog.logPath(root);
	ignoreFailure(() => {
		const size = orFallback(() => fs.statSync(file).size, 0);
		if (size >= LOG_CAP_BYTES)
			fs.renameSync(file, jevLog.previousLogPath(root));
		const line = {
			at: new Date().toISOString(),
			session: sessionId,
			outcome,
			...(why ? { why } : {}),
			...(confidence === undefined ? {} : { confidence }),
			...(latencyMs === undefined ? {} : { latencyMs }),
			...(retries ? { retries } : {}),
			...served,
			...(VENDOR_OUTCOMES.has(outcome) ? { questionHash: QUESTION_HASH } : {}),
			messageLen: message.length,
			messageHash: digest(message),
			...(outcome === "flagged"
				? { messageText: message.slice(0, TEXT_CAP) }
				: {}),
		};
		fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
	});
}

/** @param {string} text */
function say(text) {
	process.stdout.write(JSON.stringify({ systemMessage: text }));
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
 * @returns {Promise<{probability: number,
 *   served: import("./lib/jev-gateway.js").Served, retries: number}|null>}
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
			const { probability, served } = await gateway.askJev({
				key,
				message,
				questions: QUESTIONS,
				questionKey: QUESTION_KEY,
				abortMs,
			});
			return { probability, served, retries };
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

/**
 * @param {{sessionId: string, message: string, root: string}} ctx
 * @returns {Promise<void>}
 */
async function review({ sessionId, message, root }) {
	const log = (/** @type {LineFields} */ rest) =>
		logGate({ root, sessionId, message, ...rest });

	const { outcome, why, key } = preflight({ message, sessionId, root });
	if (outcome !== null || !key)
		return log({ outcome: outcome ?? "skipped-no-sdk", why });

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
	const { probability, served, retries } = answer;

	const latencyMs = Date.now() - started;
	// #171
	const flagged = probability >= 0.5;
	log({
		outcome: flagged ? "flagged" : "clear",
		confidence: Number(probability.toFixed(2)),
		latencyMs,
		retries,
		served,
	});
	if (
		flagged &&
		hookBlock.charge({ prefix: WARN_PREFIX, sessionId, max: WARN_BUDGET })
	)
		say(advisory(digest(message)));
}

/** @returns {Promise<void>} */
async function main() {
	await stopGuard.onMessageAsync({ review });
}

module.exports = { main };

if (require.main === module) main().catch(noop);
