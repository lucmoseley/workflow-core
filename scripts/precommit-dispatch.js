#!/usr/bin/env node
/*
 * precommit-dispatch.js — the pre-commit dispatcher's shell (#5172): runs
 * every row of lib/precommit-gates.js in this one process, through
 * lib/precommit-dispatch.js.
 *
 *   node scripts/precommit-dispatch.js [--gates=merge|--gates=batch]
 *
 * .husky/pre-commit runs it once, after the shared-tree branch check, passing
 * its own arguments through.
 * SIGINT, SIGTERM and SIGHUP are caught for the run (#5188): the row they
 * land in runs to its end and no row runs after; a second signal exits at
 * once.
 *
 * Exit 0 every armed gate passed, skipped or only warned; a gating red's own
 * code otherwise (1 FAIL, 2 BROKEN, a program's code); 1 where git will not
 * name the staged paths; 128 + n on signal n.
 */

const { caught } = require("./lib/caught.js");
const { flagValue, parseOrCode } = require("./lib/cli-args.js");
const { dispatch, gateSetOf } = require("./lib/precommit-dispatch.js");
const {
	computed,
	existsUnder,
	load,
	readStaged,
} = require("./lib/precommit-dispatch-ports.js");
const { GATES } = require("./lib/precommit-gates.js");
const { catchSignals } = require("./lib/hook-entry.js");
const { scriptPath } = require("./lib/script-path.js");
const { writeFd } = require("./lib/write-fd.js");

/** @returns {Promise<number>} the hook's exit code */
async function main() {
	const interrupted = catchSignals();
	const parsed = parseOrCode(process.argv.slice(2), {
		usage: `node ${scriptPath("precommit-dispatch.js")} [--gates=merge|--gates=batch]`,
		flags: { "--gates": "value" },
	});
	if (typeof parsed === "number") return parsed;
	const cwd = process.cwd();
	return dispatch({
		rows: GATES,
		gates: gateSetOf(flagValue(parsed.flags, "--gates")),
		ports: {
			staged: () => readStaged(cwd),
			computed,
			exists: existsUnder(cwd),
			load,
			write: writeFd,
			interrupted,
		},
	});
}

if (require.main === module)
	main().then(
		(code) => process.exit(code),
		(e) => {
			writeFd(2, `pre-commit: the dispatcher threw: ${caught(e).message}\n`);
			process.exit(2);
		},
	);
