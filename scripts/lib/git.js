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
 * gitSpawnOptions(), which carries the options every git spawn shares (#2734).
 */

const { execFile, execFileSync, spawnSync } = require("node:child_process");
const { promisify } = require("node:util");

const { caught } = require("./caught.js");
const { CHILD_MAX_BUFFER } = require("./child-buffer.js");

const pExecFile = promisify(execFile);

const gitBinary = () => process.env.WFC_GIT || "git";

/**
 * @template {object} T
 * @param {T} [opts]
 * @returns {T & {maxBuffer: number}}
 */
const gitSpawnOptions = (opts) =>
	/** @type {T & {maxBuffer: number}} */ ({
		maxBuffer: CHILD_MAX_BUFFER,
		...opts,
	});

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
	return execFileSync(gitBinary(), args, gitSpawnOptions(opts));
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
	return spawnSync(gitBinary(), args, gitSpawnOptions(opts));
}

/* The ceiling on one git call a hook makes, under the hook's 10 s (#2784). A
 * ceiling, not a measurement: `git rev-parse` answers in milliseconds, and 3 s
 * leaves the rest of the budget to the guard's core. */
const HOOK_GIT_TIMEOUT_MS = 3000;

/* The ceiling on a git call not held to HOOK_GIT_TIMEOUT_MS, unmeasured and
 * there only so a wedged git ends the read rather than hanging a suite launch
 * or a Stop hook: dirty-tree.js's `gitRead` answers null, `gitOutcome`
 * `ok: false`. */
const GIT_TIMEOUT_MS = 30_000;

/**
 * @typedef {{ ok: true, out: string } | { ok: false, why: string }} GitRead
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
	if (r.error) return { ok: false, why: r.error.message };
	if (r.status === 0) return { ok: true, out: String(r.stdout) };
	if (r.status !== null && noMatch.includes(r.status))
		return { ok: true, out: "" };
	/* One line: every caller logs `why` inside a one-line record, and git's
	 * stderr can run to several (#2527). */
	const why =
		String(r.stderr || "")
			.trim()
			.replace(/\s*\n\s*/g, "; ") || `git exited ${r.status}`;
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
	gitBinary,
	gitSpawnOptions,
	execGit,
	gitAnswer,
	gitOrNull,
	gitCommonDir,
	gitCommonDirOrThrow,
	spawnGitSync,
	gitOutcome,
	gitReader,
	execGitAsync,
	HOOK_GIT_TIMEOUT_MS,
	GIT_TIMEOUT_MS,
};
