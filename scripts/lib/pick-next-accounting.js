const { EXCLUSION_CATEGORIES } = require("./pick-next-verdict.js");
const { NO_COMMAND_VALUES, takesValue } = require("./takes-label.js");

/** @typedef {import("./pick-next-verdict.js").Issue} Issue */
/** @typedef {ReturnType<typeof import("./conflict-graph.js").buildGraph>} Graph */

const HUMAN = takesValue("human");
const CHILDREN = takesValue("children");

/** @typedef {"no command" | "file held by a running session" | "shares a file" | "no admission slot"} NotLaunchedReason */
/** @typedef {{number: number, reason: NotLaunchedReason, detail: object}} NotLaunchedRow */

/** @param {string[]} takes */
const takesCell = (takes) => (takes.length > 0 ? takes.join("+") : "none");

/** @satisfies {Record<NotLaunchedReason, (d: any) => string>} */
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

// guess, #591
const NOT_PROPOSED_PRINT_CAP = 20;

/**
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
 * @param {{frontier: Issue[], graph: Graph, admission: {freeSlots: number|null, admit: boolean}, noCommand: number[], retroBundles: {issues: number[]}[]}} state
 * @returns {NotLaunchedRow[]}
 */
function notLaunchedOf(state) {
	const { frontier, graph, admission, noCommand } = state;
	const noCommandSet = new Set(noCommand);
	const bundleOf = new Map(
		state.retroBundles.flatMap((b, k) => b.issues.map((n) => [n, k])),
	);
	/** @type {Map<number, boolean>} */
	const bundleSlotted = new Map();
	const dropped = new Map(graph.dropped.map((d) => [d.number, d]));
	const proposed = new Set(graph.proposed);
	const partners = new Set(
		graph.mergeable.flatMap((p) => [`${p.a}:${p.b}`, `${p.b}:${p.a}`]),
	);
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

/** @param {{enriched: Issue[], frontier: Issue[]}} state */
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
 * @param {string[]} takes
 * @param {number} openChildCount
 */
const noCommandOpens = (takes, openChildCount) =>
	takes.includes(HUMAN) || (takes.includes(CHILDREN) && openChildCount === 0);

/**
 * @template {Issue} I
 * @param {I[]} frontier
 * @param {Map<number, number>} openChildren
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

/** @param {SummaryInput} run */
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
		frontierCount: frontier.length,
		shown: shown.length,
		noCommand: run.noCommandCount,
		rottedContainers: run.rottedContainers,
		admit: admission.admit,
		freeSlots: admission.freeSlots,
		reclaimable: reclaimable.ok ? reclaimable.count : null,
		reclaimableUnknown: reclaimable.ok ? null : reclaimable.error,
		writeSets: {
			warm: cacheState.warm.length,
			provisional: cacheState.provisional.length,
			cold: cacheState.cold.length,
		},
		proposed: graph.proposed.map((n) => {
			const c = graph.candidates.find((/** @type {any} */ x) => x.number === n);
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
