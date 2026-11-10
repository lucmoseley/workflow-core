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
 * EVERY PATH A FILE CALL NAMES IS A READ, a write's target included: as the
 * call spelt it, with its links followed, and as the descriptor the call
 * returned names it. A relative path with no directory beside it resolves
 * against every directory the trace has seen a process stand in or hold
 * open — more reads than were made, never fewer. A directory opened is its
 * whole tree.
 *
 * WHAT A TRACE CANNOT BOUND IS A DOUBT: a process still running once the
 * audit is read; a call on this repository's git directory, whose state no
 * file under the root holds; a path that will not resolve, or one a call
 * found and that is gone since; a socket connected or a datagram addressed,
 * behind which another process may do the reading; a signal sent to a
 * process the trace does not follow.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { caught } = require("./caught.js");
const { readText } = require("./file-read.js");
const { isUnder, relativeUnder } = require("./is-under.js");
const { pathKind } = require("./path-kind.js");
const { sleepSync } = require("./sleep-sync.js");

/* Signals stay in the trace: without them strace writes no line for a
 * process a signal killed. */
const FLAGS = [
	"-f",
	"-DD",
	"--seccomp-bpf",
	"-q",
	"-y",
	"-e",
	"trace=%file,fchdir,connect,sendto,sendmsg,sendmmsg,kill,tkill,tgkill",
];

/* Fixed paths, never names off PATH: a test puts its own stubs there. Where
 * one is missing the trial in `findStrace` fails, and nothing is traced. */
const SH = "/bin/sh";

/* The traced side, `$1` and `$2` the pipes its output goes down, either
 * empty: it opens them by name, so the tracer never holds them. */
const INNER =
	'a=$1 b=$2; shift 2; [ -z "$a" ] || exec >"$a"; [ -z "$b" ] || exec 2>"$b"; exec "$@"';

/* THE TRACER HOLDS NONE OF THE CHILD'S OUTPUT. It lives until the last
 * process it follows ends, so a pipe it inherited would stay open past a
 * child that left a detached process behind, and the test's spawn would
 * wait on that process. Each output that is a pipe or a socket goes through
 * a named pipe a `cat` copies from, started before the tracer and so not
 * followed; the tracer itself gets /dev/null. No other child is started
 * first: the tracer waits on one of its own before it runs the program,
 * and a stray one ending answers that wait early. `$1` the tracer, `$2`
 * the trace, the rest the child's words. */
const OUTER = [
	"s=$1 o=$2; shift 2; a= b=",
	"if [ -p /dev/fd/1 ] || [ -S /dev/fd/1 ]; then a=$o.1; fi",
	"if [ -p /dev/fd/2 ] || [ -S /dev/fd/2 ]; then b=$o.2; fi",
	'[ -z "$a" ] || /usr/bin/mkfifo "$a" || exit 127',
	'[ -z "$b" ] || /usr/bin/mkfifo "$b" || exit 127',
	'if [ -n "$a" ]; then /bin/cat <"$a" 2>/dev/null & fi',
	'if [ -n "$b" ]; then /bin/cat <"$b" 1>&2 & fi',
	'[ -z "$a" ] || exec >/dev/null',
	'[ -z "$b" ] || exec 2>/dev/null',
	`exec "$s" ${FLAGS.join(" ")} -o "$o" -- ${SH} -c '${INNER}' sh "$a" "$b" "$@"`,
].join("\n");

/**
 * The words that run `argv` under the tracer, its trace written to `out`.
 * @param {string} strace
 * @param {string} out
 * @param {string[]} argv
 */
const buildTraceArgv = (strace, out, argv) => [
	SH,
	"-c",
	OUTER,
	"sh",
	strace,
	out,
	...argv,
];

/* How long the trial trace may take: a guess, far above the ~20 ms it takes. */
const TRIAL_MS = 5000;

/**
 * The `strace` on `env`'s PATH, where a trial run under it in `dir` leaves a
 * trace this module reads; else null — none installed, an old one, or a
 * machine that forbids tracing. Found by walking PATH, not spawned by bare
 * name: the preload hands a child the tracer's path in place of its program,
 * so it needs the file. A system tool the repo does not ship, whose absence
 * the audit's untraced rules cover.
 * @param {string} dir a directory to write the trial trace in, real path
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
		/* Fails open to the untraced rules (#4966): a trial that throws is a
		 * tracer that does not work here. lib/read-audit.js prints the
		 * fall-back. */
		return null;
	} finally {
		fs.rmSync(path.join(dir, name), { force: true });
	}
}

/**
 * The directories holding the state of the repository at `root`: its `.git`,
 * and for a linked worktree its git directory and the common one.
 * @param {string} root real path
 * @returns {string[]}
 */
