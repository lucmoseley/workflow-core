const { orFallback } = require("./caught.js");
const { readStamp } = require("./delivery-stamp");

const UNEXAMINED_STAMP = "unexamined:";
const COMPLETED = new Set(["OK", "WARN", "FAIL"]);

/** @param {unknown} outcome */
const isCompleted = (outcome) => COMPLETED.has(String(outcome));

/** @param {unknown} outcome */
const isUnexamined = (outcome) => outcome === "BROKEN" || outcome === "MISSING";

/** @param {unknown} outcome */
const isJudged = (outcome) => outcome !== "SKIP";

/**
 * @param {{ keys?: unknown } | null | undefined} job
 * @returns {string[]}
 */
const keysOf = (job) =>
	Array.isArray(job?.keys)
		? [...new Set(job.keys.filter((k) => typeof k === "string"))].sort()
		: [];

/** @param {string[]} keys */
const keySignature = (keys) => JSON.stringify(keys);

/**
 * @param {string | number} tag
 * @param {Set<string> | null} delivered
 */
const unexaminedSignature = (tag, delivered) =>
	`${UNEXAMINED_STAMP}${tag}${delivered ? `:${keySignature([...delivered].sort())}` : ""}`;

/**
 * @param {string} stamp
 * @param {(stamp: string) => void} [onCorrupt]
 * @returns {Set<string> | null}
 */
function readDeliveredKeys(stamp, onCorrupt) {
	const raw = readStamp(stamp);
	if (raw === null) return null;
	const held = raw.startsWith(UNEXAMINED_STAMP) ? raw.indexOf("[") : 0;
	if (held === -1) return null;
	const keys = orFallback(() => JSON.parse(raw.slice(held)), undefined);
	if (Array.isArray(keys)) return new Set(keys);
	onCorrupt?.(stamp);
	return null;
}

/**
 * @param {{ outcome?: unknown, keys?: unknown }} job
 * @param {{ countedKeys: string[], delivered: Set<string> | null,
 *   tag: string | number }} by
 * @returns {{ stamp: string, added: string[] | null }}
 */
function judgeKeys(job, { countedKeys, delivered, tag }) {
	if (isUnexamined(job.outcome))
		return { stamp: unexaminedSignature(tag, delivered), added: null };
	return {
		stamp: keySignature(keysOf(job)),
		added: delivered
			? countedKeys.filter((k) => !delivered.has(k))
			: countedKeys,
	};
}

module.exports = {
	isCompleted,
	isUnexamined,
	isJudged,
	keysOf,
	readDeliveredKeys,
	judgeKeys,
};
