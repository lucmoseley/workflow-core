#!/usr/bin/env node
/*
 * check-issue-citations.js — periodic report on issue cross-references that
 * bury the issue number, making the referenced ticket hard to find.
 *
 * Usage:
 *   node check-issue-citations.js [--warn] [--json]
 *
 * docs/agents/issue-tracker.md §"Citing another issue" requires the number
 * before the title. The number is the only token that resolves in GitHub search
 * or `gh issue view`; titles on this repo run long enough that a title-first
 * citation costs a full sentence of reading before the reader can navigate.
 *
 * That rule is prose addressed to a model — a prior, not a mechanism. It has
 * already failed at scale: a single audit found 41 offending citations across 13
 * issues, 26 of them in mantahostels#8's decisions log alone, plus 8 blockers stated as bare
 * descriptions ("Blocked by the nav-layer ticket") with no number anywhere.
 *
 * The vendored `to-tickets` skill is a standing source of the fault: it tells
 * sessions a ticket's blocked-by list carries "the numbers/titles", silent on
 * order. A correction made in place is reverted on the next re-vendor unless it
 * is declared in .agents/vendored-skill-edits.json (mantahostels#1826), so
 * scripts/inject-tracker-docs.js overrides it per session instead, and this
 * script catches what slips through anyway.
 *
 * THIS SCRIPT NEVER WRITES. Rewriting a citation means resolving a description
 * to an issue and glossing it in the author's own words; a script that guessed
 * would be asserting a judgement nobody made.
 *
 * What it reports:
 *   TITLE-FIRST  a markdown link to an issue in THIS repo whose link text does
 *                not start with `#<n>` — the number is hidden in the URL.
 *                Counts toward the exit code.
 *   NO-NUMBER    a `Blocked by` / `Blocks` line carrying no `#<n>` at all.
 *                Worse than title-first: there is no number to find. Counts.
 *
 * Links to OTHER repositories' issues are ignored. `[Some upstream bug](
 * .../vercel/next.js/issues/123)` is a normal citation of someone else's
 * tracker, where our numbering convention has no purchase.
 *
 * Requires the `gh` CLI, authenticated.
 *
 * Outcomes follow the family alphabet in scripts/lib/check.js: an unreachable
 * GitHub is SKIP (exit 0), any other gh failure is BROKEN (exit 2, mantahostels#164 —
 * the ticket that drew that line), and a
 * buried citation is a FAIL finding (exit 1, or 0 under --warn).
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const { runCheck } = require("./lib/check");
const { readCitationFindings } = require("./lib/citation-findings-cache");
const { raiseGhFailure } = require("./lib/gh");
const { titleFirstLinks } = require("./lib/title-first-links");
const { requireKey } = require("./lib/workflow-core-config");

/* The config's `tracker`, read when the check runs rather than at load. */
let tracker = "";

// --- parsing ----------------------------------------------------------------

/*
 * A blocker line naming a blocker without its number, in two shapes.
 *
 * (1) The line carries no `#<n>` at all — "Blocked by the scope ticket."
 *
 * (2) The line carries a number AND a described blocker: "Blocked by the
 *     nav-layer ticket, and by #19". A bare `#<n>` test passes this, and mantahostels#26
 *     and mantahostels#29 both sat in exactly this form — half-cited, and the described
 *     half is no more findable for the numbered half sitting beside it.
 *
 *     Detected by the referring phrase itself: `the <hyphenated-name> <noun>`,
 *     where the noun is one of the handful this tracker uses for "an issue I am
 *     not naming". Deliberately narrow — a blocker line legitimately contains
 *     prose, and a loose rule here would flag every one of them.
 *
 *     Every `#<n>` and its gloss is stripped BEFORE that test, because the
 *     compliant form is itself a referring phrase: `#22 (the nav-layer
 *     question)` is exactly what the rule asks for, and testing the raw line
 *     flags the correction as the fault. What remains after stripping is a
 *     description with no number attached to it — the actual defect.
 */
