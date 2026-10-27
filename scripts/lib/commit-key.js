#!/usr/bin/env node
/*
 * commit-key.js — the key naming one commit's own changes for one slow gate
 * (#1650, spec #1639): the gate's name, then every (path, new mode, new blob
 * id) by which the index differs from HEAD, deletions included, sorted and
 * hashed. HEAD's side of an entry is not in it, so a neighbour moving HEAD
 * voids a key only where that changes what this commit adds. An unborn branch
 * compares against the empty tree.
 *
 * A gate's pre-lock green writes its key to a stamp of its own, named to the
 * hook by a variable of its own (#1904).
 *
 * One module for both sides — commit-paths in process, the pre-commit gate
 * through `stand-down` — so the two cannot disagree on a key.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { writeFd } = require("./write-fd.js");
const { execGit } = require("./git.js");

/**
 * @param {{env?: NodeJS.ProcessEnv}} opts
 * @param {string[]} args
 */
const git = (opts, ...args) =>
	execGit(args, {
		env: opts.env ?? process.env,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});

/** @param {string} gate */
const isGate = (gate) => /^[a-z]+$/.test(gate);

/**
 * So the name is safe in a variable and a file name.
 * @param {string} gate
 */
function checkGate(gate) {
	if (!isGate(gate))
		throw new Error(`gate name '${gate}' is not lowercase letters alone`);
	return gate;
}

/**
 * The variable naming `gate`'s stamp to the hook: WFC_TEST_STAMP for `test`.
 * @param {string} gate
 */
const stampVariable = (gate) => `WFC_${checkGate(gate).toUpperCase()}_STAMP`;

/**
 * @param {string} gate
 * @param {string} gitDir
 * @param {string} run
 */
const stampFile = (gate, gitDir, run) =>
	path.join(gitDir, `${run}.${checkGate(gate)}-stamp`);

/**
 * @param {string} file
 * @param {string} key
 */
const writeStamp = (file, key) => fs.writeFileSync(file, `${key}\n`);

/**
 * `gate`'s key of the index `env.GIT_INDEX_FILE` names, or the default index.
 * Throws where git cannot read it.
 * @param {string} gate
 * @param {{env?: NodeJS.ProcessEnv}} [opts]
 * @returns {string}
 */
function commitKey(gate, opts = {}) {
	checkGate(gate);
	let base;
	try {
		base = git(opts, "rev-parse", "--verify", "-q", "HEAD^{tree}").trim();
	} catch {
		base = git(opts, "hash-object", "-t", "tree", "/dev/null").trim();
	}
	const fields = git(
		opts,
		"diff-index",
		"--cached",
		"--no-renames",
		"-z",
		base,
	).split("\0");
	const entries = [];
	for (let i = 0; ; i += 2) {
		const meta = fields[i];
		const file = fields[i + 1];
		if (meta === undefined || file === undefined) break;
		const [, newMode, , newBlob] = meta.split(" ");
		entries.push(`${newMode} ${newBlob}\t${file}`);
	}
	entries.sort();
	return crypto
		.createHash("sha256")
		.update([gate, ...entries].join("\0"))
		.digest("hex");
}

/**
 * Null where `stampPath` may stand `gate` down for the index git handed the
 * hook; otherwise the condition that failed.
 * @param {string} gate
 * @param {string} stampPath
 * @returns {string|null}
 */
function standDownRefusal(gate, stampPath) {
	if (!stampPath) return "no stamp named";
	const unreadable =
		"stamp unreadable or outside this checkout's git directory";
	let recorded;
	try {
		const gitDir = git({}, "rev-parse", "--absolute-git-dir").trim();
		const real = fs.realpathSync(stampPath);
		// Directly in it: a linked worktree's git directory sits under the main
		// checkout's, and its stamp must not stand the main checkout down.
		if (path.dirname(real) !== fs.realpathSync(gitDir)) return unreadable;
		recorded = fs.readFileSync(real, "utf8").trim();
	} catch {
		return unreadable;
	}
	let key;
	try {
		key = commitKey(gate);
	} catch {
		return "the key could not be computed";
	}
	return recorded === key ? null : "changes that do not match";
}

/* `node commit-key.js key <gate>` prints the key;
 * `node commit-key.js stand-down <gate> <stamp>` exits 0 where the stamp
 * stands that gate down, and otherwise prints the failed condition and exits 1. */
if (require.main === module) {
	const [verb, gate = "", stamp] = process.argv.slice(2);
	if (verb === "key" && isGate(gate)) {
		writeFd(1, `${commitKey(gate)}\n`);
	} else if (verb === "stand-down" && isGate(gate)) {
		const why = standDownRefusal(gate, stamp ?? "");
		if (why !== null) {
			writeFd(1, `${why}\n`);
			process.exit(1);
		}
	} else {
		writeFd(
			2,
			"usage: node commit-key.js key <gate> | stand-down <gate> <stamp>\n",
		);
		process.exit(2);
	}
}

module.exports = { commitKey, stampFile, stampVariable, writeStamp };
