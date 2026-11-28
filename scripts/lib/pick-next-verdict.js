const blockerGraph = require("./blocker-graph.js");
const { isRouteStep } = require("./decision-labels.js");
const {
	agePointsOf,
	compareLevels,
	WAITING_LABEL,
} = require("./frontier-order.js");
const { resolveGate } = require("./issue-gate.js");
const { parseIssueRef } = require("./issue-ref.js");
const { labelAge } = require("./label-age.js");
const { PARKED_LABEL } = require("./parked.js");
const { unparsedBlockersOf } = require("./prose-blockers.js");
const { dispatchAge, holdingDispatch } = require("./pick-next-dispatched.js");
const { claimHolder } = require("./pick-next-sessions.js");
const { takesLabel, takesOf } = require("./takes-label.js");
const { URGENT_LABEL } = require("./urgent-label.js");

/**
 * @typedef {object} RawIssue
 * @property {number} number
 * @property {string} state
 * @property {string} title
 * @property {string} url
 * @property {string} createdAt
 * @property {string[]} assignees
 * @property {string[]} labels
 * @property {string} body
 * @property {string|null} parent
 * @property {number} openSubIssues
 * @property {string|null} repo
 */

/**
 * @typedef {object} Enrichment
 * @property {string[]} [paths]
 * @property {import("./blocker-graph").Edge[]} [blockedBy]
 * @property {unknown} [depsUnknown]
 * @property {ReturnType<typeof blockerGraph.proseOf> & {unparsed: ReturnType<typeof import("./prose-blockers.js").unparsedBlockersOf>}} [proseBlocked]
 * @property {{label: string, native: boolean}[]} [openBlockers]
 * @property {number} [reach]
 * @property {ReturnType<typeof labelAge>|null} [urgency]
 * @property {import("./blocker-graph").Via|null} [urgentVia]
 * @property {import("./blocker-graph").Via|null} [bugVia]
 * @property {import("./blocker-graph").Via|null} [goalVia]
 * @property {number} [depth]
 * @property {number} [closes]
 * @property {boolean} [bug]
 * @property {boolean} [urgent]
 * @property {ReturnType<typeof waitFrom>|null} [wait]
 * @property {number} [stallDays]
 * @property {number} [agePoints]
 * @property {ReturnType<typeof labelAge>|null} [parked]
 * @property {boolean} [goal]
 * @property {number} [collision]
 * @property {boolean} [asksQuestions]
 * @property {string[]} [takes]
 * @property {string} [group]
 * @property {ReturnType<typeof import("./issue-gate").gateOf>} [gate]
 * @property {ReturnType<typeof import("./issue-gate").gateOnOf>} [gateOn]
 * @property {boolean} [gateConflict]
 * @property {boolean} [gateHolds]
 * @property {boolean} [gateOnHolds]
 * @property {string|null} [excluded]
 * @property {ExclusionCategory|null} [exclusionCategory]
 * @property {import("./dispatch-ledger").DispatchRecord} [dispatchRec]
 * @property {boolean} [dispatchHeld]
 * @property {boolean} [assignedUnclaimed]
 */

/** @typedef {RawIssue & Enrichment} Enriching */

/**
 * @typedef {Enriching &
 *   Required<Pick<Enrichment, "blockedBy" | "depsUnknown" | "proseBlocked">>
 * } DepsResolved
 */

/** @typedef {RawIssue & Required<Omit<Enrichment, "paths" | "dispatchRec">> & {paths?: string[], dispatchRec?: import("./dispatch-ledger").DispatchRecord}} Issue */

// guess, lucmoseley/mantahostels#956
const WAITING_STALL_DAYS = 7;

/**
 * @param {import("./blocker-graph").Graph} graph
 * @param {{number: number, body: string}} i
 */
function proseBlockedOf(graph, i) {
	return {
		...blockerGraph.proseOf(graph, i.number),
		unparsed: unparsedBlockersOf(i.body),
	};
}

/**
 * @param {import("./blocker-graph").Graph} graph
 * @param {Map<number, RawIssue>} byNumber
 * @param {Set<number>} goalRanked
 */
function inheritanceOf(graph, byNumber, goalRanked) {
	/** @param {number} n @param {string} label */
	const has = (n, label) => byNumber.get(n)?.labels.includes(label) === true;
	return blockerGraph.inheritance(graph, {
		bug: (n) => has(n, "bug"),
		urgent: (n) => has(n, URGENT_LABEL),
		goal: (n) => goalRanked.has(n),
	});
}

/**
 * @param {{bug: boolean, urgent: boolean, goal: boolean}} own
 * @param {ReturnType<ReturnType<typeof inheritanceOf>>} held
 */
function tiersOf(own, held) {
	const bug = own.bug || held.via.bug !== null;
	return {
		bug,
		urgent: bug || own.urgent || held.via.urgent !== null,
		goal: own.goal || held.via.goal !== null,
		depth: held.depth,
	};
}

