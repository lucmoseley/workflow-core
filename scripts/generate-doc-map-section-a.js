#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { worktreeRoot } = require("./lib/host-root.js");
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
	const repoRoot = worktreeRoot();
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
