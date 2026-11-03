/*
 * git-read-memo.js — one tool call's git reads, each distinct one run once
 * (dispatcher contract 5, #2733; #4127). lib/git.js consults it on every sync
 * spawn, so a core, its host and the libraries under them share it with no port
 * threaded through them. Off, as it is outside withGitReadMemo, every spawn runs.
 *
 * The answer kept is the spawn's own, and each caller gets it in the shape its
 * options ask for. A timed-out answer is replayed only to a caller whose
 * timeout is no longer: a longer one still gets its wait. Git never having
 * started for any other reason is not kept, as the next spawn may start.
 *
 * A subcommand not named a read counts as a write: it runs, and what was kept is
 * dropped, since the reads after it may answer differently.
 *
 * Residual: a write no spawn here carries goes unseen, so the reads after it
 * answer from before it: a file written directly, execGitAsync, or a program
 * spawned past lib/git.js's execProgram. A caller running such writes between
 * reads turns the memo off with withoutGitReadMemo, as PostToolUse's formatter
 * does.
 */

const path = require("node:path");
const { CHILD_MAX_BUFFER } = require("./child-buffer.js");

/**
 * @typedef {import("node:child_process").SpawnSyncOptions} SpawnOptions
 * @typedef {import("node:child_process").SpawnSyncReturns<string | Buffer>} SpawnResult
 * @typedef {import("node:child_process").SpawnSyncReturns<Buffer>} RawResult
 * @typedef {{ raw: RawResult, timeout: number }} Kept
 */

const READS = new Set([
	"cat-file",
	"check-ignore",
	"diff",
	"for-each-ref",
	"grep",
	"log",
	"ls-files",
	"ls-remote",
	"ls-tree",
	"merge-base",
	"rev-list",
	"rev-parse",
	"show",
	"show-ref",
	"status",
]);

/** The global options that take the next argument as their value. */
const VALUED_GLOBALS = new Set(["-C", "-c"]);

/** The spawn options a replay reproduces. */
const REPLAYED_OPTIONS = new Set([
	"cwd",
	"encoding",
	"env",
	"input",
	"maxBuffer",
	"stdio",
	"timeout",
]);

/** @type {Map<string, Kept> | null} */
let kept = null;

/**
 * Whether `args` only reads, from its subcommand past git's global options. A
 * spelling this does not know is no read. `--output` is the one option the read
 * subcommands write through.
 * @param {readonly string[]} args
 */
function isGitRead(args) {
	let i = 0;
	for (let arg = args[i]; arg?.startsWith("-"); arg = args[i])
		i += VALUED_GLOBALS.has(arg) ? 2 : 1;
	const sub = args[i] ?? "";
	const rest = args.slice(i + 1);
	if (rest.some((a) => a === "--output" || a.startsWith("--output=")))
		return false;
	if (sub === "config") return rest[0]?.startsWith("--get") ?? false;
	if (sub === "remote") return rest.length === 1 && rest[0] === "-v";
	if (sub === "worktree") return rest[0] === "list";
	if (sub === "symbolic-ref")
		return (
			rest.filter((a) => !a.startsWith("-")).length === 1 &&
			!rest.includes("-d") &&
			!rest.includes("--delete")
		);
	return READS.has(sub);
}

/**
 * `fn`'s result, every git read it makes sharing one memo: the one already on,
 * or a new one.
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
function withGitReadMemo(fn) {
	return withKept(kept ?? new Map(), fn);
}

/**
 * `fn`'s result, every git spawn it makes running.
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
function withoutGitReadMemo(fn) {
	return withKept(null, fn);
}

/**
 * @template T
 * @param {Map<string, Kept> | null} memo
 * @param {() => T} fn
 * @returns {T}
 */
function withKept(memo, fn) {
	const outer = kept;
	kept = memo;
	try {
		return fn();
	} finally {
		kept = outer;
	}
}

/**
 * Where `stdio` sends the child's fd `fd`; "pipe" where it does not say.
 * @param {SpawnOptions["stdio"]} stdio
 * @param {number} fd
 */
