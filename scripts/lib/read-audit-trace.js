const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { caught, ignoreFailure } = require("./caught.js");
const { readText } = require("./file-read.js");
const { isUnder } = require("./is-under.js");
const { pathKind } = require("./path-kind.js");
const { repoPath } = require("./read-audit-paths.js");
const { sleepSync } = require("./sleep-sync.js");

const FLAGS = [
	"-f",
	"-DD",
	"--seccomp-bpf",
	"--kill-on-exit",
	"-q",
	"-y",
	"-e",
	"trace=%file,fchdir,connect,sendto,sendmsg,sendmmsg,kill,tkill,tgkill",
];

const SH = "/bin/sh";

const TASKSET = "/usr/bin/taskset";

/** @type {boolean|undefined} */
let canPin;

/** @returns {string|null} */
function readPinCpu() {
	canPin ??= isRunnable(TASKSET);
	if (!canPin) return null;
	try {
		const stat = fs.readFileSync("/proc/self/stat", "utf8");
		const cpu = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[36];
		return cpu !== undefined && /^\d+$/.test(cpu) ? cpu : null;
	} catch {
		return null;
	}
}

/** @param {string} file */
function isRunnable(file) {
	try {
		fs.accessSync(file, fs.constants.X_OK);
		return pathKind(file) === "file";
	} catch {
		return false;
	}
}

const INNER =
	'a=$1 b=$2; shift 2; [ -z "$a" ] || exec >"$a"; [ -z "$b" ] || exec 2>"$b"; exec "$@"';

const OUTER = [
	"c=$1 s=$2 o=$3; shift 3; a= b=",
	"if [ -p /dev/fd/1 ] || [ -S /dev/fd/1 ]; then a=$o.1; fi",
	"if [ -p /dev/fd/2 ] || [ -S /dev/fd/2 ]; then b=$o.2; fi",
	'[ -z "$a" ] || /usr/bin/mkfifo "$a" || exit 127',
	'[ -z "$b" ] || /usr/bin/mkfifo "$b" || exit 127',
	'if [ -n "$a" ]; then { /bin/cat <"$a" 2>/dev/null; /bin/rm -f "$a"; } & fi',
	'if [ -n "$b" ]; then { /bin/cat <"$b" 1>&2; /bin/rm -f "$b"; } & fi',
	'[ -z "$a" ] || exec >/dev/null',
	'[ -z "$b" ] || exec 2>/dev/null',
	`set -- "$s" ${FLAGS.join(" ")} -o "$o" -- ${SH} -c '${INNER}' sh "$a" "$b" "$@"`,
	`if [ -n "$c" ]; then exec ${TASKSET} -c "$c" "$@"; fi`,
	'exec "$@"',
].join("\n");

/**
 * @param {string} strace
 * @param {string} out
 * @param {string[]} argv
 */
const buildTraceArgv = (strace, out, argv) => [
	SH,
	"-c",
	OUTER,
	"sh",
	readPinCpu() ?? "",
	strace,
	out,
	...argv,
];

// guess, workflow-core#5218
const COPY_MS = 2000;
const COPY_STEP_MS = 5;

/**
 * @typedef {{
 *   openSync: typeof fs.openSync,
 *   closeSync: typeof fs.closeSync,
 *   unlinkSync: typeof fs.unlinkSync,
 * }} FifoIo
 */

/**
 * @param {string} abs
 * @param {FifoIo} io
 */
