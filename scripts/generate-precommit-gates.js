#!/usr/bin/env node
/*
 * generate-precommit-gates.js — renders .husky/pre-commit's two
 * `precommit-gates` regions from lib/precommit-gates.js's GATES (#4597).
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
 * TWO REGIONS, because the hook exits on `--gates=merge` between them: the
 * `merge` region holds the gates the lander's merge set runs, the `batch`
 * region the rest (#4545).
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

const HOOK = ".husky/pre-commit";
const REGISTRY = "scripts/lib/precommit-gates.js";

/** @type {import("./lib/cli-args").CliSpec} */
const CLI = {
	usage: `Usage: node ${scriptPath("generate-precommit-gates.js")} [--check]`,
	flags: { "--check": "boolean" },
};

/** @typedef {import("./lib/precommit-gates").PrecommitGate} PrecommitGate */
/** @typedef {{ GATES: PrecommitGate[], FLAG_ARGS: Record<string, string> }} Registry */

const REGIONS = /** @type {const} */ (["merge", "batch"]);

/** @param {string} region */
const begin = (region) => `# precommit-gates:${region}:begin`;
/** @param {string} region */
const end = (region) => `# precommit-gates:${region}:end`;

/**
 * One gate's block.
 * @param {PrecommitGate} gate
 * @param {Record<string, string>} flagArgs
 */
const block = (gate, flagArgs) =>
	[
		`if ${gate.lander === "batch" ? "" : "! lander_batch && "}armed ${gate.arm}; then`,
		`  node "\${WFC_PLUGIN_ROOT:-.}"/${gate.script} ${flagArgs[gate.flag]} || exit "$?"`,
		"fi",
	].join("\n");

/**
 * A region's lines between its markers.
 * @param {Registry} registry
 * @param {string} region
 */
const regionBody = ({ GATES, FLAG_ARGS }, region) =>
	GATES.filter((g) => (g.lander === "merge") === (region === "merge"))
		.map((g) => block(g, FLAG_ARGS))
		.join("\n\n");

/**
 * The hook with each region re-rendered.
 * @param {string} hook
 * @param {Registry} registry
 * @returns {string}
 */
function render(hook, registry) {
	let out = hook;
	for (const region of REGIONS) {
		const lines = out.split("\n");
		const from = lines.indexOf(begin(region));
		const to = lines.indexOf(end(region));
		if (from === -1 || to < from)
			throw new Error(
				`${HOOK} has no \`${begin(region)}\` … \`${end(region)}\` pair`,
			);
		const body = regionBody(registry, region);
		out = [
			...lines.slice(0, from + 1),
			...(body ? [body] : []),
			...lines.slice(to),
		].join("\n");
	}
	return out;
}

/**
 * The registry's source, loaded as a module resolving from its own path.
 * @param {string} source
 * @returns {Registry}
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
const indexBlob = (rel) =>
	execGit(["show", `:${rel}`], {
		encoding: "utf8",
		timeout: GIT_TIMEOUT_MS,
		stdio: ["ignore", "pipe", "pipe"],
	});

/** @returns {boolean} */
const indexHolds = (/** @type {string} */ rel) =>
	execGit(["ls-files", "--", rel], {
		encoding: "utf8",
		timeout: GIT_TIMEOUT_MS,
		stdio: ["ignore", "pipe", "pipe"],
	}).trim() !== "";

/** @returns {number} */
function checkIndex() {
	if (!indexHolds(REGISTRY)) return 0;
	const hook = indexBlob(HOOK);
	if (render(hook, loadRegistry(indexBlob(REGISTRY))) === hook) return 0;
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

module.exports = { begin, end, render };