function readGitDirs(root) {
	const dot = path.join(root, ".git");
	const out = [dot];
	/* Unreadable is `.git` as a directory, which is itself the whole state;
	 * absent is no repository. Either way the one entry stands. */
	const link = readText(dot);
	const own =
		link.state === "read" ? /^gitdir: (.*)$/m.exec(link.data)?.[1] : undefined;
	if (own) {
		const dir = path.resolve(root, own.trim());
		out.push(dir);
		/* A git directory with no `commondir` is its own common one. */
		const common = readText(path.join(dir, "commondir"));
		if (common.state === "read")
			out.push(path.resolve(dir, common.data.trim()));
	}
	/* A directory that will not resolve stands nowhere a call could reach by
	 * another name, so its spelling is the only one to match. */
	return out.map((dir) => realOf(dir) ?? dir);
}

/**
 * `abs` with its links followed, the part of it that does not exist kept as
 * spelt; null where it will not resolve, as in a loop of links.
 * @param {string} abs
 * @returns {string|null}
 */
function realOf(abs) {
	try {
		return fs.realpathSync(abs);
	} catch (e) {
		const code = caught(e).code;
		const parent = path.dirname(abs);
		if ((code !== "ENOENT" && code !== "ENOTDIR") || parent === abs)
			return null;
		const up = realOf(parent);
		return up === null ? null : path.join(up, path.basename(abs));
	}
}

/* The tracer writes a process's end a moment after the process ends. How
 * long one reading of an audit waits, in all, for traces to settle, and how
 * often it looks: guesses, the first far above the few milliseconds a
 * tracer takes. */
const SETTLE_MS = 2000;
const SETTLE_STEP_MS = 10;

const RUNNING = "was still running when its trace was read";

/**
 * @typedef {{now: () => number, sleep: (ms: number) => void}} Clock
 */

/** @type {Clock} */
const REAL_CLOCK = { now: Date.now, sleep: sleepSync };

/**
 * A reader of the traces in `dir`, for one reading of an audit over `root`:
 * `(name, cwd)` gives the trace `name` of a child started in `cwd` as the
 * audit's log entries, or what in it cannot be bounded.
 * @param {string} dir the audit's log directory
 * @param {string} root the checkout's real path
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
			if (!("doubt" in got) || got.doubt !== RUNNING) return got;
			deadline ??= clock.now() + SETTLE_MS;
			if (clock.now() >= deadline) return got;
			clock.sleep(SETTLE_STEP_MS);
		}
	};
}

/**
 * The trace `name` in `dir`, parsed; a doubt where none can be read.
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

/* A send that reached nobody: no other process did anything for it. */
const NO_PEER = /^-1 (ENOENT|ECONNREFUSED|EACCES)\b/;

const UNFINISHED = " <unfinished ...>";
const TORN = "left a trace line that will not parse";
const CHDIR = new Set(["chdir", "fchdir"]);
const GONE = new Set(["ENOENT", "ENOTDIR"]);
const SIGNALS = new Set(["kill", "tkill", "tgkill"]);
const READLINKS = new Set(["readlink", "readlinkat"]);
const SENDS = new Set(["connect", "sendto", "sendmsg", "sendmmsg"]);

/**
 * @typedef {{cwd: string, root: string, gitDirs: string[]}} Where the
 *   directory the child started in, the checkout's real path and
 *   `readGitDirs` of it
 * @typedef {{name: string, args: string, result: string, errno?: string}} Call
 * @typedef {{text: string, from: string|null}} Named
 *   a path a call names, and the directory printed before it, which a
 *   relative one is taken from
 * @typedef {{stood: Set<string>, entries: Map<string, Record<string, unknown>>,
 *   signalled: Set<string>}} Seen
 *   what the calls so far add up to: every directory a process has stood in
 *   or held open, the log entries, and each process sent a signal
 */

/**
 * A trace as the audit's log entries — `probe` and `tree`, repo-relative —
 * or what in it cannot be bounded.
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
 * Each call of the trace as one line, a call a switch of process split
 * joined again, and every process the trace followed; or the doubt where a
 * line will not parse or a process never ended.
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
	return live.size > 0 ? RUNNING : { calls, pids };
}

/**
 * One line's call where the line ends one: null where it ends none, false
 * where it resumes a call nothing began.
 * @param {string} pid
 * @param {string} body
 * @param {Map<string, string>} pending accumulator: each process's call cut
 *   short
 * @param {Set<string>} live accumulator: the processes seen and not yet
 *   ended
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
 * Add one call's reads to `seen`; returns the doubt it leaves, or null.
 * @param {string} body
 * @param {Seen} seen accumulator
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
 * Every place a file call's paths may lie, as spelt and with links
 * followed, and whether the call found its one path absent; or the doubt
 * where one cannot be placed. Adds the directories the call stands in or
 * holds to `seen.stood`.
 * @param {Call} call
 * @param {Seen} seen accumulator
 * @returns {{paths: string[], absent: boolean, guessed: Set<string>}|string}
 *   `guessed` the places a name with no directory beside it does not lie,
 *   where it lies in another: absent there, not gone
 */
