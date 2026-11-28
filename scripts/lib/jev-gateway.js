const { spawnSync } = require("node:child_process");
const { readSecretKeepingIgnore } = require("./env-file.js");

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

// guess: generous against a ~200 ms one-message scan, #204
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
 * @param {{key: string, message: string, questions: Record<string, unknown>,
 *   questionKey: string, abortMs: number}} spec
 * @returns {Promise<{probability: number, probabilities: Record<string, number>,
 *   served: Served}>}
 */
async function askJev({ key, message, questions, questionKey, abortMs }) {
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
		// `ai` retries 408, 429 and 500-599 with backoff to a ~40 s worst case.
		maxRetries: 0,
		abortSignal: AbortSignal.timeout(abortMs),
	});
	const served = servedBy(result);
	/** @type {Record<string, number>} */
	const probabilities = {};
	for (const k of Object.keys(questions)) {
		const p = result?.answers?.[k]?.probability;
		if (typeof p !== "number" || !Number.isFinite(p))
			throw new MalformedReply(
				`no ${k} probability in the gateway's answer`,
				served,
			);
		probabilities[k] = p;
	}
	const probability = probabilities[questionKey];
	if (probability === undefined)
		throw new MalformedReply("no probability in the gateway's answer", served);
	return { probability, probabilities, served };
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

module.exports = {
	KEY_VAR,
	MalformedReply,
	budgetFromEnv,
	readKey,
	sdkMissing,
	sweepRefusal,
	askJev,
	isMalformedReply,
	isRefusedKey,
};
