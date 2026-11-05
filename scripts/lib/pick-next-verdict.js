/*
 * pick-next-verdict.js — each open issue's verdict in scripts/pick-next.js:
 * the sort levels it ranks on (mantahostels#106, #2001, #2664, #3222) and why it is
 * held out of the frontier, earliest-applicable first (mantahostels#105); and the
 * frontier those verdicts rank into.
 *
 * Every read is done in pick-next.js and handed in through `enrichIssue`'s
 * context: the blocker graph, the timelines, the claims, the ledger, the goal
 * set and the clock, a function so each age is read when it is computed.
 */

const blockerGraph = require("./blocker-graph.js");
const { compareLevels, WAITING_LABEL } = require("./frontier-order.js");
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
 * What the GitHub listing gives.
 * @typedef {object} RawIssue
 * @property {number} number
 * @property {string} state
 * @property {string} title
 * @property {string} url
 * @property {string} createdAt ISO 8601, GitHub's `created_at`
 * @property {string[]} assignees
 * @property {string[]} labels
 * @property {string} body
 * @property {string|null} parent
 * @property {number} openSubIssues its open children in every repo, by its
 *   sub_issues_summary
 * @property {string|null} repo the repo it lives in, `owner/name`
 */

/**
 * That, plus everything pick-next.js's `main` hangs on it before anything
 * reads one.
 *
 * EVERY FIELD IS OPTIONAL HERE, AND REQUIRED IN `Issue` BELOW, so a read placed
 * before the field is assigned does not compile (mantahostels#1637).
 *
 * IT DOES NOT CATCH ALL OF THEM. A field only used for its truthiness is not
 * protected, `undefined` being falsy like `false`: that is the booleans, the
 * two `unknown`s, and `urgency`/`urgentVia`/`wait`/`gate`/`gateOn`, whose types
 * already admit a falsy value.
 * @typedef {object} Enrichment
 * @property {string[]} [paths]
 * @property {import("./blocker-graph").Edge[]} [blockedBy]
 * @property {unknown} [depsUnknown]
 * @property {ReturnType<typeof blockerGraph.proseOf> & {unparsed: ReturnType<typeof import("./prose-blockers.js").unparsedBlockersOf>}} [proseBlocked]
 * @property {{label: string, native: boolean}[]} [openBlockers]
 * @property {number} [reach]
 * @property {ReturnType<typeof labelAge>|null} [urgency] the issue's own `urgent`'s age, null where the label is off
 * @property {import("./blocker-graph").Via|null} [urgentVia] the held issue whose `urgent` it inherits, null where none does
 * @property {import("./blocker-graph").Via|null} [bugVia] the held `bug` it inherits, null where none does
 * @property {import("./blocker-graph").Via|null} [goalVia] the held goal-set member it inherits, null where none does
 * @property {number} [depth]
 * @property {number} [closes]
 * @property {boolean} [bug]
 * @property {boolean} [urgent]
 * @property {ReturnType<typeof waitFrom>|null} [wait]
 * @property {number} [stallDays]
 * @property {ReturnType<typeof labelAge>|null} [parked] `parked`'s age, null where the label is off
 * @property {boolean} [goal]
 * @property {number} [collision]
 * @property {boolean} [asksQuestions]
 * @property {string[]} [takes]
 * @property {string} [group]
 * @property {ReturnType<import("./issue-gate").gateOf>} [gate]
 * @property {ReturnType<import("./issue-gate").gateOnOf>} [gateOn]
 * @property {boolean} [gateConflict]
 * @property {boolean} [gateHolds]
 * @property {boolean} [gateOnHolds]
 * @property {unknown} [excluded]
 * @property {import("./dispatch-ledger").DispatchRecord} [dispatchRec] the ledger entry holding it (#752)
 * @property {boolean} [dispatchHeld]
 * @property {boolean} [assignedUnclaimed]
 */

/**
 * Mid-enrichment: whatever `main` has assigned so far, nothing promised.
 * @typedef {RawIssue & Enrichment} Enriching
 */

/**
 * The first three fields resolved, the rest still pending. The passes that read
 * a blocker before the rest of enrichment has run take this rather than
 * `Enriching`.
 * @typedef {Enriching &
 *   Required<Pick<Enrichment, "blockedBy" | "depsUnknown" | "proseBlocked">>
 * } DepsResolved
 */

/**
 * Post-enrichment, which is what everything downstream of `main`'s enrichment
 * block reads.
 *
 * `paths` stays optional: `annotatePaths` (lib/pick-next-collisions.js)
 * returns it, on copies of the frontier and the in-flight set only, well
 * below `enrichIssue`. So does `dispatchRec`, absent wherever no ledger entry
 * holds the issue.
 * @typedef {RawIssue & Required<Omit<Enrichment, "paths" | "dispatchRec">> & {paths?: string[], dispatchRec?: import("./dispatch-ledger").DispatchRecord}} Issue
 */

