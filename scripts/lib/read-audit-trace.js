/*
 * read-audit-trace.js — what a child that is no audited Node process read of
 * the checkout, off an `strace` of its file calls (#4966). The read audit
 * (lib/read-audit.js) cannot see inside a stub a test wrote or a shell, so
 * its preload runs each under `strace` and this reads the trace back as the
 * audit's own log entries.
 *
 * THE TRACER IS A DETACHED GRANDCHILD (`-DD`), in a process group of its own:
 * the program stays the direct child the test spawned, under the pid, exit
 * status and signals it would have had.
 *
 * EVERY PATH A FILE CALL NAMES IS A READ, a write's target included. A
 * relative path with no directory beside it resolves against every directory
 * the trace has seen a process stand in or hold open — more reads than were
 * made, never fewer. A directory opened is its whole tree.
 *
 * WHAT A TRACE CANNOT BOUND IS A DOUBT: a process still running once the
 * audit is read; a call on this repository's git directory, whose state no
 * file under the root holds; a socket connected, behind which another
 * process may do the reading. Not weighed: a datagram sent on a socket never
 * connected, and work a signal starts in a process outside the trace.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { isUnder, relativeUnder } = require("./is-under.js");
const { pathKind } = require("./path-kind.js");
const { sleepSync } = require("./sleep-sync.js");

/* `-f` follows every descendant; `--seccomp-bpf` stops the traced processes
 * on the named calls only; `-y` prints the directory a relative path is
 * taken from. */
const FLAGS = [
	"-f",
	"-DD",
	"--seccomp-bpf",
	"-q",
	"-y",
	"-e",
	"trace=%file,fchdir,connect",
];

/**
 * The words that run `argv` under the tracer, its trace written to `out`.
 * @param {string} strace
 * @param {string} out
 * @param {string[]} argv
 */
const traceArgv = (strace, out, argv) => [
	strace,
	...FLAGS,
	"-o",
	out,
	"--",
	...argv,
];

/* How long the trial trace may take: a guess, far above the ~20 ms it takes. */
const TRIAL_MS = 5000;

/**
 * The `strace` on `env`'s PATH, where a trial run under it in `dir` leaves a
 * trace this module reads; else null — none installed, an old one, or a
 * machine that forbids tracing.
 * @param {string} dir a directory to write the trial trace in, real path
 * @param {NodeJS.ProcessEnv} env
 * @returns {string|null}
 */
