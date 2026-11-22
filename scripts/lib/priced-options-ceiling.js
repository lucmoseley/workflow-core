const hookBlock = require("./hook-block");
const {
	LIMBS,
	isExemptLimb,
	limbOf,
	SESSION_PREFIX,
	SESSION_MAX,
} = require("./priced-options-limbs");

const MACHINE_DIRECTED =
	"A Stop guard refused this turn. The refusal is machine-directed — " +
	"instructions to the session about the shape of its own reply — and holds " +
	"nothing for you to answer.";

/** @typedef {import("./priced-options-limbs").ExemptLimb} ExemptLimb */

function buildCeilingNotices() {
	const exempt = LIMBS.filter(isExemptLimb);
	/** @param {ExemptLimb[]} rows */
	const buildCheckList = (rows) =>
		`${new Intl.ListFormat("en-GB").format(rows.map((row) => row.name))} check${rows.length > 1 ? "s" : ""}`;
	const reshaping = exempt.filter((limb) => limb.recordPrefix);
	const exemptMayBlock =
		`The ${buildCheckList(exempt)} count separately and may still block` +
		(reshaping.length > 0
			? `, the ${buildCheckList(reshaping)} also on the shape of a question ${reshaping.length > 1 ? "they" : "it"} refused`
			: "") +
		".";
	return {
		session:
			`\n\nThis was guard-priced-options.js's last Stop block of the session — its \`${SESSION_PREFIX}\` ceiling of ${String(SESSION_MAX)} is now spent. ` +
			"Every rule above still binds; nothing will refuse a reply shape or a status marker for the rest of the session, so get this one right unaided. " +
			`${exemptMayBlock} ` +
			"Any per-counter notice below this one is superseded: the ceiling outranks it.",
		outside:
			`\n\nguard-priced-options.js's session ceiling is spent: only the ${buildCheckList(exempt)} may still block this session. ` +
			"Any per-counter notice below this one is superseded.",
		shapeReserve:
			"\n\nFrom here guard-priced-options.js will not refuse a turn for reply shape alone this session — a question round's form, a recommendation's order, a `needs input:` with no round. " +
			"Those rules still bind; the one block left is reserved for the status-marker checks that decide how the job is filed, and a shape defect is named only if that block fires. " +
			exemptMayBlock,
	};
}

/**
 * @typedef {{prefix: string, reason: string}} Part
 * @typedef {{prefix: string, reasons: string[]}} PrefixGroup
 * @typedef {import("./priced-options-limbs").Limb} Limb
 * @typedef {{ blocking: PrefixGroup[], chargesCeiling: boolean, last: boolean,
 *   shapeLast: boolean, ceilingAt: (max: number) => boolean }} CeilingPlan
 */

/** @type {(group: {prefix: string}) => Limb["tier"]} */
const tierOf = (group) => limbOf(group.prefix).tier;

/**
 * @param {Part[]} parts
 * @returns {PrefixGroup[]}
 */
function groupByPrefix(parts) {
	/** @type {PrefixGroup[]} */
	const groups = [];
	for (const part of parts) {
		const group = groups.find((g) => g.prefix === part.prefix);
		if (group) group.reasons.push(part.reason);
		else groups.push({ prefix: part.prefix, reasons: [part.reason] });
	}
	return groups;
}

/**
 * @param {PrefixGroup[]} live
 * @param {(max: number) => boolean} ceilingAt
 * @returns {CeilingPlan}
 */
function ceilingPlan(live, ceilingAt) {
	/** @type {(tier: Limb["tier"]) => (group: PrefixGroup) => boolean} */
	const inTier = (tier) => (group) => tierOf(group) === tier;
	const underCeiling = live.filter(
		(group) => !inTier("outside-ceiling")(group),
	);

	const last = ceilingAt(SESSION_MAX - 1);
	const reserved = last && underCeiling.every(inTier("shape"));
	const shapeLast = !last && ceilingAt(SESSION_MAX - 2);
	const chargesCeiling =
		underCeiling.length > 0 && !reserved && !ceilingAt(SESSION_MAX);
	const blocking = chargesCeiling
		? live
		: live.filter(inTier("outside-ceiling"));
	return {
		blocking,
		chargesCeiling,
		last,
		shapeLast,
		ceilingAt,
	};
}

/**
 * @typedef {{ prefix: string, onBlocked: (slot: number) => void,
 *   onBlockedElsewhere?: () => void }} Recorder
 */

/**
 * @param {CeilingPlan} plan
 * @param {{ sessionId: string, recorders?: Recorder[], tail?: () => string }} turn
 * @returns {boolean}
 */
function blockOn(plan, { sessionId, recorders = [], tail = () => "" }) {
	const { blocking, chargesCeiling, last, shapeLast, ceilingAt } = plan;
	const [firstBlocking] = blocking;
	if (!firstBlocking) return false;
	const reasons = blocking.flatMap((group) => group.reasons);
	const notices = buildCeilingNotices();
	const outsideCeiling = blocking.some(
		(group) => tierOf(group) === "outside-ceiling",
	);
	if (
		!hookBlock.blockStop({
			...limbCounter(firstBlocking.prefix, sessionId),
			reason:
				`${MACHINE_DIRECTED}\n\n${reasons.join("\n\n")}` +
				(chargesCeiling && last ? notices.session : "") +
				(chargesCeiling && shapeLast ? notices.shapeReserve : "") +
				(outsideCeiling && ceilingAt(SESSION_MAX) ? notices.outside : "") +
				tail(),
		})
	)
		return false;
	for (const group of blocking.slice(1))
		hookBlock.charge({ ...limbCounter(group.prefix, sessionId) });
	if (chargesCeiling)
		hookBlock.charge({
			prefix: SESSION_PREFIX,
			sessionId,
			max: SESSION_MAX,
		});
	tellRecorders(recorders, new Set(blocking.map((g) => g.prefix)), sessionId);
	return true;
}

/**
 * @param {Recorder[]} recorders
 * @param {Set<string>} blocked
 * @param {string} sessionId
 */
function tellRecorders(recorders, blocked, sessionId) {
	for (const limb of recorders)
		if (blocked.has(limb.prefix))
			limb.onBlocked(hookBlock.readCount(limb.prefix, sessionId));
		else limb.onBlockedElsewhere?.();
}

/**
 * @param {string} prefix
 * @param {string} sessionId
 */
const limbCounter = (prefix, sessionId) => ({
	prefix,
	sessionId,
	max: limbOf(prefix).cap,
});

/**
 * @param {string} prefix
 * @param {string} sessionId
 */
const isLive = (prefix, sessionId) =>
	!hookBlock.capSpent(limbCounter(prefix, sessionId));

/**
 * @param {PrefixGroup[]} groups
 * @param {string} sessionId
 */
const liveGroups = (groups, sessionId) =>
	groups.filter((group) => isLive(group.prefix, sessionId));

module.exports = {
	groupByPrefix,
	isLive,
	liveGroups,
	ceilingPlan,
	blockOn,
	limbCounter,
};