/*
 * `waiting:external` — the action has been taken and now sits with someone
 * outside the project, so nobody here can move it (mantahostels#243).
 *
 * ESCALATES WITH AGE, NEVER DEMOTES. Sinking a waiting issue would make a stall
 * quieter the longer it ran, which is the failure mantahostels#85 (no working channel to
 * an outside partner) already suffered. So a wait at the threshold below climbs, and
 * one under it ranks exactly as it would with no label at all.
 *
 * 7 DAYS — the first of the three actions the evidence puts a date on, from
 * the wait-threshold research mantahostels#956 re-derived (75%, 65-85%, that 7
 * beats both 3 and 14), replacing the 14-day guess mantahostels#259 set;
 * docs/agents/triage-labels.md owns the figure. The research's later points — switch channel at
 * 21 days, non-responsive at 45 — need no threshold of their own: escalating is
 * a prompt to look rather than the action itself, and rank goes on climbing
 * with age past this one. A threshold rather than a curve because at most three
 * issues can carry this label, so a curve would tune invisible differences.
 *
 * Rejected — 14, which the same research also supports: its closest structural
 * match puts the modal first chase at 1-2 weeks, and a desk the adopter must
 * return to for the price-comparison consent makes being logged a nuisance an
 * asymmetric cost. 7 survives that because what fires here is the
 * receipt-confirmation chase the research separates out — a factual question an
 * inbox answers without deciding anything — not the decision chase.
 */
const WAITING_STALL_DAYS = 7;

/**
 * PROSE SELF-GATES (mantahostels#1289): `i`'s `**Blocked on**` references as
 * the graph judged them — this repo's against every open issue, already
 * fetched, at no extra call — and the marker lines that name no number.
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
 * Each issue's inherited tiers and chain depth (#3222), read at selection
 * time and never written onto it. A `bug`, an `urgent` and a goal-set member
 * pass on from any issue held out, as a blocker or as a parent (#3250).
 * @param {import("./blocker-graph").Graph} graph
 * @param {Map<number, RawIssue>} byNumber
 * @param {Set<number>} goalRanked the issues the goal tier ranks on
 */
function inheritanceOf(graph, byNumber, goalRanked) {
	/** @param {number} n @param {string} label */
	const has = (n, label) => byNumber.get(n)?.labels.includes(label) === true;
	// In compareLevels' order: depth runs to the first of these an issue holds.
	return blockerGraph.inheritance(graph, {
		bug: (n) => has(n, "bug"),
		urgent: (n) => has(n, URGENT_LABEL),
		goal: (n) => goalRanked.has(n),
	});
}

/**
 * The tier levels an issue ranks on: its own joined with what it inherits,
 * a `bug` urgent too (#2664).
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
 * The wait reads the same timeline for the same reason `urgent` does: a
 * hand-written date in the body rots, and nothing updates it when the wait
 * resets.
 *
 * An unreadable start leaves the wait unranked rather than assumed stalled: the
 * worst case is a stall keeping the rank it has today and printing `?`.
 * @param {{ok: boolean, events?: any[], error?: any}} timeline
 * @param {number} now ms since the epoch
 * @returns {{unknown: true, error: any, ageDays?: undefined, appliedAt?: undefined, appliedBy?: undefined, stalled?: undefined}
 *   | {unknown?: false, error?: undefined, ageDays: number, appliedAt: string, appliedBy: string, stalled: boolean}}
 */
function waitFrom(timeline, now) {
	const age = labelAge(timeline, WAITING_LABEL, now);
	return age.unknown
		? age
		: { ...age, stalled: age.ageDays >= WAITING_STALL_DAYS };
}

/**
 * The WAIT cell: whole days since `waiting:external` went on, `!` marking the
 * wait past the threshold — the only one the sort reads. `?` is the label on
 * with its start unreadable, which leaves the rank untouched.
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

/*
 * Collision estimate — the collision sort level (mantahostels#106), and its
 * weakest ruling (70%, band 55-82%). A `wayfinder:grilling` or `:research`
 * ticket resolves by writing a comment and closing an issue, touching no repo
 * file, so it cannot collide with a parallel session on `doc-map.md` or the
 * roadmap pair. Everything else is assumed to write. This reads labels applied
 * for other reasons — mantahostels#96 ruled out a label declaring what a
 * session will touch, because that is a promise agents break.
 */
const COMMENT_ONLY = ["wayfinder:grilling", "wayfinder:research"];
/** @param {RawIssue} issue */
const collisionOf = (issue) =>
	issue.labels.some((l) => COMMENT_ONLY.includes(l)) ? 0 : 1;

