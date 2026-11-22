#!/usr/bin/env node
const { caught } = require("./lib/caught.js");
const { flagValue, parseOrCode } = require("./lib/cli-args.js");
const { dispatch, gateSetOf } = require("./lib/precommit-dispatch.js");
const {
	computed,
	existsUnder,
	factsAt,
	load,
	readStaged,
} = require("./lib/precommit-dispatch-ports.js");
const { GATES } = require("./lib/precommit-gates.js");
const { catchSignals } = require("./lib/hook-entry.js");
const { scriptPath } = require("./lib/script-path.js");
const { writeFd } = require("./lib/write-fd.js");

/** @returns {Promise<number>} */
async function main() {
	const interrupted = catchSignals();
	const parsed = parseOrCode(process.argv.slice(2), {
		usage: `node ${scriptPath("precommit-dispatch.js")} [--gates=merge|--gates=batch|--gates=tested]`,
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
			fact: factsAt(cwd, writeFd),
			load,
			write: writeFd,
			interrupted,
		},
	});
}

module.exports = { main };

if (require.main === module)
	main().then(
		(code) => process.exit(code),
		(e) => {
			writeFd(2, `pre-commit: the dispatcher threw: ${caught(e).message}\n`);
			process.exit(2);
		},
	);
