#!/usr/bin/env node

const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const hookBlock = require("./lib/hook-block");
const { scriptPath } = require("./lib/script-path.js");
const stopGuard = require("./lib/stop-guard");
const jevLog = require("./lib/jev-log.js");
const { guardDisabled } = require("./lib/workflow-core-config");
const { hasRoundMarker } = require("./lib/round-marker");
const { readSecretKeepingIgnore } = require("./lib/env-file.js");
const { ignoreFailure, orFallback } = require("./lib/caught.js");
const { noop } = require("./lib/noop.js");

const CHECK_NAME = "jev-advisory";

const ENV_SWITCH = "WFC_JEV_ADVISORY";
const OFF_VALUES = new Set(["0", "false", "off"]);

const WARN_PREFIX = ".jev-advisory-nagged-";

const TEXT_CAP = 4000;

const WARN_BUDGET = hookBlock.MAX_BLOCKS;

const OUTAGE_BUDGET = 1;

const MALFORMED_BUDGET = 1;

const REFUSED_BUDGET = 1;

const REFUSED_STATUSES = new Set([401, 403]);

const MALFORMED_REPLY_NAME = "JevMalformedReply";

const UNREADABLE_NAMES = new Set([
	MALFORMED_REPLY_NAME,
	"AI_InvalidResponseDataError",
	"AI_TypeValidationError",
	"AI_JSONParseError",
]);

// #226 measured deepest cause chain 4, doubled
const CAUSE_DEPTH = 8;

class MalformedReply extends Error {
	/**
	 * @param {string} why
	 * @param {Served} served
	 */
	constructor(why, served) {
		super(why);
		this.name = MALFORMED_REPLY_NAME;
		this.served = served;
	}
}

/** @typedef {{model?: string, provider?: string}} Served */

/**
 * @param {any} result
 * @returns {Served}
 */
function servedBy(result) {
	// `@ai-sdk/gateway` sets `response.modelId` to the id it was asked for.
	const model = result?.response?.body?.model ?? result?.response?.modelId;
	const provider = result?.providerMetadata?.gateway?.routing?.finalProvider;
	return {
		...(typeof model === "string" ? { model } : {}),
		...(typeof provider === "string" ? { provider } : {}),
	};
}

const KEY_VAR = "AI_GATEWAY_API_KEY";

const BASE_URL_VAR = "WFC_JEV_BASE_URL";

const SDK_MODULE = "ai";
const GATEWAY_MODULE = "@ai-sdk/gateway";

/** @returns {string} */
const gitleaksBinary = () => process.env.WFC_GITLEAKS || "gitleaks";

const SWEEP_MS = 5000;

/**
 * @param {string} name
 * @param {number} ceiling
 * @returns {number}
 */
function budgetFromEnv(name, ceiling) {
	const raw = process.env[name]?.trim() ?? "";
	const ms = /^[1-9]\d*$/.test(raw) ? Number(raw) : ceiling;
	return Math.min(ms, ceiling);
}

/** @returns {number} */
const sweepBudget = () => budgetFromEnv("WFC_JEV_SWEEP_MS", SWEEP_MS);

// #702
const MODEL_ID = "typesafe-ai/jev";

// #174 measured p95 1.6 s, under the 15 s hook timeout
const ABORT_MS = 3000;

