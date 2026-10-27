#!/usr/bin/env node
/*
 * report-roadmap-ceilings.js — first limb of mantahostels#3188's ruling (C), landed at
 * mantahostels#3334: a standing census of every non-done roadmap card carrying a field
 * over its word ceiling.
 *
 * Usage (from the repo root):
 *   node report-roadmap-ceilings.js [<roadmap.html>] [--dry-run]
 *   (default: docs/reference-roadmap.html; --dry-run prints the verdict and
 *   touches no issue)
 *
 * Ceilings are read off `.claude/skills/roadmap-edit/scripts/validate.js`
 * (`BODY_WORD_CEILING`, `FIELD_WORD_CEILINGS`, `bodyWords`) rather than
 * re-declared here, so a ceiling change there cannot drift this census.
 *
 * This is a CENSUS, not the validator's touch-gated CARD SHAPE warning
 * (`validate.js`'s scope diff): that warning fires only on a field an edit
 * changed while over its ceiling, because it runs at commit time and the
 * session in the field is the one that can fix it (mantahostels#3335). This reporter runs
 * from the daily repo-checks run against no baseline at all — every non-done card
 * currently over any ceiling, touched or not.
 *
 * A `capOk` exemption record is annotated on its row, never dropped from the
 * census: mantahostels#3189 ruled a capOk record reports and never suppresses, and mantahostels#3335
 * narrowed that to the census alone — the validator's warn on a touch that
 * does not grow the field is the one thing it silences. But an exempt row is
 * a founder-ratified floor, not work, so it does not keep the issue open: the
 * issue is filed and refreshed only while some row carries NO exemption, and
 * once every row does the run touches nothing and `check-cleared-trackers.js`
 * asks for a close (mantahostels#3352; mantahostels#2748, every issue must be closeable).
 *
 * Exit is 0 whether or not any card is over; the issue is the signal. It
 * exits 2, and only 2, when it cannot do its job: the roadmap unreadable, gh
 * refusing, or a command line lib/cli-args.js refuses.
 */

const fs = require("node:fs");
const { parseOrExit } = require("./lib/cli-args");
const { errMessage } = require("./lib/check");
const {
	parseRoadmap,
	BODY_WORD_CEILING,
	FIELD_WORD_CEILINGS,
	bodyWords,
} = require("../.claude/skills/roadmap-edit/scripts/validate.js");
const { fileOrRefresh } = require("./lib/tracking-issue");
const { takesLabel } = require("./lib/takes-label");

/**
 * The `b` field alongside the three-plus-`dw` ceilinged fields
 * `FIELD_WORD_CEILINGS` already carries, composed rather than re-typed so a
 * ceiling change to either source moves this list too.
 * @type {{ field: string, ceiling: number, read: (c: import("../.claude/skills/roadmap-edit/scripts/validate.js").Card) => unknown }[]}
 */
const CEILINGED_FIELDS = [
	{ field: "b", ceiling: BODY_WORD_CEILING, read: (c) => c.b },
	...FIELD_WORD_CEILINGS,
];

/**
 * `openTrackingIssue` (lib/tracking-issue.js) matches the open issue by this
 * exact string, so changing it orphans whatever issue carries the old title —
 * the next run files a duplicate instead of refreshing it. A future edit here
 * must retitle the live issue in the same session, as `report-doc-map-budget.js`'s
 * own `TITLE` comment requires of its caller.
 */
const TITLE =
	"Roadmap ceiling census — non-done cards over a field's word ceiling";
/** What the open-issue lookup matches on, alongside the exact title — the
 * category mantahostels#3334 itself carries, there being no dedicated tracker label. */
const LABEL = "Tech & Stack";
/**
 * The issue's only `takes:` value: it exists only while a row carries no
 * `capOk` exemption, and trimming that card is a specified unit of work
 * through the (model-invocable) `roadmap-edit` skill, so `/implement` is what
 * opens it — `docs/agents/triage-labels.md` §`takes:`. Never `takes:human`:
 * that label names an act outside Claude Code, and this issue has none
 * (mantahostels#3352).
 */
const TAKES = takesLabel("implement");

/**
 * The rows that keep the issue open — those no `capOk` ruling covers.
 * @param {ReturnType<typeof overCeilingRows>} rows
 */
const payable = (rows) => rows.filter((r) => r.capOk === null);

/**
 * Every (card, field) pair over its ceiling, across every non-done card.
 *
 * @param {any[]} items
 * @returns {{ id: string, field: string, words: number, ceiling: number, excess: number, p: number, capOk: number | null }[]}
 */
function overCeilingRows(items) {
	const rows = [];
	for (const it of items) {
		if (it.state === "done") continue;
		for (const { field, ceiling, read } of CEILINGED_FIELDS) {
			const words = bodyWords(read(it));
			if (words <= ceiling) continue;
			const capOk =
				it.capOk && typeof it.capOk[field] === "number"
					? it.capOk[field]
					: null;
			rows.push({
				id: it.id,
				field,
				words,
				ceiling,
				excess: words - ceiling,
				p: it.p,
				capOk,
			});
		}
	}
	return rows.sort((a, b) => b.excess - a.excess);
}

/**
 * @param {ReturnType<typeof overCeilingRows>} rows
 * @returns {string}
 */
