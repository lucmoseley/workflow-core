#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./lib/caught.js");
const { run } = require("./lib/guard-entry.js");
const {
	parseJobDir,
	readJobDir,
	readJobRecordIn,
	shortJobId,
} = require("./lib/job-paths.js");
const { mainCheckout } = require("./lib/main-checkout.js");
const { buildCutCommand } = require("./lib/cutover.js");
const { scriptPath } = require("./lib/script-path.js");
const { carryJobFiles } = require("./lib/carry-job-files.js");
const { runClaude, buildSeatEnv } = require("./lib/seat-claude.js");
const { claudeBin } = require("./lib/claude-bin.js");
const {
	launchAuthRefusal,
	STATUS_TIMEOUT_MS,
} = require("./lib/launch-auth.js");
const { launchDir } = require("./lib/session-checkout.js");

// #4340 guess
const CLAUDE_TIMEOUT_MS = 60_000;
const HOOK_TIMEOUT_MS = 1_200_000;
// #4340 guess
const NODE_START_MS = 10_000;
const LAUNCH_ROOM_MS =
	2 * CLAUDE_TIMEOUT_MS + 2 * STATUS_TIMEOUT_MS + NODE_START_MS;

/**
 * @typedef {import("./lib/job-paths.js").JobRef & { root: string,
 *   jobDir: string, intent: string, name: string, flags: string[],
 *   short: string, providerEnv: Record<string, string> }} Job
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
 * @param {string} source
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
	// #4750
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
 * @param {string[]} args
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} seatEnv
 * @returns {Ran}
 */
function runOnJobSeat(args, cwd, seatEnv) {
	const r = runClaude(args, {
		cwd,
		env: seatEnv,
		timeout: CLAUDE_TIMEOUT_MS,
	});
	const output = [r.out, r.error && caught(r.error).message]
		.filter(Boolean)
		.join("\n");
	return { ok: r.failed === null, output };
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {Job} job
 */
const seatEnvOf = (env, job) => buildSeatEnv(env, job.seat, job.providerEnv);

/**
 * @param {string[]} flags
 * @returns {string|undefined}
 */
function settingsOf(flags) {
	const i = flags.findLastIndex(
		(g) => g === "--settings" || g.startsWith("--settings="),
	);
	const f = flags[i];
	if (f === undefined) return;
	return f === "--settings" ? flags[i + 1] : f.slice("--settings=".length);
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {Job} job
 * @param {string} intent
 * @param {string} dir
 * @returns {Ran}
 */
function relaunch(env, job, intent, dir) {
	const seatEnv = seatEnvOf(env, job);
	const refusal = launchAuthRefusal({
		bin: claudeBin(seatEnv),
		env: seatEnv,
		cwd: dir,
		settings: settingsOf(job.flags),
		bg: true,
	});
	if (refusal) return { ok: false, output: refusal };
	return runOnJobSeat(["--bg", ...job.flags, "--", intent], dir, seatEnv);
}

/**
 * @param {Record<string, unknown>} payload
 * @param {NodeJS.ProcessEnv} env
 * @returns {Job | null}
 */
function readJob(payload, env) {
	if (typeof payload.cwd !== "string") return null;
	const jobDir = readJobDir(env);
	if (jobDir === null) return null;
	const ref = parseJobDir(jobDir);
	if (ref === null) return null;
	const record = readJobRecordIn(jobDir);
	if (record === null) return null;
	const cwd = fs.realpathSync(payload.cwd);
	const root = mainCheckout(cwd);
	if (root === null || fs.realpathSync(root) !== cwd) return null;
	return {
		root: cwd,
		seat: ref.seat,
		jobId: ref.jobId,
		jobDir: path.resolve(jobDir),
		intent: typeof record.intent === "string" ? record.intent : "",
		name: String(record.name ?? "session"),
		flags: Array.isArray(record.respawnFlags)
			? record.respawnFlags.filter(
					/** @param {unknown} f */ (f) => typeof f === "string",
				)
			: [],
		short: String(record.daemonShort ?? shortJobId(ref.jobId)),
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
		carry: (job, dir) =>
			carryJobFiles({
				text: job.intent,
				jobDir: job.jobDir,
				jobId: job.jobId,
				checkout: dir,
			}).text,
		launch: (job, intent, dir) => relaunch(env, job, intent, dir),
		remove: (job) =>
			runOnJobSeat(["rm", job.short], job.root, seatEnvOf(env, job)),
	};
}

if (require.main === module)
	run({
		field: "source",
		top: true,
		// #4340
		event: /** @type {import("./lib/guard-entry.js").HookEvent} */ (
			/** @type {unknown} */ ("SessionStart")
		),
		noun: "a background job's start",
		decide,
		ports,
	});

module.exports = { decide };
