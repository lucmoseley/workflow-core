const CAP = 3;

const SHAPE_PREFIX = ".priced-options-nagged-";
const NEEDS_INPUT_ROUND_PREFIX = ".needs-input-round-nagged-";
const FOUNDER_ACT_PREFIX = ".founder-act-nagged-";
const ACTOR_ONLY_PREFIX = ".actor-only-nagged-";
const RECURRENCE_PREFIX = ".recurrence-nagged-";

const COMPLETED_WHILE_WAITING_PREFIX = ".completed-while-waiting-nagged-";
const NEEDS_INPUT_UNDERCUT_PREFIX = ".needs-input-undercut-nagged-";
const NEEDS_INPUT_MISPLACED_PREFIX = ".needs-input-misplaced-nagged-";
const RESULT_MISPLACED_PREFIX = ".result-misplaced-nagged-";
const UNMARKED_STOP_PREFIX = ".unmarked-stop-nagged-";
const MISSING_NEEDS_INPUT_PREFIX = ".missing-needs-input-nagged-";
const EMPTY_MARKER_PREFIX = ".empty-marker-nagged-";
const WAITING_IN_JOB_PREFIX = ".waiting-in-job-nagged-";

const CLOSE_RIVALS_PREFIX = ".close-rivals-nagged-";
const ROUND_CHECK_PREFIX = ".round-check-nagged-";
const RESEARCH_LADDER_PREFIX = ".research-ladder-nagged-";

const CLOSE_RIVALS_RECORD_PREFIX = ".close-rivals-record-";
const ROUND_CHECK_RECORD_PREFIX = ".round-check-record-";

/** @typedef {"shape" | "filing" | "outside-ceiling"} Tier */
/** @typedef {{ prefix: string, tier: "shape" | "filing", cap: number }} CeilingLimb */
/** @typedef {{ prefix: string, tier: "outside-ceiling", cap: number, name: string, recordPrefix?: string }} ExemptLimb */
/** @typedef {CeilingLimb | ExemptLimb} Limb */

/** @type {Limb[]} */
const LIMBS = [
	{ prefix: SHAPE_PREFIX, tier: "shape", cap: CAP },
	{ prefix: NEEDS_INPUT_ROUND_PREFIX, tier: "shape", cap: CAP },
	{ prefix: FOUNDER_ACT_PREFIX, tier: "shape", cap: CAP },
	{ prefix: ACTOR_ONLY_PREFIX, tier: "shape", cap: CAP },
	{ prefix: RECURRENCE_PREFIX, tier: "shape", cap: CAP },
	{ prefix: COMPLETED_WHILE_WAITING_PREFIX, tier: "filing", cap: CAP },
	{ prefix: NEEDS_INPUT_UNDERCUT_PREFIX, tier: "filing", cap: CAP },
	{ prefix: NEEDS_INPUT_MISPLACED_PREFIX, tier: "filing", cap: CAP },
	{ prefix: RESULT_MISPLACED_PREFIX, tier: "filing", cap: CAP },
	{ prefix: UNMARKED_STOP_PREFIX, tier: "filing", cap: CAP },
	{ prefix: MISSING_NEEDS_INPUT_PREFIX, tier: "filing", cap: CAP },
	{ prefix: EMPTY_MARKER_PREFIX, tier: "filing", cap: CAP },
	{ prefix: WAITING_IN_JOB_PREFIX, tier: "filing", cap: CAP },
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
];

/**
 * @param {Limb} limb
 * @returns {limb is ExemptLimb}
 */
const isExemptLimb = (limb) => limb.tier === "outside-ceiling";

const LIMB_OF = new Map(LIMBS.map((limb) => [limb.prefix, limb]));

/**
 * @param {string} prefix
 * @returns {Limb}
 */
function limbOf(prefix) {
	const limb = LIMB_OF.get(prefix);
	if (!limb) throw new Error(`no limb row for ${prefix}`);
	return limb;
}

const SESSION_PREFIX = ".priced-options-session-nagged-";
// guess, lucmoseley/mantahostels#3450
const SESSION_MAX = 5;
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
	RECURRENCE_PREFIX,
	COMPLETED_WHILE_WAITING_PREFIX,
	NEEDS_INPUT_UNDERCUT_PREFIX,
	NEEDS_INPUT_MISPLACED_PREFIX,
	RESULT_MISPLACED_PREFIX,
	UNMARKED_STOP_PREFIX,
	MISSING_NEEDS_INPUT_PREFIX,
	EMPTY_MARKER_PREFIX,
	WAITING_IN_JOB_PREFIX,
	CLOSE_RIVALS_PREFIX,
	ROUND_CHECK_PREFIX,
	RESEARCH_LADDER_PREFIX,
};
