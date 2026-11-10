#!/usr/bin/env node
/*
 * guard-main-checkout-job.js — SessionStart hook (#4340). A
 * background job started with the main checkout as its cwd, as every job the
 * agents view dispatches is (`wc1`/`wc2`/`wc3` run `claude agents` from
 * there), is relaunched in its own worktree before its first turn.
 *
 * THE MOVE. The worktree is `lib/session-checkout.js`'s launch directory for
 * the job's prompt, the cut the refill loop makes. The same job is started
 * there with `claude --bg`, its record's `respawnFlags` and prompt, on the
 * plan its job directory sits under; then the original is removed with
 * `claude rm` while its SessionStart hooks still hold back its first turn.
 *
 * CARRIED FILES. `claude rm` deletes the original's job directory, where the
 * harness saves a pasted image and names it in the prompt. Each file the
 * prompt names under that directory is copied to the worktree's ignored
 * `.claude/tmp/attachments/`, at its path below the job directory, and the
 * copy's path replaces it in the relaunched prompt (#4750). The directory
 * matches as the job was given it or resolved; punctuation glued after a path
 * that does not exist is dropped. Where one cannot be copied, or resolves
 * outside the job directory, nothing is relaunched. Residual: a path holding a
 * space is cut there, so its copy fails and the job stays put.
 *
 * WHY A RELAUNCH. The harness's own isolation (`worktree.bgIsolation`) sends
 * a background job to `EnterWorktree`, which 2.1.318 does not offer one, and
 * no hook output moves a session's cwd or ends it (#4340).
 *
 * A RESUMED JOB, OR ONE WITH NO PROMPT, IS NOT RELAUNCHED: a worktree is cut
 * and the session told to work there, as is one cut too late to relaunch.
 *
 * ANYTHING ELSE STARTS AS IT WOULD HAVE: an interactive session (no job
 * directory), a job already in a worktree, a `clear` or `compact` start, a
 * repository without the `landing` module (the launch directory is then the
 * main checkout).
 *
 * THE REGISTRATION ALLOWS 1200 s, the cut's own bounds summed: a fetch of up
 * to 3 tries and two more git steps at 30 s each, and an `npm ci` (or a wait
 * on a neighbour's) at 15 minutes (lib/dep-store.js). A cut slower than
 * that — a wait on a builder that then dies, and a build after it — is killed
 * before any launch. The launch and the removal start only with
 * `LAUNCH_ROOM_MS` left, so a kill never falls between them and leaves two
 * jobs on one prompt; a cut finishing later is handed to the session to work
 * in instead.
 *
 * IMPLICIT:  at every startup or resume of a background job in the main
 *            checkout, cuts a worktree; at a startup with a prompt, copies
 *            the files it names in the job directory there, starts a second
 *            job there and removes the first.
 * JUSTIFIED: fail-safe — a job left in the main checkout edits and commits
 *            where every session's dirt blocks `main` following the lander.
 * DEFEAT:    a fault anywhere leaves the job in the main checkout, saying why
 *            on stderr.
 * TREE:      host — acts only where the hook's cwd is the main checkout, and
 *            cuts under it
 */

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./lib/caught.js");
const { run } = require("./lib/guard-entry.js");
const {
	parseJobDir,
	readJobRecordIn,
	shortJobId,
} = require("./lib/job-paths.js");
const { mainCheckout } = require("./lib/main-checkout.js");
const { buildCutCommand } = require("./lib/cutover.js");
const { scriptPath } = require("./lib/script-path.js");
const { escapeRe } = require("./lib/regex-group.js");
const { relativeUnder } = require("./lib/is-under.js");
const { trimEndRun } = require("./lib/trim-run.js");
const { runClaude, buildSeatEnv } = require("./lib/seat-claude.js");
const { launchDir } = require("./lib/session-checkout.js");