function verdict(rows) {
	const cards = new Set(rows.map((r) => r.id)).size;
	const totalExcess = rows.reduce((s, r) => s + r.excess, 0);
	const exempt = rows.length - payable(rows).length;
	return rows.length > 0
		? `${cards} non-done card(s) over at least one ceiling, ${rows.length} field(s) total, ${totalExcess.toLocaleString("en-GB")} words of total excess; ${exempt} of the ${rows.length} carry a capOk exemption.`
		: "No non-done card is over any field's word ceiling.";
}

/**
 * Excess summed by phase, only over the phases actually present in `rows` —
 * the baseline at mantahostels#3188 named four (P0-P3) because that's what was over then,
 * not because a fifth phase is out of scope.
 * @param {{ p: number, excess: number }[]} rows
 * @returns {string}
 */
function buildPhaseLine(rows) {
	if (rows.length === 0) return "";
	/** @type {Map<number, number>} */
	const byPhase = new Map();
	for (const r of rows) byPhase.set(r.p, (byPhase.get(r.p) || 0) + r.excess);
	const phases = [...byPhase.keys()].sort((a, b) => a - b);
	return `By phase: ${phases.map((p) => `P${p} ${(byPhase.get(p) ?? 0).toLocaleString("en-GB")}`).join(" / ")}.`;
}

/**
 * @param {ReturnType<typeof overCeilingRows>} rows
 * @returns {string}
 */
function body(rows) {
	const queue =
		rows.length > 0
			? rows.map(
					(r) =>
						`- §${r.id} \`${r.field}\`: ${r.words} words, ${r.excess} over the ${r.ceiling}-word ceiling` +
						(r.capOk === null
							? ""
							: ` — carries a \`capOk\` exemption (#${r.capOk}): a ratified floor, listed for the record (mantahostels#3189), never payable by a trim`),
				)
			: [
					"None — every non-done card is at or under every field's word ceiling.",
				];
	return [
		"Filed automatically by `scripts/report-roadmap-ceilings.js`, from the",
		"daily repo-checks run at session start, which rewrites this body while any",
		"non-done card is over a ceiling. **Edit it by hand and the next run",
		"silently overwrites it** — put anything you want kept in a comment.",
		"",
		"```",
		verdict(rows),
		...(buildPhaseLine(rows) ? [buildPhaseLine(rows)] : []),
		"```",
		"",
		"## Over-ceiling fields, largest excess first",
		"",
		...queue,
		"",
		"## What to do",
		"",
		"Pay by trimming an unexempted over-ceiling field, through the `roadmap-edit`",
		"skill — largest excess first, per the queue above. A `capOk` row is a",
		"founder-ratified floor: it stays listed (mantahostels#3189) but is never paid by a trim,",
		"and a trim to it voids the exemption on touch (mantahostels#3189).",
		"",
		`The same run keeps the \`takes:\` label at \`${TAKES}\`, so a hand-set value is`,
		"overwritten on the next daily repo-checks run.",
		"",
		"## Why this is an issue and not a red build",
		"",
		"Retrospective bound on a corpus where the session that crosses a field's",
		"ceiling is not the one that can pay (mantahostels#3188's ruling (C), the working",
		"precedent `report-doc-map-budget.js`'s header states this same way).",
		"",
		"**Close this issue once no unexempted row remains**: a run with none files",
		"and touches nothing, `scripts/check-cleared-trackers.js` reports the tracker",
		"cleared at session start, and the open-issue lookup matches open issues",
		"only, so the next unexempted breach files a fresh one. The exempt rows",
		"stay readable in the roadmap's own `capOk` fields and in this script's",
		"`--dry-run` verdict (mantahostels#3352; mantahostels#2748).",
	].join("\n");
}

/** @type {import("./lib/cli-args").CliSpec} */
const CLI = {
	usage: "usage: node report-roadmap-ceilings.js [<roadmap.html>] [--dry-run]",
	flags: { "--dry-run": "boolean" },
	max: 1,
};

/** @param {import("./lib/cli-args").Parsed} args */
function main({ flags, positionals }) {
	const roadmapPath = positionals[0] || "docs/reference-roadmap.html";

	let html;
	try {
		html = fs.readFileSync(roadmapPath, "utf8");
	} catch (e) {
		console.error(`cannot read roadmap at ${roadmapPath} — ${errMessage(e)}`);
		return 2;
	}

	let items;
	try {
		({ ITEMS: items } = parseRoadmap(html));
	} catch (e) {
		console.error(
			`cannot parse ${roadmapPath} as a roadmap — ${errMessage(e)}`,
		);
		return 2;
	}

	const rows = overCeilingRows(items);
	console.log(verdict(rows));
	const phase = buildPhaseLine(rows);
	if (phase) console.log(phase);

	if (rows.length === 0) {
		console.log("Nothing over — nothing to file.");
		return 0;
	}
	if (payable(rows).length === 0) {
		console.log(
			"Every over-ceiling row carries a capOk exemption — nothing to file.",
		);
		return 0;
	}
	if (flags["--dry-run"]) {
		console.log("--dry-run: no issue filed or refreshed.");
		return 0;
	}

	try {
		console.log(
			fileOrRefresh({
				title: TITLE,
				label: LABEL,
				labels: [LABEL],
				takes: TAKES,
				body: body(rows),
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
	// Parsed before the module gate, so --help is answered with roadmap off too (#1062).
	const args = parseOrExit(process.argv.slice(2), CLI);
	require("./lib/workflow-core-config.js").exitUnlessModule("roadmap");
	process.exit(main(args));
}

module.exports = { TITLE, LABEL, overCeilingRows, payable, verdict };
