/*
 * pick-next-accounting.js — the figures scripts/pick-next.js counts off a
 * ranked frontier: why each frontier issue outside the set did not launch and
 * why each open issue was never takeable (#591), the dispatchable floor
 * (mantahostels#1507), the band no command opens (mantahostels#1626), and the run summary
 * the skill's §6 message is written from (mantahostels#1001), and the NOT
 * PROPOSED block's complete text (#4382).
 *
 * Every input is the run's own state, already read; nothing here reads
 * anything.
 */

const { EXCLUSION_CATEGORIES } = require("./pick-next-verdict.js");
const { NO_COMMAND_VALUES, takesValue } = require("./takes-label.js");

/** @typedef {import("./pick-next-verdict.js").Issue} Issue */
/** @typedef {ReturnType<typeof import("./conflict-graph.js").buildGraph>} Graph */

const HUMAN = takesValue("human");
const CHILDREN = takesValue("children");

/**
 * Why a frontier issue outside the set did not launch, in precedence order;
 * pick-next.js's render groups by that order.
 * @typedef {"no command" | "file held by a running session" | "shares a file" | "no admission slot"} NotLaunchedReason
 */
/** @typedef {{number: number, reason: NotLaunchedReason, detail: object}} NotLaunchedRow */

/**
 * An issue's `takes:` values as one table cell.
 * "none" is a fault, not a state — every open issue carries one.
 * @param {string[]} takes
 */
const takesCell = (takes) => (takes.length > 0 ? takes.join("+") : "none");

/**
 * The reasons in precedence order, each with its printed detail.
 * @satisfies {Record<NotLaunchedReason, (d: any) => string>} `any`: each
 * reason's detail has its own shape, built in `notLaunchedOf` below.
 */
const NOT_LAUNCHED_REASONS = {
	"no command": (d) => takesCell(d.takes),
	"file held by a running session": (d) =>
		`${d.session} holds ${d.files.join(", ")}`,
	"shares a file": (d) =>
		`with #${d.with} on ${d.file} (provisional — the band read confirms or clears it)`,
	"no admission slot": (d) =>
		`${d.freeSlots === null ? "free slots unknown" : `${d.slots} slot(s)`}, as of this run`,
};
/** @type {NotLaunchedReason[]} */
const REASON_ORDER = /** @type {NotLaunchedReason[]} */ (
	Object.keys(NOT_LAUNCHED_REASONS)
);

/** NOT PROPOSED rows printed; --json carries the lot. UNMEASURED, set to match pick-next.js's other print caps. */
const NOT_PROPOSED_PRINT_CAP = 20;

/**
 * The NOT PROPOSED block's lines, header first.
 * @param {NotLaunchedRow[]} rows
 * @returns {string[]}
 */
function notProposedLines(rows) {
	const sorted = [...rows].sort(
		(a, b) => REASON_ORDER.indexOf(a.reason) - REASON_ORDER.indexOf(b.reason),
	);
	const lines = [
		`\nNOT PROPOSED (${sorted.length}) — frontier issues outside the set, by the first reason that applies\n`,
	];
	if (sorted.length === 0) lines.push("  none");
	/** @type {NotLaunchedReason | null} */
	let shownReason = null;
	for (const e of sorted.slice(0, NOT_PROPOSED_PRINT_CAP)) {
		if (e.reason !== shownReason) lines.push(`  ${e.reason}:`);
		shownReason = e.reason;
		lines.push(`    #${e.number}  ${NOT_LAUNCHED_REASONS[e.reason](e.detail)}`);
	}
	if (sorted.length > NOT_PROPOSED_PRINT_CAP)
		lines.push(
			`  ... and ${sorted.length - NOT_PROPOSED_PRINT_CAP} more — --json carries every one.`,
		);
	return lines;
}

