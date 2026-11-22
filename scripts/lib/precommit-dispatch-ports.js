const fs = require("node:fs");
const path = require("node:path");
const v8 = require("node:v8");
const vm = require("node:vm");
const { getPoolFiles } = require("./always-loaded-pool.js");
const { checkInProcess } = require("./check.js");
const { spawnGitSync } = require("./git.js");
const { MODULES, moduleReader } = require("./workflow-core-config.js");
const { fromCoreRoot } = require("./precommit-gates.js");

v8.setFlagsFromString("--expose-gc");
const collect = vm.runInNewContext("gc");

/** @param {import("./precommit-gates.js").PrecommitGate} row */
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

/** @type {Record<string, () => string[]>} */
const COMPUTED = {
	"rule-fragment-sources": () =>
		require("../generate-rule-fragments.js").SOURCES,
	"always-loaded-pool": () => {
		try {
			return getPoolFiles();
		} catch {
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
 * @param {(fd: number, text: string) => void} write
 * @returns {(name: string) => boolean}
 */
function factsAt(cwd, write) {
	const on = moduleReader(cwd, (what, detail) =>
		write(2, `pre-commit: ${what}${detail ? ` — ${detail}` : ""}\n`),
	);
	return (name) => {
		const module = /^module:(.+)$/.exec(name)?.[1];
		const known = MODULES.find((m) => m === module);
		if (!known) throw new Error(`no fact is named '${name}'`);
		return on(known);
	};
}

/**
 * @param {string} cwd
 * @returns {(rel: string) => boolean}
 */
const existsUnder = (cwd) => (rel) => fs.existsSync(path.join(cwd, rel));

module.exports = { computed, existsUnder, factsAt, load, readStaged };
