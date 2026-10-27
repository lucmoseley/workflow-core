#!/usr/bin/env node
/*
 * report-doc-map-budget.js — the issue-filing half of mantahostels#971 (the ticket that put a
 * published word budget on docs/doc-map.md §B, the load-bearing figure registry).
 *
 * Usage (from the repo root):
 *   node report-doc-map-budget.js [<doc-map.md>] [--dry-run]
 *   (default: docs/doc-map.md; --dry-run prints the verdict and touches no issue)
 *
 * §B has a budget of 80,000 words. The breach is STANDING REPO STATE, not a
 * property of any commit, and the session that crosses the line is not the one
 * that can pay — so this never fails a build and never refuses a commit (mantahostels#894).
 * It files ONE issue, from the daily repo-checks run, through the seam
 * report-manual-staleness.js files the manual's on (mantahostels#389).
 * check-doc-map.js prints the figure; this is the only thing that acts on it.
 *
 * **The budget is a level plus stated headroom** (mantahostels#1311, re-based at mantahostels#1079):
 * 80,000 records where §B was measured plus what the headroom buys, and it
 * resets downward on a drain. mantahostels#1311's never-upward limb is overturned at mantahostels#1079 — a level no ruled mechanism can
 * reach reports nothing, so a budget the drain cannot meet is re-set upward
 * with its headroom stated. The issue this files is NOT open indefinitely: it
 * closes when §B is under budget, and `openTrackingIssue` matches open issues
 * only, so the next breach files a fresh one with a fresh drain queue.
 *
 * The body also carries a births-over-cap line (mantahostels#1384).
 *
 * Exit is 0 whether or not §B is over budget; the issue is the signal. It exits
 * 2, and only 2, when it cannot do its job: the map unreadable, no §B to
 * measure, gh refusing, or a command line lib/cli-args.js refuses.
 */

const fs = require("node:fs");
const { parseOrExit } = require("./lib/cli-args");
const { errMessage } = require("./lib/check");
const {
	sectionBRange,
	sectionBWords,
	sectionBEntryCount,
	sectionBEntryRate,
	overCapEntries,
	readSectionBBirths,
	malformedExemptionMarkers,
	PROSE_CAP_WORDS,
} = require("./lib/doc-map");
const { fileOrRefresh } = require("./lib/tracking-issue");
const { takesLabel } = require("./lib/takes-label");

/**
 * Settled at mantahostels#894; re-set 50,000 -> 80,000 at mantahostels#1079, being §B's measured level
 * on 3 September 2026 (72,519 words, 169 entries) plus 7,481 words of headroom
 * — about 17 entries at that day's 429-word mean.
 */
const BUDGET_WORDS = 80_000;

/**
 * `openTrackingIssue` (lib/tracking-issue.js) matches the open issue by this
 * exact string, so changing it orphans whatever issue carries the old title —
 * the next run files a duplicate instead of refreshing it. A future edit here
 * must retitle the live issue in the same session (mantahostels#1317).
 */
const TITLE = "doc-map §B — drain the entries over the 300-word prose cap";
/** What the open-issue lookup matches on, alongside the exact title. */
const LABEL = "documentation";
/**
 * The `takes:` value while the drain queue holds an unexempted entry. Paying is
 * a specified unit of work — bring the named entry under the cap — so it is
 * `/implement` that opens it (mantahostels#1079).
 */
const TAKES_QUEUED = takesLabel("implement");
/**
 * The `takes:` value while the queue is empty yet §B is still over budget:
 * every remaining over-cap entry is exempted by ruling, so what is left is a
 * decision — raise the budget or revoke an exemption — and a founder decision
 * takes `/wayfinder` (mantahostels#3439). Never `takes:human`: that names an act outside
 * Claude Code, and there is none here (mantahostels#3352).
 */
const TAKES_EMPTY = takesLabel("wayfinder");

/**
 * Which of the two the issue should carry now.
 *
 * Read off the SAME `overCapEntries` the body's queue is rendered from, so the
 * label cannot disagree with the worklist printed under it.
 *
 * @param {{ exemptedAt: number | null }[]} overCap
 */
