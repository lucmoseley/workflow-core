/*
 * prepare-commit-msg-rows.js — .husky/prepare-commit-msg's steps, one row
 * each, run in order by scripts/prepare-commit-msg-dispatch.js through
 * lib/precommit-dispatch.js (#5207). Every row gates: its red refuses the
 * commit with its own code, and prints its own epilogue after what the step
 * said.
 *
 * THE CLOSING-KEYWORD SCAN (#138) reads the finished message file, so it sees
 * `-F <file>`, a `-c`/`-C` reuse and the founder's own terminal, which the
 * guard-commit-form core's PreToolUse read of `-m` cannot. It does NOT see a
 * message typed into $EDITOR — git runs this hook before the editor opens and
 * hands it an empty file — which is what `.husky/commit-msg` exists for.
 * It stands down on a replay, where a rebase or cherry-pick replaying a
 * pre-#129 commit carries a keyword nobody is writing now and refusing would
 * strand the sequence; a `git revert` is no replay. With no message file
 * given — the direct `sh -e .husky/prepare-commit-msg` a test or a person
 * makes — it skips rather than refusing.
 *
 * THEN ONE OF THREE PATHS, by the entry's facts:
 *   - a pre-commit stamp matching the index (`stamped`): `pre-commit` already
 *     ran on this exact index, so the trailer alone;
 *   - a replay (mantahostels#1706): gitleaks alone, never the whole stack
 *     (mantahostels#1687) — an intermediate rebase state can fail a
 *     cross-file check only the final state satisfies, which would make an
 *     ordinary rebase impossible. THE RESIDUAL is the rest of the stack,
 *     unrun there. A cherry-pick takes the review hold too (#3905), then the
 *     trailer; a rebase takes no hold, which would hold each replayed commit
 *     whole. The two apply routes are listed in the replay set so that a git
 *     which starts routing them here is gated, not silently exempt;
 *   - anything else: the whole of .husky/pre-commit, inline, then the
 *     trailer. On `git revert A B` that is once per reverted commit, which
 *     can strand on an intermediate state as a rebase would (#1503).
 *
 * The trailer row (#3664) writes the hold's `Review-Tier:` trailer and
 * refuses a tree that moved after the hold passed (#3905).
 *
 * A step whose script is missing: the scanner refuses (#138); the hold and
 * the trailer say so, log it for check-guard-errors.js and pass (#4051).
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const { constants } = require("node:os");
const path = require("node:path");
const { routeAbort, routeName, scanRefusal } = require("./commit-route.js");
const { readText } = require("./file-read.js");
const { precommitStamp } = require("./precommit-stamp.js");

const HOOK = "prepare-commit-msg";

/**
 * What every row reads: the hook's environment and what the entry computed
 * before the first row ran.
 * @typedef {object} PrepareCommitMsgContext
 * @property {string} cwd the repo the commit is made in
 * @property {NodeJS.ProcessEnv} env the hook's environment
 * @property {string} husky the hook's own directory, holding `pre-commit`
 * @property {string} root where the steps' scripts live:
 *   `${WFC_PLUGIN_ROOT:-<husky>/..}`
 * @property {string} file the message file git hands, "" where none
 * @property {string} gitDir the absolute git directory, "" where git names none
 * @property {string} route the commit route, lib/commit-route.js's
 */

/**
 * @typedef {import("./precommit-dispatch.js").RowResult} RowResult
 * @typedef {import("./precommit-dispatch.js").Row & {
 *   script: string,
 *   run: (ctx: PrepareCommitMsgContext) => RowResult,
 * }} PrepareCommitMsgRow `script` is the file holding the check, which
 *   check-guard-registry.js reads as wired
 */

/** The scripts a row runs, each under the context's `root`. */
const SCANNER = "scripts/check-commit-message-closes.js";
const HOLD = "scripts/review-hold-gate.js";
const TRAILER = "scripts/review-tier-trailer.js";

/**
 * `rel` under `ctx.root`.
 * @param {PrepareCommitMsgContext} ctx
 * @param {string} rel
 */
const scriptAt = (ctx, rel) => path.join(ctx.root, rel);

/**
 * Whether `file` can be read, as the shell's `[ -r ]` asks.
 * @param {string} file
 */
