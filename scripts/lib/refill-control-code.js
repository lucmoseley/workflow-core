const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { pidLock } = require("./pid-lock.js");
const { linkOf } = require("./pinned-code.js");
const { procRoot } = require("./proc-root.js");
const { FIELD, readStatFields } = require("./proc-stat.js");
const { refillPath } = require("./refill-dir.js");
const { relativeUnder } = require("./is-under.js");
const { sleepSync } = require("./sleep-sync.js");

const PROGRAM_NAME = "refill-loop.js";
const PROGRAM = path.join("scripts", PROGRAM_NAME);
const PID_FILE = ".refill-loop.pid";
const CODE_DIR = ".refill-loop-code";
const CONTROL_COMMANDS = new Set(["start", "stop", "set", "status"]);
// the empty read measured 3 ms at most under 32 busy loops, #5571
const EXEC_WAIT_MS = 1000;
const EXEC_POLL_MS = 1;

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

// measured: a live pid reads an empty cmdline mid-exec, 15 in 4000 spawns, #5571
/**
 * @param {number} pid
 * @param {(ms: number) => void} pause
 * @returns {{argv: string[]}|{unread: string}}
 */
function readArgv(pid, pause) {
	for (let waited = 0; ; waited += EXEC_POLL_MS) {
		const raw = fs.readFileSync(`${procRoot()}/${pid}/cmdline`, "utf8");
		if (raw !== "") return { argv: raw.split("\0") };
		const state = readStatFields(pid)?.[FIELD.state];
		if (state === undefined || state === "Z")
			return { unread: `pid ${pid} has exited` };
		if (waited >= EXEC_WAIT_MS)
			return {
				unread: `pid ${pid}'s command line stayed empty for ${EXEC_WAIT_MS} ms`,
			};
		pause(EXEC_POLL_MS);
	}
}

/**
 * @param {number} pid
 * @param {{pause?: (ms: number) => void}} [ports]
 * @returns {{program: string}|{unread: string}}
 */
function readRunningProgram(pid, { pause = sleepSync } = {}) {
	try {
		const read = readArgv(pid, pause);
		if ("unread" in read) return read;
		const arg = read.argv.find((a) => path.basename(a) === PROGRAM_NAME);
		return arg
			? {
					program: path.resolve(
						fs.readlinkSync(`${procRoot()}/${pid}/cwd`),
						arg,
					),
				}
			: {
					unread: `pid ${pid} runs no ${PROGRAM_NAME}: ${read.argv.join(" ").trim()}`,
				};
	} catch (err) {
		if (isGone(err)) return { unread: `pid ${pid} is gone` };
		throw err;
	}
}

/**
 * @param {number|null} pid
 * @param {string} codeDir
 */
function readControlProgram(pid, codeDir) {
	const running = pid === null ? null : readRunningProgram(pid);
	const candidates = [
		running !== null && "program" in running ? running.program : null,
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