const BLOCKER_LINE = /^[*_\-\s]*(?:un)?block(?:ed by|s|ing)\b/i;
const HEADING = /^\s{0,3}#{1,6}\s/;
const CITED = /#\d+\s*(?:\([^)]*\))?/g;
const REFERRING_PHRASE =
	/\bthe\s+[\w'-]+(?:\s+[\w'-]+){0,3}\s+(ticket|decision|route|question|audit|check|clean|issue)\b/i;
/*
 * "Blocked by nothing." states there is no blocker (#1656, #2389): none,
 * nothing or no blocker(s), after the verb or, after Blocking or Blocks, a
 * one-word label ending in a colon ("**Blocking question:** none.", where
 * "Blocked by upstream: nothing" names its blocker), wrapped in emphasis, a
 * bracket, a backtick, a quote or a dash, and ending its clause at the line's
 * end or at . ; : , ( or a dash. So "Blocked by the scope ticket; nothing
 * else" and "Blocked by nothing but the scope ticket" still report, and so
 * does an absence whose sentence goes on to a referring phrase
 * with no number ("Blocked by nothing, except the scope ticket."). That phrase
 * test is as narrow here as above: "Blocked by nothing, except upstream" passes.
 */
const NO_BLOCKER = new RegExp(
	// eslint-disable-next-line regexp/no-super-linear-backtracking -- input is issue, comment, commit or reply text from the repo's own writers; a crafted one slows the hook, nothing worse (#4642)
	`${BLOCKER_LINE.source}(?:(?<!by)\\s+\\w+(?=[*_]*:))?[\\s:*_\`'"(\\[—–-]*` +
		`(?:none|nothing|no blockers?)\\b[*_\`'")\\]]*\\s*(?:$|([.;:,(—–-]))`,
	"i",
);

/** @param {string} line */
function statesNoBlocker(line) {
	const m = NO_BLOCKER.exec(line);
	if (!m) return false;
	if (!m[1] || m[1] === ".") return true;
	const [sentence = ""] = line
		.slice(m.index + m[0].length)
		.split(/[.?!](?:\s|$)/);
	return !REFERRING_PHRASE.test(sentence.replace(CITED, " "));
}

/** @param {string} text */
function numberlessBlockers(text) {
	const found = [];
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line || HEADING.test(line)) continue;
		if (!BLOCKER_LINE.test(line)) continue;
		if (statesNoBlocker(line)) continue;
		if (/#\d+/.test(line) && !REFERRING_PHRASE.test(line.replace(CITED, " ")))
			continue;
		found.push(line.slice(0, 120));
	}
	return found;
}

/*
 * Each surface scanned on its own, so the report can say WHERE — a body
 * fault is fixed with `gh issue edit`, a comment fault needs the comments API
 * by its id, and pointing a reader at the wrong one wastes the trip.
 */
const scanner = () => ({
	/* Every source a finding depends on: a changed rule rescans the tracker. */
	version: crypto
		.createHash("sha256")
		.update(fs.readFileSync(__filename))
		.update(fs.readFileSync(require.resolve("./lib/title-first-links")))
		.digest("hex")
		.slice(0, 16),
	/** @param {string} text */
	body(text) {
		const links = titleFirstLinks(text, tracker);
		const lines = numberlessBlockers(text);
		return links.length > 0 || lines.length > 0 ? { links, lines } : null;
	},
	/* Blocker prose lives in bodies; a comment saying "blocked by X" is
	 * conversation, not the ticket's own state, so comments are scanned for
	 * title-first links alone. */
	/** @param {string} text */
	comment(text) {
		const links = titleFirstLinks(text, tracker);
		return links.length > 0 ? { links } : null;
	},
});

/**
 * The cached findings as the report's two lists, highest issue first.
 * @param {Record<string, import("./lib/citation-findings-cache").Entry>} issues
 */
function splitFindings(issues) {
	const titleFirst = [];
	const noNumber = [];
	const numbers = Object.keys(issues)
		.map(Number)
		.sort((a, b) => b - a);
	for (const number of numbers) {
		const e = /** @type {any} */ (issues[number]);
		const base = { number, title: e.title, url: e.url };
		if (e.body?.links.length)
			titleFirst.push({ ...base, where: "body", links: e.body.links });
		for (const [id, c] of Object.entries(e.comments))
			titleFirst.push({ ...base, where: `comment ${id}`, links: c.links });
		if (e.body?.lines.length) noNumber.push({ ...base, lines: e.body.lines });
	}
	return { titleFirst, noNumber };
}