function usableStrace(dir, env) {
	const strace = String(env.PATH ?? "")
		.split(path.delimiter)
		.filter((entry) => path.isAbsolute(entry))
		.map((entry) => path.join(entry, "strace"))
		.find((abs) => pathKind(abs) === "file");
	if (strace === undefined) return null;
	const name = "trial.trace";
	try {
		const trial = ["/bin/sh", "-c", "test -e trial.probe"];
		const [file, ...args] = traceArgv(strace, path.join(dir, name), trial);
		const r = spawnSync(String(file), args, {
			cwd: dir,
			stdio: "ignore",
			timeout: TRIAL_MS,
		});
		const got = tracesIn(dir, dir)(name, dir);
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

/* The tracer writes a process's end a moment after the process ends. How
 * long one reading of an audit waits, in all, for traces to settle, and how
 * often it looks: guesses, the first far above the few milliseconds a
 * tracer takes, so only a child that really outlives its run spends it. */
const SETTLE_MS = 2000;
const SETTLE_STEP_MS = 10;

const RUNNING = "was still running when its trace was read";

/**
 * A reader of the traces in `dir`, for one reading of an audit over `root`:
 * `(name, cwd)` gives the trace `name` of a child started in `cwd` as the
 * audit's log entries, or what in it cannot be bounded.
 * @param {string} dir the audit's log directory
 * @param {string} root the checkout's real path
 * @returns {(name: string, cwd: string) =>
 *   {entries: Record<string, unknown>[]} | {doubt: string}}
 */
function tracesIn(dir, root) {
	const repo = gitDirs(root);
	/** @type {number|undefined} */
	let deadline;
	return (name, cwd) => {
		for (;;) {
			let text;
			try {
				if (path.basename(name) !== name) throw new Error("no trace name");
				text = fs.readFileSync(path.join(dir, name), "utf8");
			} catch {
				return { doubt: "left no trace" };
			}
			const got = traceReads(text, { cwd, root, gitDirs: repo });
			if (!("doubt" in got) || got.doubt !== RUNNING) return got;
			deadline ??= Date.now() + SETTLE_MS;
			if (Date.now() >= deadline) return got;
			sleepSync(SETTLE_STEP_MS);
		}
	};
}

/**
 * The directories holding the state of the repository at `root`: its `.git`,
 * and for a linked worktree its git directory and the common one.
 * @param {string} root real path
 * @returns {string[]}
 */
function gitDirs(root) {
	const dot = path.join(root, ".git");
	const out = [dot];
	try {
		const own = /^gitdir: (.*)$/m.exec(fs.readFileSync(dot, "utf8"))?.[1];
		if (own) {
			const dir = path.resolve(root, own.trim());
			out.push(dir);
			const common = fs.readFileSync(path.join(dir, "commondir"), "utf8");
			out.push(path.resolve(dir, common.trim()));
		}
	} catch {
		// `.git` is a directory, or absent: the one entry stands.
	}
	return out.map((dir) => {
		try {
			return fs.realpathSync(dir);
		} catch {
			return dir;
		}
	});
}

/* A connect that reached nobody: no other process did anything for it. */
const NO_PEER = /^-1 (ENOENT|ECONNREFUSED|EACCES)\b/;

const UNFINISHED = " <unfinished ...>";
const TORN = "left a trace line that will not parse";
const CHDIR = new Set(["chdir", "fchdir"]);
const GONE = new Set(["ENOENT", "ENOTDIR"]);

/**
 * @typedef {{cwd: string, root: string, gitDirs: string[]}} Where the
 *   directory the child started in, the checkout's real path and `gitDirs`
 *   of it
 * @typedef {{name: string, args: string, result: string, errno?: string}} Call
 * @typedef {{text: string, from: string|null}} Named
 *   a path a call names, and the directory printed before it, which a
 *   relative one is taken from
 */

/**
 * A trace as the audit's log entries — `probe` and `tree`, repo-relative —
 * or what in it cannot be bounded.
 * @param {string} text
 * @param {Where} at
 * @returns {{entries: Record<string, unknown>[]} | {doubt: string}}
 */
function traceReads(text, at) {
	const calls = wholeCalls(text);
	if (typeof calls === "string") return { doubt: calls };
	const stood = new Set([at.cwd]);
	/** @type {Map<string, Record<string, unknown>>} */
	const entries = new Map();
	for (const body of calls) {
		const why = takeCall(body, stood, entries, at);
		if (why) return { doubt: why };
	}
	return { entries: [...entries.values()] };
}

/**
 * Each call of the trace as one line, a call a switch of process split
 * joined again; or the doubt where a line will not parse or a process never
 * ended.
 * @param {string} text
 * @returns {string[]|string}
 */
function wholeCalls(text) {
	/** @type {Map<string, string>} */
	const pending = new Map();
	/** @type {Set<string>} */
	const live = new Set();
	const out = [];
	for (const line of text.split("\n")) {
		if (line === "") continue;
		const m = /^(\d+) +(\S.*)$/s.exec(line);
		if (!m) return TORN;
		const whole = wholeCall(String(m[1]), String(m[2]), pending, live);
		if (whole === false) return TORN;
		if (whole !== null) out.push(whole);
	}
	return live.size > 0 ? RUNNING : out;
}

/**
 * One line's call where the line ends one: null where it ends none, false
 * where it resumes a call nothing began.
 * @param {string} pid
 * @param {string} body
 * @param {Map<string, string>} pending each process's call cut short
 * @param {Set<string>} live the processes seen and not yet ended
 * @returns {string|null|false}
 */
function wholeCall(pid, body, pending, live) {
	live.add(pid);
	/* A signal's line, which may fall inside a call cut short. */
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
 * @param {string} body one whole call, or one its process's end cut short
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
 * Add one call's reads to `entries`; returns the doubt it leaves, or null.
 * @param {string} body
 * @param {Set<string>} stood every directory a process has stood in so far
 * @param {Map<string, Record<string, unknown>>} entries
 * @param {Where} at
 * @returns {string|null}
 */
function takeCall(body, stood, entries, at) {
	const call = parseCall(body);
	if (!call) return TORN;
	if (call.name === "connect")
		return NO_PEER.test(call.result) ? null : "connected to a socket";
	const { named, held } = pathsIn(call.args);
	const dirs = [...stood];
	const paths = named.flatMap((n) => resolved(n, dirs));
	for (const dir of [...held, ...(CHDIR.has(call.name) ? paths : [])])
		stood.add(dir);
	if (paths.some((abs) => isUnder(abs, at.gitDirs, path.sep)))
		return "read this repository's git directory";
	/* One path named and the call found nothing there: absent then, whatever
	 * stands there now. */
	const gone = GONE.has(String(call.errno)) && named.length === 1;
	for (const abs of paths) {
		const e = entryOf(abs, at.root, call, gone);
		if (e) entries.set(JSON.stringify(e), e);
	}
	return null;
}

/**
 * Where a named path may lie: itself, under the directory printed beside it,
 * or under each directory a process has stood in.
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
 * The log entry for a path a call named, null where it lies outside the
 * checkout or under a `node_modules`.
 * @param {string} abs
 * @param {string} root
 * @param {Call} call
 * @param {boolean} absent
 */
function entryOf(abs, root, call, absent) {
	const rel = relativeUnder(root, abs);
	if (rel === null) return null;
	const p = (rel || ".").split(path.sep).join("/");
	if (p.split("/").includes("node_modules")) return null;
	const kind = absent ? "absent" : pathKind(abs);
	return kind === "dir" && call.name.startsWith("open") && !call.errno
		? { k: "tree", p }
		: { k: "probe", p, s: kind };
}

/**
 * The paths a call's arguments name — each quoted string outside a list or a
 * struct — and the paths of the descriptors it holds, which are no reads of
 * this call: a process stands in one, or opened it in a call of its own.
 * @param {string} args
 * @returns {{named: Named[], held: string[]}}
 */
function pathsIn(args) {
	/** @type {Named[]} */
	const named = [];
	/** @type {string[]} */
	const held = [];
	/** @type {string|null} */
	let from = null;
	for (const t of tokens(args)) {
		if (!t.fd) named.push({ text: t.text, from });
		else if (t.text.startsWith("/")) {
			from = t.text;
			held.push(t.text);
		}
	}
	return { named, held };
}

/**
 * @typedef {{text: string, end: number, cut: boolean, fd: boolean}} Token
 *   `fd` a descriptor's path, not a string
 */

/** @type {Record<string, number>} */
const DEPTH = { "[": 1, "{": 1, "]": -1, "}": -1 };

/**
 * The strings and descriptor paths outside every list and struct.
 * @param {string} args
 * @returns {Token[]}
 */
function tokens(args) {
	const out = [];
	let depth = 0;
	for (let i = 0; i < args.length; ) {
		const t = tokenAt(args, i);
		if (!t) {
			depth += DEPTH[String(args[i])] ?? 0;
			i++;
			continue;
		}
		if (depth === 0 && !t.cut) out.push(t);
		i = t.end;
	}
	return out;
}

/**
 * The quoted string or descriptor path starting at `i`, null where neither
 * does. `cut` marks a string strace shortened, which is no path, and a
 * descriptor path the line ends inside.
 * @param {string} args
 * @param {number} i
 * @returns {Token|null}
 */
function tokenAt(args, i) {
	if (args[i] === '"') {
		const s = cString(args, i);
		return { ...s, cut: args.startsWith("...", s.end), fd: false };
	}
	if (args[i] !== "<") return null;
	/* strace prints a descriptor's path after its number, or `AT_FDCWD`. */
	const before = args.slice(0, i);
	if (!before.endsWith("AT_FDCWD") && !/\d/.test(before.slice(-1))) return null;
	const close = args.indexOf(">", i);
	if (close < 0) return { text: "", end: args.length, cut: true, fd: true };
	return {
		text: args.slice(i + 1, close),
		end: close + 1,
		cut: false,
		fd: true,
	};
}

/** @type {Record<string, number>} */
const ESCAPES = { n: 10, t: 9, r: 13, v: 11, f: 12, e: 27, a: 7, b: 8 };

/**
 * The C string strace printed at `at`, an opening quote.
 * @param {string} s
 * @param {number} at
 * @returns {{text: string, end: number}} `end` just past the closing quote
 */
function cString(s, at) {
	/** @type {number[]} */
	const bytes = [];
	let i = at + 1;
	while (i < s.length && s[i] !== '"') {
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
 * The byte the escape after a backslash stands for, and its length.
 * @param {string} s
 * @param {number} at just past the backslash
 */
function escapeAt(s, at) {
	const octal = /^[0-7]{1,3}/.exec(s.slice(at, at + 3))?.[0];
	if (octal) return { byte: Number.parseInt(octal, 8), length: octal.length };
	const hex = /^x([0-9a-f]{2})/i.exec(s.slice(at, at + 3))?.[1];
	if (hex) return { byte: Number.parseInt(hex, 16), length: 3 };
	const c = String(s[at]);
	return { byte: ESCAPES[c] ?? c.charCodeAt(0), length: 1 };
}

module.exports = { traceArgv, tracesIn, usableStrace };