function readable(file) {
	try {
		fs.accessSync(file, fs.constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * The program `file` exports, `file` being under the context's root.
 * @param {string} file
 * @returns {{ PROGRAM?: Function, main?: Function }}
 */
const loadScript = (file) => require(file);

/**
 * The line naming the abort of an operation a refusal leaves open, "" where
 * the route has none.
 * @param {string} route
 */
function inProgressLine(route) {
	const abort = routeAbort(route);
	return abort
		? `  The ${routeName(route)} is left IN PROGRESS. Clear it with:  ${abort}\n`
		: "";
}

/**
 * Says on stderr that `file` is missing and logs it for check-guard-errors.js;
 * the step passes.
 * @param {string} file
 * @param {string} what what went unchecked
 * @returns {RowResult}
 */
function unchecked(file, what) {
	require("./fail-open-logger.js").failOpenLogger(HOOK)?.(
		`${path.basename(file)} is missing — ${what}`,
	);
	return {
		exit: 0,
		stdout: "",
		stderr: `${HOOK}: ${file} is missing, so ${what}.\n`,
	};
}

/**
 * A child's exit status as a shell reads it: 128 + n where signal n ended it.
 * @param {import("node:child_process").SpawnSyncReturns<unknown>} r
 */
function shellStatus(r) {
	if (r.status !== null) return r.status;
	return r.signal ? 128 + constants.signals[r.signal] : 1;
}

/** @type {RowResult} */
const PASS = { exit: 0, stdout: "", stderr: "" };

/** @param {PrepareCommitMsgContext} ctx @returns {RowResult} */
function closingKeyword(ctx) {
	const scanner = scriptAt(ctx, SCANNER);
	if (!readable(scanner))
		return {
			exit: 1,
			stdout: "",
			stderr: `${HOOK}: ${scanner} is missing, so the closing-keyword scan did not run.\n  Refusing rather than passing the message unread (#138).\n`,
		};
	const { main } = loadScript(scanner);
	const r = /** @type {{ code: number, stderr: string }} */ (
		main?.([ctx.file, HOOK])
	);
	return { exit: r.code === 0 ? 0 : 1, stdout: "", stderr: r.stderr };
}

/** gitleaks' arguments: a scan of the staged content, findings redacted. */
const GITLEAKS_STAGED = ["git", "--staged", "--redact"];

/**
 * The secrets scan alone, the command .husky/pre-commit runs, its output
 * straight to the terminal (mantahostels#1706, #224).
 * @param {PrepareCommitMsgContext} ctx
 * @returns {RowResult}
 */
function replayScan(ctx) {
	const bin = ctx.env.WFC_GITLEAKS || "gitleaks";
	const r = spawnSync(bin, GITLEAKS_STAGED, {
		cwd: ctx.cwd,
		env: ctx.env,
		stdio: "inherit",
	});
	if (!r.error && r.status === 0) return PASS;
	return {
		exit: 1,
		stdout: "",
		stderr:
			(r.error ? `${HOOK}: ${bin} would not start: ${r.error.message}\n` : "") +
			scanRefusal(HOOK, ctx.route),
	};
}

/**
 * A program step: its own result, with the in-progress line after a red.
 * @param {RowResult} r
 * @param {string} route
 * @returns {RowResult}
 */
const withEpilogue = (r, route) =>
	r.exit === 0 ? r : { ...r, stderr: r.stderr + inProgressLine(route) };

/** @param {PrepareCommitMsgContext} ctx @returns {RowResult} */
function reviewHold(ctx) {
	const hold = scriptAt(ctx, HOLD);
	if (!readable(hold))
		return unchecked(
			hold,
			"this cherry-pick went unchecked for a sensitive-path review",
		);
	const { PROGRAM } = loadScript(hold);
	return withEpilogue(PROGRAM?.({ cwd: ctx.cwd, env: ctx.env }), ctx.route);
}

/**
 * The whole of .husky/pre-commit, under `sh -e` as its own process and its
 * status passed through rather than collapsed to 1 — both for the reasons
 * `.husky/pre-merge-commit` records; git itself discards the code and
 * reports 1. WFC_INDEX_FROZEN: git read this commit's index before this hook
 * ran, so a gate staging a fix here would not reach the commit (#4514).
 * @param {PrepareCommitMsgContext} ctx
 * @returns {RowResult}
 */
function inlinePreCommit(ctx) {
	const r = spawnSync("sh", ["-e", path.join(ctx.husky, "pre-commit")], {
		cwd: ctx.cwd,
		env: { ...ctx.env, WFC_INDEX_FROZEN: "1" },
		stdio: "inherit",
	});
	/* pre-commit stamps its own success, and leaving that stamp would let
	 * this run stand down a later `--no-verify` commit. */
	if (ctx.gitDir) fs.rmSync(precommitStamp(ctx.gitDir), { force: true });
	if (r.error) throw r.error;
	const status = shellStatus(r);
	if (status === 0) return PASS;
	/* A merge and a multi-commit revert are readable; a clean single revert is
	 * not (mantahostels#1706). */
	return {
		exit: status,
		stdout: "",
		stderr:
			`${HOOK}: the gates above refused this commit's content.\n` +
			"  This hook runs them because --no-verify cannot turn it off (mantahostels#1705).\n" +
			"  Fix the finding and commit again.\n" +
			(inProgressLine(ctx.route) ||
				"  Was this a revert? It is left IN PROGRESS:  git revert --abort\n"),
	};
}

/** @param {PrepareCommitMsgContext} ctx @returns {RowResult} */
function trailer(ctx) {
	const script = scriptAt(ctx, TRAILER);
	if (!readable(script))
		return unchecked(
			script,
			"this commit lands with no Review-Tier: trailer and no check that its tree stayed put",
		);
	const { PROGRAM } = loadScript(script);
	return withEpilogue(
		PROGRAM?.({ cwd: ctx.cwd, env: ctx.env, args: [ctx.file] }),
		ctx.route,
	);
}

/**
 * Whether the trailer would write and strip nothing: no message, or no stamp
 * of this session's in the git directory and no `Review-Tier:` line in the
 * message, so its run is skipped (#5153).
 * @param {PrepareCommitMsgContext} ctx
 */
function trailerIdle(ctx) {
	if (!ctx.file) return true;
	if (!ctx.gitDir) return false;
	const { reviewTierStamp } = require("./review-tier-stamp.js");
	const stamp = reviewTierStamp(ctx.gitDir, ctx.env.CLAUDE_CODE_SESSION_ID);
	if (stamp !== null && fs.existsSync(stamp)) return false;
	/* A message that will not read is no proof it lacks a Review-Tier: line:
	 * not idle, so the trailer runs. */
	const read = readText(ctx.file);
	if (read.state !== "read") return false;
	const { KEY } = require("./review-tier-trailer.js");
	return !read.data.split("\n").some((line) => KEY.test(line));
}

/**
 * @param {PrepareCommitMsgContext} ctx
 * @param {{ stamped: boolean, replay: boolean }} path
 */
function trailerArmed(ctx, { stamped, replay }) {
	const due =
		stamped ||
		!replay ||
		(ctx.route === "cherry-pick" && readable(scriptAt(ctx, HOLD)));
	return due && (!readable(scriptAt(ctx, TRAILER)) || !trailerIdle(ctx));
}

/** @type {PrepareCommitMsgRow[]} */
const ROWS = [
	{
		id: "closing-keyword",
		script: SCANNER,
		arm: { always: true },
		when: { unlessRoutes: ["replay"], facts: ["message"] },
		policy: "gate",
		run: closingKeyword,
	},
	{
		id: "replay-scan",
		script: "scripts/lib/prepare-commit-msg-rows.js",
		arm: { always: true },
		when: { routes: ["replay"], unlessFacts: ["stamped"] },
		policy: "gate",
		run: replayScan,
	},
	{
		id: "review-hold",
		script: HOLD,
		arm: { always: true },
		when: { routes: ["cherry-pick"], unlessFacts: ["stamped"] },
		policy: "gate",
		run: reviewHold,
	},
	{
		id: "inline-pre-commit",
		script: ".husky/pre-commit",
		arm: { always: true },
		when: { unlessRoutes: ["replay"], unlessFacts: ["stamped"] },
		policy: "gate",
		run: inlinePreCommit,
	},
	{
		id: "trailer",
		script: TRAILER,
		arm: { always: true },
		when: { facts: ["trailer"] },
		policy: "gate",
		run: trailer,
	},
];

module.exports = { ROWS, trailerArmed };
