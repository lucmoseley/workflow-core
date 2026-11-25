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

const VALUED_GLOBALS = new Set(["-C", "-c"]);

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

/** @param {readonly string[]} args */
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
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
function withGitReadMemo(fn) {
	return withKept(kept ?? new Map(), fn);
}

/**
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
 * @param {SpawnOptions["stdio"]} stdio
 * @param {number} fd
 */
const stdioOf = (stdio, fd) =>
	(Array.isArray(stdio) ? stdio[fd] : stdio) ?? "pipe";

/** @param {SpawnOptions} opts */
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
 * @param {readonly string[]} args
 * @param {SpawnOptions} opts
 * @param {(args: readonly string[], opts: SpawnOptions) => RawResult} spawn
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

function dropKeptReads() {
	kept?.clear();
}

/** @param {Error} e */
const isTimeout = (e) =>
	/** @type {NodeJS.ErrnoException} */ (e).code === "ETIMEDOUT";

module.exports = {
	consultMemo,
	dropKeptReads,
	withGitReadMemo,
	withoutGitReadMemo,
};
