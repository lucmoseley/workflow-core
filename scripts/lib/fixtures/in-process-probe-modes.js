const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const { noop } = require("../noop.js");
const { readFdAll } = require("../read-fd.js");

const LEAKED = Symbol.for("wfc.in-process-probe.leaked");

const say = (/** @type {string} */ text) => fs.writeSync(1, `${text}\n`);

const leak = () => {
	const timer = setInterval(noop, 1000);
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
	"stdin-read-fd": () => say(readFdAll(0).toString("utf8")),
	env: () =>
		say(
			`${process.env.PROBE ?? "<unset>"}|${String("CARRIED" in process.env)}`,
		),
	argv: () => say(process.argv.slice(2).join(",")),
	uptime: () => say(String(process.uptime())),
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
	"leak-then-handled-throw": () => {
		process.on("uncaughtException", noop);
		leak();
		throw new Error("probe threw");
	},
};

module.exports = { LEAKED, modes };
