/*
 * refill-control-code.js — the code a refill-loop control command runs from
 * (#4337). `start`, `stop`, `set` and `status` write or show the one
 * machine-wide control file, and an older checkout's parseControl drops every
 * field it does not list, so each runs from the code that reads that file: the
 * running loop's program; with no loop, the boot link's, the code the last loop
 * ran (lib/refill-code.js); with neither, the caller's own.
 *
 * scripts/refill-loop.js requires this before any other lib and hands off
 * before it parses its arguments, so a checkout whose libs or flags lag the
 * loop's still runs the loop's whole.
 *
 * Residual: a live loop whose command line names no program on disk, with no
 * boot link, leaves the caller's own code to write the file.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { pidLock } = require("./pid-lock.js");
const { linkOf } = require("./pinned-code.js");
const { procRoot } = require("./proc-root.js");
const { refillPath } = require("./refill-dir.js");

const PROGRAM_NAME = "refill-loop.js";
const PROGRAM = path.join("scripts", PROGRAM_NAME);
const PID_FILE = ".refill-loop.pid";
const CODE_DIR = ".refill-loop-code";
const CONTROL_COMMANDS = new Set(["start", "stop", "set", "status"]);

/** @param {string} codeDir */
const bootLinkOf = (codeDir) => linkOf(codeDir, "current");

/** @param {string} codeDir the program the boot link names */
const bootLinkProgram = (codeDir) => path.join(bootLinkOf(codeDir), PROGRAM);

/** @param {unknown} err */
const isGone = (err) => caught(err).code === "ENOENT";

/**
 * `file` named through the boot link where it sits in one of the loop's code
 * worktrees, which the loop removes once it adopts a newer tip and nothing
 * runs from it; null where it sits in none.
 * @param {string} file a real path
 */
function throughBootLink(file) {
	const codeDir = refillPath(CODE_DIR);
	let realCodeDir;
	try {
		realCodeDir = fs.realpathSync(codeDir);
	} catch (err) {
		if (isGone(err)) return null;
		throw err;
	}
	if (!file.startsWith(`${realCodeDir}${path.sep}`)) return null;
	const [, ...inTip] = path.relative(realCodeDir, file).split(path.sep);
	return path.join(bootLinkOf(codeDir), ...inTip);
}

/**
 * The program the loop at `pid` runs, resolved against its cwd; null where the
 * process is gone or its command line names none.
 * @param {number} pid
 * @throws where its command line or cwd will not read for another reason
 */
function readRunningProgram(pid) {
	try {
		const arg = fs
			.readFileSync(`${procRoot()}/${pid}/cmdline`, "utf8")
			.split("\0")
			.find((a) => path.basename(a) === PROGRAM_NAME);
		return arg
			? path.resolve(fs.readlinkSync(`${procRoot()}/${pid}/cwd`), arg)
			: null;
	} catch (err) {
		if (isGone(err)) return null;
		throw err;
	}
}

/**
 * The real path of the program a control command runs from: the loop at
 * `pid`'s, else the boot link's; null where neither is on disk.
 * @param {number|null} pid
 * @param {string} codeDir
 */
function readControlProgram(pid, codeDir) {
	const candidates = [
		pid === null ? null : readRunningProgram(pid),
		bootLinkProgram(codeDir),
	];
	for (const program of candidates) {
		if (program === null) continue;
		try {
			return fs.realpathSync(program);
		} catch (err) {
			if (!isGone(err)) throw err;
		}
	}
	return null;
}

/**
 * Run control command `argv` from the loop's code where `self` is not it,
 * returning its exit; null where `self` runs it.
 * @param {string[]} argv
 * @param {string} self the calling program's path
 */
function handOff(argv, self) {
	if (!CONTROL_COMMANDS.has(String(argv[0]))) return null;
	const program = readControlProgram(
		pidLock(refillPath(PID_FILE), PROGRAM_NAME).holder(),
		refillPath(CODE_DIR),
	);
	if (program === null || program === fs.realpathSync(self)) return null;
	const r = spawnSync(process.execPath, [program, ...argv], {
		stdio: "inherit",
	});
	if (r.error) throw r.error;
	return r.status ?? 1;
}

module.exports = {
	CODE_DIR,
	PID_FILE,
	PROGRAM,
	PROGRAM_NAME,
	bootLinkOf,
	bootLinkProgram,
	handOff,
	readRunningProgram,
	throughBootLink,
};