function takesNow(overCap) {
	return overCap.some((e) => e.exemptedAt === null)
		? TAKES_QUEUED
		: TAKES_EMPTY;
}

/**
 * GFM inline code, safe against a backtick run inside `text` (mantahostels#2269): the
 * fence grows past the longest run in the text, padded with a space per the
 * spec's own escape so the fence characters don't fuse with the content.
 * @param {string} text
 */
function mdInlineCode(text) {
	let fence = "`";
	while (text.includes(fence)) fence += "`";
	const pad = fence.length > 1 ? " " : "";
	return `${fence}${pad}${text}${pad}${fence}`;
}

/** @param {number} words */
function verdict(words) {
	const budget = BUDGET_WORDS.toLocaleString("en-GB");
	const pct = Math.round((words / BUDGET_WORDS) * 100);
	const gap = Math.abs(words - BUDGET_WORDS).toLocaleString("en-GB");
	return (
		`§B is ${words.toLocaleString("en-GB")} words — ${pct}% of the ` +
		`${budget}-word budget, ` +
		(words > BUDGET_WORDS ? `over by ${gap}.` : `with ${gap} to spare.`)
	);
}

/**
 * The level signal mantahostels#1316 adopted in place of a scheduled or heterogeneity
 * trigger: §B's entry count and its trailing-7-day entries/day rate. No
 * threshold and no trigger — mantahostels#1316 refused both — so this only ever reports.
 * @param {number} entries
 * @param {{ rate: number, days: number } | null} rate
 */
function buildLevelLine(entries, rate) {
	const rateText = rate
		? `${rate.rate >= 0 ? "+" : ""}${rate.rate.toFixed(1)}/day over the last ${rate.days.toFixed(1)} day(s) of git history`
		: "rate unavailable (docs/doc-map.md's git history could not be read)";
	return `§B holds ${entries} entries, ${rateText}.`;
}

/**
 * How many over-cap births the line names before it stops counting them: past
 * this the count is the signal and the names are only a drain's starting point
 * (mantahostels#1384).
 */
const BIRTH_NAMES = 10;

/**
 * How many §B entries were born over the 300-word prose cap in the trailing
 * window (mantahostels#1384). No threshold and no trigger, as with `buildLevelLine` above: it
 * reports and never fails.
 *
 * Measured at each entry's BIRTH commit, not at HEAD, so an entry drained
 * since still reports what it was born at.
 * @param {{ born: {id: string, words: number, sha: string}[], days: number } | null} births
 */
function buildBirthsLine(births) {
	if (!births)
		return "Births over cap unavailable (docs/doc-map.md's git history could not be read).";
	const over = births.born
		.filter((b) => b.words > PROSE_CAP_WORDS)
		.sort((a, b) => b.words - a.words);
	const named = over
		.slice(0, BIRTH_NAMES)
		.map((b) => `§${b.id} (${b.words})`)
		.join(", ");
	const n = births.born.length;
	return (
		`${n} entr${n === 1 ? "y" : "ies"} born in the last ${births.days} day(s); ` +
		(over.length > 0
			? `${over.length} over the ${PROSE_CAP_WORDS}-word prose cap at birth, ` +
				`heaviest first: ${named}${
					over.length > BIRTH_NAMES
						? ` (+${over.length - BIRTH_NAMES} more)`
						: ""
				}.`
			: `none over the ${PROSE_CAP_WORDS}-word prose cap at birth.`)
	);
}

/**
 * @param {number} words
 * @param {{id: string, words: number, excess: number, exemptedAt: number | null}[]} overCap
 * @param {{
 *   entries: number,
 *   rate: { rate: number, days: number } | null,
 *   births: { born: {id: string, words: number, sha: string}[], days: number } | null,
 *   malformedMarkers: { id: string, line: string }[],
 * }} counts
 */
/*
 * mantahostels#2060: an entry carrying an `Over cap by ruling` marker is not a drain
 * candidate — it stays over cap by design — so it is split out of the
 * worklist into its own counted stanza rather than reported alongside the
 * entries this queue is actually asking someone to pay down.
 */