const stdioOf = (stdio, fd) =>
	(Array.isArray(stdio) ? stdio[fd] : stdio) ?? "pipe";

/**
 * Whether the memo can stand in for this spawn: nothing on stdin, whose content
 * would be part of the question, no output that must reach a stream live, the
 * buffer limit a kept answer was read under, and no option a replay drops.
 * @param {SpawnOptions} opts
 */
function isReplayable(opts) {
	/** @param {number} fd */
	const isCaptured = (fd) => {
		const to = stdioOf(opts.stdio, fd);
		return to === "pipe" || to === "ignore";
	};
	return (
		opts.input === undefined &&
		opts.maxBuffer === CHILD_MAX_BUFFER &&
		Object.keys(opts).every((name) => REPLAYED_OPTIONS.has(name)) &&
		[0, 1, 2].every(isCaptured)
	);
}

/**
 * `raw` as a spawn under `opts` would have returned it.
 * @param {RawResult} raw
 * @param {SpawnOptions} opts
 * @returns {SpawnResult}
 */
function shaped(raw, opts) {
	if (!raw.output) return raw;
	/** @param {number} fd @param {Buffer | null} out */
	const stream = (fd, out) => {
		if (stdioOf(opts.stdio, fd) === "ignore" || out === null) return null;
		const encoding = opts.encoding;
		return encoding && encoding !== "buffer" ? out.toString(encoding) : out;
	};
	const stdout = stream(1, raw.stdout);
	const stderr = stream(2, raw.stderr);
	return /** @type {SpawnResult} */ ({
		...raw,
		output: [null, stdout, stderr],
		stdout,
		stderr,
	});
}

/**
 * Put a git spawn to the memo: a read gets its answer, run on a miss, and a write
 * drops what was kept. Null where the memo is off or cannot stand in, for the
 * caller to spawn as it would have.
 * @param {readonly string[]} args
 * @param {SpawnOptions} opts
 * @param {(args: readonly string[], opts: SpawnOptions) => RawResult} spawn
 *   from lib/git.js, the one module that names the binary
 * @returns {SpawnResult | null}
 */
function consultMemo(args, opts, spawn) {
	if (!kept) return null;
	if (!isGitRead(args)) {
		dropKeptReads();
		return null;
	}
	if (!isReplayable(opts)) return null;
	const { cwd, env, timeout } = opts;
	const wait = timeout ?? Number.POSITIVE_INFINITY;
	const key = JSON.stringify([path.resolve(String(cwd ?? ".")), args, env]);
	let hit = kept.get(key);
	if (
		!hit ||
		(hit.raw.error && isTimeout(hit.raw.error) && wait > hit.timeout)
	) {
		hit = {
			raw: spawn(args, {
				cwd,
				env,
				timeout,
				maxBuffer: CHILD_MAX_BUFFER,
				encoding: "buffer",
				stdio: ["ignore", "pipe", "pipe"],
			}),
			timeout: wait,
		};
		if (!hit.raw.error || isTimeout(hit.raw.error)) kept.set(key, hit);
	}
	return shaped(hit.raw, opts);
}

/** Forget what was kept. */
function dropKeptReads() {
	kept?.clear();
}

/** @param {Error} e */
const isTimeout = (e) =>
	/** @type {NodeJS.ErrnoException} */ (e).code === "ETIMEDOUT";

/**
 * What execFileSync does with a finished spawn: its stdout, or the error it
 * throws, carrying the same fields.
 * @param {SpawnResult} r
 * @param {readonly string[]} argv the program and its arguments
 * @returns {string | Buffer}
 */
function stdoutOrThrow(r, argv) {
	if (r.error) throw Object.assign(new Error(r.error.message), r.error, r);
	if (r.status !== 0) {
		const said = r.stderr?.length ? `\n${r.stderr.toString()}` : "";
		throw Object.assign(
			new Error(`Command failed: ${argv.join(" ")}${said}`),
			r,
		);
	}
	return r.stdout;
}

module.exports = {
	consultMemo,
	dropKeptReads,
	stdoutOrThrow,
	withGitReadMemo,
	withoutGitReadMemo,
};
