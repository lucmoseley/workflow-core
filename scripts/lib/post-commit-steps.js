/*
 * post-commit-steps.js — `.husky/post-commit`'s Node steps as in-process
 * cores (#5208, spec #5207): one function per hook block, each printing
 * exactly what that block prints today and exiting 0, post-commit never
 * refusing.
 *
 *   1. unpushedReport           report_unpushed
 *   2. newSharedFaultsRow       report_new_shared_faults
 *   3–4. touchedByRow(script)   report_touched_by, per checker
 *   5. releaseClaimsRow         release_committed_claims
 *   6. recordCommitRow          record_session_commit
 *   7. keepShimsRow             keep_hook_shims
 *   8. droppedReviewTier        report_dropped_review_tier
 *
 * Each takes `{ cwd, env }`, the hook's own, computes the arguments its block
 * passes (the commit, the top level, the committed paths, the main tree) and
 * stands down where the block's own preconditions do. The route gate the
 * blocks share, `in_replay`, is not here: that is the dispatcher row's
 * arming. A program's own run is its PROGRAM export (2, 5–7) or its
 * lib/check.js SPEC (3–4); the translation of its output into what the block
 * prints is here.
 *
 * NO GIT CALL SEES THE HOOK'S REDIRECTS. git exports GIT_INDEX_FILE=.git/index
 * — a RELATIVE path — into every hook, and a commit in a linked worktree also
 * GIT_DIR=<repo>/.git/worktrees/<name>. A program reading from a cwd of its own
 * (a throwaway worktree, a materialised tree, the main checkout) would read the
 * wrong index or pin every read to the hook's gitdir. GIT_WORK_TREE is the
 * third redirect of the class. The hook unset all three per block; here every
 * git call, and every program's environment, is scrubbedGitEnv's.
 */

const path = require("node:path");
const { spawnGitSync } = require("./git.js");
const { readTopLevel } = require("./git-tree.js");
const { inProgramScope } = require("./program-scope.js");
const { trimEndRun } = require("./trim-run.js");

/** @typedef {{ cwd: string, env: NodeJS.ProcessEnv }} HookIo */
/** @typedef {import("./program-scope.js").ProgramResult} ProgramResult */

const GIT_REDIRECTS = ["GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE"];

/**
 * `env` without the three variables git exports into a hook that redirect a
 * read.
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv}
 */
function scrubbedGitEnv(env) {
	const out = { ...env };
	for (const key of GIT_REDIRECTS) delete out[key];
	return out;
}

/** What a step prints when it prints nothing. @type {ProgramResult} */
const SILENT = Object.freeze({ exit: 0, stdout: "", stderr: "" });

/**
 * A git read as a shell `$(git …)` takes it: stdout with its trailing
 * newlines stripped, or null on a non-zero exit.
 * @param {HookIo} io
 * @param {string[]} args
 * @returns {string | null}
 */