/*
 * mantahostels#2269: an entry with no valid marker but a line that reaches for one and
 * misses reads, unannotated, as an ordinary drain candidate — exactly the
 * confusion mantahostels#2124 built `MALFORMED-OVER-CAP-MARKER` to end, on the checker
 * surface only. This is the other surface a human actually reads. Only
 * entries already in `unexempted` are matched: an under-cap entry carrying a
 * near-miss line isn't in the queue and isn't this confusion — it's assertion
 * 23's alone.
 *
 * **Residual, unrefused:** an entry with several near-miss lines names all of
 * them, oldest first — `malformedExemptionMarkers` pushes one record per
 * line, so grouping by id rather than overwriting is what keeps that.
 */
function body(words, overCap, { entries, rate, births, malformedMarkers }) {
	const unexempted = overCap.filter((e) => e.exemptedAt === null);
	const exempted = overCap.filter((e) => e.exemptedAt !== null);
	const malformedById = new Map();
	for (const m of malformedMarkers) {
		if (!malformedById.has(m.id)) malformedById.set(m.id, []);
		malformedById.get(m.id).push(m.line);
	}
	const queue =
		unexempted.length > 0
			? unexempted.map((e) => {
					const near = malformedById.get(e.id);
					const base = `- §${e.id}: ${e.words} prose words, ${e.excess} over the ${PROSE_CAP_WORDS}-word cap`;
					return near
						? `${base} — carries a line that does not parse as an exemption marker: ` +
								near.map(mdInlineCode).join(", ")
						: base;
				})
			: [
					exempted.length > 0
						? "None — every remaining over-cap entry is exempted by ruling (see below)."
						: `None — every §B entry is at or under the ${PROSE_CAP_WORDS}-word prose cap.`,
				];
	const exemptedSection =
		exempted.length > 0
			? [
					"",
					`## Exempted over cap by ruling (${exempted.length}) — not drain candidates`,
					"",
					...exempted.map(
						(e) =>
							`- §${e.id}: ${e.words} prose words, ${e.excess} over the ${PROSE_CAP_WORDS}-word cap (#${e.exemptedAt})`,
					),
				]
			: [];
	return [
		"Filed automatically by `scripts/report-doc-map-budget.js`, from the",
		"daily repo-checks run at session start, which rewrites this body while §B is still over.",
		"**Edit it by hand and the next run silently overwrites it** —",
		"`issue-body.js replace` only refuses a write landing during the call itself,",
		"not a hand edit sitting between runs — so put anything you want kept in a",
		"comment.",
		"The same run sets the `takes:` label from the queue below —",
		`\`${TAKES_QUEUED}\` while it holds an entry, \`${TAKES_EMPTY}\` while it is empty`,
		"(what is left then is a decision: raise the budget or revoke an exemption) —",
		"so a hand-set value is overwritten on the next run. Only while §B is over",
		"budget: a run under it files and touches nothing, label included.",
		"",
		"```",
		verdict(words),
		buildLevelLine(entries, rate),
		buildBirthsLine(births),
		"```",
		"",
		"The births-over-cap reading counts births anywhere in the window, and the window",
		"reaches back past the gate: `check-doc-map.js`'s new-entry cap assertion landed at",
		"`e914dc2b`, 27 Aug 2026 11:10 +0800, so a birth older than that was never gated at",
		"all. Only a birth at a commit AFTER `e914dc2b` means one got past the assertion.",
		"Measured at mantahostels#1704: all 44 over-cap births in the 28 Aug window predate it, the",
		"latest by twenty minutes, and the 13 births since are all under cap.",
		"",
		"## Drain queue — over-cap entries, largest excess first",
		"",
		...queue,
		...exemptedSection,
		"",
		"## What to do",
		"",
		`Pay by bringing an over-cap entry under the ${PROSE_CAP_WORDS}-word prose cap`,
		"(mantahostels#891) — largest excess first, per the queue above. Do not pay by declining to write",
		"an entry: `CLAUDE.md`'s duty to record a settled load-bearing fact is unconditional.",
		"",
		"## Why this is an issue and not a red build",
		"",
		"The session that writes the entry crossing the line is not the session that can pay.",
		"Ruled at mantahostels#894.",
		"",
		"This issue is the drain queue (mantahostels#1311, mantahostels#1317). The 80,000-word budget is a ratchet",
		"— where §B was measured, plus headroom — not a defended limit, but it is meetable,",
		"and mantahostels#1311's open-indefinitely design was overturned at mantahostels#1079.",
		"The daily repo-checks run refreshes this body while §B is over. **Close this issue once §B is",
		"under budget**: a run under it files and touches nothing, and the open-issue lookup",
		"matches open issues only, so the next breach files a fresh one.",
	].join("\n");
}