/**
 * WHY EACH FRONTIER ISSUE OUTSIDE THE SET DID NOT LAUNCH (#591), the reasons
 * pick-next can know. Earliest-applicable wins, in `NotLaunchedReason`'s
 * order; the skill adds the rest of the vocabulary (a prose gate, the
 * launcher's drops) and confirms or clears the provisional `shares a file`.
 *
 * A dropped issue in a merge-test pair with a set member rides that member's
 * line, so it is launched, not listed — and takes no slot of its own.
 * @param {{frontier: Issue[], graph: Graph, admission: {freeSlots: number|null, admit: boolean}, noCommand: number[], retroBundles: {issues: number[]}[]}} state
 * @returns {NotLaunchedRow[]}
 */
function notLaunchedOf(state) {
	const { frontier, graph, admission, noCommand } = state;
	const noCommandSet = new Set(noCommand);
	/* A retro bundle takes one slot, at its first-ranked member, and the rest
	 * ride it. Its members sit outside the conflict graph (#1105). */
	const bundleOf = new Map(
		state.retroBundles.flatMap((b, k) => b.issues.map((n) => [n, k])),
	);
	/** @type {Map<number, boolean>} bundle index -> whether it got a slot */
	const bundleSlotted = new Map();
	const dropped = new Map(graph.dropped.map((d) => [d.number, d]));
	const proposed = new Set(graph.proposed);
	/* Merged only onto the set member it clashed with: a pair partner elsewhere
	 * in the set does not carry it. */
	const partners = new Set(
		graph.mergeable.flatMap((p) => [`${p.a}:${p.b}`, `${p.b}:${p.a}`]),
	);
	/* The always-admit-one rule gives a slot where `freeSlots` reads 0 or
	 * unknown, so `admit` counts for one. */
	const slots = Math.max(admission.freeSlots ?? 0, admission.admit ? 1 : 0);
	let used = 0;
	const takeSlot = () => ++used <= slots;
	/**
	 * @param {number} number
	 * @returns {NotLaunchedRow}
	 */
	const noSlot = (number) => ({
		number,
		reason: "no admission slot",
		detail: { slots, freeSlots: admission.freeSlots },
	});
	/** @param {number} number */
	const slotRow = (number) => (takeSlot() ? null : noSlot(number));
	/**
	 * @param {number} bundle
	 * @param {number} number
	 */
	const bundleRow = (bundle, number) => {
		if (!bundleSlotted.has(bundle)) bundleSlotted.set(bundle, takeSlot());
		return bundleSlotted.get(bundle) ? null : noSlot(number);
	};
	const ctx = { noCommandSet, dropped, proposed, partners, slotRow };
	/** @type {NotLaunchedRow[]} */
	const out = [];
	for (const i of frontier) {
		const bundle = bundleOf.get(i.number);
		const row =
			bundle === undefined ? frontierRow(i, ctx) : bundleRow(bundle, i.number);
		if (row) out.push(row);
	}
	return out;
}

/**
 * `notLaunchedOf`'s verdict on one frontier issue outside a retro bundle:
 * its row, or null where it launches -- in the set on a slot of its own, or
 * riding a set member's merge-test line.
 * @param {Issue} i
 * @param {{noCommandSet: Set<number>, dropped: Map<number, Graph["dropped"][number]>, proposed: Set<number>, partners: Set<string>, slotRow: (n: number) => NotLaunchedRow | null}} ctx
 * @returns {NotLaunchedRow | null}
 */
function frontierRow(i, ctx) {
	if (ctx.noCommandSet.has(i.number))
		return {
			number: i.number,
			reason: "no command",
			detail: { takes: i.takes },
		};
	const d = ctx.dropped.get(i.number);
	if (!d) return ctx.slotRow(i.number);
	if (d.kind === "held")
		return {
			number: i.number,
			reason: "file held by a running session",
			detail: { files: d.paths, session: d.heldBy, sessionId: d.sessionId },
		};
	if (
		d.kind === "clash" &&
		ctx.proposed.has(d.with) &&
		ctx.partners.has(`${i.number}:${d.with}`)
	)
		return null;
	return {
		number: i.number,
		reason: "shares a file",
		detail: { with: d.with, file: d.paths[0], provisional: true },
	};
}

/**
 * Why the open issues outside the frontier were never takeable (#591).
 * @param {{enriched: Issue[], frontier: Issue[]}} state
 */
