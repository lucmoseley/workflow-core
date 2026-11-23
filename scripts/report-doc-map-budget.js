#!/usr/bin/env node

const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
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

// lucmoseley/mantahostels#1079 measured 72,519 words on 3 Sep 2026, plus 7,481 headroom
const BUDGET_WORDS = 80_000;

const TITLE = "doc-map §B — drain the entries over the 300-word prose cap";
const LABEL = "documentation";
const TAKES_QUEUED = takesLabel("implement");
const TAKES_EMPTY = takesLabel("wayfinder");

/** @param {{ exemptedAt: number | null }[]} overCap */
function takesNow(overCap) {
	return overCap.some((e) => e.exemptedAt === null)
		? TAKES_QUEUED
		: TAKES_EMPTY;
}

/** @param {string} text */
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
 * @param {number} entries
 * @param {{ rate: number, days: number } | null} rate
 */
function buildLevelLine(entries, rate) {
	const rateText = rate
		? `${rate.rate >= 0 ? "+" : ""}${rate.rate.toFixed(1)}/day over the last ${rate.days.toFixed(1)} day(s) of git history`
		: "rate unavailable (docs/doc-map.md's git history could not be read)";
	return `§B holds ${entries} entries, ${rateText}.`;
}

// guess: past it the count is the signal, lucmoseley/mantahostels#1384
const BIRTH_NAMES = 10;

/** @param {{ born: {id: string, words: number, sha: string}[], days: number } | null} births */
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
		writeFd(2, `cannot read doc map at ${mapPath} — ${errMessage(e)}\n`);
		return 2;
	}

	if (!sectionBRange(text.split("\n"))) {
		writeFd(
			2,
			`no "## Section B" heading in ${mapPath}, so there is no section to ` +
				"measure. Nothing filed.\n",
		);
		return 2;
	}

	const words = sectionBWords(text);
	writeFd(1, `${verdict(words)}\n`);

	if (words <= BUDGET_WORDS) {
		writeFd(1, "Under budget — nothing to file.\n");
		return 0;
	}
	if (flags["--dry-run"]) {
		writeFd(1, "--dry-run: no issue filed or refreshed.\n");
		return 0;
	}

	try {
		const entries = sectionBEntryCount(text);
		const rate = sectionBEntryRate(mapPath, entries);
		const overCap = overCapEntries(text);
		const takes = takesNow(overCap);
		writeFd(
			1,
			`${fileOrRefresh({
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
			})}\n`,
		);
	} catch (e) {
		writeFd(
			2,
			`could not file or refresh the tracking issue — ${errMessage(e)}\n`,
		);
		return 2;
	}
	return 0;
}

if (require.main === module) {
	const args = parseOrExit(process.argv.slice(2), CLI);
	require("./lib/workflow-core-config.js").exitUnlessModule("governance");
	process.exit(main(args));
}

module.exports = { BUDGET_WORDS, TITLE, LABEL };
