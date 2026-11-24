#!/usr/bin/env node

const fs = require("node:fs");
const { runCheck } = require("./lib/check");
const { ghIssueListAll, raiseGhFailure } = require("./lib/gh");
const { takesLabel } = require("./lib/takes-label");

const HUMAN_LABEL = takesLabel("human");

/**
 * @typedef {{number: number, title: string, state: string, closedAt: string|null,
 *   url: string, parent: {number: number}|null, labels: {name: string}[]}} GhIssue
 * @typedef {{id?: string, state?: string, m?: unknown}} RoadmapItem
 */

/** @param {string} title */
function cardIdOf(title) {
	const m = title.match(/^\s*([A-Za-z0-9._-]+)\s+[—–-]\s+/);
	return m ? m[1] : null;
}

/** @param {string} html @param {string} decl @returns {any[]} */
function extractArray(html, decl) {
	const start = html.indexOf(decl);
	if (start === -1) throw new Error(`could not find "${decl}"`);
	const end = html.indexOf("\n];", start);
	if (end === -1)
		throw new Error(`could not find closing "\\n];" after "${decl}"`);
	const block = html.slice(start, end + 3);
	const name = decl.match(/const (\w+)/)?.[1];
	if (!name) throw new Error(`could not read the declared name from "${decl}"`);
	return new Function(`${block}\nreturn ${name};`)();
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {string} roadmapPath
 * @returns {RoadmapItem[]}
 */
function readRoadmapItems(ctx, roadmapPath) {
	/** @type {string} */
	let html;
	try {
		html = fs.readFileSync(roadmapPath, "utf8");
	} catch (e) {
		ctx.broken(
			`cannot read ${roadmapPath}: ${e instanceof Error ? e.message : e}`,
		);
	}

	/** @type {RoadmapItem[]} */
	let items = [];
	try {
		items = extractArray(html, "const ITEMS = [");
	} catch (e) {
		ctx.broken(
			`cannot parse cards from ${roadmapPath}: ${e instanceof Error ? e.message : e}`,
		);
	}
	return items;
}

/**
 * @param {RoadmapItem[]} items
 */
function cardMaps(items) {
	const cardState = new Map();
	const cardDash = new Map();
	for (const it of items) {
		if (it?.id) cardState.set(it.id, it.state || "(no state)");
		if (it?.id) cardDash.set(it.id, it.m === "—");
	}
	return { cardState, cardDash };
}

/** @param {string} state @returns {GhIssue[]} */
const ghIssues = (state) =>
	ghIssueListAll(`${state} issues`, [
		"--state",
		state,
		"--json",
		"number,title,state,closedAt,url,parent,labels",
	]);

/** @param {GhIssue} iss */
const parentNumber = (iss) => iss.parent?.number ?? null;

/** @param {GhIssue} iss */
const hasHuman = (iss) => iss.labels.some((l) => l.name === HUMAN_LABEL);

/**
 * @typedef {{ closedNotDone: any[], doneStillOpen: any[], unparseable: GhIssue[],
 *   unparseableParented: GhIssue[], unknownCard: any[], childTicket: any[] }} Buckets
 */

/**
 * @param {GhIssue[]} closed
 * @param {Map<string, string>} cardState
 * @param {Buckets} buckets
 */
function classifyClosed(closed, cardState, buckets) {
	for (const iss of closed) {
		const id = cardIdOf(iss.title);
		if (!id) {
			if (parentNumber(iss) === null) buckets.unparseable.push(iss);
			else buckets.unparseableParented.push(iss);
			continue;
		}
		if (!cardState.has(id)) {
			buckets.unknownCard.push({ ...iss, id });
			continue;
		}
		if (cardState.get(id) === "done") continue;
		const parent = parentNumber(iss);
		if (parent !== null) {
			buckets.childTicket.push({ ...iss, id, parent });
			continue;
		}
		buckets.closedNotDone.push({ ...iss, id, state: cardState.get(id) });
	}
}

/**
 * @param {GhIssue[]} open
 * @param {Map<string, string>} cardState
 * @param {Buckets} buckets
 */
function classifyOpen(open, cardState, buckets) {
	for (const iss of open) {
		const id = cardIdOf(iss.title);
		if (!id) continue;
		if (cardState.get(id) !== "done") continue;
		const parent = parentNumber(iss);
		if (parent !== null) {
			buckets.childTicket.push({ ...iss, id, parent });
			continue;
		}
		buckets.doneStillOpen.push({ ...iss, id });
	}
}

/** @param {GhIssue[]} issues */
function ownIssuesByCard(issues) {
	const ownIssuesByCardId = new Map();
	for (const iss of issues) {
		const id = cardIdOf(iss.title);
		if (!id || parentNumber(iss) !== null) continue;
		if (!ownIssuesByCardId.has(id)) ownIssuesByCardId.set(id, []);
		ownIssuesByCardId.get(id).push(iss);
	}
	return ownIssuesByCardId;
}

/**
 * @param {Map<string, boolean>} cardDash
 * @param {Map<string, GhIssue[]>} ownIssuesByCardId
 */
function dashNotHumanOf(cardDash, ownIssuesByCardId) {
	const dashNotHuman = [];
	for (const [id, isDash] of cardDash) {
		if (!isDash) continue;
		for (const own of ownIssuesByCardId.get(id) || [])
			if (!hasHuman(own)) dashNotHuman.push({ ...own, id });
	}
	return dashNotHuman;
}

/**
 * @param {Map<string, GhIssue[]>} ownIssuesByCardId
 * @param {Map<string, string>} cardState
 * @param {Map<string, boolean>} cardDash
 */
function humanNotDashOf(ownIssuesByCardId, cardState, cardDash) {
	const humanNotDash = [];
	for (const [id, owns] of ownIssuesByCardId) {
		if (!cardState.has(id)) continue;
		if (cardDash.get(id)) continue;
		for (const iss of owns)
			if (hasHuman(iss)) humanNotDash.push({ ...iss, id });
	}
	return humanNotDash;
}

/**
 * @param {any} ctx
 * @param {any[]} closedNotDone
 */
function sayClosedNotDone(ctx, closedNotDone) {
	if (closedNotDone.length === 0) return;
	ctx.say(`CLOSED-BUT-NOT-DONE (${closedNotDone.length}):`);
	for (const i of closedNotDone)
		ctx.say(
			`  #${i.number} ${i.id} — card is "${i.state}", issue closed ${(
				i.closedAt || ""
			).slice(0, 10)}\n    ${i.url}`,
		);
	ctx.say(
		"\n  Likely closed outside /card-close. The roadmap stays authoritative:\n" +
			"  decide the real state, then record it through the roadmap-edit loop\n" +
			"  with a proper done-log. Do not batch-flip these.\n",
	);
}

/**
 * @param {any} ctx
 * @param {any[]} doneStillOpen
 */
function sayDoneStillOpen(ctx, doneStillOpen) {
	if (doneStillOpen.length === 0) return;
	ctx.say(`DONE-BUT-STILL-OPEN (${doneStillOpen.length}):`);
	for (const i of doneStillOpen)
		ctx.say(`  #${i.number} ${i.id} — card is done, issue open\n    ${i.url}`);
	ctx.say(
		"\n  The cheap direction of failure (/card-close step 8). Re-run\n" +
			"  `gh issue close <n>` once the card is confirmed correct.\n",
	);
}

/**
 * @param {any} ctx
 * @param {any[]} childTicket
 */
function sayChildTickets(ctx, childTicket) {
	if (childTicket.length === 0) return;
	const byParent = new Map();
	for (const i of childTicket)
		byParent.set(i.parent, (byParent.get(i.parent) || 0) + 1);
	ctx.say(
		`CHILD TICKETS (${childTicket.length}) — carry a card's id but are not its issue, so not drift:`,
	);
	for (const [parent, n] of [...byParent].sort((a, b) => b[1] - a[1]))
		ctx.say(`  ${n} under #${parent}`);
	ctx.say("");
}

/**
 * @param {any} ctx
 * @param {any[]} dashNotHuman
 */
function sayDashNotHuman(ctx, dashNotHuman) {
	if (dashNotHuman.length === 0) return;
	ctx.say(
		`"—" CARD, ISSUE NOT takes:human (${dashNotHuman.length}) — card marked "—" but its own issue lacks the label:`,
	);
	for (const i of dashNotHuman) ctx.say(`  #${i.number} ${i.id}\n    ${i.url}`);
	ctx.say(
		"\n  Not blocked — reconcile by hand: either the card wrongly carries\n" +
			'  "—" or the issue is missing takes:human.\n',
	);
}

/**
 * @param {any} ctx
 * @param {any[]} humanNotDash
 */
function sayHumanNotDash(ctx, humanNotDash) {
	if (humanNotDash.length === 0) return;
	ctx.say(
		`takes:human ISSUE, CARD NOT "—" (${humanNotDash.length}) — own issue is takes:human but the card carries no "—":`,
	);
	for (const i of humanNotDash) ctx.say(`  #${i.number} ${i.id}\n    ${i.url}`);
	ctx.say("\n  Not blocked — reconcile by hand.\n");
}

/**
 * @param {any} ctx
 * @param {any[]} unknownCard
 */
function sayUnknownCard(ctx, unknownCard) {
	if (unknownCard.length === 0) return;
	ctx.say(`UNKNOWN CARD (${unknownCard.length}) — title prefix names no card:`);
	for (const i of unknownCard) ctx.say(`  #${i.number} "${i.title}" → ${i.id}`);
	ctx.say("");
}

/**
 * @param {any} ctx
 * @param {GhIssue[]} unparseable
 * @param {GhIssue[]} unparseableParented
 */
function sayUnparseable(ctx, unparseable, unparseableParented) {
	if (unparseable.length === 0 && unparseableParented.length === 0) return;
	const seen = unparseable.length + unparseableParented.length;
	ctx.say(
		`UNPARSEABLE TITLE (${unparseable.length} of ${seen}) — not \`<card-id> — <title>\`, unparented only:`,
	);
	for (const i of unparseable) ctx.say(`  #${i.number} "${i.title}"`);
	if (unparseableParented.length > 0)
		ctx.say(
			`  ${unparseableParented.length} parented, omitted — a card's own issue has none. --json carries them.`,
		);
	ctx.say("  Not guessed at, by design. Reported only.\n");
}

runCheck({
	name: "issue-card-drift",
	module: "roadmap",
	usage: "node check-issue-card-drift.js [--warn] [--json] [<roadmap.html>]",
	run(ctx) {
		const roadmapPath = ctx.args[0] || "docs/reference-roadmap.html";

		const { cardState, cardDash } = cardMaps(
			readRoadmapItems(ctx, roadmapPath),
		);

		if (
			cardState.size > 0 &&
			[...cardState.values()].every((s) => s === "(no state)")
		)
			ctx.broken(
				`no card in ${roadmapPath} has a "state" field — the card schema\n` +
					"       has probably changed. Refusing to report drift against it.",
			);

		/** @type {GhIssue[]} */
		let closed = [];
		/** @type {GhIssue[]} */
		let open = [];
		try {
			closed = ghIssues("closed");
			open = ghIssues("open");
		} catch (e) {
			raiseGhFailure(e, "No drift conclusion drawn.");
		}

		/** @type {Buckets} */
		const buckets = {
			closedNotDone: [],
			doneStillOpen: [],
			unparseable: [],
			unparseableParented: [],
			unknownCard: [],
			childTicket: [],
		};
		classifyClosed(closed, cardState, buckets);
		classifyOpen(open, cardState, buckets);
		const {
			closedNotDone,
			doneStillOpen,
			unparseable,
			unparseableParented,
			unknownCard,
			childTicket,
		} = buckets;

		const ownIssuesByCardId = ownIssuesByCard([...closed, ...open]);
		const dashNotHuman = dashNotHumanOf(cardDash, ownIssuesByCardId);
		const humanNotDash = humanNotDashOf(ownIssuesByCardId, cardState, cardDash);

		const driftCount = closedNotDone.length + doneStillOpen.length;

		for (const i of closedNotDone)
			ctx.fail(
				"CLOSED-BUT-NOT-DONE",
				`#${i.number} ${i.id} — card is "${i.state}", issue closed`,
				i,
				`CLOSED-BUT-NOT-DONE\t#${i.number}`,
			);
		for (const i of doneStillOpen)
			ctx.fail(
				"DONE-BUT-STILL-OPEN",
				`#${i.number} ${i.id} — card is done, issue still open`,
				i,
				`DONE-BUT-STILL-OPEN\t#${i.number}`,
			);

		ctx.say(
			`Checked ${closed.length} closed and ${open.length} open issue(s) against ` +
				`${cardState.size} cards in ${roadmapPath}.\n`,
		);

		sayClosedNotDone(ctx, closedNotDone);
		sayDoneStillOpen(ctx, doneStillOpen);
		sayChildTickets(ctx, childTicket);
		sayDashNotHuman(ctx, dashNotHuman);
		sayHumanNotDash(ctx, humanNotDash);
		sayUnknownCard(ctx, unknownCard);
		sayUnparseable(ctx, unparseable, unparseableParented);

		return {
			okLine: "no issue/card drift.",
			noun: "disagreement(s)",
			data: {
				closedNotDone,
				doneStillOpen,
				unparseable,
				unparseableParented,
				unknownCard,
				childTicket,
				dashNotHuman,
				humanNotDash,
				driftCount,
			},
		};
	},
});
