#!/usr/bin/env node
/*
 * A stand-in CLI for run-in-process.test.ts (mantahostels#1907): one entry per property
 * the seam claims to reproduce. Tracked rather than written to a temp dir per test
 * because the registry purge only reaches modules inside this repo, which is
 * what the `state` mode exists to show.
 *
 * A lookup rather than a switch: `process.exit` is typed `never`, so a case
 * ending in one has an unreachable `break` that the typecheck rejects and a
 * missing one that the linter rejects.
 *
 * Its writes stay a bare `fs.writeSync`, never lib/write-fd.js (#1676): that
 * call on fd 1 and 2 is the route run-in-process.js captures, so it is what
 * the probe exists to exercise.
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const state = require("./in-process-probe-state.js");

const [mode, arg] = process.argv.slice(2);
const say = (/** @type {string} */ text) => fs.writeSync(1, `${text}\n`);

/** @type {Record<string, () => void>} */
const modes = {
	exit: () => {
		say("before exit");
		process.exit(Number(arg));
	},
	"exit-code": () => {
		process.exitCode = Number(arg);
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
		// The one path where the recorded code is the only record of the exit.
		try {
			say("before exit");
			process.exit(6);
		} catch {
			/* the swallow under test: the recorded code is the exit's only trace */
		}
	},
	"add-listener": () => {
		process.on("uncaughtException", () => {
			/* only its registration matters: the seam must remove it */
		});
		process.on("SIGUSR2", () => {
			/* only its registration matters: the seam must remove it */
		});
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
	"read-file": () => say(fs.readFileSync(String(arg), "utf8")),
	env: () =>
		say(
			`${process.env.PROBE ?? "<unset>"}|${String("CARRIED" in process.env)}`,
		),
	argv: () => say(process.argv.slice(2).join(",")),
	"entry-module": () => say(String(require.main === module)),
	state: () => {
		state.calls += 1;
		say(String(state.calls));
	},
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
};

const run =
	(mode === undefined ? undefined : modes[mode]) ??
	(() => {
		fs.writeSync(2, `unknown mode: ${mode}\n`);
		process.exit(2);
	});
run();
