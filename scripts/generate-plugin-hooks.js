#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const { capture } = require("./lib/check-sink.js");
const { writeFd } = require("./lib/write-fd.js");
const path = require("node:path");
const { parseOrExit } = require("./lib/cli-args.js");
const { worktreeRoot } = require("./lib/host-root.js");
const { caught } = require("./lib/caught.js");
const { extractTree, indexTree } = require("./lib/check.js");
const { guardDirs, isDenyCapableIn } = require("./lib/deny-capable.js");
const { SELF_PLUGIN_HOOKS, readHooksAt } = require("./lib/core-hooks.js");
const { scriptPath } = require("./lib/script-path.js");
const { shipsPlugin } = require("./lib/plugin-state.js");
const {
	ENTRY,
	OUT,
	renderAt,
	renderManifest,
	withFailClosed,
} = require("./lib/plugin-hooks-render.js");

/** @type {import("./lib/cli-args").CliSpec} */
const CLI = {
	usage: `Usage: node ${scriptPath("generate-plugin-hooks.js")} [--check]`,
	flags: { "--check": "boolean" },
};

const SKIP =
	"SKIP: this repo ships no plugin (.claude-plugin/plugin.json is absent), so there is no hook manifest to render\n";

/** @param {string} root */
const failClosedAt = (root) =>
	withFailClosed(
		readHooksAt(root, SELF_PLUGIN_HOOKS),
		isDenyCapableIn(guardDirs(root, root)),
	);

/**
 * @param {string} tree
 * @param {import("./lib/write-fd.js").Write} write
 * @returns {number}
 */
function checkAt(tree, write) {
	const { drift } = failClosedAt(tree);
	const rendered = renderAt(tree);
	const outPath = path.join(tree, OUT);
	const current = fs.existsSync(outPath)
		? fs.readFileSync(outPath, "utf8")
		: "";
	const faults = drift.map(
		(d) => `generate-plugin-hooks: ${SELF_PLUGIN_HOOKS}: ${d}\n`,
	);
	if (current !== rendered)
		faults.push(`generate-plugin-hooks: ${OUT} is stale\n`);
	if (faults.length === 0) return 0;
	write(
		2,
		`${faults.join("")}generate-plugin-hooks: run node ${scriptPath("generate-plugin-hooks.js")}, then stage ${OUT} and ${SELF_PLUGIN_HOOKS} with this commit\n`,
	);
	return 1;
}

/**
 * @param {import("./lib/write-fd.js").Write} write
 * @returns {number}
 */
function checkIndex(write) {
	const work = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-hooks-check-"));
	try {
		const tree = path.join(work, "tree");
		fs.mkdirSync(tree);
		extractTree(indexTree(path.join(work, "index")), tree);
		if (!shipsPlugin(tree)) {
			write(2, SKIP);
			return 0;
		}
		return checkAt(tree, write);
	} finally {
		fs.rmSync(work, { recursive: true, force: true });
	}
}

/**
 * @param {string} root
 * @returns {number}
 */
function writeAt(root) {
	if (!shipsPlugin(root)) {
		writeFd(2, SKIP);
		return 0;
	}
	const failClosed = failClosedAt(root);
	const rendered = renderManifest(
		{ hooks: failClosed.hooks },
		fs.existsSync(path.join(root, ENTRY)),
	);
	if (failClosed.drift.length > 0)
		fs.writeFileSync(
			path.join(root, SELF_PLUGIN_HOOKS),
			`${JSON.stringify({ hooks: failClosed.hooks }, null, "\t")}\n`,
		);
	const outPath = path.join(root, OUT);
	fs.mkdirSync(path.dirname(outPath), { recursive: true });
	fs.writeFileSync(outPath, rendered);
	return 0;
}

/**
 * @param {import("./lib/write-fd.js").Write} write
 * @param {() => number} run
 * @returns {number}
 */
function brokenOnThrow(write, run) {
	try {
		return run();
	} catch (err) {
		write(2, `generate-plugin-hooks: ${caught(err).message}\n`);
		return 2;
	}
}

/** @type {import("./lib/precommit-gates.js").Program} */
const PROGRAM = () =>
	capture((write) => brokenOnThrow(write, () => checkIndex(write)));

function main() {
	const check = Boolean(
		parseOrExit(process.argv.slice(2), CLI).flags["--check"],
	);
	return brokenOnThrow(writeFd, () =>
		check ? checkIndex(writeFd) : writeAt(worktreeRoot()),
	);
}

module.exports = { PROGRAM };

if (require.main === module) process.exit(main());
