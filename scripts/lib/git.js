/*
 * git.js — the seam between the Node scripts and the `git` CLI: they route
 * every spawn through here and never name the binary themselves (#2636).
 * Test support, lib/precommit-gate-harness.js among it, builds its repos
 * with the real `git`, since the test it serves may stub WFC_GIT.
 * lib/resolve-core.js, copied into adopters and run before any core is found,
 * requires builtins only.
 *
 * The binary is injected at one named point, WFC_GIT, so a test feeding git
 * chosen output stubs it there rather than on PATH (base §N7, #2581, #2589).
 * Read on every call, as the in-process runner swaps process.env between runs.
 *
 * A caller whose spawn is injected for tests (an `execFn` that runs `vitest`
 * as well as `git`) passes gitBinary() to it and wraps its options in
 * gitSpawnOptions(), which carries the options every git spawn shares (#2734);
 * execProgram is that spawn with git's reads kept in lib/git-read-memo.js, which
 * execGit and spawnGitSync consult (#4127).
 */

const { execFile, execFileSync, spawnSync } = require("node:child_process");
const { promisify } = require("node:util");

const { caught } = require("./caught.js");
const { CHILD_MAX_BUFFER } = require("./child-buffer.js");
const { consultMemo, dropKeptReads } = require("./git-read-memo.js");
const { spawnTimeout } = require("./hook-deadline.js");
const { writeFd } = require("./write-fd.js");

const pExecFile = promisify(execFile);

/**
 * What execFileSync does with a finished spawn: its stdout, or the error it
 * throws, carrying the same fields.
 * @param {import("node:child_process").SpawnSyncReturns<string | Buffer>} r
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

const gitBinary = () => process.env.WFC_GIT || "git";

/**
 * The options every git spawn takes: its timeout, or none, cut to what the
 * dispatcher's entry budget leaves (hook-deadline.js).
 * @template {object} T
 * @param {T} [opts]
 * @returns {T & {maxBuffer: number}}
 */
const gitSpawnOptions = (opts) => {
	const timeout = spawnTimeout(
		/** @type {{ timeout?: number } | undefined} */ (opts)?.timeout,
	);
	return /** @type {T & {maxBuffer: number}} */ ({
		maxBuffer: CHILD_MAX_BUFFER,
		...opts,
		...(timeout ? { timeout } : {}),
	});
};

/**
 * execFileSync on git: returns stdout, throws on a non-zero exit.
 * @overload
 * @param {readonly string[]} args
 * @param {import("node:child_process").ExecFileSyncOptionsWithStringEncoding} opts
 * @returns {string}
 */
/**
 * @overload
 * @param {readonly string[]} args
 * @param {import("node:child_process").ExecFileSyncOptionsWithBufferEncoding} [opts]
 * @returns {Buffer}
 */
/**
 * @overload
 * @param {readonly string[]} args
 * @param {import("node:child_process").ExecFileSyncOptions} [opts]
 * @returns {string | Buffer}
 */
/**
 * @param {readonly string[]} args
 * @param {import("node:child_process").ExecFileSyncOptions} [opts]
 * @returns {string | Buffer}
 */
function execGit(args, opts = {}) {
	const full = gitSpawnOptions(opts);
	const read = consultGitMemo(args, full);
	if (!read) return execFileSync(gitBinary(), args, full);
	/* execFileSync echoes the stderr of a caller naming no stdio. */
	if (opts.stdio === undefined && read.stderr?.length)
		writeFd(2, read.stderr.toString());
	return stdoutOrThrow(read, [gitBinary(), ...args]);
}

/**
 * @param {readonly string[]} args
 * @param {import("node:child_process").SpawnSyncOptions} opts
 */
const consultGitMemo = (args, opts) =>
	consultMemo(
		args,
		opts,
		(a, o) =>
			/** @type {import("node:child_process").SpawnSyncReturns<Buffer>} */ (
				spawnSync(gitBinary(), a, o)
			),
	);

/**
 * An `execFn` for a caller whose spawn runs other programs as well as git: git
 * by execGit, so its reads reach the call's memo, and anything else as it is,
 * after which the memo keeps nothing it may have changed.
 * @param {string} file
 * @param {readonly string[]} args
 * @param {import("node:child_process").ExecFileSyncOptions} [opts]
 * @returns {string | Buffer}
 */
function execProgram(file, args, opts) {
	if (file === gitBinary()) return execGit(args, opts);
	dropKeptReads();
	return execFileSync(file, args, opts ?? {});
}

