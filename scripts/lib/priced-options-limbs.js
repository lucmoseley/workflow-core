/*
 * priced-options-limbs.js — every marker guard-priced-options.js writes, and
 * the budget tier each limb's counter sits in (#1474). arbiter-markers.js
 * sweeps every prefix here.
 *
 * DATA ONLY: this file loads nothing, which is what lets arbiter-markers.js
 * load it destructured under arbiter-store.js's split rule.
 *
 * The tiers, which priced-options-ceiling.js applies:
 * - `shape`: a miss files no job wrongly and lets no false claim stand. Stops
 *   one block short of the session ceiling, its last block being reserved for
 *   the filing tier (mantahostels#3420 Q5, mantahostels#3430). A `needs input:`
 *   with no round still files the job blocked, so it is shape.
 * - `filing`: decides which bucket the job is filed in, so each has its own
 *   counter, and no other defect can spend the allowance the filing depends on
 *   (mantahostels#2544) — within the session ceiling (mantahostels#2786).
 * - `outside-ceiling`: exempt from the ceiling and the shape reserve, bounded
 *   only by its own cap (#1067); a block it shares charges the ceiling once.
 * - `after-batch`: judged only once the batched block has not gone out, on its
 *   own counter — there is no shape to iterate toward, and a cap of 1 is the
 *   escape on a machine that cannot afford a run (mantahostels#1253).
 */

/* A copy of hook-block.js's MAX_BLOCKS, since this file loads nothing;
 * priced-options-ceiling.test.ts pins the two equal. */
const CAP = 3;

/* The shared counter: the round's shape and its recommendation arrow
 * (mantahostels#3420). */
const SHAPE_PREFIX = ".priced-options-nagged-";
const NEEDS_INPUT_ROUND_PREFIX = ".needs-input-round-nagged-";
const FOUNDER_ACT_PREFIX = ".founder-act-nagged-";
const ACTOR_ONLY_PREFIX = ".actor-only-nagged-";

const COMPLETED_WHILE_WAITING_PREFIX = ".completed-while-waiting-nagged-";
const NEEDS_INPUT_UNDERCUT_PREFIX = ".needs-input-undercut-nagged-";
const NEEDS_INPUT_MISPLACED_PREFIX = ".needs-input-misplaced-nagged-";
const RESULT_MISPLACED_PREFIX = ".result-misplaced-nagged-";
const UNMARKED_STOP_PREFIX = ".unmarked-stop-nagged-";
const MISSING_NEEDS_INPUT_PREFIX = ".missing-needs-input-nagged-";
const EMPTY_MARKER_PREFIX = ".empty-marker-nagged-";
const WAITING_UNVERIFIED_PREFIX = ".waiting-unverified-nagged-";

const CLOSE_RIVALS_PREFIX = ".close-rivals-nagged-";
const ROUND_CHECK_PREFIX = ".round-check-nagged-";
/* A still-caught re-send whose research ladder is unclimbed (#2006). */
const RESEARCH_LADDER_PREFIX = ".research-ladder-nagged-";

const GREEN_SUITE_PREFIX = ".green-suite-nagged-";

/* Not a counter: the questions the close-rivals limb last refused (#489). */
const CLOSE_RIVALS_RECORD_PREFIX = ".close-rivals-record-";
/* Not a counter: the questions the under-researched-round limb last refused
 * (#1710). */
const ROUND_CHECK_RECORD_PREFIX = ".round-check-record-";

/** @typedef {"shape" | "filing" | "outside-ceiling" | "after-batch"} Tier */
/** @typedef {{ prefix: string, tier: "shape" | "filing", cap: number }} CeilingLimb */
/* A limb the ceiling exempts carries the name priced-options-ceiling.js's
 * notices list it by, and `recordPrefix` where it keeps a record of the
 * questions it refused, whose shape it then also refuses (#1730, #2062). */
/** @typedef {{ prefix: string, tier: "outside-ceiling" | "after-batch", cap: number, name: string, recordPrefix?: string }} ExemptLimb */
/** @typedef {CeilingLimb | ExemptLimb} Limb */

