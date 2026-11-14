/*
 * post-commit-steps.js — `.husky/post-commit`'s Node steps as in-process
 * cores (#5208, spec #5207): one function per lib/post-commit-rows.js row,
 * each returning what that row prints and exiting 0, post-commit never
 * refusing.
 *
 * Each takes `{ cwd, env }`, the hook's own, computes the arguments its
 * program takes (the commit, the top level, the committed paths, the main
 * tree) and stands down where its own preconditions fail. The route gate
 * the gated rows share is their `when` in lib/post-commit-rows.js, which the
 * dispatcher applies. A program's own run is its PROGRAM export (2, 5–7) or
 * its lib/check.js SPEC (3–4), reached through the `Programs` port.
 *
 * NO GIT CALL SEES THE HOOK'S REDIRECTS. A program reading from a cwd of its
 * own (a throwaway worktree, a materialised tree, the main checkout) under
 * the GIT_* variables git exports into a hook would read the wrong index or
 * pin every read to the hook's gitdir, so every git call here, and every
 * program's environment, is lib/hook-entry.js's scrubbedGitEnv.
 */

const path = require("node:path");
const { gitCommonDir, spawnGitSync } = require("./git.js");
const { scrubbedGitEnv } = require("./hook-entry.js");
const { readTopLevel } = require("./git-tree.js");
const { inProgramScope } = require("./program-scope.js");
const { trimEndRun } = require("./trim-run.js");

/** @typedef {{ cwd: string, env: NodeJS.ProcessEnv }} HookIo */
/** @typedef {import("./program-scope.js").ProgramResult} ProgramResult */

/**
 * How a step reaches the programs it runs: `load` a script under scripts/ as
 * its module, whose PROGRAM or SPEC the step takes, and `check` lib/check.js's
 * checkInProcess. lib/post-commit-testkit.ts fills it with stand-ins.
 * @typedef {{
 *   load: (script: string) => {
 *     PROGRAM?: (io: HookIo & { args: string[] }) => ProgramResult,
 *     SPEC?: import("./check.js").CheckSpec,
 *   },
 *   check: (
 *     spec: import("./check.js").CheckSpec,
 *     argv: string[],
 *     opts: { script: string },
 *   ) => Promise<ProgramResult>,
 * }} Programs
 */

/** @param {string} script a file under scripts/ */
const scriptAt = (script) => path.join(__dirname, "..", script);

/* Each loaded at first use, not with this file: on a replay the route-gated
 * rows stand down, and their programs and lib/check.js go unloaded. */
/** @type {Programs} */
const PROGRAMS = {
	load: (script) => require(scriptAt(script)),
	check: (spec, argv, opts) =>
		require("./check.js").checkInProcess(spec, argv, opts),
};

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

/** THIS commit, or "" where HEAD does not resolve. */
const readCommitted = (/** @type {HookIo} */ io) =>
	git(io, ["rev-parse", "--verify", "-q", "HEAD"]) ?? "";

/** `io` with the redirects scrubbed. @param {HookIo} io @returns {HookIo} */
const scrubbed = (io) => ({ cwd: io.cwd, env: scrubbedGitEnv(io.env) });

/** The tree the hook runs in, or null where git names none. */
const readTopLevelOf = (/** @type {HookIo} */ io) =>
	inProgramScope(scrubbed(io), () => readTopLevel(io.cwd));

/**
 * @param {Programs} programs
 * @param {string} script a file under scripts/
 * @param {HookIo} io
 * @param {string[]} args
 * @returns {ProgramResult}
 */
function runProgramAt(programs, script, io, args) {
	const { PROGRAM } = programs.load(script);
	if (!PROGRAM) throw new Error(`${script} exports no PROGRAM`);
	return PROGRAM({ ...scrubbed(io), args });
}

/* A yellow `!`. */
const BANG = "\u001b[33m!\u001b[0m";

/**
 * Row 1: how many commits are not yet pushed to the ref this checkout
 * pushes to, lib/landing-refs.js's `unpushed` answer. Silent where git
 * names no top level, no count, or none ahead. A throw reading the ref is
 * not caught here: the row warns, so the dispatcher prints one line naming
 * it and runs the rest (§N5).
 * @param {HookIo} io
 * @returns {ProgramResult}
 */