/*
 * Ticket type — #2001. A ticket that asks the founder questions ranks first,
 * so its round lands while the founder is present rather than behind a long
 * implement run. Untyped means no `wayfinder:` label at all: a `wayfinder:map`
 * asks nothing by itself. Every case needs `takes:wayfinder`, since a `takes:`
 * value overrides a type label that disagrees with it
 * (docs/agents/triage-labels.md §`takes:`).
 * Residual: labels are all it reads, so a ticket that asks questions without
 * one of these labels ranks as one that asks none.
 */
const QUESTION_TYPES = ["wayfinder:grilling", "wayfinder:prototype"];
const WAYFINDER_LABEL = takesLabel("wayfinder");
/** @param {RawIssue} issue */
const isQuestionType = (issue) =>
	issue.labels.includes(WAYFINDER_LABEL) &&
	(issue.labels.some((l) => QUESTION_TYPES.includes(l)) ||
		!issue.labels.some((l) => l.startsWith("wayfinder:")));

/**
 * What `enrichIssue` reads besides the issue itself.
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
 * @property {Set<number>} goalRanked the issues the goal tier ranks on
 * @property {() => number} now the clock, ms since the epoch
 */

/**
 * Why an issue is held out of the frontier, earliest-applicable first, or
 * null where nothing holds it.
 * @param {DepsResolved} i
 * @param {EnrichContext} ctx
 * @param {{openBlockers: {label: string, native: boolean}[], dispatchReason: string|null, resolved: ReturnType<typeof resolveGate>}} facts
 * @returns {string|null}
 */
function exclusionOf(i, ctx, facts) {
	const { openBlockers, dispatchReason, resolved } = facts;
	const { claims, parentHeld, listed, openChildren } = ctx;
	// `gateHolds`/`gateOnHolds` already prove non-null and non-malformed;
	// these locals carry that proof where the flag alone cannot.
	const gate = resolved.gate;
	const gateOn = resolved.gateOn;
	if (i.depsUnknown) return `readiness unknown — ${i.depsUnknown}`;
	if (openBlockers.length > 0)
		return `blocked by ${openBlockers
			.map((b) => (b.native ? b.label : `${b.label} (prose only)`))
			.join(", ")}`;
	if (claims.held.has(i.number))
		return `claimed by ${claimHolder(i.assignees, claims.held.get(i.number), claims.kept, listed.names)}`;
	const parent = parentHeld.held.get(i.number);
	if (parent)
		return `claimed through parent map ${parent.label} by ${claimHolder([], parent.sessionId, parent.kept, listed.names)}`;
	if (dispatchReason) return dispatchReason;
	if (openChildren.get(i.number)) {
		const unread = ctx.blockers.childrenUnread.get(i.number);
		return `container — ${openChildren.get(i.number)} open children${unread ? ` by its summary; sub-issues unreadable (${unread})` : ""}`;
	}
	if (resolved.gateHolds && gate && !gate.malformed)
		return `gated until ${gate.iso} (${gate.daysLeft}d) — ${gate.reason || "no reason given"}`;
	if (resolved.gateOnHolds && gateOn && !gateOn.malformed)
		return `gated on ${gateOn.condition}`;
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
	// Null unless the label is on: absence of a wait, distinct from a wait
	// whose start could not be read.
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
	/*
	 * Computed before the chain so the flag below can say whether THIS limb
	 * is the one that fired. An issue that is also blocked or claimed keeps
	 * that reason, and is reported there rather than in two blocks at once.
	 */
	const dispatchRec = holdingDispatch(ctx.dispatched, i.number, takes);
	const dispatchReason = dispatchRec
		? `dispatched ${dispatchAge(dispatchRec, ctx.now())}`
		: null;
	const excluded = exclusionOf(i, ctx, {
		openBlockers,
		dispatchReason,
		resolved,
	});
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
		// The one number the sort reads: 0 for everything that is not a stalled
		// wait, an unreadable age included.
		stallDays: wait && !wait.unknown && wait.stalled ? wait.ageDays : 0,
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
		dispatchHeld: dispatchReason !== null && excluded === dispatchReason,
		// Assigned, but no live session recorded a claim: fail open, and say so
		// under the shortlist rather than silently. Excluded issues are left out —
		// this run is not offering them.
		assignedUnclaimed:
			i.assignees.length > 0 && !ctx.claims.held.has(i.number) && !excluded,
	};
}

/**
 * The maps and the specs among `issues`, by their labels: the two kinds the
 * verdict's grouping and the parent-claim test read.
 * @param {RawIssue[]} issues
 */
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
 * Every issue's verdict, and the inheritance each passes on, worked out once
 * over the whole set first.
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
 * The frontier: every issue nothing holds out, in sort-level order, then by
 * number.
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
	enrichAll,
	kindSetsOf,
	proseBlockedOf,
	rankFrontier,
	tiersOf,
	WAITING_STALL_DAYS,
	waitCell,
};
