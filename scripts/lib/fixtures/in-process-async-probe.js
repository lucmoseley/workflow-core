#!/usr/bin/env node
/*
 * A stand-in async CLI for run-in-process.test.ts's `runInProcessAsync`
 * cases (mantahostels#1944) — the shape `pick-next.js` and its two siblings share:
 * `async function main()`, exported, invoked only under
 * `require.main === module`.
 *
 * A lookup rather than a switch, for the reason `in-process-probe.js`'s own
 * header gives.
 *
 * Its writes stay a bare `fs.writeSync`, never lib/write-fd.js (#1676): that
 * call on fd 1 and 2 is the route run-in-process.js captures, so it is what
 * the probe exists to exercise.
 */

const fs = require("node:fs");
const shared = require("./in-process-probe-modes.js");

const [mode, arg] = process.argv.slice(2);
const say = (/** @type {string} */ text) => fs.writeSync(1, `${text}\n`);
const tick = () => new Promise((resolve) => setImmediate(resolve));

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
	/* pick-next.js requires lib/gh.js at its own top level, which requires
	 * lib/check.js, which installs an `uncaughtException` listener at require
	 * time — before its main() ever runs. This mode requires it from inside
	 * main() instead, purely so the probe stays clean under every other mode;
	 * what matters for mantahostels#1996 is only that the listener is installed before the
	 * rejection, which either shape gives. */
	"reject-with-listener": async () => {
		require("../check");
		await tick();
		throw new Error("probe rejected");
	},
	/* The status a tail like queue-run.js's takes from main's resolved value. */
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
	/* run-in-process.test.ts's takeover cases: a call that outlives the one
	 * that takes it over as stale. */
	delay: async () => {
		await new Promise((resolve) => setTimeout(resolve, Number(arg)));
		say("delayed done");
	},
	/* Same wait, no output of its own — isolates whether a stale call's late
	 * settle disturbs a call that took it over, from whatever that stale
	 * call's own script writes while it is still running. */
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
	/* After an await, so only a check made once main() settles sees a leak. */
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