/**
 * gitOrNull's answer, and whether a null came from overrunning `opts.timeout`.
 * @param {readonly string[]} args
 * @param {Omit<import("node:child_process").ExecFileSyncOptions, "encoding">} [opts]
 * @returns {{ out: string | null, timedOut: boolean }}
 */
function gitAnswer(args, opts = {}) {
	try {
		const out = execGit(args, {
			stdio: ["ignore", "pipe", "ignore"],
			...opts,
			encoding: "utf8",
		});
		return { out, timedOut: false };
	} catch (e) {
		return {
			out: null,
			timedOut: caught(e).code === "ETIMEDOUT",
		};
	}
}

/**
 * execGit's stdout, or null where git could not answer: no git, not a repo, a
 * non-zero exit. An overrun buffer or a timeout is null too.
 * @param {readonly string[]} args
 * @param {Omit<import("node:child_process").ExecFileSyncOptions, "encoding">} [opts]
 * @returns {string | null}
 */
function gitOrNull(args, opts = {}) {
	return gitAnswer(args, opts).out;
}

const COMMON_DIR_ARGS = [
	"rev-parse",
	"--path-format=absolute",
	"--git-common-dir",
];
const BOTH_DIRS_ARGS = [
	"rev-parse",
	"--path-format=absolute",
	"--git-dir",
	"--git-common-dir",
];

/**
 * The absolute git common dir of the checkout holding `cwd` — from a linked
 * worktree, its main checkout's `.git`. Throws execGit's error, stderr on it,
 * where git will not say; gitCommonDir is the null-on-failure form.
 * @param {string} cwd
 * @param {Omit<import("node:child_process").ExecFileSyncOptions, "encoding" | "cwd">} [opts]
 * @returns {string}
 */
function gitCommonDirOrThrow(cwd, opts = {}) {
	return execGit(COMMON_DIR_ARGS, {
		stdio: ["ignore", "pipe", "pipe"],
		...opts,
		cwd,
		encoding: "utf8",
	}).trim();
}

/**
 * gitCommonDirOrThrow, or null where git will not say or prints nothing.
 * @param {string} cwd
 * @param {Omit<import("node:child_process").ExecFileSyncOptions, "encoding" | "cwd">} [opts]
 * @returns {string | null}
 */
function gitCommonDir(cwd, opts = {}) {
	return gitOrNull(COMMON_DIR_ARGS, { ...opts, cwd })?.trim() || null;
}

/**
 * The absolute git dir and common dir of the checkout holding `cwd`, from one
 * `rev-parse` rather than gitCommonDir and a second fork (#4302); equal in a
 * main checkout, different in a linked worktree or a submodule. Null where git
 * will not say.
 * @param {string} cwd
 * @returns {{ gitDir: string, common: string } | null}
 */
function gitDirs(cwd) {
	const [gitDir, common] = (gitOrNull(BOTH_DIRS_ARGS, { cwd }) ?? "").split(
		"\n",
	);
	return gitDir && common ? { gitDir, common } : null;
}

/**
 * `git rev-parse` of `flags` and then the git common dir, absolute paths, in
 * one fork: each flag's line, the common dir last. Throws execGit's error
 * where git refuses a flag.
 * @param {string} cwd
 * @param {readonly string[]} flags
 * @param {Omit<import("node:child_process").ExecFileSyncOptions, "encoding" | "cwd">} [opts]
 * @returns {string[]}
 */
function revParseWithCommonDirOrThrow(cwd, flags, opts = {}) {
	return execGit(
		["rev-parse", "--path-format=absolute", ...flags, "--git-common-dir"],
		{
			stdio: ["ignore", "pipe", "ignore"],
			...opts,
			cwd,
			encoding: "utf8",
		},
	)
		.trim()
		.split("\n");
}

/**
 * spawnSync on git: never throws; the caller reads `status` and `error`.
 * @overload
 * @param {readonly string[]} args
 * @param {import("node:child_process").SpawnSyncOptionsWithStringEncoding} opts
 * @returns {import("node:child_process").SpawnSyncReturns<string>}
 */
/**
 * @overload
 * @param {readonly string[]} args
 * @param {import("node:child_process").SpawnSyncOptionsWithBufferEncoding} [opts]
 * @returns {import("node:child_process").SpawnSyncReturns<Buffer>}
 */
/**
 * @overload
 * @param {readonly string[]} args
 * @param {import("node:child_process").SpawnSyncOptions} [opts]
 * @returns {import("node:child_process").SpawnSyncReturns<string | Buffer>}
 */
