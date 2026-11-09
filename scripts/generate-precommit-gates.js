#!/usr/bin/env node
/*
 * generate-precommit-gates.js — writes .husky/pre-commit's two
 * `precommit-gates` regions, rendered by lib/precommit-gates-render.js from
 * lib/precommit-gates.js's GATES (#4597).
 *
 * Usage:
 *   node scripts/generate-precommit-gates.js [--check]
 *
 * --check  render the index's registry and diff it against the index's hook;
 *          exit 1 where a region is stale, 2 where either file cannot be read
 *          or the hook lacks a region's marker pair. A repo whose index holds
 *          no registry passes: an adopter's hook carries no region (#5).
 *
 * --check JUDGES THE INDEX, so a neighbour's unstaged edit to either file
 * cannot refuse a commit that stages neither (#2901).
 *
 * A RUN WRITES THE SESSION'S OWN TREE, `worktreeRoot()` (#4438).
 */

const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { writeFd } = require("./lib/write-fd.js");
const { parseOrExit } = require("./lib/cli-args.js");
const { worktreeRoot } = require("./lib/host-root.js");
const { caught } = require("./lib/caught.js");
const { execGit, GIT_TIMEOUT_MS } = require("./lib/git.js");
const { scriptPath } = require("./lib/script-path.js");
const { HOOK, render } = require("./lib/precommit-gates-render.js");

const REGISTRY = "scripts/lib/precommit-gates.js";

/** @type {import("./lib/cli-args").CliSpec} */
const CLI = {
	usage: `Usage: node ${scriptPath("generate-precommit-gates.js")} [--check]`,
	flags: { "--check": "boolean" },
};

/** @type {import("node:child_process").ExecFileSyncOptionsWithStringEncoding} */
const GIT_READ = {
	encoding: "utf8",
	timeout: GIT_TIMEOUT_MS,
	stdio: ["ignore", "pipe", "pipe"],
};

/**
 * The registry's source, loaded as a module resolving from its own path.
 * `--check` must judge the index's copy, which no file on disk holds, and
 * compiling it at the real path lets its `./script-path.js` require resolve
 * (#4597). Module#_compile is Node's private loader: a Node that drops it
 * fails `--check` with exit 2, refusing every commit staging the hook.
 * @param {string} source
 * @returns {import("./lib/precommit-gates-render").Registry}
 */
function loadRegistry(source) {
	const file = path.join(__dirname, "lib", "precommit-gates.js");
	const m = new Module(file);
	m.filename = file;
	// @ts-expect-error _compile is Node's own loader, undeclared in its types
	m._compile(source, file);
	return m.exports;
}

/** @param {string} rel */
const readIndexBlob = (rel) => execGit(["show", `:${rel}`], GIT_READ);

/** @param {string} rel */
const isInIndex = (rel) =>
	execGit(["ls-files", "--", rel], GIT_READ).trim() !== "";

/** @returns {number} */
function checkIndex() {
	if (!isInIndex(REGISTRY)) return 0;
	const hook = readIndexBlob(HOOK);
	if (render(hook, loadRegistry(readIndexBlob(REGISTRY))) === hook) return 0;
	writeFd(
		2,
		`generate-precommit-gates: ${HOOK}'s precommit-gates regions are stale against ${REGISTRY}\n` +
			`generate-precommit-gates: run node ${scriptPath("generate-precommit-gates.js")}, then stage ${HOOK} with this commit\n`,
	);
	return 1;
}

/**
 * @param {string} root
 * @returns {number}
 */
function writeAt(root) {
	const file = path.join(root, HOOK);
	const registry = loadRegistry(
		fs.readFileSync(path.join(root, REGISTRY), "utf8"),
	);
	fs.writeFileSync(file, render(fs.readFileSync(file, "utf8"), registry));
	return 0;
}

function main() {
	const check = Boolean(
		parseOrExit(process.argv.slice(2), CLI).flags["--check"],
	);
	try {
		return check ? checkIndex() : writeAt(worktreeRoot());
	} catch (err) {
		writeFd(2, `generate-precommit-gates: ${caught(err).message}\n`);
		return 2;
	}
}

if (require.main === module) process.exit(main());
