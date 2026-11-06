/*
 * seat-claude.js — `claude` run on a seat (#4344). `--bg`, `rm`, `attach` and
 * the job record are scoped to CLAUDE_CONFIG_DIR, so a call addressing a job
 * runs on that job's seat.
 */

const { stripVTControlCharacters } = require("node:util");
const { claudeBin } = require("./claude-bin.js");
const { CHILD_TIMEOUT_MS, spawnRaw } = require("./child-spawn.js");
const { childVerdict } = require("./child-failure.js");
const { forgetRoots } = require("./inherited-roots.js");
const { forgetSession } = require("./session-id.js");

/**
 * `env` on seat `seat`, with `over` laid on it and the caller's session
 * identity and root forgotten (lib/inherited-roots.js).
 * @param {NodeJS.ProcessEnv} env
 * @param {string} seat
 * @param {Record<string, string>} [over]
 * @returns {NodeJS.ProcessEnv}
 */
function buildSeatEnv(env, seat, over = {}) {
	const out = { ...env, ...over, CLAUDE_CONFIG_DIR: seat };
	forgetSession(out);
	forgetRoots(out);
	return out;
}

/**
 * `claude <args>` run to its end in `cwd` (else the caller's) under `env`
 * (buildSeatEnv's).
 * @param {string[]} args
 * @param {{cwd?: string, env: NodeJS.ProcessEnv, timeout?: number, bin?: string}} opts
 *   `bin` where the caller pins a CLI version
 */
function runClaude(
	args,
	{ cwd, env, timeout = CHILD_TIMEOUT_MS, bin = claudeBin(env) },
) {
	const r = spawnRaw(bin, args, {
		cwd,
		env,
		stdio: ["ignore", "pipe", "pipe"],
		timeout,
	});
	const child = {
		...r,
		stdout: stripVTControlCharacters(r.stdout),
		stderr: stripVTControlCharacters(r.stderr),
	};
	return { ...child, ...childVerdict(child) };
}

module.exports = { buildSeatEnv, runClaude };