/** @type {Limb[]} */
const LIMBS = [
	{ prefix: SHAPE_PREFIX, tier: "shape", cap: CAP },
	{ prefix: NEEDS_INPUT_ROUND_PREFIX, tier: "shape", cap: CAP },
	{ prefix: FOUNDER_ACT_PREFIX, tier: "shape", cap: CAP },
	{ prefix: ACTOR_ONLY_PREFIX, tier: "shape", cap: CAP },
	{ prefix: COMPLETED_WHILE_WAITING_PREFIX, tier: "filing", cap: CAP },
	{ prefix: NEEDS_INPUT_UNDERCUT_PREFIX, tier: "filing", cap: CAP },
	{ prefix: NEEDS_INPUT_MISPLACED_PREFIX, tier: "filing", cap: CAP },
	{ prefix: RESULT_MISPLACED_PREFIX, tier: "filing", cap: CAP },
	{ prefix: UNMARKED_STOP_PREFIX, tier: "filing", cap: CAP },
	{ prefix: MISSING_NEEDS_INPUT_PREFIX, tier: "filing", cap: CAP },
	{ prefix: EMPTY_MARKER_PREFIX, tier: "filing", cap: CAP },
	{ prefix: WAITING_UNVERIFIED_PREFIX, tier: "filing", cap: CAP },
	{
		prefix: CLOSE_RIVALS_PREFIX,
		tier: "outside-ceiling",
		cap: CAP,
		name: "close-rivals",
		recordPrefix: CLOSE_RIVALS_RECORD_PREFIX,
	},
	{
		prefix: ROUND_CHECK_PREFIX,
		tier: "outside-ceiling",
		cap: CAP,
		name: "under-researched-round",
		recordPrefix: ROUND_CHECK_RECORD_PREFIX,
	},
	{
		prefix: RESEARCH_LADDER_PREFIX,
		tier: "outside-ceiling",
		cap: CAP,
		name: "research-ladder",
	},
	{
		prefix: GREEN_SUITE_PREFIX,
		tier: "after-batch",
		cap: 1,
		name: "green-suite evidence",
	},
];

/**
 * @param {Limb} limb
 * @returns {limb is ExemptLimb}
 */
const isExemptLimb = (limb) =>
	limb.tier === "outside-ceiling" || limb.tier === "after-batch";

/** Each limb's row, by its prefix. */
const LIMB_OF = new Map(LIMBS.map((limb) => [limb.prefix, limb]));

/**
 * @param {string} prefix a prefix from this file
 * @returns {Limb}
 */
function limbOf(prefix) {
	const limb = LIMB_OF.get(prefix);
	if (!limb) throw new Error(`no limb row for ${prefix}`);
	return limb;
}

/* The ceiling every shape and filing limb shares (mantahostels#2786). */
const SESSION_PREFIX = ".priced-options-session-nagged-";
/* THE CEILING'S SIZE. Batching cuts the common case; this bounds the
 * pathological one, where each corrected reply trips something new. FIVE IS
 * CHOSEN, NOT DERIVED: a correction cycle spending a limb's own three and then
 * tripping a bucket-deciding limb argues for 4, and the fifth is slack against
 * a turn that trips two new limbs at once. Re-priced and held at
 * mantahostels#3450. */
const SESSION_MAX = 5;
/* Not swept: the two limbs' durable logs, which outlive the 24 h sweep
 * (`refusal-log.js`). */
const CLOSE_CHECK_LOG = ".close-check-log.jsonl";
const ROUND_CHECK_LOG = ".round-check-log.jsonl";

const PREFIXES = [
	...LIMBS.map((limb) => limb.prefix),
	SESSION_PREFIX,
	...LIMBS.flatMap((limb) =>
		isExemptLimb(limb) && limb.recordPrefix ? [limb.recordPrefix] : [],
	),
];

module.exports = {
	CLOSE_CHECK_LOG,
	ROUND_CHECK_LOG,
	LIMBS,
	isExemptLimb,
	limbOf,
	PREFIXES,
	SESSION_PREFIX,
	SESSION_MAX,
	CLOSE_RIVALS_RECORD_PREFIX,
	ROUND_CHECK_RECORD_PREFIX,
	SHAPE_PREFIX,
	NEEDS_INPUT_ROUND_PREFIX,
	FOUNDER_ACT_PREFIX,
	ACTOR_ONLY_PREFIX,
	COMPLETED_WHILE_WAITING_PREFIX,
	NEEDS_INPUT_UNDERCUT_PREFIX,
	NEEDS_INPUT_MISPLACED_PREFIX,
	RESULT_MISPLACED_PREFIX,
	UNMARKED_STOP_PREFIX,
	MISSING_NEEDS_INPUT_PREFIX,
	EMPTY_MARKER_PREFIX,
	WAITING_UNVERIFIED_PREFIX,
	CLOSE_RIVALS_PREFIX,
	ROUND_CHECK_PREFIX,
	RESEARCH_LADDER_PREFIX,
	GREEN_SUITE_PREFIX,
};