/* Untraced. */
const CLAUDE_TIMEOUT_MS = 60_000;
/* The registration's timeout (self-plugin/hooks/hooks.json), held to it by
 * the test. */
const HOOK_TIMEOUT_MS = 1_200_000;
/* Both claude calls at their bound, and 10 s for node's own start and exit. */
const LAUNCH_ROOM_MS = 2 * CLAUDE_TIMEOUT_MS + 10_000;

/**
 * @typedef {{ root: string, seat: string, jobId: string, jobDir: string,
 *   jobDirs: string[], intent: string, name: string, flags: string[], short: string,
 *   providerEnv: Record<string, string> }} Job
 * @typedef {{ ok: boolean, output: string }} Ran
 * @typedef {{
 *   job: () => Job | null,
 *   cut: (job: Job) => string,
 *   msLeft: () => number,
 *   carry: (job: Job, dir: string) => string,
 *   launch: (job: Job, intent: string, dir: string) => Ran,
 *   remove: (job: Job) => Ran,
 * }} Ports
 */

/** @param {string} dir */
const workThere = (dir) =>
	`Your first tool call is Bash \`cd ${dir}\`; then read, edit and commit only under ${dir}, and land with \`node ${scriptPath("session-checkout.js")} land\`.`;

const STARTED_HERE =
	"This background job started in the main checkout, where no session edits or commits (#4229),";

/**
 * @param {string} source the start's `source`
 * @param {Ports} io
 * @returns {import("./lib/guard-entry.js").Decision}
 */
function decide(source, io) {
	if (source !== "startup" && source !== "resume") return null;
	const job = io.job();
	if (job === null) return null;
	let dir;
	try {
		dir = io.cut(job);
	} catch (err) {
		return {
			context: `${STARTED_HERE} and cutting its own worktree failed: ${caught(err).message}. Cut one yourself with ${buildCutCommand()}, which prints its path. ${workThere("<that path>")}`,
		};
	}
	if (dir === job.root) return null;
	if (source === "resume" || job.intent === "")
		return {
			context: `${STARTED_HERE} and a ${source === "resume" ? "resumed job" : "job with no prompt"} is not relaunched, so a worktree is cut for it at ${dir}. ${workThere(dir)}`,
		};
	if (io.msLeft() < LAUNCH_ROOM_MS)
		return {
			context: `${STARTED_HERE} and its worktree, ${dir}, was cut too late to relaunch the job there. ${workThere(dir)}`,
		};
	let intent;
	/* A file not carried is deleted by the removal below (#4750). */
	try {
		intent = io.carry(job, dir);
	} catch (err) {
		return {
			context: `${STARTED_HERE} and ${caught(err).message}, so it is not relaunched there. ${workThere(dir)}`,
		};
	}
	const launched = io.launch(job, intent, dir);
	if (!launched.ok)
		return {
			context: `${STARTED_HERE} and its relaunch in its own worktree failed: ${launched.output || "no output"}. That worktree is cut at ${dir}. ${workThere(dir)}`,
		};
	const removed = io.remove(job);
	if (!removed.ok)
		return {
			context: `This background job was relaunched in its own worktree, ${dir}, as: ${launched.output}. Removing this original copy failed (${removed.output || "no output"}). Do nothing for the prompt: end this turn at once with the line \`result: relaunched in ${path.basename(dir)}\`.`,
		};
	return null;
}

/**
 * `job`'s prompt with each file it names under the job directory copied into
 * `dir` and named there instead; throws naming a path it cannot carry.
 * @param {Job} job
 * @param {string} dir
 * @returns {string}
 */
