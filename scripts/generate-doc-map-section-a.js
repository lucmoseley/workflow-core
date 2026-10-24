#!/usr/bin/env node
/*
 * generate-doc-map-section-a.js — renders docs/doc-map.md §A's register tables
 * from docs/doc-map-classes.json, the class sidecar mantahostels#1848 built.
 *
 * One judgement per file — its authority class — lives in the sidecar; Role,
 * Update route and Consumes come from the path, the class and the minority of
 * per-file overrides carrying a fact recorded nowhere else (mantahostels#1808, mantahostels#1863).
 *
 * Usage:
 *   node scripts/generate-doc-map-section-a.js [--check] [--map <path>]
 *     [--data-file <path>] [--claim-cmd <cmd>] [--release-cmd <cmd>] [--no-claim]
 *
 * --check      render and diff without writing; exit 1 on drift.
 * --no-claim   skip the claim below; for tests, which run against throwaway
 *              files outside the tree the claim store governs.
 *
 * WHAT IT DOES NOT TOUCH: everything in §A that is not a register table — the
 * preamble, each subsection's own prose, §Version stamps' table (a different
 * header) and the two prose subsections under it. Those stay hand-written and
 * a generator run preserves them byte for byte.
 *
 * Claims §A before it writes, per mantahostels#1808 user story 25: the PreToolUse claim
 * hook watches Write/Edit alone, so a script writing a guarded docs/ path
 * leaves no content record unless it claims for itself. Fails open
 * (lib/doc-map-generator.js's default): a refused claim costs the record and
 * nothing else.
 *
 * §A, NEVER THE BARE MAP (mantahostels#2422). `--generator` is what gets the claim past
 * doc-map-regions.js's `isGeneratorOnlyRegion`, which shuts §A to everybody
 * else.
 *
 * IT RELEASES ON BOTH PATHS, with `--generator` again (mantahostels#2428). The arbiter
 * refuses a dirty subject (mantahostels#63), and the write this run just made is exactly
 * what makes §A dirty, so without the flag the claim stood until somebody
 * committed. The flag waives that refusal on §A alone.
 *
 * SO A RUN THAT DIES MID-WRITE releases too, handing back a claim on a
 * half-rendered §A. Re-running the generator is the whole repair.
 */

const fs = require("node:fs");
const path = require("node:path");
const { hostRoot } = require("./lib/host-root.js");
const { scriptPath } = require("./lib/script-path.js");
const { flagValue, parseOrExit } = require("./lib/cli-args.js");
const { claimDataFile, releaseClaim } = require("./lib/doc-map-generator");
const { REGISTER_SECTION, SIDECAR_PATH } = require("./lib/doc-map-regions");
const {
	loadDocClasses,
	renderSectionA,
	REGISTER_HEADER,
	sectionARegion,
} = require("./lib/doc-map");
const { caught } = require("./lib/caught.js");

const DEFAULT_MAP = "docs/doc-map.md";

/**
 * @param {string[]} argv
 * @returns {number}
 */
function main(argv) {
	const { flags } = parseOrExit(argv, {
		usage:
			`usage: node ${scriptPath("generate-doc-map-section-a.js")} [--check] [--map <path>]\n` +
			"  [--data-file <path>] [--claim-cmd <cmd>] [--release-cmd <cmd>] [--no-claim]",
		flags: {
			"--check": "boolean",
			"--no-claim": "boolean",
			"--map": "value",
			"--data-file": "value",
			"--claim-cmd": "value",
			"--release-cmd": "value",
		},
	});
	const flag = (/** @type {string} */ name) => flags[name] === true;
	const value = (/** @type {string} */ name) => flagValue(flags, name) ?? null;
	/* The HOST repo, through the one seam (#1): in a plugin install
	 * `path.join(__dirname, "..")` is the plugin root, and the map and sidecar
	 * were looked for inside the plugin. */
	const repoRoot = hostRoot();
	const mapPath = value("--map") || path.join(repoRoot, DEFAULT_MAP);
	const dataFile = value("--data-file") || path.join(repoRoot, SIDECAR_PATH);

	let text;
	try {
		text = fs.readFileSync(mapPath, "utf8");
	} catch (e) {
		console.error(`cannot read ${mapPath} — ${caught(e).message}`);
		return 2;
	}

	let sidecar;
	try {
		sidecar = loadDocClasses(dataFile);
	} catch (e) {
		console.error(caught(e).message || String(e));
		return 2;
	}

	/* renderSectionA leaves the map alone two ways — no `## Section A` heading,
	 * and no register table for rows to land in — and either would otherwise
	 * read here as "already matches", a false pass on a map where nothing was
	 * rendered at all (§N5). */
	const sectionA = sectionARegion(text);
	if (!sectionA?.includes(REGISTER_HEADER)) {
		console.error(
			`${mapPath} carries no §A register table (\`${REGISTER_HEADER}\`), so ` +
				"there is nowhere to render the sidecar's rows. Nothing was written.",
		);
		return 2;
	}

	const rendered = renderSectionA(text, sidecar);
	if (rendered === text) {
		console.log(
			`${mapPath} §A already matches the sidecar (${Object.keys(sidecar).length} rows).`,
		);
		return 0;
	}

	if (flag("--check")) {
		console.error(
			`${mapPath} §A does not match ${dataFile}. Regenerate it:\n` +
				`  node ${scriptPath("generate-doc-map-section-a.js")}`,
		);
		return 1;
	}

	/** @type {string | null} */
	let held = null;
	if (!flag("--no-claim")) {
		const subject = `${mapPath}#${REGISTER_SECTION}`;
		// `claimed`, not `ok`: fail-open answers ok on a refusal too, and releasing
		// a claim the arbiter never granted asks it to drop somebody else's.
		if (
			claimDataFile(subject, {
				claimCmd: value("--claim-cmd"),
				generator: true,
			}).claimed
		)
			held = subject;
	}
	try {
		fs.writeFileSync(mapPath, rendered);
	} catch (e) {
		console.error(`cannot write ${mapPath} — ${caught(e).message}`);
		return 2;
	} finally {
		if (held) releaseClaim(held, value("--release-cmd"), { generator: true });
	}
	console.log(
		`rendered ${mapPath} §A from ${Object.keys(sidecar).length} sidecar rows.`,
	);
	return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main };
