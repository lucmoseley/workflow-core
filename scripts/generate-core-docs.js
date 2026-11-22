#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { readText } = require("./lib/file-read.js");
const { worktreeRoot } = require("./lib/host-root.js");
const { scriptPath } = require("./lib/script-path.js");
const { parseOrExit } = require("./lib/cli-args.js");
const { caught } = require("./lib/caught.js");
const { capture } = require("./lib/check-sink.js");
const { shipsPlugin } = require("./lib/plugin-state.js");
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
 * @param {string} root
 * @param {{ check: boolean }} opts
 * @param {import("./lib/write-fd.js").Write} write
 * @returns {number}
 */
function render(root, { check }, write) {
	if (!shipsPlugin(root)) {
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

/** @type {import("./lib/precommit-gates.js").Program} */
const PROGRAM = ({ cwd }) =>
	capture((write) => render(cwd, { check: true }, write));

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main, PROGRAM };
