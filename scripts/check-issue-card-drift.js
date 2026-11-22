#!/usr/bin/env node
/*
 * check-issue-card-drift.js — periodic report on GitHub issues whose roadmap
 * card state disagrees with them.
 *
 * Usage:
 *   node check-issue-card-drift.js [--warn] [--json] [<roadmap.html>]
 *   (default roadmap: docs/reference-roadmap.html)
 *
 * /card-close closes an issue and marks its card `done` in one pass, in that
 * order, precisely so the roadmap never falls behind. Nothing forces anyone to
 * use it. Closing an issue in the GitHub UI, or with a bare `gh issue close`,
 * leaves the card untouched and emits no signal at all — the roadmap simply
 * describes work as outstanding that was finished weeks ago, and there is no
 * error anywhere to notice.
 *
 * THIS SCRIPT NEVER WRITES. The roadmap is the sole authority for card state,
 * so a drift report must not "reconcile" anything: a script that flipped cards
 * to `done` from issue state would make the issue tracker the authority by the
 * back door, and would silently skip the done-log that is the card's real
 * content. It reports; a human decides and uses the roadmap-edit loop.
 *
 * Two directions, both reported:
 *   CLOSED-BUT-NOT-DONE  issue closed, card is not `done` — the drift that
 *                        prompted this check; almost always a close that
 *                        bypassed /card-close.
 *   DONE-BUT-STILL-OPEN  card is `done`, issue still open — the cheap failure
 *                        /card-close documents (step 8 failed after commit).
 *
 * Two more, added by mantahostels#1173 (which made a card's `"—"` — no Claude session
 * works it — and its own issue's `takes:human` label one concept) and never
 * blocked (ruled there): a `"—"` card whose own issue lacks `takes:human`,
 * and an unparented `takes:human` issue whose card is not `"—"`. Both skip
 * children on the same parentage discriminator as CHILD TICKETS below.
 *
 * Runs daily from the session-start launcher (scripts/repo-checks.js),
 * and on demand with
 * `npm run check:issues`.
 *
 * Requires the `gh` CLI, authenticated. Issue titles follow the tracker's
 * `<card-id> — <title>` (em dash) convention; a title that doesn't parse is
 * reported as UNPARSEABLE rather than guessed at, matching /card-close's rule
 * of never fuzzy-matching a title to a card.
 *
 * UNPARSEABLE lists only the unparented. A title with no card id is the normal
 * state of a closed issue, not an exception — 189 of 228 on 13 Aug 2026, by then
 * 189 of the report's 201 lines. Only a card's own issue can be drift and it has
 * no parent, so the parented are counted, not listed; `--json` carries them.
 * Same discriminator, and same residual, as the CHILD TICKET rule below. The
 * open side has always skipped these outright. Ruled at mantahostels#277.
 *
 * A CHILD TICKET carries the prefix without being the card's issue. A card
 * charted as a /wayfinder map spawns child tickets that inherit its id in their
 * titles, so closing one says nothing about the card — the map is still running.
 * Read the wrong way round, every closed child is a card reported as finished
 * early, which is what all 26 of this check's FAILs were before mantahostels#275 (the ticket
 * that fixed it).
 *
 * The discriminator is parentage, a native GitHub relation rather than a
 * convention anyone has to remember. Measured 13 Aug 2026 over the 39 closed
 * issues carrying a card-id prefix: all 33 child tickets had a parent; of the 6
 * without, 5 are a card's own issue and one (mantahostels#219) is a spin-off that borrowed
 * the prefix — the known residual, invisible to this rule. Both rivals lost — a
 * `wayfinder:*` label separates only 26 of the 33, and requiring `wayfinder:map`
 * on the card issue would silence two genuine ones (mantahostels#211, mantahostels#2) that never
 * carried it.
 *
 * Outcomes follow the family alphabet in scripts/lib/check.js. The roadmap is
 * tracked in the repo, so one that will not read or will not parse is BROKEN
 * (exit 2).
 * An unreachable GitHub is SKIP (exit 0); any other gh failure is BROKEN (mantahostels#164 — the ticket that drew
 * that line).
 */

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

// Titles are `<card-id> — <title>`, em dash. Accept an en/em dash or a hyphen
// surrounded by spaces, but never fall back to matching the title text.
/** @param {string} title */
function cardIdOf(title) {
	const m = title.match(/^\s*([A-Za-z0-9._-]+)\s+[—–-]\s+/);
	return m ? m[1] : null;
}

// Same extraction the digest generator uses: slice the `const ITEMS = [...]`
// literal and evaluate only that slice, rather than regexing card fields out
// of prose that legitimately contains braces, quotes and inline HTML.
// `any[]`: the value comes out of `new Function(...)()`, and nothing here
// statically knows its shape — the caller pins it to RoadmapItem[] above.
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
 * The roadmap's cards, read and parsed; BROKEN when either step fails.
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
 * Each card's state, and whether it carries the "—" marker, keyed by card id.
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

// `parent` and `labels` ride along in the list call — gh serves them as
// fields, so the takes:human/`—` verdicts below (mantahostels#1173) cost no extra
// request.
/** @param {string} state @returns {GhIssue[]} */
const ghIssues = (state) =>
	ghIssueListAll(`${state} issues`, [
		"--state",
		state,
		"--json",
		"number,title,state,closedAt,url,parent,labels",
	]);

