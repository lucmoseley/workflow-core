/*
 * seat-claude.js — the one way a script runs `claude` on a seat (#4344):
 * `claude stop`, `attach`, `rm`, `--bg` and the job record are scoped to
 * CLAUDE_CONFIG_DIR, so a call addressing a job runs on that job's seat.
 * guard-main-checkout-job.js and the refill loop's resume (lib/resume-io.js,
 * lib/refill-resume.js) run their `claude` calls through it.
 */

const { stripVTControlCharacters } = require("node:util");
const { claudeBin } = require("./claude-bin.js");
const { CHILD_TIMEOUT_MS, spawnChild } = require("./child-spawn.js");
const { childVerdict } = require("./child-failure.js");
const { forgetSession } = require("./session-id.js");

/**
 * `env` on seat `seat`, with `over` laid on it and the caller's session
 * identity forgotten: the job a call starts or addresses is no session of the
 * caller's.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} seat
 * @param {Record<string, string>} [over]
 * @returns {NodeJS.ProcessEnv}
 */
function seatEnv(env, seat, over = {}) {
	const out = { ...env, ...over, CLAUDE_CONFIG_DIR: seat };
	forgetSession(out);
	return out;
}

/**
 * `claude <args>` run to its end in `cwd` under `env` (seatEnv's), its output
 * stripped of the VT codes the CLI colours it with, and judged.
 * @param {string[]} args
 * @param {{cwd: string, env: NodeJS.ProcessEnv, timeout?: number}} opts
 */
function runClaude(args, { cwd, env, timeout = CHILD_TIMEOUT_MS }) {
	const r = spawnChild(claudeBin(), args, {
		cwd,
		env,
		stdio: ["ignore", "pipe", "pipe"],
		timeout,
	});
	const child = {
		status: r.status,
		stdout: stripVTControlCharacters(r.stdout),
		stderr: stripVTControlCharacters(r.stderr),
		error: r.error,
	};
	return { ...child, ...childVerdict(child) };
}

module.exports = { runClaude, seatEnv };
