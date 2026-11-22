#!/usr/bin/env node

const fs = require("node:fs");
const { ignoreFailure } = require("../caught.js");
const { noop } = require("../noop.js");
const shared = require("./in-process-probe-modes.js");
const state = require("./in-process-probe-state.js");

const [mode, arg] = process.argv.slice(2);
const say = (/** @type {string} */ text) => fs.writeSync(1, `${text}\n`);

/** @type {Record<string, () => void>} */
const modes = {
	exit: () => {
		say("before exit");
		process.exit(Number(arg));
	},
	throw: () => {
		throw new Error("probe threw");
	},
	"throw-handled": () => {
		process.on("uncaughtException", (e) => {
			fs.writeSync(2, `handled: ${e.message}\n`);
			process.exit(7);
		});
		throw new Error("probe threw");
	},
	"exit-in-try": () => {
		try {
			say("before exit");
			process.exit(5);
		} catch {
			say("the script swallowed its own exit");
			process.exit(9);
		}
	},
	"exit-swallowed": () => {
		ignoreFailure(() => {
			say("before exit");
			process.exit(6);
		});
	},
	"add-listener": () => {
		process.on("uncaughtException", noop);
		process.on("SIGUSR2", noop);
	},
	"read-file": () => say(fs.readFileSync(String(arg), "utf8")),
	"entry-module": () => say(String(require.main === module)),
	state: () => {
		state.calls += 1;
		say(String(state.calls));
	},
};

const own = mode === undefined ? undefined : modes[mode];
const sharedMode = mode === undefined ? undefined : shared.modes[mode];
const run =
	own ??
	(sharedMode
		? () => sharedMode(arg)
		: () => {
				fs.writeSync(2, `unknown mode: ${mode}\n`);
				process.exit(2);
			});
run();
