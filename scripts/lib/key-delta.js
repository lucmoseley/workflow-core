/*
 * key-delta.js — spec workflow-core#1510's delta gate, the one place it is applied
 * (mantahostels#2483: a key set, never a count), and the outcome tests the
 * daily repo-checks run and its hand-run reader both read a job by (workflow-core#1725).
 *
 * A STAMP IS ONE OF TWO SPELLINGS: the delivered keys as a sorted JSON array,
 * or `unexamined:<tag>` for a BROKEN or MISSING job, never equal to the last,
 * so that job is said at every reading until it clears. The second carries the
 * keys delivered before it, `unexamined:<tag>:[…]`, so a check that recovers
 * says only what it gained, never its whole backlog again (workflow-core#1553 review).
 */

const { readStamp } = require("./delivery-stamp");

const UNEXAMINED_STAMP = "unexamined:";
const COMPLETED = new Set(["OK", "WARN", "FAIL"]);

/**
 * Ran to a verdict, whatever it found.
 * @param {unknown} outcome
 */
const isCompleted = (outcome) => COMPLETED.has(String(outcome));

/**
 * Was meant to run and drew no conclusion: BROKEN, or MISSING — no envelope,
 * cut off by the run's ceiling, or absent from the reading.
 * @param {unknown} outcome
 */
const isUnexamined = (outcome) => outcome === "BROKEN" || outcome === "MISSING";

/**
 * Not gated off: a SKIP examined nothing and was meant to.
 * @param {unknown} outcome
 */
const isJudged = (outcome) => outcome !== "SKIP";

/**
 * A job's finding keys, strings only, deduplicated and sorted.
 * @param {{ keys?: unknown } | null | undefined} job
 * @returns {string[]}
 */
const keysOf = (job) =>
	Array.isArray(job?.keys)
		? [...new Set(job.keys.filter((k) => typeof k === "string"))].sort()
		: [];

/** @param {string[]} keys as keysOf returns them */
const keySignature = (keys) => JSON.stringify(keys);

/**
 * @param {string | number} tag what makes this reading's stamp its own; no `[`
 * @param {Set<string> | null} delivered
 */
const unexaminedSignature = (tag, delivered) =>
	`${UNEXAMINED_STAMP}${tag}${delivered ? `:${keySignature([...delivered].sort())}` : ""}`;

/**
 * The keys last delivered under `stamp`, through any unexamined deliveries
 * since, or null where every key reads as new: none delivered, or a stamp
 * that will not parse, which `onCorrupt` hears of.
 *
 * @param {string} stamp
 * @param {(stamp: string) => void} [onCorrupt]
 * @returns {Set<string> | null}
 */
function readDeliveredKeys(stamp, onCorrupt) {
	const raw = readStamp(stamp);
	if (raw === null) return null;
	const held = raw.startsWith(UNEXAMINED_STAMP) ? raw.indexOf("[") : 0;
	if (held === -1) return null;
	try {
		const keys = JSON.parse(raw.slice(held));
		if (Array.isArray(keys)) return new Set(keys);
	} catch {
		/* Unparseable and a non-array are one fault: the call below. */
	}
	onCorrupt?.(stamp);
	return null;
}

/**
 * The gate for one judged job: the stamp this reading delivers, and the keys
 * gained since `delivered` — every one where none were, and null where the
 * job is unexamined. Items only removed are no gain.
 *
 * @param {{ outcome?: unknown, keys?: unknown }} job
 * @param {{ countedKeys: string[], delivered: Set<string> | null,
 *   tag: string | number }} by `countedKeys` is the keys a gain is counted
 *   in; the stamp holds every key regardless
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
