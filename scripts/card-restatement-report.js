#!/usr/bin/env node
/*
 * card-restatement-report.js — which docs/doc-map.md §B entries restate a
 * roadmap card, so a session cutting a sentence from that card body can see
 * first whether the sentence is a registered copy.
 *
 * WHY IT EXISTS. check-doc-map.js's DEAD-ANCHOR check only reads locators holding a quoted phrase
 * (check-doc-map.js:952-968) and every roadmap locator is a bare backticked
 * card id (mantahostels#1573), so a cut figure on a card is silent; the restatement COUNT
 * fault fires on a sidecar edit, which is after the session has already
 * decided. `roadmap-edit` SKILL.md §What a card holds runs this before a cut
 * for that reason. Ruled at mantahostels#3191, built at mantahostels#3339.
 *
 * IN NO §N3 FAMILY, DELIBERATELY. `report-*` files a GitHub issue and exits 0;
 * this is a lookup a session runs by hand and reads, and it exits 2 where it
 * cannot answer at all. Its `report:` npm alias is concision-route-report.js's
 * arrangement, not a claim on the family.
 *
 * Usage:
 *   node scripts/card-restatement-report.js <card-id>   one card
 *   node scripts/card-restatement-report.js --audit     the whole roadmap edge set
 *
 * EXIT 2 IS WIDER THAN AN UNREADABLE SIDECAR: it is every state in which no
 * answer can be given — a missing or malformed sidecar, an unreadable or
 * Section-B-less map, and no card id (mantahostels#3339).
 *
 * EXIT 0 WITH A `SKIP:` LINE where there is nothing to look up: the roadmap
 * module off, or a §B holding no entry and a sidecar holding no edge — an
 * adopter's day one, not a fault (workflow-core#418).
 */

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

/* writeFd, never console or process.stdout.write (§N6): node buffers a
 * pipe and drops what is still buffered at process.exit, and a session reads
 * this through Bash, whose stdout is a pipe. */
const out = (/** @type {string} */ s) => writeFd(1, s);
const err = (/** @type {string} */ s) => writeFd(2, s);

const ROADMAP = "docs/reference-roadmap.html";

/* A card id as the sidecar writes it: the whole locator, backticked, nothing
 * else. Read out of the locator rather than off the roadmap, so a card cut from
 * the file still reports the entries that named it. */
const CARD_LOCATOR = /^`([a-z0-9][a-z0-9-]*)`$/;

/**
 * The card id a locator names, or null where it names something else — a
 * quoted anchor, a section, a compound.
 * @param {string|undefined} locator
 */
function cardOf(locator) {
	return locator ? (locator.match(CARD_LOCATOR)?.[1] ?? null) : null;
}

/**
 * Every roadmap path in the sidecar, flattened to one row per path. Matched
 * through citationMatcher rather than by equality: the sidecar writes the
 * roadmap both as `reference-roadmap.html` and as `docs/reference-roadmap.html`,
 * and one card is named only by the second.
 * @param {Record<string, {paths: {path: string, locator?: string, gloss?: string}[]}>} data
 */
function roadmapEdges(data) {
	const rows = [];
	for (const [id, entry] of Object.entries(data))
		for (const item of entry.paths) {
			if (!citationMatcher(item.path)(ROADMAP)) continue;
			rows.push({ id, card: cardOf(item.locator), item });
		}
	return rows;
}

/**
 * Each §B entry's heading and its `The claim` line, keyed by id. Where an entry
 * carries no claim line the heading, which states the figure, is what a caller
 * renders — never an empty line.
 * @param {string} mapFile
 */
function entryText(mapFile) {
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
		entries = entryText(mapFile);
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
 * --audit: the whole roadmap edge set, and each locator that is not a bare
 * card id.
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
 * One card: every §B entry restating it, with its claim line and gloss.
 * @param {string | undefined} card
 * @param {ReturnType<typeof roadmapEdges>} rows
 * @param {ReturnType<typeof entryText>} entries
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
