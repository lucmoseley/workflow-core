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
 *
 * Exit 0 every armed gate passed, skipped or only warned; a gating red's own
 * code otherwise (1 FAIL, 2 BROKEN, a program's code); 1 where git will not
 * name the staged paths, since no gate could arm.
 */

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
 * The runner one row names: a checker's exported SPEC, run in-process.
 * @param {import("./lib/precommit-gates.js").PrecommitGate} row
 */
function load(row) {
	const script = fromCoreRoot(row.script);
	const { SPEC } = require(script);
	if (!SPEC) throw new Error(`${row.script} exports no SPEC.`);
	return () =>
		checkInProcess(SPEC, row.args, {
			script,
			sides: row.side ? "spawn" : "in-process",
		});
}

/** @returns {Promise<number>} the hook's exit code */
async function main() {
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
			computed: () => [],
			exists: existsUnder(cwd),
			load,
			write: writeFd,
		},
	});
}

main().then(
	(code) => process.exit(code),
	(e) => {
		writeFd(2, `pre-commit: the dispatcher threw: ${caught(e).message}\n`);
		process.exit(2);
	},
);
