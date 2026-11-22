const { stripVTControlCharacters } = require("node:util");
const { claudeBin } = require("./claude-bin.js");
const { CHILD_TIMEOUT_MS, spawnRaw } = require("./child-spawn.js");
const { childVerdict } = require("./child-failure.js");
const { forgetRoots } = require("./inherited-roots.js");
const { forgetSession } = require("./session-id.js");

/**
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
 * @param {string[]} args
 * @param {{cwd?: string, env: NodeJS.ProcessEnv, timeout?: number, bin?: string, spawn?: typeof spawnRaw}} opts
 */
function runClaude(
	args,
	{
		cwd,
		env,
		timeout = CHILD_TIMEOUT_MS,
		bin = claudeBin(env),
		spawn = spawnRaw,
	},
) {
	const r = spawn(bin, args, {
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