function isCopying(abs, io) {
	let fd;
	try {
		fd = io.openSync(abs, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
	} catch (e) {
		if (caught(e).code === "ENXIO") ignoreFailure(() => io.unlinkSync(abs));
		return false;
	}
	io.closeSync(fd);
	return true;
}

/**
 * @param {string} out
 * @param {number[]} fds
 * @param {FifoIo} io
 * @param {Clock} [clock]
 */
function awaitCopied(out, fds, io, clock = REAL_CLOCK) {
	const deadline = clock.now() + COPY_MS;
	let left = fds.map((n) => `${out}.${n}`);
	for (;;) {
		left = left.filter((abs) => isCopying(abs, io));
		if (left.length === 0 || clock.now() >= deadline) return;
		clock.sleep(COPY_STEP_MS);
	}
}

// guess, workflow-core#4966
const TRIAL_MS = 5000;

/**
 * @param {string} dir
 * @param {NodeJS.ProcessEnv} env
 * @returns {string|null}
 */
function findStrace(dir, env) {
	const strace = String(env.PATH ?? "")
		.split(path.delimiter)
		.filter((entry) => path.isAbsolute(entry))
		.map((entry) => path.join(entry, "strace"))
		.find((abs) => pathKind(abs) === "file");
	if (strace === undefined) return null;
	const name = "trial.trace";
	try {
		const trial = [SH, "-c", "test -e trial.probe"];
		const [file, ...args] = buildTraceArgv(strace, path.join(dir, name), trial);
		const r = spawnSync(String(file), args, {
			cwd: dir,
			stdio: "ignore",
			timeout: TRIAL_MS,
		});
		const got = buildTraceReader(dir, dir)(name, dir);
		const saw =
			"entries" in got &&
			got.entries.some((e) => e.p === "trial.probe" && e.s === "absent");
		return r.status === 1 && saw ? strace : null;
	} catch {
		return null;
	} finally {
		fs.rmSync(path.join(dir, name), { force: true });
	}
}

/**
 * @param {string} root
 * @returns {string[]}
 */
function readGitDirs(root) {
	const dot = path.join(root, ".git");
	const out = [dot];
	const link = readText(dot);
	const own =
		link.state === "read" ? /^gitdir: (.*)$/m.exec(link.data)?.[1] : undefined;
	if (own) {
		const dir = path.resolve(root, own.trim());
		out.push(dir);
		const common = readText(path.join(dir, "commondir"));
		if (common.state === "read")
			out.push(path.resolve(dir, common.data.trim()));
	}
	return out.map((dir) => realOf(dir) ?? dir);
}

/**
 * @param {string} abs
 * @param {(p: string) => string} [realpath]
 * @returns {string|null}
 */
function realOf(abs, realpath = fs.realpathSync) {
	try {
		return realpath(abs);
	} catch (e) {
		const code = caught(e).code;
		const parent = path.dirname(abs);
		if ((code !== "ENOENT" && code !== "ENOTDIR") || parent === abs)
			return null;
		const up = realOf(parent, realpath);
		return up === null ? null : path.join(up, path.basename(abs));
	}
}

// guess, workflow-core#4966
const SETTLE_MS = 2000;
const SETTLE_STEP_MS = 10;

const RUNNING = "was still running when its trace was read";

const EMPTY = "left an empty trace";

const UNSETTLED = new Set([RUNNING, EMPTY]);

/**
 * @typedef {{now: () => number, sleep: (ms: number) => void}} Clock
 */

/** @type {Clock} */
const REAL_CLOCK = { now: Date.now, sleep: sleepSync };

/**
 * @param {string} dir
 * @param {string} root
 * @param {Clock} [clock]
 * @returns {(name: string, cwd: string) =>
 *   {entries: Record<string, unknown>[]} | {doubt: string}}
 */
function buildTraceReader(dir, root, clock = REAL_CLOCK) {
	const gitDirs = readGitDirs(root);
	/** @type {number|undefined} */
	let deadline;
	return (name, cwd) => {
		for (;;) {
			const got = readTrace(dir, name, { cwd, root, gitDirs });
			if (!("doubt" in got) || !UNSETTLED.has(got.doubt)) return got;
			deadline ??= clock.now() + SETTLE_MS;
			if (clock.now() >= deadline) return got;
			clock.sleep(SETTLE_STEP_MS);
		}
	};
}

/**
 * @param {string} dir
 * @param {string} name
 * @param {Where} where
 */
function readTrace(dir, name, where) {
	if (path.basename(name) !== name) return { doubt: "left no trace" };
	const file = readText(path.join(dir, name));
	if (file.state === "unreadable")
		return { doubt: "left a trace that will not read" };
	if (file.state !== "read") return { doubt: "left no trace" };
	return parseTrace(file.data, where);
}

const NO_PEER = /^-1 (ENOENT|ECONNREFUSED|EACCES)\b/;

const UNFINISHED = " <unfinished ...>";
const TORN = "left a trace line that will not parse";
const CHDIR = new Set(["chdir", "fchdir"]);
const GONE = new Set(["ENOENT", "ENOTDIR"]);
const SIGNALS = new Set(["kill", "tkill", "tgkill"]);
const READLINKS = new Set(["readlink", "readlinkat"]);
const SENDS = new Set(["connect", "sendto", "sendmsg", "sendmmsg"]);

/**
 * @typedef {{cwd: string, root: string, gitDirs: string[]}} Where
 * @typedef {{name: string, args: string, result: string, errno?: string}} Call
 * @typedef {{text: string, from: string|null}} Named
 * @typedef {{stood: Set<string>, entries: Map<string, Record<string, unknown>>,
 *   signalled: Set<string>}} Seen
 */

/**
 * @param {string} text
 * @param {Where} where
 * @returns {{entries: Record<string, unknown>[]} | {doubt: string}}
 */
function parseTrace(text, where) {
	const lines = parseLines(text);
	if (typeof lines === "string") return { doubt: lines };
	/** @type {Seen} */
	const seen = {
		stood: new Set([where.cwd]),
		entries: new Map(),
		signalled: new Set(),
	};
	for (const body of lines.calls) {
		const why = takeCall(body, seen, where);
		if (why) return { doubt: why };
	}
	if ([...seen.signalled].some((pid) => !lines.pids.has(pid)))
		return { doubt: "signalled a process outside its trace" };
	return { entries: [...seen.entries.values()] };
}

/**
 * @param {string} text
 * @returns {{calls: string[], pids: Set<string>}|string}
 */
function parseLines(text) {
	/** @type {Map<string, string>} */
	const pending = new Map();
	/** @type {Set<string>} */
	const live = new Set();
	/** @type {Set<string>} */
	const pids = new Set();
	const calls = [];
	for (const line of text.split("\n")) {
		if (line === "") continue;
		const m = /^(\d+) +(\S.*)$/s.exec(line);
		if (!m) return TORN;
		pids.add(String(m[1]));
		const whole = wholeCall(String(m[1]), String(m[2]), pending, live);
		if (whole === false) return TORN;
		if (whole !== null) calls.push(whole);
	}
	if (live.size > 0) return RUNNING;
	return pids.size === 0 ? EMPTY : { calls, pids };
}

/**
 * @param {string} pid
 * @param {string} body
 * @param {Map<string, string>} pending
 * @param {Set<string>} live
 * @returns {string|null|false}
 */
function wholeCall(pid, body, pending, live) {
	live.add(pid);
	if (body.startsWith("--- ")) return null;
	const head = pending.get(pid);
	pending.delete(pid);
	if (body.startsWith("+++ ")) {
		live.delete(pid);
		return head ?? null;
	}
	const resumed = /^<\.\.\. \w+ resumed>(.*)$/s.exec(body);
	if (resumed) return head === undefined ? false : head + String(resumed[1]);
	if (!body.endsWith(UNFINISHED)) return body;
	pending.set(pid, body.slice(0, -UNFINISHED.length));
	return null;
}

/**
 * @param {string} body
 * @returns {Call|null}
 */
function parseCall(body) {
	const open = body.indexOf("(");
	const name = body.slice(0, Math.max(open, 0));
	if (!/^\w+$/.test(name)) return null;
	const end = body.lastIndexOf(") = ");
	const args = body.slice(open + 1, end < 0 ? undefined : end);
	const result = end < 0 ? "?" : body.slice(end + 4);
	return { name, args, result, errno: /^-1 (E\w+)/.exec(result)?.[1] };
}

/**
 * @param {string} body
 * @param {Seen} seen
 * @param {Where} where
 * @returns {string|null}
 */
function takeCall(body, seen, where) {
	const call = parseCall(body);
	if (!call) return TORN;
	if (SENDS.has(call.name)) return sendDoubt(call);
	if (SIGNALS.has(call.name)) {
		const to = signalled(call);
		if (to !== null) seen.signalled.add(to);
		return null;
	}
	const found = pathsOf(call, seen);
	if (typeof found === "string") return found;
	if (found.paths.some((abs) => isUnder(abs, where.gitDirs, path.sep)))
		return "read this repository's git directory";
	for (const abs of found.paths) {
		const absent = found.absent || found.guessed.has(abs);
		const e = entryOf(abs, where.root, call, absent);
		if (e) seen.entries.set(JSON.stringify(e), e);
	}
	return null;
}

/**
 * @param {Call} call
 * @param {Seen} seen
 * @returns {{paths: string[], absent: boolean, guessed: Set<string>}|string}
 */
function pathsOf(call, seen) {
	const { named: strings, held, torn } = pathsIn(call.args);
	const named = READLINKS.has(call.name) ? strings.slice(0, 1) : strings;
	const opened = tokenAt(call.result, call.result.indexOf("<"));
	if (torn || opened?.cut) return "held a path its trace cut short";
	const dirs = [...seen.stood];
	const places = named.map((n) => resolved(n, dirs));
	const spelt = places.flat();
	if (opened?.text.startsWith("/")) spelt.push(opened.text);
	for (const dir of [...held, ...(CHDIR.has(call.name) ? spelt : [])])
		seen.stood.add(dir);
	const real = spelt.map((abs) => realOf(abs));
	if (real.includes(null)) return "named a path that will not resolve";
	const missing = places
		.map((at) => at.filter((abs) => pathKind(abs) === "absent"))
		.filter((gone, i) => gone.length < (places[i]?.length ?? 0));
	return {
		guessed: new Set(
			missing.flat().flatMap((abs) => [abs, realOf(abs) ?? abs]),
		),
		paths: [...new Set([...spelt, .../** @type {string[]} */ (real)])],
		absent: GONE.has(String(call.errno)) && named.length === 1,
	};
}

/**
 * @param {Call} call
 * @returns {string|null}
 */
function sendDoubt(call) {
	if (call.name !== "connect" && !call.args.includes("sa_family=")) return null;
	return NO_PEER.test(call.result) ? null : "reached a socket";
}

/**
 * @param {Call} call
 * @returns {string|null}
 */
function signalled(call) {
	const words = call.args.split(", ");
	if (call.errno || words.at(-1) === "0") return null;
	return String(words[0]);
}

/**
 * @param {Named} n
 * @param {string[]} dirs
 * @returns {string[]}
 */
function resolved(n, dirs) {
	if (path.isAbsolute(n.text)) return [n.text];
	if (n.from !== null) return [path.resolve(n.from, n.text)];
	return dirs.map((dir) => path.resolve(dir, n.text));
}

/**
 * @param {string} abs
 * @param {string} root
 * @param {Call} call
 * @param {boolean} absent
 */
function entryOf(abs, root, call, absent) {
	const p = repoPath(root, abs);
	if (p === null) return null;
	const now = pathKind(abs);
	if (absent) return { k: "probe", p, s: "absent" };
	if (now === "absent" && !call.errno) return { k: "probe", p, s: "gone" };
	return now === "dir" && call.name.startsWith("open") && !call.errno
		? { k: "tree", p }
		: { k: "probe", p, s: now };
}

/**
 * @param {string} args
 * @returns {{named: Named[], held: string[], torn: boolean}}
 */
function pathsIn(args) {
	/** @type {Named[]} */
	const named = [];
	/** @type {string[]} */
	const held = [];
	/** @type {string|null} */
	let from = null;
	let torn = false;
	for (const t of parseTokens(args)) {
		if (!t.fd) named.push({ text: t.text, from });
		else if (t.cut || t.text.endsWith(" (deleted)")) torn = true;
		else if (t.text.startsWith("/")) {
			from = t.text;
			held.push(t.text);
		}
	}
	return { named, held, torn };
}

/** @typedef {{text: string, end: number, cut: boolean, fd: boolean}} Token */

/** @type {Record<string, number>} */
const DEPTH = { "[": 1, "{": 1, "]": -1, "}": -1 };

/**
 * @param {string} args
 * @returns {Token[]}
 */
function parseTokens(args) {
	const out = [];
	let depth = 0;
	for (let i = 0; i < args.length; ) {
		const t = tokenAt(args, i);
		if (!t) {
			depth += DEPTH[String(args[i])] ?? 0;
			i++;
			continue;
		}
		if (depth === 0 && (t.fd || !t.cut)) out.push(t);
		i = t.end;
	}
	return out;
}

/**
 * @param {string} args
 * @param {number} i
 * @returns {Token|null}
 */
function tokenAt(args, i) {
	if (args[i] === '"') {
		const s = decoded(args, i + 1, '"');
		return { ...s, cut: args.startsWith("...", s.end), fd: false };
	}
	if (args[i] !== "<") return null;
	const before = args.slice(0, i);
	if (!before.endsWith("AT_FDCWD") && !/\d/.test(before.slice(-1))) return null;
	const s = decoded(args, i + 1, ">");
	return { ...s, cut: s.end > args.length, fd: true };
}

/** @type {Record<string, number>} */
const ESCAPES = { n: 10, t: 9, r: 13, v: 11, f: 12, e: 27, a: 7, b: 8 };

/**
 * @param {string} s
 * @param {number} at
 * @param {string} stop
 * @returns {{text: string, end: number}}
 */
function decoded(s, at, stop) {
	/** @type {number[]} */
	const bytes = [];
	let i = at;
	while (i < s.length && s[i] !== stop) {
		if (s[i] === "\\") {
			const esc = escapeAt(s, i + 1);
			bytes.push(esc.byte);
			i += 1 + esc.length;
		} else {
			bytes.push(...Buffer.from(String(s[i])));
			i++;
		}
	}
	return { text: Buffer.from(bytes).toString(), end: i + 1 };
}

/**
 * @param {string} s
 * @param {number} at
 */
function escapeAt(s, at) {
	const octal = /^[0-7]{1,3}/.exec(s.slice(at, at + 3))?.[0];
	if (octal) return { byte: Number.parseInt(octal, 8), length: octal.length };
	const hex = /^x([0-9a-f]{2})/i.exec(s.slice(at, at + 3))?.[1];
	if (hex) return { byte: Number.parseInt(hex, 16), length: 3 };
	const c = String(s[at]);
	return { byte: ESCAPES[c] ?? c.charCodeAt(0), length: 1 };
}

module.exports = {
	awaitCopied,
	buildTraceArgv,
	buildTraceReader,
	findStrace,
	realOf,
};