function carryJobFiles(job, dir) {
	const unders = job.jobDirs.map((d) => escapeRe(`${d}${path.sep}`));
	const named = new RegExp(`(?:${unders.join("|")})[^\\s'"\`<>|]+`, "g");
	const into = path.join(dir, ".claude", "tmp", "attachments");
	return job.intent.replace(named, (token) => {
		const bare = trimEndRun(token, ".,;:)]");
		const from = fs.existsSync(token) ? token : bare;
		try {
			const rel = relativeUnder(job.jobDir, fs.realpathSync(from));
			if (!rel) throw new Error("it is not inside the job directory");
			const to = path.join(into, rel);
			fs.mkdirSync(path.dirname(to), { recursive: true });
			fs.copyFileSync(from, to);
			return `${to}${token.slice(from.length)}`;
		} catch (err) {
			throw new Error(
				`carrying ${from} into its worktree failed: ${caught(err).message}`,
				{ cause: err },
			);
		}
	});
}

/**
 * `claude <args>` on `job`'s seat in `cwd`, in the environment the daemon
 * gave the job.
 * @param {string[]} args
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 * @param {Job} job
 * @returns {Ran}
 */
function runOnJobSeat(args, cwd, env, job) {
	const r = runClaude(args, {
		cwd,
		env: buildSeatEnv(env, job.seat, job.providerEnv),
		timeout: CLAUDE_TIMEOUT_MS,
	});
	const output = [r.out, r.error && caught(r.error).message]
		.filter(Boolean)
		.join("\n");
	return { ok: r.failed === null, output };
}

/**
 * The job this hook runs in where it is a background job started in the
 * main checkout itself.
 * @param {Record<string, unknown>} payload
 * @param {NodeJS.ProcessEnv} env
 * @returns {Job | null}
 */
function readJob(payload, env) {
	if (typeof payload.cwd !== "string") return null;
	const where = parseJobDir(env.CLAUDE_JOB_DIR);
	if (where === null) return null;
	const record = readJobRecordIn(String(env.CLAUDE_JOB_DIR));
	if (record === null) return null;
	const cwd = fs.realpathSync(payload.cwd);
	const root = mainCheckout(cwd);
	if (root === null || fs.realpathSync(root) !== cwd) return null;
	return {
		root: cwd,
		seat: where.seat,
		jobId: where.jobId,
		jobDir: fs.realpathSync(String(env.CLAUDE_JOB_DIR)),
		jobDirs: [
			...new Set([
				path.resolve(String(env.CLAUDE_JOB_DIR)),
				fs.realpathSync(String(env.CLAUDE_JOB_DIR)),
			]),
		],
		intent: typeof record.intent === "string" ? record.intent : "",
		name: String(record.name ?? "session"),
		flags: Array.isArray(record.respawnFlags)
			? record.respawnFlags.filter(
					/** @param {unknown} f */ (f) => typeof f === "string",
				)
			: [],
		short: String(record.daemonShort ?? shortJobId(where.jobId)),
		providerEnv: Object.fromEntries(
			Object.entries(record.providerEnv ?? {}).filter(
				([, v]) => typeof v === "string",
			),
		),
	};
}

/**
 * @param {import("./lib/kit-context.js").PortEnv} at
 * @returns {Ports}
 */
function ports(at) {
	const env = process.env;
	const started = Date.now() - process.uptime() * 1000;
	return {
		job: () => readJob(at.payload, env),
		cut: (job) => launchDir(job.root, job.intent || job.name),
		msLeft: () => HOOK_TIMEOUT_MS - (Date.now() - started),
		carry: carryJobFiles,
		launch: (job, intent, dir) =>
			runOnJobSeat(["--bg", ...job.flags, "--", intent], dir, env, job),
		remove: (job) => runOnJobSeat(["rm", job.short], job.root, env, job),
	};
}

if (require.main === module)
	run({
		field: "source",
		top: true,
		/* guard-entry's HookEvent names no SessionStart, and widening it
		 * expires every guard's registry anchor; its emit writes any event. */
		event: /** @type {import("./lib/guard-entry.js").HookEvent} */ (
			/** @type {unknown} */ ("SessionStart")
		),
		noun: "a background job's start",
		decide,
		ports,
	});

module.exports = { decide };
