#!/usr/bin/env node

const fs = require("node:fs");
const { sleepSync } = require("../sleep-sync.js");
const shared = require("./in-process-probe-modes.js");

const [mode, arg] = process.argv.slice(2);
const say = (/** @type {string} */ text) => fs.writeSync(1, `${text}\n`);
const tick = () => new Promise((resolve) => setImmediate(resolve));

const STALL_MS = 400;
// guess, #5529
const CLOSE_AFTER_MS = 20;

/** @type {Record<string, (argv: string[]) => Promise<number | void>>} */
const modes = {
	exit: async () => {
		say("before exit");
		await tick();
		process.exit(Number(arg));
	},
	reject: async () => {
		await tick();
		throw new Error("probe rejected");
	},
	"reject-with-listener": async () => {
		require("../check");
		await tick();
		throw new Error("probe rejected");
	},
	returns: async () => Number(arg),
	"main-argv": async (argv) => {
		say(JSON.stringify(argv));
	},
	"entry-module": async () => {
		say(String(require.main === module));
	},
	ordered: async () => {
		say("first");
		await tick();
		say("second");
	},
	ran: async () => {
		say("ran once");
	},
	"close-watcher-stalled": async () => {
		const watcher = fs.watch(process.cwd());
		setTimeout(() => {
			watcher.close();
			sleepSync(STALL_MS);
		}, CLOSE_AFTER_MS);
	},
	delay: async () => {
		await new Promise((resolve) => setTimeout(resolve, Number(arg)));
		say("delayed done");
	},
	"delay-silent": async () => {
		await new Promise((resolve) => setTimeout(resolve, Number(arg)));
	},
};

/** @param {string[]} argv */
async function main(argv) {
	const own = mode === undefined ? undefined : modes[mode];
	const sharedMode = mode === undefined ? undefined : shared.modes[mode];
	if (own) return own(argv);
	if (!sharedMode) {
		fs.writeSync(2, `unknown mode: ${mode}\n`);
		process.exit(2);
	}
	await tick();
	sharedMode(arg);
}

module.exports = { main };

if (require.main === module) {
	main(process.argv.slice(2)).then(
		(code) => {
			if (typeof code === "number") process.exitCode = code;
		},
		(e) => {
			fs.writeSync(2, `FAILED: ${e?.stack || String(e)}\n`);
			process.exit(1);
		},
	);
}