function unpushedReport(io) {
	const toplevel = readTopLevelOf(io);
	if (toplevel === null) return SILENT;
	const ref = inProgramScope(scrubbed(io), () => {
		const { hostOf, readUnpushedRef } = require("./landing-refs.js");
		return readUnpushedRef({ root: hostOf(toplevel), tree: toplevel });
	});
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
 * Row 2: the whole-repo faults THIS commit added. Its stdout always prints;
 * its stderr only on its exit 2, "a side could not be read", and then on the
 * hook's stdout, after its report.
 * @param {HookIo} io
 * @param {Programs} [programs]
 * @returns {ProgramResult}
 */
function newSharedFaultsRow(io, programs = PROGRAMS) {
	const committed = readCommitted(io);
	if (!committed || readTopLevelOf(io) === null) return SILENT;
	const r = runProgramAt(programs, "report-new-shared-faults.js", io, [
		committed,
	]);
	const out = trimEndRun(r.stdout, "\n");
	return {
		exit: 0,
		stdout: (out ? `${out}\n` : "") + (r.exit === 2 ? r.stderr : ""),
		stderr: "",
	};
}

/**
 * Rows 3 and 4: what THIS commit expired, by one lib/check.js checker's
 * `--touched-by`, run through its in-process run. Its report is on stderr
 * and printed on the hook's stdout: on a pass unless empty or `OK:`, on a
 * non-zero exit only where its git ceiling stopped it.
 * @param {string} script `check-instruction-surface.js` or
 *   `check-guard-registry.js`
 * @returns {(io: HookIo, programs?: Programs) => Promise<ProgramResult>}
 */
const touchedByRow =
	(script) =>
	async (io, programs = PROGRAMS) => {
		const toplevel = readTopLevelOf(io);
		const committed = readCommitted(io);
		if (toplevel === null || !committed) return SILENT;
		const { SPEC } = programs.load(script);
		if (!SPEC) throw new Error(`${script} exports no SPEC`);
		const r = await inProgramScope(scrubbed(io), () =>
			programs.check(SPEC, ["--root", toplevel, "--touched-by", committed], {
				script: scriptAt(script),
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
 * Row 5: release this session's whole-file claims on the paths THIS commit
 * touched. A merge, naming no path under this form, releases nothing. Both
 * streams pass through.
 * @param {HookIo} io
 * @param {Programs} [programs]
 * @returns {ProgramResult}
 */
function releaseClaimsRow(io, programs = PROGRAMS) {
	const committed = readCommitted(io);
	if (!committed || readTopLevelOf(io) === null) return SILENT;
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
	const r = runProgramAt(programs, "session-arbiter.js", io, [
		"release-committed",
		"--commit",
		committed,
		...paths,
	]);
	return { exit: 0, stdout: r.stdout, stderr: r.stderr };
}

/**
 * Row 6: record THIS commit as this session's own, in the ledger rooted at
 * the main worktree, the directory holding the common git dir. Needs a
 * session id; a bare or relocated git dir names no main worktree.
 * @param {HookIo} io
 * @param {Programs} [programs]
 * @returns {ProgramResult}
 */
function recordCommitRow(io, programs = PROGRAMS) {
	if (!io.env.CLAUDE_CODE_SESSION_ID) return SILENT;
	const committed = readCommitted(io);
	if (!committed || readTopLevelOf(io) === null) return SILENT;
	const common = gitCommonDir(io.cwd, { env: scrubbedGitEnv(io.env) });
	if (common === null || !common.endsWith("/.git")) return SILENT;
	const r = runProgramAt(
		programs,
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
 * Row 7: the hook-shim keeper's lazy run.
 * @param {HookIo} io
 * @param {Programs} [programs]
 * @returns {ProgramResult}
 */
function keepShimsRow(io, programs = PROGRAMS) {
	if (readTopLevelOf(io) === null) return SILENT;
	const r = runProgramAt(programs, "keep-hook-shims.js", io, ["--lazy"]);
	return { exit: 0, stdout: r.stdout, stderr: r.stderr };
}

const REVIEW_TIER_LINE = /^Review-Tier[ \t\v\f\r]*:/i;

/** @param {string | null} message */
const carriesReviewTier = (message) =>
	(message ?? "").split("\n").some((line) => REVIEW_TIER_LINE.test(line));

const DROPPED_REVIEW_TIER =
	"post-commit: this amend dropped the Review-Tier: line the amended commit carried, so the review it recorded is now unrecorded. On an unchanged tree, amend again with that line in the message to keep it.\n";

/**
 * Row 8: an amend given a message of its own drops the amended commit's
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
	touchedByRow,
	unpushedReport,
};