/**
 * @param {any} ctx
 * @param {any[]} titleFirst
 * @param {number} linkCount
 */
function sayTitleFirst(ctx, titleFirst, linkCount) {
	ctx.say(
		`TITLE-FIRST (${linkCount} citation(s) across ${titleFirst.length} surface(s)) — number hidden in the URL:`,
	);
	for (const i of titleFirst) {
		ctx.say(`  #${i.number} ${i.title}  [${i.where}]\n    ${i.url}`);
		for (const l of i.links)
			ctx.say(`      → #${l.target} cited as "${l.linkText}"`);
	}
	ctx.say(
		"\n  Rewrite as `[#<n> — <title>](<url>)`. The title stays; the number leads.\n",
	);
}

/**
 * @param {any} ctx
 * @param {any[]} noNumber
 * @param {number} lineCount
 */
function sayNoNumber(ctx, noNumber, lineCount) {
	ctx.say(
		`NO-NUMBER (${lineCount} line(s) across ${noNumber.length} issue(s)) — blocker named by description only:`,
	);
	for (const i of noNumber) {
		ctx.say(`  #${i.number} ${i.title}\n    ${i.url}`);
		for (const l of i.lines) ctx.say(`      ${l}`);
	}
	ctx.say(
		"\n  Resolve each description to its issue and cite it `#<n> (<gloss>)`. The\n" +
			"  native dependency graph usually already knows the answer:\n" +
			`  \`gh api repos/${tracker}/issues/<n>/dependencies/blocked_by\`.\n`,
	);
}

/** @type {import("./lib/check").CheckSpec} */
const SPEC = {
	name: "issue-citations",
	usage: "node check-issue-citations.js [--warn] [--json]",
	async run(ctx) {
		tracker = requireKey("tracker");
		let found;
		try {
			found = await readCitationFindings(tracker, scanner());
		} catch (e) {
			return raiseGhFailure(e);
		}

		const { titleFirst, noNumber } = splitFindings(found.issues);

		// --- report ---------------------------------------------------------------

		const linkCount = titleFirst.reduce((n, i) => n + i.links.length, 0);
		const lineCount = noNumber.reduce((n, i) => n + i.lines.length, 0);
		const total = linkCount + lineCount;

		/* Keyed per SURFACE (`where` is the body or a comment id), not per
		 * citation: fixing one of three citations on one comment is a drain, and a
		 * key carrying the count would report it as an addition (mantahostels#2490). */
		for (const i of titleFirst)
			ctx.fail(
				"TITLE-FIRST",
				`#${i.number} [${i.where}] — ${i.links.length} citation(s) with the number hidden in the URL`,
				i,
				`TITLE-FIRST\t#${i.number}\t${i.where}`,
			);
		for (const i of noNumber)
			ctx.fail(
				"NO-NUMBER",
				`#${i.number} — ${i.lines.length} blocker line(s) naming no issue number`,
				i,
				`NO-NUMBER\t#${i.number}`,
			);

		const r = found.read;
		ctx.say(
			r.full
				? `Checked all ${r.issues} issue(s) and ${r.comments} comment(s) on ${tracker}.\n`
				: `Checked the ${r.issues} issue(s) and ${r.comments} comment(s) on ${tracker} changed since ${r.since};\n` +
						`every other surface's findings carried from the cache begun ${r.fullStamp}.\n`,
		);

		if (titleFirst.length > 0) sayTitleFirst(ctx, titleFirst, linkCount);

		if (noNumber.length > 0) sayNoNumber(ctx, noNumber, lineCount);

		return {
			okLine: "every issue cross-reference leads with its number.",
			// Counted per citation, not per surface: one issue body can bury several.
			count: total,
			noun: "citation(s) not leading with an issue number",
			data: { titleFirst, noNumber, linkCount, lineCount, total },
		};
	},
};

const main = () => runCheck(SPEC);

module.exports = { main };
if (require.main === module) main();