/**
 * @param {readonly string[]} args
 * @param {import("node:child_process").SpawnSyncOptions} [opts]
 * @returns {import("node:child_process").SpawnSyncReturns<string | Buffer>}
 */
function spawnGitSync(args, opts = {}) {
	const full = gitSpawnOptions(opts);
	return consultGitMemo(args, full) ?? spawnSync(gitBinary(), args, full);
}

/* The ceiling on one git call a hook makes, sized to the tightest budget any
 * caller answers to (#3248): the 7.5 s the PostToolUse dispatcher cuts its
 * reads to (hook-deadline.js). The PreToolUse dispatcher cuts them to 30 s,
 * and standalone hooks answer to their own registration, 10 s or more. A
 * ceiling, not a measurement: `git rev-parse` answers in milliseconds, and two
 * wedged calls at 3 s leave 1.5 s of the 7.5 s to the rest. */
const HOOK_GIT_TIMEOUT_MS = 3000;

/* The ceiling on a git call not held to HOOK_GIT_TIMEOUT_MS, unmeasured and
 * there only so a wedged git ends the read rather than hanging a suite launch
 * or a Stop hook: dirty-tree.js's `gitRead` answers null, `gitOutcome`
 * `ok: false`. */
const GIT_TIMEOUT_MS = 30_000;
/* Untraced: long enough to stay unique in a repository this size. */
const SHORT_SHA = 9;

/**
 * @typedef {{ ok: true, out: string } | { ok: false, why: string, isUnrun?: true }} GitRead
 *   `isUnrun`: git never answered, its spawn failing or outliving its time
 * @typedef {(args: string[], noMatch: number[]) => GitRead} GitReader
 */

/**
 * git's THREE outcomes, kept apart.
 *
 * `git grep` exits 1 on no match and >1 on failure, and `rev-parse --verify`
 * exits 1 on an unknown ref and 128 outside a repository — so a wrapper that
 * folds every non-zero into one answer reports a broken apparatus as an empty
 * result. That is the fail-open `lib/check.js`'s SUBJECT/APPARATUS split exists
 * to prevent, and it is why `noMatch` is named per call rather than assumed.
 *
 * @param {string[]} args
 * @param {number[]} noMatch exit codes that mean "asked and answered nothing"
 * @param {string} [cwd]
 * @returns {GitRead}
 */
function gitOutcome(args, noMatch, cwd, timeout = GIT_TIMEOUT_MS) {
	const r = spawnGitSync(args, {
		cwd,
		encoding: "utf8",
		timeout,
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (r.error) return { ok: false, why: r.error.message, isUnrun: true };
	if (r.status === 0) return { ok: true, out: String(r.stdout) };
	if (r.status !== null && noMatch.includes(r.status))
		return { ok: true, out: "" };
	/* One line: every caller logs `why` inside a one-line record, and git's
	 * stderr can run to several (#2527). stdout where stderr is empty: `git
	 * merge` prints its refusal there. */
	const why =
		String(r.stderr || r.stdout || "")
			.trim()
			.replace(/\s+/g, (run) => (run.includes("\n") ? "; " : run)) ||
		`git exited ${r.status}`;
	return { ok: false, why };
}

/**
 * @param {string} [cwd]
 * @param {number} [timeout]
 * @returns {GitReader}
 */
const gitReader = (cwd, timeout) => (args, noMatch) =>
	gitOutcome(args, noMatch, cwd, timeout);

/**
 * execFile on git, promisified: resolves `{ stdout, stderr }` as strings,
 * rejects on a non-zero exit.
 * @param {readonly string[]} args
 * @param {import("node:child_process").ExecFileOptions} [opts]
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
async function execGitAsync(args, opts = {}) {
	const { stdout, stderr } = await pExecFile(
		gitBinary(),
		args,
		gitSpawnOptions({ encoding: "utf8", ...opts }),
	);
	return { stdout: String(stdout), stderr: String(stderr) };
}

module.exports = {
	SHORT_SHA,
	gitBinary,
	gitSpawnOptions,
	execGit,
	execProgram,
	gitAnswer,
	gitOrNull,
	gitCommonDir,
	gitDirs,
	gitCommonDirOrThrow,
	revParseWithCommonDirOrThrow,
	spawnGitSync,
	gitOutcome,
	gitReader,
	execGitAsync,
	HOOK_GIT_TIMEOUT_MS,
	GIT_TIMEOUT_MS,
};