function pathsOf(call, seen) {
	const { named: strings, held, torn } = pathsIn(call.args);
	/* A link read prints where it points as a second string: no path the
	 * call named, and what follows the link is a call of its own. */
	const named = READLINKS.has(call.name) ? strings.slice(0, 1) : strings;
	const opened = tokenAt(call.result, call.result.indexOf("<"));
	if (torn || opened?.cut) return "held a path its trace cut short";
	const dirs = [...seen.stood];
	const places = named.map((n) => resolved(n, dirs));
	const spelt = places.flat();
	if (opened?.text.startsWith("/")) spelt.push(opened.text);
	for (const dir of [...held, ...(CHDIR.has(call.name) ? spelt : [])])
		seen.stood.add(dir);
	const real = spelt.map(realOf);
	if (real.includes(null)) return "named a path that will not resolve";
	const missing = places
		.map((at) => at.filter((abs) => pathKind(abs) === "absent"))
		.filter((gone, i) => gone.length < (places[i]?.length ?? 0));
	return {
		guessed: new Set(
			missing.flat().flatMap((abs) => [abs, realOf(abs) ?? abs]),
		),
		paths: [...new Set([...spelt, .../** @type {string[]} */ (real)])],
		/* One path named and the call found nothing there: absent then,
		 * whatever stands there now. */
		absent: GONE.has(String(call.errno)) && named.length === 1,
	};
}

/**
 * The doubt a connect or a send leaves: none where it named no address, as
 * on a socket already connected, or reached nobody.
 * @param {Call} call
 * @returns {string|null}
 */
function sendDoubt(call) {
	if (call.name !== "connect" && !call.args.includes("sa_family=")) return null;
	return NO_PEER.test(call.result) ? null : "reached a socket";
}

/**
 * The process a signal call reached, null where it sent none: the null
 * signal, which only asks whether the process is there, or a call that
 * failed. A group or every process reads as a process no trace follows.
 * @param {Call} call
 * @returns {string|null}
 */
function signalled(call) {
	const words = call.args.split(", ");
	if (call.errno || words.at(-1) === "0") return null;
	return String(words[0]);
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
 * checkout or under a `node_modules`. A path the call found and that is
 * absent now reads `gone`, a kind the audit doubts.
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
	const now = pathKind(abs);
	if (absent) return { k: "probe", p, s: "absent" };
	if (now === "absent" && !call.errno) return { k: "probe", p, s: "gone" };
	return now === "dir" && call.name.startsWith("open") && !call.errno
		? { k: "tree", p }
		: { k: "probe", p, s: now };
}

/**
 * The paths a call's arguments name — each quoted string outside a list or a
 * struct — and the paths of the descriptors it holds, which are no reads of
 * this call: a process stands in one, or opened it in a call of its own.
 * `torn` where a descriptor's path is cut short or names a deleted file,
 * which no relative path can be taken from.
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
	for (const t of tokens(args)) {
		if (!t.fd) named.push({ text: t.text, from });
		else if (t.cut || t.text.endsWith(" (deleted)")) torn = true;
		else if (t.text.startsWith("/")) {
			from = t.text;
			held.push(t.text);
		}
	}
	return { named, held, torn };
}

/**
 * @typedef {{text: string, end: number, cut: boolean, fd: boolean}} Token
 *   `fd` a descriptor's path, not a string; `cut` a string strace shortened,
 *   which is no path, or a descriptor path the line ends inside
 */

/** @type {Record<string, number>} */
const DEPTH = { "[": 1, "{": 1, "]": -1, "}": -1 };

/**
 * The strings and descriptor paths outside every list and struct, a
 * shortened string left out.
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
		if (depth === 0 && (t.fd || !t.cut)) out.push(t);
		i = t.end;
	}
	return out;
}

/**
 * The quoted string or descriptor path starting at `i`, null where neither
 * does.
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
	/* strace prints a descriptor's path after its number, or `AT_FDCWD`. */
	const before = args.slice(0, i);
	if (!before.endsWith("AT_FDCWD") && !/\d/.test(before.slice(-1))) return null;
	const s = decoded(args, i + 1, ">");
	return { ...s, cut: s.end > args.length, fd: true };
}

/** @type {Record<string, number>} */
const ESCAPES = { n: 10, t: 9, r: 13, v: 11, f: 12, e: 27, a: 7, b: 8 };

/**
 * The text strace printed from `at` up to `stop`, its escapes undone.
 * @param {string} s
 * @param {number} at
 * @param {string} stop the character that ends it, which strace escapes
 *   inside it
 * @returns {{text: string, end: number}} `end` just past `stop`, past the
 *   end of `s` where `stop` never came
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

module.exports = { buildTraceArgv, buildTraceReader, findStrace };
