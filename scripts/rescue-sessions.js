#!/usr/bin/env node
// cli-args-exempt: #5540

const { writeFd } = require("./lib/write-fd.js");
const { ENTRIES, parseArgs } = require("./lib/rescue-cli.js");

/** @returns {import("./lib/rescue-jobs.js").RescuePorts} */
function productionPorts() {
	const { runOracle } = require("./lib/agent-liveness.js");
	const { spawnRaw } = require("./lib/child-spawn.js");
	const { gh } = require("./lib/gh.js");
	const { procRoot } = require("./lib/proc-root.js");
	return {
		env: process.env,
		now: Date.now,
		sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
		oracle: runOracle,
		claude: spawnRaw,
		gh,
		procRoot: procRoot(),
	};
}

/** @param {string[]} [argv] */
async function main(argv = process.argv.slice(2)) {
	const args = parseArgs(argv);
	const run = ENTRIES[/** @type {keyof typeof ENTRIES} */ (args._[0])];
	const { status, stdout, stderr } = await run()(args, productionPorts());
	writeFd(1, stdout);
	writeFd(2, stderr);
	process.exit(status);
}

module.exports = { main };

if (require.main === module)
	main().catch((e) => {
		writeFd(2, `rescue-sessions: ${e?.stack ?? e}\n`);
		process.exit(1);
	});