// Named for the field it reads: sibling checkers have their own parentOf
// taking a parent_issue_url string, and this one takes a gh issue row.
/** @param {GhIssue} iss */
const parentNumber = (iss) => iss.parent?.number ?? null;

/** @param {GhIssue} iss */
const hasHuman = (iss) => iss.labels.some((l) => l.name === HUMAN_LABEL);

/**
 * @typedef {{ closedNotDone: any[], doneStillOpen: any[], unparseable: GhIssue[],
 *   unparseableParented: GhIssue[], unknownCard: any[], childTicket: any[] }} Buckets
 */

/**
 * Sort the closed issues into `buckets`.
 * @param {GhIssue[]} closed
 * @param {Map<string, string>} cardState
 * @param {Buckets} buckets accumulator: each drifting closed issue is pushed
 *   onto its bucket
 */
function classifyClosed(closed, cardState, buckets) {
	for (const iss of closed) {
		const id = cardIdOf(iss.title);
		if (!id) {
			// Parented ones are counted, not listed — see the header (mantahostels#277).
			if (parentNumber(iss) === null) buckets.unparseable.push(iss);
			else buckets.unparseableParented.push(iss);
			continue;
		}
		if (!cardState.has(id)) {
			buckets.unknownCard.push({ ...iss, id });
			continue;
		}
		if (cardState.get(id) === "done") continue;
		// After the done check, so only issues that would OTHERWISE have been
		// reported land in childTicket. Recording every parented issue that
		// carries a prefix would rebuild the wall of noise this exists to
		// remove — one map alone has 27 — while saying nothing about drift.
		const parent = parentNumber(iss);
		if (parent !== null) {
			buckets.childTicket.push({ ...iss, id, parent });
			continue;
		}
		buckets.closedNotDone.push({ ...iss, id, state: cardState.get(id) });
	}
}

/**
 * Sort the open issues into `buckets`.
 * @param {GhIssue[]} open
 * @param {Map<string, string>} cardState
 * @param {Buckets} buckets accumulator: each drifting open issue is pushed
 *   onto its bucket
 */
function classifyOpen(open, cardState, buckets) {
	for (const iss of open) {
		const id = cardIdOf(iss.title);
		if (!id) continue; // an open issue needn't be a card yet
		if (cardState.get(id) !== "done") continue;
		const parent = parentNumber(iss);
		if (parent !== null) {
			buckets.childTicket.push({ ...iss, id, parent });
			continue;
		}
		buckets.doneStillOpen.push({ ...iss, id });
	}
}

// A card id can carry more than one unparented issue in practice (a
// stale spin-off, a reopened one) — keyed to an array, not last-wins, so
// every one is checked rather than nine of ten going silently unseen.
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
 * "—" cards whose own issue lacks takes:human.
 * @param {Map<string, boolean>} cardDash
 * @param {Map<string, GhIssue[]>} ownIssuesByCardId
 */
function dashNotHumanOf(cardDash, ownIssuesByCardId) {
	const dashNotHuman = [];
	for (const [id, isDash] of cardDash) {
		if (!isDash) continue;
		// Accepted limit: most "—" cards have no issue at all, so this only
		// reaches cards that have one.
		for (const own of ownIssuesByCardId.get(id) || [])
			if (!hasHuman(own)) dashNotHuman.push({ ...own, id });
	}
	return dashNotHuman;
}

/**
 * takes:human own issues whose card carries no "—".
 * @param {Map<string, GhIssue[]>} ownIssuesByCardId
 * @param {Map<string, string>} cardState
 * @param {Map<string, boolean>} cardDash
 */
function humanNotDashOf(ownIssuesByCardId, cardState, cardDash) {
	const humanNotDash = [];
	for (const [id, owns] of ownIssuesByCardId) {
		if (!cardState.has(id)) continue; // card's own issue but no such card
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
	// Both counts, so a short list never reads as the whole population.
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

		// --- roadmap card state -------------------------------------------------

		const { cardState, cardDash } = cardMaps(
			readRoadmapItems(ctx, roadmapPath),
		);

		// A roadmap where nothing carries a state means the field was renamed, not
		// that every card is incomplete. Reporting every closed issue as drift off
		// the back of that would be a wall of false positives, so refuse instead.
		if (
			cardState.size > 0 &&
			[...cardState.values()].every((s) => s === "(no state)")
		)
			ctx.broken(
				`no card in ${roadmapPath} has a "state" field — the card schema\n` +
					"       has probably changed. Refusing to report drift against it.",
			);

		// --- issues -------------------------------------------------------------

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

		// --- "—" / takes:human mismatch (mantahostels#1173) ---------------------------------
		// Skip children on the same parentage discriminator as CHILD TICKETS
		// above: a takes:human child under a card with real build work is
		// correct, not drift.
		const ownIssuesByCardId = ownIssuesByCard([...closed, ...open]);
		const dashNotHuman = dashNotHumanOf(cardDash, ownIssuesByCardId);
		const humanNotDash = humanNotDashOf(ownIssuesByCardId, cardState, cardDash);

		// --- report -------------------------------------------------------------

		const driftCount = closedNotDone.length + doneStillOpen.length;

		/* The issue number alone is the key (mantahostels#2490): the card id and its state
		 * both ride in the message and both move while the drift stays the same
		 * drift. */
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