function git({ cwd, env }, args) {
	const r = spawnGitSync(args, {
		cwd,
		env: scrubbedGitEnv(env),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (r.status !== 0 || r.error) return null;
	return trimEndRun(String(r.stdout), "\n");
}

/** The hook's `committed`: THIS commit, or "" where HEAD does not resolve. */
const committedOf = (/** @type {HookIo} */ io) =>
	git(io, ["rev-parse", "--verify", "-q", "HEAD"]) ?? "";

/** `io` with the redirects scrubbed. @param {HookIo} io @returns {HookIo} */
const scrubbed = (io) => ({ cwd: io.cwd, env: scrubbedGitEnv(io.env) });

/** The hook's `toplevel`, the tree it runs in, or null where git names none. */
const toplevelOf = (/** @type {HookIo} */ io) =>
	inProgramScope(scrubbed(io), () => readTopLevel(io.cwd));

/** @param {string} script a file under scripts/ */
const scriptAt = (script) => path.join(__dirname, "..", script);

/**
 * A program's PROGRAM, run under `io` with the redirects scrubbed.
 * @param {string} script a file under scripts/
 * @param {HookIo} io
 * @param {string[]} args
 * @returns {ProgramResult}
 */
function runProgramAt(script, io, args) {
	const { PROGRAM } = require(scriptAt(script));
	return PROGRAM({ ...scrubbed(io), args });
}

/* The block's own: `\033[33m!\033[0m`, a yellow `!`. */
const BANG = "\u001b[33m!\u001b[0m";

/**
 * Block 1: how many commits are not yet pushed to the ref this checkout
 * pushes to, lib/landing-refs.js's `unpushed` answer. Silent on every
 * failure.
 * @param {HookIo} io
 * @returns {ProgramResult}
 */
function unpushedReport(io) {
	const toplevel = toplevelOf(io);
	if (toplevel === null) return SILENT;
	let ref;
	try {
		ref = inProgramScope(scrubbed(io), () => {
			const { hostOf, readUnpushedRef } = require("./landing-refs.js");
			return readUnpushedRef({ root: hostOf(toplevel), tree: toplevel });
		});
	} catch {
		/* The CLI's crash, which the block's `|| return 0` silences. */
		return SILENT;
	}
	if (git(io, ["rev-parse", "--verify", "-q", ref]) === null)
		return {
			exit: 0,
			stdout: `${BANG} ${ref} does not exist here — nothing is tracking these commits.\n`,
			stderr: "",
		};
	const ahead = git(io, ["rev-list", "--count", `${ref}..HEAD`]);
	if (ahead === null || !/^\d+$/.test(ahead) || Number(ahead) <= 0)
		return SILENT;
	return {
		exit: 0,
		stdout:
			Number(ahead) === 1
				? `${BANG} 1 commit not pushed to ${ref}.\n`
				: `${BANG} ${ahead} commits not pushed to ${ref}.\n`,
		stderr: "",
	};
}

/**
 * Block 2: the whole-repo faults THIS commit added. Its stdout always
 * prints; its stderr only on its exit 2, "a side could not be read", and on
 * the hook's stdout, as the block's `cat` puts it.
 * @param {HookIo} io
 * @returns {ProgramResult}
 */
function newSharedFaultsRow(io) {
	const committed = committedOf(io);
	if (!committed || toplevelOf(io) === null) return SILENT;
	const r = runProgramAt("report-new-shared-faults.js", io, [committed]);
	const out = trimEndRun(r.stdout, "\n");
	return {
		exit: 0,
		stdout: (out ? `${out}\n` : "") + (r.exit === 2 ? r.stderr : ""),
		stderr: "",
	};
}

/**
 * Blocks 3 and 4: what THIS commit expired, by one lib/check.js checker's
 * `--touched-by`, run through its in-process run. Its report is on stderr
 * and printed on the hook's stdout: on a pass unless empty or `OK:`, on a
 * non-zero exit only where its git ceiling stopped it.
 * @param {string} script `check-instruction-surface.js` or
 *   `check-guard-registry.js`
 * @returns {(io: HookIo) => Promise<ProgramResult>}
 */
const touchedByRow = (script) => async (io) => {
	const toplevel = toplevelOf(io);
	const committed = committedOf(io);
	if (toplevel === null || !committed) return SILENT;
	const file = scriptAt(script);
	const { SPEC } = require(file);
	const { checkInProcess } = require("./check.js");
	const r = await inProgramScope(scrubbed(io), () =>
		checkInProcess(SPEC, ["--root", toplevel, "--touched-by", committed], {
			script: file,
		}),
	);
	const out = trimEndRun(r.stderr, "\n");
	const said =
		r.exit === 0
			? out !== "" && !out.startsWith("OK:")
			: /passed its [\s\S]* ceiling/.test(out);
	return said ? { exit: 0, stdout: `${out}\n`, stderr: "" } : SILENT;
};

/**
 * Block 5: release this session's whole-file claims on the paths THIS commit
 * touched. A merge, naming no path under this form, releases nothing. Both
 * streams pass through: the arbiter's stderr names a clobber it finds.
 * @param {HookIo} io
 * @returns {ProgramResult}
 */
function releaseClaimsRow(io) {
	const committed = committedOf(io);
	if (!committed || toplevelOf(io) === null) return SILENT;
	const listed = git(io, [
		"-c",
		"core.quotePath=false",
		"diff-tree",
		"--no-commit-id",
		"--name-only",
		"-r",
		"--root",
		committed,
	]);
	if (!listed) return SILENT;
	const paths = listed.split("\n").filter((rel) => rel !== "");
	const r = runProgramAt("session-arbiter.js", io, [
		"release-committed",
		"--commit",
		committed,
		...paths,
	]);
	return { exit: 0, stdout: r.stdout, stderr: r.stderr };
}

/**
 * Block 6: record THIS commit as this session's own, in the ledger rooted at
 * the main worktree, the directory holding the common git dir. Needs a
 * session id; a bare or relocated git dir names no main worktree.
 * @param {HookIo} io
 * @returns {ProgramResult}
 */
function recordCommitRow(io) {
	if (!io.env.CLAUDE_CODE_SESSION_ID) return SILENT;
	const committed = committedOf(io);
	if (!committed || toplevelOf(io) === null) return SILENT;
	const common = git(io, [
		"rev-parse",
		"--path-format=absolute",
		"--git-common-dir",
	]);
	if (common === null || !common.endsWith("/.git")) return SILENT;
	const r = runProgramAt(
		"session-arbiter.js",
		{
			cwd: io.cwd,
			env: { ...io.env, CLAUDE_PROJECT_DIR: common.slice(0, -"/.git".length) },
		},
		["record-commit", committed],
	);
	return { exit: 0, stdout: r.stdout, stderr: r.stderr };
}

/**
 * Block 7: the hook-shim keeper's lazy run.
 * @param {HookIo} io
 * @returns {ProgramResult}
 */
function keepShimsRow(io) {
	if (toplevelOf(io) === null) return SILENT;
	const r = runProgramAt("keep-hook-shims.js", io, ["--lazy"]);
	return { exit: 0, stdout: r.stdout, stderr: r.stderr };
}

/* grep -qiE '^Review-Tier[[:space:]]*:' over one line: [[:space:]] within a
 * line, a newline never being in one. */
const REVIEW_TIER_LINE = /^Review-Tier[ \t\v\f\r]*:/i;

/** @param {string | null} message */
const carriesReviewTier = (message) =>
	(message ?? "").split("\n").some((line) => REVIEW_TIER_LINE.test(line));

const DROPPED_REVIEW_TIER =
	"post-commit: this amend dropped the Review-Tier: line the amended commit carried, so the review it recorded is now unrecorded. On an unchanged tree, amend again with that line in the message to keep it.\n";

/**
 * Block 8: an amend given a message of its own drops the amended commit's
 * `Review-Tier:` line, which only the review hold writes back. The reflog
 * tells an amend from an empty commit on HEAD's tree.
 * @param {HookIo} io
 * @returns {ProgramResult}
 */
function droppedReviewTier(io) {
	const subject = git(io, ["reflog", "-1", "--format=%gs", "HEAD"]);
	if (!subject?.startsWith("commit (amend):")) return SILENT;
	if (!carriesReviewTier(git(io, ["log", "-1", "--format=%B", "HEAD@{1}"])))
		return SILENT;
	if (carriesReviewTier(git(io, ["log", "-1", "--format=%B", "HEAD"])))
		return SILENT;
	return { exit: 0, stdout: "", stderr: DROPPED_REVIEW_TIER };
}

module.exports = {
	droppedReviewTier,
	keepShimsRow,
	newSharedFaultsRow,
	recordCommitRow,
	releaseClaimsRow,
	scrubbedGitEnv,
	touchedByRow,
	unpushedReport,
};
