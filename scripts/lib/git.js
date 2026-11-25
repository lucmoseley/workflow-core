const { execFile, execFileSync, spawnSync } = require("node:child_process");
const { promisify } = require("node:util");

const { caught } = require("./caught.js");
const { CHILD_MAX_BUFFER } = require("./child-buffer.js");
const { consultMemo, dropKeptReads } = require("./git-read-memo.js");
const { spawnTimeout } = require("./hook-deadline.js");
const { writeFd } = require("./write-fd.js");

const pExecFile = promisify(execFile);

/**
 * @param {import("node:child_process").SpawnSyncReturns<string | Buffer>} r
 * @param {readonly string[]} argv
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
 * @param {string} cwd
 * @param {Omit<import("node:child_process").ExecFileSyncOptions, "encoding" | "cwd">} [opts]
 * @returns {string | null}
 */
function gitCommonDir(cwd, opts = {}) {
	return gitOrNull(COMMON_DIR_ARGS, { ...opts, cwd })?.trim() || null;
}

/**
 * @param {string} cwd
 * @returns {{ gitDir: string, common: string } | null}
 */
function gitDirs(cwd) {
	return parseGitDirs(gitOrNull(BOTH_DIRS_ARGS, { cwd }));
}

/**
 * @param {string | null} out
 * @returns {{ gitDir: string, common: string } | null}
 */
function parseGitDirs(out) {
	const [gitDir, common] = (out ?? "").trim().split("\n");
	return gitDir && common ? { gitDir, common } : null;
}

/**
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

// guess, workflow-core#3248
const HOOK_GIT_TIMEOUT_MS = 3000;

// guess, workflow-core#2196
const GIT_TIMEOUT_MS = 30_000;
// guess, workflow-core#2607
const SHORT_SHA = 9;
// guess: a sha in a report line, unique where 9 may not be, workflow-core#892
const WIDE_SHA = 12;

/**
 * @typedef {{ ok: true, out: string } | { ok: false, why: string, isUnrun?: true }} GitRead
 * @typedef {(args: string[], noMatch: number[]) => GitRead} GitReader
 */

/**
 * @param {string[]} args
 * @param {number[]} noMatch
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
	WIDE_SHA,
	gitBinary,
	gitSpawnOptions,
	execGit,
	execProgram,
	gitAnswer,
	gitOrNull,
	gitCommonDir,
	gitDirs,
	BOTH_DIRS_ARGS,
	parseGitDirs,
	gitCommonDirOrThrow,
	revParseWithCommonDirOrThrow,
	spawnGitSync,
	gitOutcome,
	gitReader,
	execGitAsync,
	HOOK_GIT_TIMEOUT_MS,
	GIT_TIMEOUT_MS,
};