/** @type {import("./lib/cli-args").CliSpec} */
const CLI = {
	usage: "usage: node report-doc-map-budget.js [<doc-map.md>] [--dry-run]",
	flags: { "--dry-run": "boolean" },
	max: 1,
};

/** @param {import("./lib/cli-args").Parsed} args */
function main({ flags, positionals }) {
	const mapPath = positionals[0] || "docs/doc-map.md";

	let text;
	try {
		text = fs.readFileSync(mapPath, "utf8");
	} catch (e) {
		console.error(`cannot read doc map at ${mapPath} — ${errMessage(e)}`);
		return 2;
	}

	// Split from the count: an absent heading and an empty section both measure
	// zero words, and only the first means the file handed in is not the map.
	if (!sectionBRange(text.split("\n"))) {
		console.error(
			`no "## Section B" heading in ${mapPath}, so there is no section to ` +
				"measure. Nothing filed.",
		);
		return 2;
	}

	const words = sectionBWords(text);
	console.log(verdict(words));

	if (words <= BUDGET_WORDS) {
		// Under budget this touches gh not at all — the property mantahostels#894 built it
		// on. So the `takes:` label below is reconciled only while §B is OVER
		// budget: an under-budget §B whose queue refills (an exemption revoked,
		// an entry grown) leaves the open issue on whatever label it last
		// carried, until §B crosses back over.
		//
		// Ruled acceptable at mantahostels#2675, which re-examined it. Under budget mantahostels#1079's
		// condition has CLEARED, and check-cleared-trackers.js reports it as
		// such at every session start, off this file's own TITLE, LABEL and
		// BUDGET_WORDS — so the state is not silent, and what it asks for is a
		// CLOSE, not a relabel. It does not reconcile here (mantahostels#1079):
		// that costs a `gh issue list` on every quiet run, and would have to
		// refresh the body too, or the label disagrees with the queue printed
		// under it (the same-scan invariant below).
		console.log("Under budget — nothing to file.");
		return 0;
	}
	if (flags["--dry-run"]) {
		console.log("--dry-run: no issue filed or refreshed.");
		return 0;
	}

	try {
		// Inside the same try as fileOrRefresh: neither call is expected to
		// throw (sectionBEntryRate catches its own git failures and returns
		// null), but an unforeseen one must still exit 2, never 1 — the header's
		// "exits 2, and only 2, when it cannot do its job" contract.
		const entries = sectionBEntryCount(text);
		const rate = sectionBEntryRate(mapPath, entries);
		// Measured once and handed to both: the label and the queue it names
		// must be read from the same scan, or a refresh can print a worklist
		// under a label saying there is none.
		const overCap = overCapEntries(text);
		const takes = takesNow(overCap);
		console.log(
			fileOrRefresh({
				title: TITLE,
				label: LABEL,
				labels: [LABEL],
				takes,
				body: body(words, overCap, {
					entries,
					rate,
					births: readSectionBBirths(mapPath),
					malformedMarkers: malformedExemptionMarkers(text),
				}),
			}),
		);
	} catch (e) {
		console.error(
			`could not file or refresh the tracking issue — ${errMessage(e)}`,
		);
		return 2;
	}
	return 0;
}

if (require.main === module) {
	// Parsed before the module gate, so --help is answered with governance off too (#1062).
	const args = parseOrExit(process.argv.slice(2), CLI);
	require("./lib/workflow-core-config.js").exitUnlessModule("governance");
	process.exit(main(args));
}

module.exports = { BUDGET_WORDS, TITLE, LABEL };
