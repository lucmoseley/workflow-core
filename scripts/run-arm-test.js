#!/usr/bin/env node
const { spawnRaw } = require("./lib/child-spawn.js");
const { parseOrExit } = require("./lib/cli-args");
const { hostRoot } = require("./lib/host-root.js");
const arm = require("./lib/run-arm.js");
const { sleepSync } = require("./lib/sleep-sync.js");
const { writeFd } = require("./lib/write-fd.js");

/** @param {string[]} argv */
function main(argv) {
	const parsed = parseOrExit(argv, arm.CLI);
	/** @type {import("./lib/run-arm.js").Ports} */
	const p = {
		env: process.env,
		claude: spawnRaw,
		node: (cli, args, opts) => spawnRaw(process.execPath, [cli, ...args], opts),
		clock: () => performance.now(),
		now: () => Date.now(),
		sleep: sleepSync,
		out: (text) => writeFd(1, text),
		err: (text) => writeFd(2, text),
		hostRoot: () => hostRoot(),
	};
	if (parsed.command === "plan") return arm.plan(p, parsed);
	if (parsed.command === "launch") return arm.launch(p, parsed);
	if (parsed.command === "run") return arm.run(p, parsed);
	if (parsed.command === "report") return arm.report(p, parsed);
	return arm.refuse(p, arm.CLI.usage);
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { main };