function openTallyOf(state) {
	return {
		open: state.enriched.length,
		frontier: state.frontier.length,
		categories: EXCLUSION_CATEGORIES.map((category) => {
			const numbers = state.enriched
				.filter((i) => i.exclusionCategory === category)
				.map((i) => i.number)
				.sort((a, b) => a - b);
			return { category, count: numbers.length, numbers };
		}),
	};
}

/**
 * DISPATCHABLE FLOOR (mantahostels#1507, mantahostels#1621). The numerator only — `graph.proposed`
 * minus every member whose `takes:` is `human` or `children`, the two
 * values no command opens (docs/agents/triage-labels.md §`takes:`). Never
 * folded against `admission.freeSlots` here: that figure is minutes stale
 * by the time §6 is written, so §5 takes `min(floor, a fresh admission.js
 * read)` instead. It over-counts by construction — a candidate with an
 * empty predicted write-set is admitted with nothing to clash on, and
 * conflict detection sees only predicted write-sets, never real ones
 * (mantahostels#1506) — deliberately left unrepaired, per mantahostels#1507.
 *
 * Plus one per retro bundle, which is one session (#1105).
 * @param {Graph} graph
 * @param {Issue[]} frontier
 * @param {number[][]} bundles
 * @returns {number}
 */
function dispatchableFloorOf(graph, frontier, bundles) {
	return (
		graph.proposed.filter((n) => {
			const i = frontier.find((x) => x.number === n);
			const takes = i ? i.takes : [];
			return !takes.some((t) => NO_COMMAND_VALUES.includes(t));
		}).length + bundles.length
	);
}

/**
 * NO COMMAND OPENS IT (mantahostels#1622, built at mantahostels#1626) — the accounting line's third
 * term. `takes:human` is founder work, and `takes:children` is a container
 * whose last child has closed: both sit on the frontier takeable by nobody a
 * `/`-command can start.
 *
 * THE OPEN-CHILD COUNT IS A PARAMETER, NOT AN ASSUMPTION. A live container is
 * held off the frontier by the exclusion cascade (`container — <n> open
 * children`), so on the frontier this arm fires only on the rotted case — but
 * any caller applying this to a different set owes the count itself. That is
 * the distinction against mantahostels#1507's `dispatchable` predicate, which subtracts
 * `children` unconditionally from `graph.proposed`: same two label values,
 * different rule, so the two deliberately do not share a body.
 *
 * @param {string[]} takes
 * @param {number} openChildCount
 */
const noCommandOpens = (takes, openChildCount) =>
	takes.includes(HUMAN) || (takes.includes(CHILDREN) && openChildCount === 0);

/**
 * THE ACCOUNTING LINE'S THIRD TERM (mantahostels#1622, built at mantahostels#1626) — the frontier
 * work no `/`-command opens, which the sum would otherwise force into
 * `disqualified` though it matches none of the three named disqualifiers.
 *
 * Counted by the script rather than left to the session because both inputs
 * are already computed per issue — the `takes:` value the TAKES column prints,
 * and the open-child count the exclusion cascade derives — so the session
 * copies a printed figure and the marker can pin it.
 *
 * `rottedContainers` names them by number, not merely counted: a
 * `takes:children` issue on the frontier is mislabelled by construction.
 * Retagging mid-selection was rejected (mantahostels#1622) — that is triage, not
 * selection — so the band is put in front of the session every run instead,
 * to be drained. `scripts/check-issue-labels.js` detects the same case and
 * retires nothing.
 * @template {Issue} I
 * @param {I[]} frontier
 * @param {Map<number, number>} openChildren open-child count, by issue
 * @returns {{noCommand: I[], rottedContainers: number[]}}
 */
function noCommandOf(frontier, openChildren) {
	const noCommand = frontier.filter((i) =>
		noCommandOpens(i.takes, openChildren.get(i.number) ?? 0),
	);
	return {
		noCommand,
		rottedContainers: noCommand
			.filter((i) => i.takes.includes(CHILDREN))
			.map((i) => i.number),
	};
}