/**
 * @param {{ok: boolean, events?: any[], error?: any}} timeline
 * @param {number} now
 * @returns {{unknown: true, unrecorded: boolean, error: any, ageDays?: undefined, appliedAt?: undefined, appliedBy?: undefined, stalled?: undefined}
 *   | {unknown?: false, error?: undefined, ageDays: number, appliedAt: string, appliedBy: string, stalled: boolean}}
 */
function waitFrom(timeline, now) {
	const age = labelAge(timeline, WAITING_LABEL, now);
	return age.unknown
		? age
		: { ...age, stalled: age.ageDays >= WAITING_STALL_DAYS };
}

/**
 * @param {{wait: ReturnType<typeof waitFrom>|null}} issue
 * @returns {string}
 */
const waitCell = (issue) => {
	if (!issue.wait) return "";
	if (issue.wait.unknown) return "?";
	return `${Math.floor(issue.wait.ageDays)}d${issue.wait.stalled ? "!" : ""}`;
};

/**
 * @param {RawIssue} issue
 * @param {Set<number>} mapNumbers
 * @param {Set<number>} specNumbers
 */
function groupOf(issue, mapNumbers, specNumbers) {
	if (issue.labels.includes("wayfinder:map")) return "map root";
	if (issue.labels.includes("kind:spec")) return "spec root";
	if (!issue.parent) return "standalone";
	const parent = parseIssueRef(issue.parent)?.number ?? null;
	if (parent !== null && mapNumbers.has(parent)) return `map #${parent}`;
	if (parent !== null && specNumbers.has(parent)) return `spec #${parent}`;
	return `child of #${parent}`;
}

const COMMENT_ONLY = ["wayfinder:grilling", "wayfinder:research"];
/** @param {RawIssue} issue */
const collisionOf = (issue) =>
	issue.labels.some((l) => COMMENT_ONLY.includes(l)) ? 0 : 1;

const QUESTION_TYPES = ["wayfinder:grilling", "wayfinder:prototype"];
const WAYFINDER_LABEL = takesLabel("wayfinder");
/** @param {RawIssue} issue */
const isQuestionType = (issue) =>
	issue.labels.includes(WAYFINDER_LABEL) &&
	(issue.labels.some((l) => QUESTION_TYPES.includes(l)) ||
		!isRouteStep(issue.labels));

/**
 * @typedef {object} EnrichContext
 * @property {import("./blocker-graph").Graph} blockers
 * @property {Map<number, import("./label-age.js").Timeline|undefined>} timelineByIssue
 * @property {ReturnType<typeof inheritanceOf>} inherit
 * @property {Set<number>} mapNumbers
 * @property {Set<number>} specNumbers
 * @property {import("./agent-liveness.js").ListedSessions} listed
 * @property {{held: Map<number, any>, kept: boolean}} claims
 * @property {{held: Map<number, {label: string, sessionId: string, kept: boolean}>}} parentHeld
 * @property {{byIssue: Map<number, import("./dispatch-ledger").DispatchRecord[]>}} dispatched
 * @property {Map<number, number>} openChildren
 * @property {Set<number>} goalRanked
 * @property {() => number} now
 */

const EXCLUSION_CATEGORIES = /** @type {const} */ ([
	"degraded",
	"blocked",
	"claimed",
	"already dispatched",
	"container",
	"gated",
]);
/** @typedef {typeof EXCLUSION_CATEGORIES[number]} ExclusionCategory */

const TO_SPEC_LABEL = takesLabel("to-spec");

/**
 * @param {DepsResolved} i
 * @param {EnrichContext} ctx
 * @param {{openBlockers: {label: string, native: boolean}[], dispatchReason: string|null, resolved: ReturnType<typeof resolveGate>}} facts
 * @returns {{category: ExclusionCategory, text: string}|null}
 */
function exclusionOf(i, ctx, facts) {
	const { openBlockers, dispatchReason, resolved } = facts;
	const { claims, parentHeld, listed, openChildren } = ctx;
	const gate = resolved.gate;
	const gateOn = resolved.gateOn;
	if (i.depsUnknown)
		return {
			category: "degraded",
			text: `readiness unknown — ${i.depsUnknown}`,
		};
	if (openBlockers.length > 0)
		return {
			category: "blocked",
			text: `blocked by ${openBlockers
				.map((b) => (b.native ? b.label : `${b.label} (prose only)`))
				.join(", ")}`,
		};
	if (claims.held.has(i.number))
		return {
			category: "claimed",
			text: `claimed by ${claimHolder(i.assignees, claims.held.get(i.number), claims.kept, listed.names)}`,
		};
	const parent = parentHeld.held.get(i.number);
	if (parent)
		return {
			category: "claimed",
			text: `claimed through parent map ${parent.label} by ${claimHolder([], parent.sessionId, parent.kept, listed.names)}`,
		};
	if (dispatchReason)
		return { category: "already dispatched", text: dispatchReason };
	if (openChildren.get(i.number) && !i.labels.includes(TO_SPEC_LABEL)) {
		const unread = ctx.blockers.childrenUnread.get(i.number);
		return {
			category: "container",
			text: `container — ${openChildren.get(i.number)} open children${unread ? ` by its summary; sub-issues unreadable (${unread})` : ""}`,
		};
	}
	if (resolved.gateHolds && gate && !gate.malformed)
		return {
			category: "gated",
			text: `gated until ${gate.iso} (${gate.daysLeft}d) — ${gate.reason || "no reason given"}`,
		};
	if (resolved.gateOnHolds && gateOn && !gateOn.malformed)
		return { category: "gated", text: `gated on ${gateOn.condition}` };
	return null;
}

