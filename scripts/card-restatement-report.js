#!/usr/bin/env node

const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const path = require("node:path");
const { flagValue, parseOrCode } = require("./lib/cli-args");
const {
	DATA_FILES,
	FIGURE_ID,
	citationMatcher,
	loadRestatements,
	parseEntries,
	sectionBRange,
} = require("./lib/doc-map.js");
const { caught } = require("./lib/caught.js");

const out = (/** @type {string} */ s) => writeFd(1, s);
const err = (/** @type {string} */ s) => writeFd(2, s);

const ROADMAP = "docs/reference-roadmap.html";

const CARD_LOCATOR = /^`([a-z0-9][a-z0-9-]*)`$/;

/** @param {string|undefined} locator */
function cardOf(locator) {
	return locator ? (locator.match(CARD_LOCATOR)?.[1] ?? null) : null;
}

/** @param {Record<string, {paths: {path: string, locator?: string, gloss?: string}[]}>} data */
function roadmapEdges(data) {
	const rows = [];
	for (const [id, entry] of Object.entries(data))
		for (const item of entry.paths) {
			if (!citationMatcher(item.path)(ROADMAP)) continue;
			rows.push({ id, card: cardOf(item.locator), item });
		}
	return rows;
}

/** @param {string} mapFile */
function readEntryText(mapFile) {
	const lines = fs.readFileSync(mapFile, "utf8").split("\n");
	const range = sectionBRange(lines);
	if (!range) throw new Error(`${mapFile} holds no "## Section B" heading`);
	/** @type {Map<string, {heading: string, claim: string|null}>} */
	const found = new Map();
	const body = lines.slice(range.start, range.end).join("\n");
	for (const e of parseEntries(body, FIGURE_ID))
		found.set(e.id, {
			heading: e.heading.replace(/^#+\s*/, ""),
			claim:
				e.lines.find((l) => /^\s*[-*]\s+\*\*The claim\b/i.test(l))?.trim() ??
				null,
		});
	return found;
}

const USAGE =
	"usage: card-restatement-report.js <card-id> | --audit [--map <doc-map.md>]";

/** @param {string[]} argv */
function main(argv) {
	const parsed = parseOrCode(argv, {
		usage: USAGE,
		flags: { "--map": "value", "--audit": "boolean" },
		max: 1,
	});
	if (typeof parsed === "number") return parsed;
	const mapFile = flagValue(parsed.flags, "--map") ?? "docs/doc-map.md";
	const audit = "--audit" in parsed.flags;
	const [card] = parsed.positionals;
	if (!audit && !card) {
		err(`${USAGE}\n`);
		return 2;
	}

	let data;
	let entries;
	try {
		entries = readEntryText(mapFile);
		data = loadRestatements(
			path.join(path.dirname(mapFile), DATA_FILES.restatements),
			{ allowEmpty: entries.size === 0 },
		);
	} catch (e) {
		err(`cannot read the §B restatement record: ${caught(e).message}\n`);
		return 2;
	}
	if (entries.size === 0 && Object.keys(data).length === 0) {
		err(`SKIP: ${mapFile} has no §B entry yet — nothing restates a card.\n`);
		return 0;
	}

	const rows = roadmapEdges(data);
	if (audit) return printAudit(rows);
	return printCard(card, rows, entries);
}

/**
 * @param {ReturnType<typeof roadmapEdges>} rows
 * @returns {number}
 */
function printAudit(rows) {
	const cards = new Set(rows.filter((r) => r.card).map((r) => r.card));
	const odd = rows.filter((r) => !r.card);
	out(
		`${rows.length} roadmap path(s) across ${cards.size} card(s); ` +
			`${odd.length} locator(s) that are not a bare card id\n`,
	);
	for (const r of odd) out(`  ${r.id} → ${r.item.locator ?? "(no locator)"}\n`);
	return 0;
}

/**
 * @param {string | undefined} card
 * @param {ReturnType<typeof roadmapEdges>} rows
 * @param {ReturnType<typeof readEntryText>} entries
 * @returns {number}
 */
function printCard(card, rows, entries) {
	const hits = rows.filter((r) => r.card === card);
	if (hits.length === 0) {
		out(`No §B entry restates \`${card}\`.\n`);
		return 0;
	}
	out(
		`${hits.length} §B entr(ies) restate \`${card}\` — a cut through one of ` +
			"these is a propagation pass, not a trim:\n",
	);
	for (const h of hits) {
		const e = entries.get(h.id);
		out(`\n${e ? e.heading : `${h.id} (no §B entry!)`}\n`);
		if (e?.claim) out(`  ${e.claim}\n`);
		if (h.item.gloss) out(`  gloss: ${h.item.gloss}\n`);
	}
	return 0;
}

if (require.main === module) {
	const config = require("./lib/workflow-core-config.js");
	config.exitUnlessModule(config.MANUAL_HALF);
	process.exit(main(process.argv.slice(2)));
}
