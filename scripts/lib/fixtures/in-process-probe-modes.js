/*
 * The probe modes both in-process-probe.js and in-process-async-probe.js run,
 * so run-in-process.test.ts's contract rows hold each entry point to the same
 * spawned behaviour (#2782). A mode whose result names its own file, or reads
 * its own `module`, stays in its probe.
 *
 * Writes stay a bare `fs.writeSync`, for the reason in-process-probe.js's
 * header gives.
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

/* Where a leak mode parks its timer, so the test that refused one can clear
 * it rather than leave it running in the vitest worker. */
const LEAKED = Symbol.for("wfc.in-process-probe.leaked");

const say = (/** @type {string} */ text) => fs.writeSync(1, `${text}\n`);

/* "armed" tells a spawned run that hangs apart from one that never started. */
const leak = () => {
	const timer = setInterval(() => {
		/* only its being live matters: the harness must see it */
	}, 1000);
	/** @type {any} */ (globalThis)[LEAKED] = timer;
	say("armed");
	return timer;
};

/** @type {Record<string, (arg: string | undefined) => void>} */
const modes = {
	"exit-code": (arg) => {
		process.exitCode = Number(arg);
	},
	streams: () => {
		fs.writeSync(1, "fd1\n");
		fs.writeSync(2, "fd2\n");
		process.stdout.write("stdout-write\n");
		console.log("console-log");
		console.error("console-error");
	},
	cwd: () => say(process.cwd()),
	stdin: () => say(fs.readFileSync(0, "utf8")),
	"stdin-buffer": () => say(fs.readFileSync(0).toString("utf8")),
	env: () =>
		say(
			`${process.env.PROBE ?? "<unset>"}|${String("CARRIED" in process.env)}`,
		),
	argv: () => say(process.argv.slice(2).join(",")),
	child: () =>
		say(
			execFileSync(
				process.execPath,
				[
					"-e",
					"process.stdout.write(process.cwd()+'|'+(process.env.PROBE??'<unset>'))",
				],
				{ encoding: "utf8" },
			),
		),
	"leak-timer": () => {
		leak();
	},
	"leak-timer-unref": () => {
		leak().unref();
	},
	"leak-then-exit": () => {
		leak();
		process.exit(0);
	},
	"leak-then-throw": () => {
		leak();
		throw new Error("probe threw");
	},
	/* A listener that returns keeps a real process running, timer and all. */
	"leak-then-handled-throw": () => {
		process.on("uncaughtException", () => {
			/* returns */
		});
		leak();
		throw new Error("probe threw");
	},
};

module.exports = { LEAKED, modes };
