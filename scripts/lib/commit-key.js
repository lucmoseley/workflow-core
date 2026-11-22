#!/usr/bin/env node

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

/** @param {string} gate */
function checkGate(gate) {
	if (!isGate(gate))
		throw new Error(`gate name '${gate}' is not lowercase letters alone`);
	return gate;
}

/** @param {string} gate */
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
