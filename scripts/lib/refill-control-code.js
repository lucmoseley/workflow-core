const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { pidLock } = require("./pid-lock.js");
const { linkOf } = require("./pinned-code.js");
const { procRoot } = require("./proc-root.js");
const { refillPath } = require("./refill-dir.js");
const { relativeUnder } = require("./is-under.js");

const PROGRAM_NAME = "refill-loop.js";
const PROGRAM = path.join("scripts", PROGRAM_NAME);
const PID_FILE = ".refill-loop.pid";
const CODE_DIR = ".refill-loop-code";
const CONTROL_COMMANDS = new Set(["start", "stop", "set", "status"]);

/** @param {string} codeDir */
const bootLinkOf = (codeDir) => linkOf(codeDir, "current");

/** @param {string} codeDir */
const bootLinkProgram = (codeDir) => path.join(bootLinkOf(codeDir), PROGRAM);

/** @param {unknown} err */
const isGone = (err) => caught(err).code === "ENOENT";

/** @param {string} file */
function throughBootLink(file) {
	const codeDir = refillPath(CODE_DIR);
	let realCodeDir;
	try {
		realCodeDir = fs.realpathSync(codeDir);
	} catch (err) {
		if (isGone(err)) return null;
		throw err;
	}
	const rel = relativeUnder(realCodeDir, file);
	if (!rel) return null;
	const [, ...inTip] = rel.split(path.sep);
	return path.join(bootLinkOf(codeDir), ...inTip);
}

/** @param {number} pid */
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
 * @param {string[]} argv
 * @param {string} self
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
