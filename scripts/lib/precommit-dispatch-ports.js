/*
 * precommit-dispatch-ports.js — the pre-commit dispatcher's real `load` and
 * `computed` ports (#5172): what runs a row in this process, and the lists a
 * computed arm reads.
 */

const v8 = require("node:v8");
const vm = require("node:vm");
const { getPoolFiles } = require("./always-loaded-pool.js");
const { checkInProcess } = require("./check.js");
const { fromCoreRoot } = require("./precommit-gates.js");

/*
 * A full collection before each row. The members share one heap, and the
 * garbage an earlier row leaves makes a later one slower (#5172; measured
 * on #5166). Exposed from inside the process, as the hook's `node` line
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
 * that computes it. The always-loaded pool is the host config's
 * `alwaysLoaded`, else the default; a config that will not read lists
 * nothing (#5171), and the row's
 * pattern still arms on `.claude/`, where the config lives. The
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

module.exports = { computed, load };
