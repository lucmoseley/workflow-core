#!/usr/bin/env node
/*
 * guard-main-checkout-job.js — SessionStart hook, `startup` only (#4340). A
 * background job started with the main checkout as its cwd, as every job the
 * agents view dispatches is (`wc1`/`wc2`/`wc3` run `claude agents` from
 * there), is relaunched in its own worktree before its first turn, so it
 * works as a refill-loop or `start-session.sh` launch does (#4229) and never
 * meets the main checkout's write refusal (#4248).
 *
 * THE MOVE. The worktree is `lib/session-checkout.js`'s launch directory for
 * the job's prompt, the cut the refill loop makes. The same job is started
 * there with `claude --bg`, its record's `respawnFlags` and prompt, on the
 * plan its job directory sits under; then the original is removed with
 * `claude rm` while its SessionStart hooks still hold back its first turn.
 * The new job's record names the worktree as its cwd, so its guards, its
 * resume and the readers attributing a worktree to its session
 * (lib/session-worktrees.js) all read it as a launcher-cut session.
 *
 * WHY A RELAUNCH. The harness's own isolation (`worktree.bgIsolation`) sends
 * a background job to `EnterWorktree`, which 2.1.318 does not offer one, and
 * no hook output moves a session's cwd or ends it: `"continue": false` on
 * SessionStart was measured not to stop the job (#4340).
 *
 * ANYTHING ELSE STARTS AS IT WOULD HAVE: an interactive session (no job
 * directory), a job already in a worktree, a resume, a repository without
 * the `landing` module (the launch directory is then the main checkout).
 * Where the relaunch fails part-way the session is told what to do instead:
 * work in the cut worktree, or end at once where its replacement is running.
 *
 * THE REGISTRATION ALLOWS 960 s: a cut whose lockfile has no dependency store
 * yet runs `npm ci`, bounded at 15 minutes (lib/session-checkout.js).
 *
 * IMPLICIT:  at every startup of a background job in the main checkout, cuts a
 *            worktree, starts a second job there and removes the first.
 * JUSTIFIED: fail-safe — a job left in the main checkout edits and commits
 *            where every session's dirt blocks `main` following the lander.
 * DEFEAT:    a fault anywhere leaves the job in the main checkout, saying why
 *            on stderr.
 * TREE:      host — acts only where the hook's cwd is the main checkout, and
 *            cuts under it
 *
 * Exit 0 always: a fault leaves the job where it started (§N5's fail-open).
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { stripVTControlCharacters } = require("node:util");
const { caught } = require("./lib/caught.js");
const { claudeBin } = require("./lib/claude-bin.js");
const {
	parseJobDir,
	readJobRecordIn,
	shortJobId,
} = require("./lib/job-paths.js");
const { mainCheckout } = require("./lib/main-checkout.js");
const { readFdAll } = require("./lib/read-fd.js");
const { launchDir } = require("./lib/session-checkout.js");
const { forgetSession } = require("./lib/session-id.js");
const { writeFd } = require("./lib/write-fd.js");

/* Untraced: `claude --bg` and `claude rm` each answer in seconds once the
 * daemon is up; this only bounds a wedged one. */
const CLAUDE_TIMEOUT_MS = 60_000;

/**
 * @param {string} text
 */
function tell(text) {
	writeFd(
		1,
		`${JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "SessionStart",
				additionalContext: text,
			},
		})}\n`,
	);
}

/**
 * @param {string[]} args
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ ok: boolean, output: string }}
 */
function runClaude(args, cwd, env) {
	const r = spawnSync(claudeBin(), args, {
		cwd,
		env,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: CLAUDE_TIMEOUT_MS,
	});
	const output = stripVTControlCharacters(
		`${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? caught(r.error).message : ""}`,
	).trim();
	return { ok: r.status === 0, output };
}

/**
 * The job this hook runs in, where it is a background job freshly started
 * in the main checkout itself; null for anything to leave alone.
 * @param {{source?: unknown, cwd?: unknown}} input
 * @param {NodeJS.ProcessEnv} env
 */
function jobToMove(input, env) {
	if (input.source !== "startup" || typeof input.cwd !== "string") return null;
	const where = parseJobDir(env.CLAUDE_JOB_DIR);
	if (where === null) return null;
	const record = readJobRecordIn(String(env.CLAUDE_JOB_DIR));
	if (record === null) return null;
	const cwd = fs.realpathSync(input.cwd);
	const root = mainCheckout(cwd);
	if (root === null || fs.realpathSync(root) !== cwd) return null;
	return { root: cwd, seat: where.seat, jobId: where.jobId, record };
}

/**
 * @param {string} raw the hook payload
 * @param {NodeJS.ProcessEnv} env
 */
function moveJob(raw, env) {
	const job = jobToMove(JSON.parse(raw), env);
	if (job === null) return;
	const { record } = job;
	const intent = typeof record.intent === "string" ? record.intent : "";
	const dir = launchDir(job.root, intent || String(record.name ?? "session"));
	if (dir === job.root) return;

	const flags = Array.isArray(record.respawnFlags)
		? record.respawnFlags.filter(
				/** @param {unknown} f */ (f) => typeof f === "string",
			)
		: [];
	const childEnv = { ...env, CLAUDE_CONFIG_DIR: job.seat };
	forgetSession(childEnv);
	const launched = runClaude(
		["--bg", ...flags, ...(intent ? ["--", intent] : [])],
		dir,
		childEnv,
	);
	if (!launched.ok) {
		tell(
			`This background job started in the main checkout, where no session edits or commits (#4229), and its relaunch in its own worktree failed: ${launched.output || "no output"}. That worktree is cut at ${dir}. Your first tool call is Bash \`cd ${dir}\`; then read, edit and commit only under ${dir}, and land with \`node scripts/session-checkout.js land\`.`,
		);
		return;
	}
	const self = String(record.daemonShort ?? shortJobId(job.jobId));
	const removed = runClaude(["rm", self], job.root, childEnv);
	if (!removed.ok)
		tell(
			`This background job was relaunched in its own worktree, ${dir}, as: ${launched.output}. Removing this original copy failed (${removed.output || "no output"}). Do nothing for the prompt: end this turn at once with the line \`result: relaunched in ${path.basename(dir)}\`.`,
		);
}

function main() {
	try {
		moveJob(readFdAll(0).toString("utf8"), process.env);
	} catch (err) {
		writeFd(
			2,
			`guard-main-checkout-job: left the job where it started: ${caught(err).message}\n`,
		);
	}
	return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { main };