/** @returns {number} */
function abortBudget() {
	return budgetFromEnv("WFC_JEV_ABORT_MS", ABORT_MS);
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
	`node ${scriptPath("write-secret.js")} ${KEY_VAR}. Not an outage, and it does not ` +
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

/** @returns {string|null} */
function readKey() {
	const fromEnv = process.env[KEY_VAR]?.trim();
	if (fromEnv) return fromEnv;
	try {
		return readSecretKeepingIgnore(KEY_VAR);
	} catch {
		return null;
	}
}

/** @returns {boolean} */
function sdkMissing() {
	try {
		require.resolve(SDK_MODULE);
		require.resolve(GATEWAY_MODULE);
	} catch {
		return true;
	}
	return false;
}

/**
 * @param {string} input
 * @returns {ReturnType<typeof spawnSync>}
 */
function runSweep(input) {
	return spawnSync(
		gitleaksBinary(),
		["stdin", "--no-banner", "--log-level", "error"],
		{
			input,
			stdio: ["pipe", "ignore", "ignore"],
			timeout: sweepBudget(),
		},
	);
}

/**
 * @param {{message: string}} spec
 * @returns {"finding"|"unswept"|null}
 */
function sweepRefusal({ message }) {
	let res;
	try {
		res = runSweep(message);
	} catch {
		return "unswept";
	}
	if (res.error) return "unswept";
	if (res.status === 0) return null;
	let probe;
	try {
		probe = runSweep("");
	} catch {
		return "unswept";
	}
	return probe.error || probe.status !== 0 ? "unswept" : "finding";
}

/**
 * @param {{key: string, message: string, questions?: Record<string, unknown>,
 *   questionKey?: string, abortMs?: number}} spec
 * @returns {Promise<{probability: number, served: Served}>}
 */
async function askJev({
	key,
	message,
	questions = QUESTIONS,
	questionKey = QUESTION_KEY,
	abortMs = ABORT_MS,
}) {
	const { createGateway } = require(GATEWAY_MODULE);
	const { experimental_evaluate: evaluate } = require(SDK_MODULE);
	const baseURL = process.env[BASE_URL_VAR]?.trim();
	const gateway = createGateway({
		apiKey: key,
		...(baseURL ? { baseURL } : {}),
	});
	const result = await evaluate({
		model: gateway.evaluationModel(MODEL_ID),
		state: message,
		questions,
		// `ai` retries 408, 429 and 500-599 with backoff to a ~40 s worst case: https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/jev-commercial-terms.md §3
		maxRetries: 0,
		abortSignal: AbortSignal.timeout(abortMs),
	});
	const served = servedBy(result);
	const probability = result?.answers?.[questionKey]?.probability;
	if (typeof probability !== "number" || !Number.isFinite(probability))
		throw new MalformedReply("no probability in the gateway's answer", served);
	return { probability, served };
}

/**
 * @param {unknown} e
 * @returns {boolean}
 */
function isMalformedReply(e) {
	const top = /** @type {Record<string, unknown>} */ (e);
	if (!top) return false;
	const status = top.statusCode;
	if (typeof status === "number" && (status < 200 || status >= 300))
		return false;
	let link = top;
	for (let depth = 0; link && depth < CAUSE_DEPTH; depth++) {
		if (UNREADABLE_NAMES.has(String(link.name))) return true;
		link = /** @type {Record<string, unknown>} */ (link.cause);
	}
	return false;
}

/**
 * @param {unknown} e
 * @returns {boolean}
 */
function isRefusedKey(e) {
	const status = /** @type {Record<string, unknown>} */ (e)?.statusCode;
	return typeof status === "number" && REFUSED_STATUSES.has(status);
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
	if (sdkMissing()) return { outcome: "skipped-no-sdk", why: "sdk" };
	const key = readKey();
	if (!key) return { outcome: "skipped-no-sdk", why: "key" };
	const refusal = sweepRefusal({ message });
	if (refusal) return { outcome: "skipped-redaction", why: refusal };
	return { outcome: null, key };
}

/**
 * @typedef {{outcome: Outcome, why?: string, confidence?: number,
 *   latencyMs?: number, retries?: number, served?: Served}} LineFields
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
		served: e instanceof MalformedReply ? e.served : undefined,
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
 * @returns {Promise<{probability: number, served: Served, retries: number}|null>}
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
			const { probability, served } = await askJev({ key, message, abortMs });
			return { probability, served, retries };
		} catch (e) {
			const latencyMs = Date.now() - started;
			if (isMalformedReply(e)) {
				failMalformed(e, { log, sessionId, latencyMs, retries });
				return null;
			}
			if (isRefusedKey(e)) {
				failRefused({ log, sessionId, latencyMs, retries });
				return null;
			}
			// `ai` synthesises a 500 for a refused connection and for an abort alike.
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

module.exports = {
	main,
	gateway: {
		readKey,
		sdkMissing,
		sweepRefusal,
		askJev,
		isMalformedReply,
	},
};

if (require.main === module) main().catch(noop);