/**
 * The run state `summaryOf` counts.
 * @typedef {object} SummaryInput
 * @property {Issue[]} enriched
 * @property {Issue[]} frontier
 * @property {Issue[]} shown
 * @property {{admit: boolean, freeSlots: number|null}} admission
 * @property {{ok: true, count: number}|{ok: false, error: string}} reclaimable
 * @property {{warm: unknown[], provisional: unknown[], cold: unknown[]}} cacheState
 * @property {Graph} graph
 * @property {Issue[]} degraded
 * @property {{why: string|null}} dispatched
 * @property {{ok: boolean, stranded?: number, carrying?: number|null, strandedWorktrees?: number|null}} stranded
 * @property {number} noCommandCount
 * @property {number[]} rottedContainers
 */

/**
 * Every figure the skill's §6 message needs, in one place (mantahostels#1001). Nothing
 * here is new; it is pick-next's `render*` blocks, counted.
 *
 * Over the whole frontier, never `shown`: the dispatch set is drawn from
 * the frontier, so a defect on a proposed member `--limit` cut off the
 * printed table went unreported (mantahostels#3363).
 * @param {SummaryInput} run
 */
function summaryOf(run) {
	const {
		enriched,
		frontier,
		shown,
		admission,
		reclaimable,
		cacheState,
		graph,
		degraded,
		dispatched,
		stranded,
	} = run;
	const labelDefects = frontier
		.filter((i) => i.takes.length !== 1)
		.map((i) => ({ number: i.number, takes: i.takes }));
	return {
		openIssues: enriched.length,
		// `frontierCount` and `payload.frontier.length` agree (mantahostels#1289).
		frontierCount: frontier.length,
		shown: shown.length,
		/*
		 * §5's third term, and its rotted members by number (mantahostels#1626). A count,
		 * not a judgement: `<U>` says no command opens these issues as they
		 * stand, which is a band rather than a fourth disqualifier.
		 */
		noCommand: run.noCommandCount,
		rottedContainers: run.rottedContainers,
		/*
		 * As of this run, and STALE by the time §6 is written: §5 sends the
		 * reader to `node scripts/admission.js` immediately before the dispatch
		 * lines (mantahostels#1144), because an over-admission freezes the machine. Carried
		 * so the summary reports what the run decided, never so §6 is written
		 * off it.
		 */
		admit: admission.admit,
		freeSlots: admission.freeSlots,
		reclaimable: reclaimable.ok ? reclaimable.count : null,
		reclaimableUnknown: reclaimable.ok ? null : reclaimable.error,
		writeSets: {
			warm: cacheState.warm.length,
			provisional: cacheState.provisional.length,
			cold: cacheState.cold.length,
		},
		/*
		 * Each member carries what §6's line is written from: its `takes:`
		 * value, and its write-set.
		 */
		proposed: graph.proposed.map((n) => {
			const c = graph.candidates.find((/** @type {any} */ x) => x.number === n);
			/*
			 * `frontier`, never `shown`: `graph.proposed` is built over the whole
			 * frontier, so a proposed member below the `--limit` cut missed this
			 * lookup and reported `takes: []`, indistinguishable from a genuinely
			 * unlabelled issue (mantahostels#3363).
			 */
			const i = frontier.find((/** @type {any} */ x) => x.number === n);
			return {
				number: n,
				takes: i ? i.takes : [],
				writeSet: c ? c.writeSet : [],
			};
		}),
		degraded: degraded.length,
		dispatchHeld: dispatched.why
			? null
			: enriched.filter((i) => i.dispatchHeld).length,
		dispatchHeldUnknown: dispatched.why,
		labelDefects,
		strandedClaims: stranded.ok ? stranded.stranded : null,
		strandedClaimsCarrying: stranded.ok ? stranded.carrying : null,
		strandedWorktrees: stranded.ok ? stranded.strandedWorktrees : null,
	};
}

module.exports = {
	dispatchableFloorOf,
	noCommandOf,
	notLaunchedOf,
	notProposedLines,
	openTallyOf,
	summaryOf,
	takesCell,
};
