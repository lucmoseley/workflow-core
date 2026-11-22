const path = require("node:path");
const { launchAuthRefusal } = require("./launch-auth.js");
const { buildSeatEnv, runClaude } = require("./seat-claude.js");
const { throttleEnv } = require("./throttle-paths.js");

/** @typedef {import("./run-arm.js").Ports} Ports */
/** @typedef {import("./run-arm.js").Run} Run */
/** @typedef {import("./run-arm.js").LaunchRecord} LaunchRecord */
/** @typedef {import("./run-arm.js").JobStates} JobStates */
/** @typedef {import("./run-arm.js").Job} Job */

const MODEL = "claude-opus-5-5[1m]";
const EFFORT = "medium";
// guess, #5529
const CALL_TIMEOUT_MS = 120_000;

/**
 * @param {string} sandbox
 * @param {NodeJS.ProcessEnv} env
 */
function sandboxEnv(sandbox, env) {
	return {
		WFC_GH: path.join(sandbox, "bin", "gh"),
		GH_HOST: "gh-stub.invalid",
		GIT_ALLOW_PROTOCOL: "file",
		DISABLE_AUTOUPDATER: "1",
		...throttleEnv(env),
	};
}

/**
 * @param {Ports} p
 * @param {Run} run
 * @param {{ repo: string, prompt: string }} ready
 * @param {string} bin
 * @returns {{ ok: true, record: LaunchRecord } | { ok: false, why: string }}
 */
function start(p, run, { repo, prompt }, bin) {
	const env = {
		...p.env,
		...sandboxEnv(run.sandbox, p.env),
		CLAUDE_CONFIG_DIR: run.configDir,
		PATH: `${path.join(run.sandbox, "bin")}:${p.env.PATH}`,
	};
	const refusal = launchAuthRefusal({ bin, env, cwd: repo, spawn: p.claude });
	if (refusal) return { ok: false, why: refusal };
	const launched = p.claude(
		bin,
		[
			"--bg",
			"--model",
			MODEL,
			"--effort",
			EFFORT,
			"--permission-mode",
			"auto",
			prompt,
		],
		{ cwd: repo, timeout: CALL_TIMEOUT_MS, env },
	);
	const job = /backgrounded\s+·\s+(\S+)/.exec(launched.stdout)?.[1];
	if (launched.status !== 0 || !job)
		return {
			ok: false,
			why: `launch failed (${launched.status}), check \`CLAUDE_CONFIG_DIR=${run.configDir} claude agents\` before relaunching: ${`${launched.stdout}${launched.stderr}`.trim()}`,
		};
	return {
		ok: true,
		record: {
			...run,
			repo,
			job,
			launchedAt: new Date(p.now()).toISOString(),
		},
	};
}

/**
 * @param {Ports} p
 * @param {string} configDir
 * @param {string} bin
 * @returns {JobStates}
 */
function readJobStates(p, configDir, bin) {
	const r = runClaude(["agents", "--json", "--all"], {
		env: buildSeatEnv(p.env, configDir),
		timeout: CALL_TIMEOUT_MS,
		bin,
		spawn: p.claude,
	});
	try {
		/** @type {(Job & { id: string })[]} */
		const rows = JSON.parse(r.stdout);
		return new Map(rows.map((j) => [j.id, j]));
	} catch {
		return null;
	}
}

module.exports = { CALL_TIMEOUT_MS, readJobStates, sandboxEnv, start };
