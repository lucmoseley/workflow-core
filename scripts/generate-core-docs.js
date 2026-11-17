#!/usr/bin/env node
/*
 * generate-core-docs.js — renders the core documents an adopter reads but
 * never edits, `.claude/workflow-core.glossary.md` from GLOSSARY.md and
 * `.claude/workflow-core.doc-map.md` from docs/doc-map.md's method sections
 * (lib/core-docs.js, #5294).
 *
 * --check  render and compare without writing; exit 1 on drift.
 *
 * Runs only in a repo shipping the plugin: in an adopter its GLOSSARY.md and
 * doc map are its own, and the renders are copies of the core's, so it SKIPs.
 *
 * Exit 2 where a source cannot be read or the doc map lacks a method section.
 */

const fs = require("node:fs");
const path = require("node:path");
const { readText } = require("./lib/file-read.js");
const { worktreeRoot } = require("./lib/host-root.js");
const { scriptPath } = require("./lib/script-path.js");
const { parseOrExit } = require("./lib/cli-args.js");
const { caught } = require("./lib/caught.js");
const { capture } = require("./lib/check-sink.js");
const { writeFd } = require("./lib/write-fd.js");
const {
	DOC_MAP_METHOD_FILE,
	DOC_MAP_SOURCE,
	GLOSSARY_FILE,
	GLOSSARY_SOURCE,
	renderDocMapMethod,
	renderGlossary,
} = require("./lib/core-docs.js");

/**
 * Renders both documents in `root`, or with `check` compares them.
 * @param {string} root
 * @param {{ check: boolean }} opts
 * @param {import("./lib/write-fd.js").Write} write
 * @returns {number}
 */
function render(root, { check }, write) {
	if (!fs.existsSync(path.join(root, ".claude-plugin", "plugin.json"))) {
		write(
			1,
			"SKIP: this repo ships no plugin, so its glossary and doc map are its own\n",
		);
		return 0;
	}
	/** @type {Array<[string, string]>} */
	let wanted;
	try {
		const read = (/** @type {string} */ rel) =>
			fs.readFileSync(path.join(root, rel), "utf8");
		wanted = [
			[GLOSSARY_FILE, renderGlossary(read(GLOSSARY_SOURCE))],
			[DOC_MAP_METHOD_FILE, renderDocMapMethod(read(DOC_MAP_SOURCE))],
		];
	} catch (e) {
		write(2, `generate-core-docs: ${caught(e).message}\n`);
		return 2;
	}
	const stale = wanted.filter(([rel, body]) => {
		const now = readText(path.join(root, rel));
		return now.state !== "read" || now.data !== body;
	});
	if (stale.length === 0) {
		write(1, "the core documents already match their sources.\n");
		return 0;
	}
	if (check) {
		write(
			2,
			`${stale.map(([rel]) => rel).join(" and ")} no longer match ${GLOSSARY_SOURCE} and ${DOC_MAP_SOURCE}. Regenerate:\n` +
				`  node ${scriptPath("generate-core-docs.js")}\n`,
		);
		return 1;
	}
	for (const [rel, body] of stale) {
		try {
			fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
			fs.writeFileSync(path.join(root, rel), body);
		} catch (e) {
			write(2, `cannot write ${rel} — ${caught(e).message}\n`);
			return 2;
		}
		write(1, `rendered ${rel}\n`);
	}
	return 0;
}

/**
 * @param {string[]} argv
 * @returns {number}
 */
function main(argv) {
	const { flags } = parseOrExit(argv, {
		usage: `usage: node ${scriptPath("generate-core-docs.js")} [--check]`,
		flags: { "--check": "boolean" },
	});
	return render(worktreeRoot(), { check: flags["--check"] === true }, writeFd);
}

/**
 * The --check run over the repo at `cwd`, as the pre-commit dispatcher runs
 * it in its own process (#5172).
 * @type {import("./lib/precommit-gates.js").Program}
 */
const PROGRAM = ({ cwd }) =>
	capture((write) => render(cwd, { check: true }, write));

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main, PROGRAM };
