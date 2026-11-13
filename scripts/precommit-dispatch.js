#!/usr/bin/env node
/*
 * precommit-dispatch.js — the pre-commit dispatcher's shell (#5172): runs
 * every row of lib/precommit-gates.js in this one process, through
 * lib/precommit-dispatch.js, so the hook's Node gates share one startup.
 *
 *   node scripts/precommit-dispatch.js [--gates=merge|--gates=batch]
 *
 * .husky/pre-commit runs it once, after the shared-tree branch check, passing
 * its own arguments through. It wires the real ports — git in the working
 * directory the hook runs in, the filesystem, fds 1 and 2 — and exits with
 * the core's code. A checker row runs through lib/check.js's
 * checkInProcess(), its sides in-process unless the row keeps a `side`.
 * SIGINT, SIGTERM and SIGHUP are caught for the run (#5188): the row they
 * land in runs to its end, its own scratch cleanup with it, and no row runs
 * after, the run exiting 128 + n.
 *
 * Exit 0 every armed gate passed, skipped or only warned; a gating red's own
 * code otherwise (1 FAIL, 2 BROKEN, a program's code); 1 where git will not
 * name the staged paths, since no gate could arm; 128 + n on signal n.
 */

const { constants } = require("node:os");

const { getPoolFiles } = require("./lib/always-loaded-pool.js");
const { checkInProcess } = require("./lib/check.js");
const { caught } = require("./lib/caught.js");
const { flagValue, parseOrCode } = require("./lib/cli-args.js");
const {
	dispatch,
	existsUnder,
	gateSetOf,
	readStaged,
} = require("./lib/precommit-dispatch.js");
const { fromCoreRoot, GATES } = require("./lib/precommit-gates.js");
const { scriptPath } = require("./lib/script-path.js");
const { writeFd } = require("./lib/write-fd.js");

/**
 * The runner one row names, run in-process: a program's exported PROGRAM over
 * the working directory, or a checker's exported SPEC.
 * @param {import("./lib/precommit-gates.js").PrecommitGate} row
 */
function load(row) {
	const script = fromCoreRoot(row.script);
	if (row.kind === "program") {
		const { PROGRAM } = require(script);
		if (!PROGRAM) throw new Error(`${row.script} exports no PROGRAM.`);
		return () => PROGRAM({ cwd: process.cwd(), env: process.env });
	}
	const { SPEC } = require(script);
	if (!SPEC) throw new Error(`${row.script} exports no SPEC.`);
	return () =>
		checkInProcess(SPEC, row.args, {
			script,
			sides: row.side ? "spawn" : "in-process",
		});
}

/**
 * The lists a `computed` arm names, each read in-process from the library
 * that computes it. The always-loaded pool is the host config's
 * `alwaysLoaded`, else the default; a config that will not read lists
 * nothing, as the hook's `2>/dev/null` read did, and the row's pattern still
 * arms on `.claude/`, where the config lives. The rule-fragment sources are
 * the generator's own list, so the row cannot arm on fewer than it scans.
 * @type {Record<string, () => string[]>}
 */
const COMPUTED = {
	"rule-fragment-sources": () =>
		require("./generate-rule-fragments.js").SOURCES,
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
 * Catches SIGINT, SIGTERM and SIGHUP for the rest of the process, and answers
 * the dispatcher's `interrupted` port: the first caught signal's 128 + n,
 * else null. A listener fires only between event-loop turns, so the port
 * yields one turn before it answers; a synchronous row runs on to its end.
 * @returns {() => Promise<number | null>}
 */
function catchSignals() {
	/** @type {number | null} */
	let code = null;
	/** @param {NodeJS.Signals} name */
	const record = (name) => {
		code ??= 128 + constants.signals[name];
	};
	for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(name, record);
	return () => new Promise((resolve) => setImmediate(() => resolve(code)));
}

/** @returns {Promise<number>} the hook's exit code */
async function main() {
	const interrupted = catchSignals();
	const parsed = parseOrCode(process.argv.slice(2), {
		usage: `node ${scriptPath("precommit-dispatch.js")} [--gates=merge|--gates=batch]`,
		flags: { "--gates": "value" },
	});
	if (typeof parsed === "number") return parsed;
	const cwd = process.cwd();
	/** @type {import("./lib/precommit-dispatch.js").StagedEntry[]} */
	let staged;
	try {
		staged = readStaged(cwd);
	} catch (e) {
		writeFd(2, `pre-commit: ${caught(e).message}\n`);
		process.exit(1);
	}
	return dispatch({
		rows: GATES,
		gates: gateSetOf(flagValue(parsed.flags, "--gates")),
		ports: {
			staged: () => staged,
			computed,
			exists: existsUnder(cwd),
			load,
			write: writeFd,
			interrupted,
		},
	});
}

module.exports = { computed, load };

if (require.main === module)
	main().then(
		(code) => process.exit(code),
		(e) => {
			writeFd(2, `pre-commit: the dispatcher threw: ${caught(e).message}\n`);
			process.exit(2);
		},
	);
