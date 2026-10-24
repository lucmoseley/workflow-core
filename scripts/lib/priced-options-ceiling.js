/*
 * priced-options-ceiling.js — how guard-priced-options.js spends its blocks:
 * which of a turn's defect groups block against the session ceiling, and the
 * one block that carries them, charging every counter it spends (#1474).
 * Each limb's tier is a row in priced-options-limbs.js; why the ceiling exists
 * and why it is reserved by tier is in the guard's header (mantahostels#2786,
 * mantahostels#3430).
 */

const hookBlock = require("./hook-block");
const {
	LIMBS,
	isExemptLimb,
	limbOf,
	SESSION_PREFIX,
	SESSION_MAX,
} = require("./priced-options-limbs");

/* How every refusal from this guard opens, ahead of the whole correction
 * (mantahostels#2350). A block has one channel and the founder reads it too, so the text
 * says up front that it is addressed to the session — otherwise the correction
 * below reads to him as a question he has to answer. Measured channel rule:
 * `docs/agents/guard-authoring.md` §Which channel reaches the model. */
const MACHINE_DIRECTED =
	"A Stop guard refused this turn. The refusal is machine-directed — " +
	"instructions to the session about the shape of its own reply — and holds " +
	"nothing for you to answer.";

/** @typedef {import("./priced-options-limbs").ExemptLimb} ExemptLimb */

/**
 * The ceiling's three notices, each naming the limbs the ceiling exempts from
 * their rows in `LIMBS`, so a new limb is named by its row alone (#2062).
 * Built per block rather than once at load, which costs nothing at a few
 * blocks a session and lets a test add a row without a test-only export.
 */
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
		/* Appended to the last block the session ceiling allows
		 * (mantahostels#2786), on the same reasoning as hook-block.js's
		 * per-counter notice: silence past a cap reads to a session as a turn it
		 * got right. */
		session:
			`\n\nThis was guard-priced-options.js's last Stop block of the session — its \`${SESSION_PREFIX}\` ceiling of ${String(SESSION_MAX)} is now spent. ` +
			"Every rule above still binds; nothing will refuse a reply shape or a status marker for the rest of the session, so get this one right unaided. " +
			`${exemptMayBlock} ` +
			/* hook-block.js appends its own per-counter notice AFTER this one where
			 * `blocking[0]` caps on the same block, and that notice says other checks may
			 * still block — true of its counter, false of the session (mantahostels#2786). */
			"Any per-counter notice below this one is superseded: the ceiling outranks it.",
		/* Appended to an outside-ceiling block past the spent ceiling (#1067,
		 * #1710), which carries no session notice to supersede hook-block.js's
		 * per-counter one. */
		outside:
			`\n\nguard-priced-options.js's session ceiling is spent: only the ${buildCheckList(exempt)} may still block this session. ` +
			"Any per-counter notice below this one is superseded.",
		/* Appended to the block that spends the shape tier's share of the
		 * ceiling (mantahostels#3430), on the same reasoning: its last block is
		 * the consequential tier's. */
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
 * Each part's reason, grouped by its prefix in first-seen order.
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
 * Which of the live groups this turn blocks on, against the session ceiling,
 * from each group's tier alone. The after-batch tier is read only where no
 * other group blocks.
 * @param {PrefixGroup[]} live
 * @param {(max: number) => boolean} ceilingAt whether the ceiling counter has
 *   reached `max`
 * @param {() => PrefixGroup[]} [afterBatch] the after-batch tier's live groups
 * @returns {CeilingPlan}
 */
function ceilingPlan(live, ceilingAt, afterBatch = () => []) {
	/** @type {(tier: Limb["tier"]) => (group: PrefixGroup) => boolean} */
	const inTier = (tier) => (group) => tierOf(group) === tier;
	const underCeiling = live.filter(
		(group) => !inTier("outside-ceiling")(group),
	);

	/* `max: SESSION_MAX - 1` reads "the ceiling counter is one short", so the
	 * block about to be written is the last one this session gets — and, that
	 * block being the filing tier's, a shape-only turn is not refused. */
	const last = ceilingAt(SESSION_MAX - 1);
	const reserved = last && underCeiling.every(inTier("shape"));
	/* One short of `last`: whatever this block refuses, shape goes dark after it. */
	const shapeLast = !last && ceilingAt(SESSION_MAX - 2);
	const chargesCeiling =
		underCeiling.length > 0 && !reserved && !ceilingAt(SESSION_MAX);
	/* Where the ceiling silences every other defect, an outside-ceiling refusal
	 * blocks alone and charges only its own counter. */
	const blocking = chargesCeiling
		? live
		: live.filter(inTier("outside-ceiling"));
	return {
		blocking: blocking.length > 0 ? blocking : afterBatch(),
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
 * Block the turn on `plan.blocking`, charging every counter it spends.
 * @param {CeilingPlan} plan
 * @param {{ sessionId: string, recorders?: Recorder[] }} turn
 *   `recorders`, the limbs that keep a record of what they refused, each told
 *   when a block carrying it goes out, and, where it asks, when one without it
 *   does
 * @returns {boolean} whether the block went out
 */
function blockOn(plan, { sessionId, recorders = [] }) {
	const { blocking, chargesCeiling, last, shapeLast, ceilingAt } = plan;
	const [firstBlocking] = blocking;
	if (!firstBlocking) return false;
	const reasons = blocking.flatMap((group) => group.reasons);
	const notices = buildCeilingNotices();
	const outsideCeiling = blocking.some(
		(group) => tierOf(group) === "outside-ceiling",
	);
	/* The first blocking group pays through `blockStop`, which owns the single
	 * stdout channel; the rest are charged silently. Order is `reviewParts`'
	 * — label defects first, a session whose status marker is wrong having to
	 * fix that before the rest is even meaningful. */
	if (
		!hookBlock.blockStop({
			...limbCounter(firstBlocking.prefix, sessionId),
			reason:
				`${MACHINE_DIRECTED}\n\n${reasons.join("\n\n")}` +
				(chargesCeiling && last ? notices.session : "") +
				(chargesCeiling && shapeLast ? notices.shapeReserve : "") +
				(outsideCeiling && ceilingAt(SESSION_MAX) ? notices.outside : ""),
		})
	)
		return false;
	/* The boolean is discarded on every call below: each prefix was
	 * `capSpent`-filtered in judge() before this plan was built, so a false
	 * here means an unwritable counter, and `charge`'s own catch says why
	 * that is not actionable once the block is already out (mantahostels#2786). */
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
 * @param {Set<string>} blocked the prefixes the block carried
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
 * Whether a limb's counter is under its cap, so its refusal can go out.
 * @param {string} prefix
 * @param {string} sessionId
 */
const isLive = (prefix, sessionId) =>
	!hookBlock.capSpent(limbCounter(prefix, sessionId));

/**
 * A counter at its cap contributes nothing and stays silent, exactly as it
 * did when each limb blocked alone: the cap is still per limb, so three
 * corrections to a round shape never disarm a bucket-deciding limb.
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