/**
 * @param {DepsResolved} i
 * @param {EnrichContext} ctx
 * @returns {Issue}
 */
function enrichIssue(i, ctx) {
	const openBlockers = blockerGraph.openBlockersOf(ctx.blockers, i.number);
	const timeline = ctx.timelineByIssue.get(i.number);
	const urgency =
		i.labels.includes(URGENT_LABEL) && timeline
			? labelAge(timeline, URGENT_LABEL, ctx.now())
			: null;
	const held = ctx.inherit({ repo: ctx.blockers.ownRepo, number: i.number });
	const { bug: bugVia, urgent: urgentVia, goal: goalVia } = held.via;
	const tiers = tiersOf(
		{
			bug: i.labels.includes("bug"),
			urgent: i.labels.includes(URGENT_LABEL),
			goal: ctx.goalRanked.has(i.number),
		},
		held,
	);
	const wait =
		i.labels.includes(WAITING_LABEL) && timeline
			? waitFrom(timeline, ctx.now())
			: null;
	const parked =
		i.labels.includes(PARKED_LABEL) && timeline
			? labelAge(timeline, PARKED_LABEL, ctx.now())
			: null;
	const takes = takesOf(i.labels);
	const resolved = resolveGate(i.body);
	const dispatchRec = holdingDispatch(ctx.dispatched, i.number, takes);
	const dispatchReason = dispatchRec
		? `dispatched ${dispatchAge(dispatchRec, ctx.now())}`
		: null;
	const exclusion = exclusionOf(i, ctx, {
		openBlockers,
		dispatchReason,
		resolved,
	});
	const excluded = exclusion?.text ?? null;
	return {
		...i,
		openBlockers,
		reach: blockerGraph.reachOf(ctx.blockers, i.number),
		depth: tiers.depth,
		closes: blockerGraph.closesOf(ctx.blockers, i.number),
		urgency,
		urgentVia,
		bugVia,
		goalVia,
		bug: tiers.bug,
		urgent: tiers.urgent,
		wait,
		stallDays: wait && !wait.unknown && wait.stalled ? wait.ageDays : 0,
		agePoints: agePointsOf(i.createdAt, ctx.now()),
		parked,
		goal: tiers.goal,
		collision: collisionOf(i),
		asksQuestions: isQuestionType(i),
		takes,
		group: groupOf(i, ctx.mapNumbers, ctx.specNumbers),
		gate: resolved.gate,
		gateOn: resolved.gateOn,
		gateConflict: resolved.conflict,
		gateHolds: resolved.gateHolds,
		gateOnHolds: resolved.gateOnHolds,
		dispatchRec,
		excluded,
		exclusionCategory: exclusion?.category ?? null,
		dispatchHeld: exclusion?.category === "already dispatched",
		assignedUnclaimed:
			i.assignees.length > 0 && !ctx.claims.held.has(i.number) && !excluded,
	};
}

/** @param {RawIssue[]} issues */
function kindSetsOf(issues) {
	const numbersWith = (/** @type {string} */ label) =>
		new Set(
			issues.filter((i) => i.labels.includes(label)).map((i) => i.number),
		);
	return {
		mapNumbers: numbersWith("wayfinder:map"),
		specNumbers: numbersWith("kind:spec"),
	};
}

/**
 * @param {DepsResolved[]} withDeps
 * @param {Map<number, RawIssue>} byNumber
 * @param {Omit<EnrichContext, "inherit">} ctx
 */
function enrichAll(withDeps, byNumber, ctx) {
	const inherit = inheritanceOf(ctx.blockers, byNumber, ctx.goalRanked);
	const enriched = withDeps.map((i) => enrichIssue(i, { ...ctx, inherit }));
	return { enriched, inherit };
}

/**
 * @template {Issue} I
 * @param {I[]} enriched
 * @returns {I[]}
 */
function rankFrontier(enriched) {
	return enriched
		.filter((i) => !i.excluded)
		.sort((a, b) => compareLevels(a, b) || a.number - b.number);
}

module.exports = {
	EXCLUSION_CATEGORIES,
	enrichAll,
	kindSetsOf,
	proseBlockedOf,
	rankFrontier,
	tiersOf,
	WAITING_STALL_DAYS,
	waitCell,
};
