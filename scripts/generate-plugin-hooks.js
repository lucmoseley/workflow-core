#!/usr/bin/env node
/*
 * generate-plugin-hooks.js — renders hooks/hooks.json, the plugin's hook
 * manifest, from the self-plugin's `self-plugin/hooks/hooks.json` (#4, #2441).
 *
 * Usage:
 *   node scripts/generate-plugin-hooks.js [--check]
 *
 * --check  render the index's self-plugin file into memory and diff against the
 *          index's hooks/hooks.json; exit 1 on a difference, 2 where the
 *          self-plugin file cannot be rendered (unreadable, or a command it
 *          refuses to rewrite; stderr names which) or the index cannot be read.
 *
 * --check JUDGES THE INDEX, extracted to a scratch tree, never the working
 * tree: in .husky/pre-commit that is the commit's own bytes, so a neighbour's
 * unstaged hooks/hooks.json or guard edit cannot refuse a commit that names
 * neither (#2901).
 *
 * The render itself, and why a deny-capable guard fails closed:
 * lib/plugin-hooks-render.js. A run writes `onFailure` into the self-plugin
 * file itself, which the core loads in place, and `--check` exits 1 naming
 * each registration out of step.
 */

const fs = require("node:fs");
const os = require("node:os");
const { writeFd } = require("./lib/write-fd.js");
const path = require("node:path");
const { parseOrExit } = require("./lib/cli-args.js");
const { hostRoot } = require("./lib/host-root.js");
const { caught } = require("./lib/caught.js");
const { extractTree, indexTree } = require("./lib/check.js");
const { guardDirs, isDenyCapableIn } = require("./lib/deny-capable.js");
const { SELF_PLUGIN_HOOKS, readHooksAt } = require("./lib/core-hooks.js");
const {
	ENTRY,
	OUT,
	renderAt,
	renderManifest,
	withFailClosed,
} = require("./lib/plugin-hooks-render.js");

/** @type {import("./lib/cli-args").CliSpec} */
const CLI = {
	usage: "Usage: node scripts/generate-plugin-hooks.js [--check]",
	flags: { "--check": "boolean" },
};

/* THE CORE'S OWN GATE. An adopter ships no plugin — its hooks come from the
 * pinned core — so the gate skips there rather than failing a first commit on
 * an absent self-plugin file (#5). */
const SKIP =
	"SKIP: this repo ships no plugin (.claude-plugin/plugin.json is absent), so there is no hook manifest to render\n";

/** @param {string} root */
const shipsPlugin = (root) =>
	fs.existsSync(path.join(root, ".claude-plugin/plugin.json"));

/** @param {string} root */
const failClosedAt = (root) =>
	withFailClosed(
		readHooksAt(root, SELF_PLUGIN_HOOKS),
		isDenyCapableIn(guardDirs(root, root)),
	);

/**
 * --check over `tree`: 0 where its hooks/hooks.json is the render of its
 * self-plugin file, 1 naming each fault where not.
 * @param {string} tree
 * @returns {number}
 */
function checkAt(tree) {
	const { drift } = failClosedAt(tree);
	/* The committed source, not the fixed one writeAt renders. */
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
	writeFd(
		2,
		`${faults.join("")}generate-plugin-hooks: run node scripts/generate-plugin-hooks.js, then stage ${OUT} and ${SELF_PLUGIN_HOOKS} with this commit\n`,
	);
	return 1;
}

/**
 * `checkAt` over the index of the repo git finds from the working directory.
 * @returns {number}
 */
function checkIndex() {
	const work = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-hooks-check-"));
	try {
		const tree = path.join(work, "tree");
		fs.mkdirSync(tree);
		extractTree(indexTree(path.join(work, "index")), tree);
		if (!shipsPlugin(tree)) {
			writeFd(2, SKIP);
			return 0;
		}
		return checkAt(tree);
	} finally {
		fs.rmSync(work, { recursive: true, force: true });
	}
}

/**
 * Writes `root`'s render to hooks/hooks.json, and `onFailure` into its
 * self-plugin file where that drifted.
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
	/* The file holds `hooks` alone: lib/core-hooks.js reads nothing else. */
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

function main() {
	const check = Boolean(
		parseOrExit(process.argv.slice(2), CLI).flags["--check"],
	);
	try {
		return check ? checkIndex() : writeAt(hostRoot());
	} catch (err) {
		writeFd(2, `generate-plugin-hooks: ${caught(err).message}\n`);
		return 2;
	}
}

if (require.main === module) process.exit(main());
