/*
 * precommit-dispatch-ports.js — the pre-commit dispatcher's real ports
 * (#5172).
 */

const fs = require("node:fs");
const path = require("node:path");
const v8 = require("node:v8");
const vm = require("node:vm");
const { getPoolFiles } = require("./always-loaded-pool.js");
const { checkInProcess } = require("./check.js");
const { spawnGitSync } = require("./git.js");
const { fromCoreRoot } = require("./precommit-gates.js");

/*
 * A full collection before each row. The members share one heap, and the
 * garbage an earlier row leaves makes a later one slower (#5172). Exposed from inside the process, as the hook's `node` line
 * carries no flag.
 */
v8.setFlagsFromString("--expose-gc");
const collect = vm.runInNewContext("gc");

/**
 * A thunk running `row` in-process after a collection.
 * @param {import("./precommit-gates.js").PrecommitGate} row
 */
function load(row) {
	const script = fromCoreRoot(row.script);
	if (row.kind === "program") {
		const { PROGRAM } = require(script);
		if (!PROGRAM) throw new Error(`${row.script} exports no PROGRAM.`);
		return () => {
			collect();
			return PROGRAM({ cwd: process.cwd(), env: process.env });
		};
	}
	const { SPEC } = require(script);
	if (!SPEC) throw new Error(`${row.script} exports no SPEC.`);
	return () => {
		collect();
		return checkInProcess(SPEC, row.args, {
			script,
			sides: row.side ? "spawn" : "in-process",
		});
	};
}

/**
 * The lists a `computed` arm names, each read in-process from the library
 * that computes it. A pool config that will not read lists nothing
 * (#5171), and the row's pattern still arms on `.claude/`, where the config
 * lives. The
 * rule-fragment sources are the generator's own list, so the row cannot arm
 * on fewer than it scans.
 * @type {Record<string, () => string[]>}
 */
const COMPUTED = {
	"rule-fragment-sources": () =>
		require("../generate-rule-fragments.js").SOURCES,
	"always-loaded-pool": () => {
		try {
			return getPoolFiles();
		} catch {
			/* A config that will not read: the checker names it when it runs. */
			return [];
		}
	},
};

/** @param {string} name */
function computed(name) {
	const list = COMPUTED[name];
	if (!list) throw new Error(`no computed list is named ${name}.`);
	return list();
}

/**
 * The commit's staged entries, by staged_names' call: `--no-renames` so a
 * rename is its `D` and its `A`, `-z` so a non-ASCII path is not quoted.
 * @param {string} cwd
 * @returns {import("./precommit-dispatch.js").StagedEntry[]}
 */
function readStaged(cwd) {
	const r = spawnGitSync(
		["diff", "--cached", "--name-status", "--no-renames", "-z"],
		{ cwd, encoding: "utf8" },
	);
	if (r.status !== 0 || r.error)
		throw new Error(
			"could not read this commit's staged paths from git — refusing, since no gate could arm.",
		);
	/* Every field ends in a NUL, so a whole list splits to status-path pairs
	 * and one trailing "". */
	const fields = String(r.stdout).split("\0");
	const brokeOff = () =>
		new Error(
			"git's staged path list broke off mid-entry — refusing, since no gate could arm on it.",
		);
	if (fields.pop() !== "") throw brokeOff();
	const entries = [];
	for (let i = 0; i < fields.length; i += 2) {
		const status = fields[i];
		const rel = fields[i + 1];
		if (status === undefined || rel === undefined) throw brokeOff();
		entries.push({ status, path: rel });
	}
	return entries;
}

/**
 * @param {string} cwd
 * @returns {(rel: string) => boolean}
 */
const existsUnder = (cwd) => (rel) => fs.existsSync(path.join(cwd, rel));

module.exports = { computed, existsUnder, load, readStaged };
