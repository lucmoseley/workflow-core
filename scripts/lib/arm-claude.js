/*
 * arm-claude.js — the `claude` calls of scripts/run-arm-test.js's core,
 * lib/run-arm.js (#2045, #5149): a run's `--bg` launch in its arm's config
 * dir, and one config dir's job listing. Each goes through the core's
 * `claude` port, and reads the time from its `now`, touching nothing else,
 * so lib/arm-claude.contract.test.ts holds the runner's in-process fake to
 * the production adapter through these same calls.
 */

const path = require("node:path");
const { launchAuthRefusal } = require("./launch-auth.js");
const { buildSeatEnv, runClaude } = require("./seat-claude.js");
const { throttleEnv } = require("./throttle-paths.js");

/** @typedef {import("./run-arm.js").Ports} Ports */
/** @typedef {import("./run-arm.js").Run} Run */
/** @typedef {import("./run-arm.js").LaunchRecord} LaunchRecord */
/** @typedef {import("./run-arm.js").JobStates} JobStates */
/** @typedef {import("./run-arm.js").Job} Job */

/**
 * `docs/effort-guide.md`'s standing default, named on the launch so both arms
 * run it whatever each config dir's settings say.
 */
const MODEL = "claude-opus-5-5[1m]";
const EFFORT = "medium";
/** Hang guards, not measurements: each call returns in seconds when well. */
const CALL_TIMEOUT_MS = 120_000;

/**
 * The throttling paths are pinned because an arm's revision may predate #2098,
 * where the sweep's state still defaults per repo root and each sandbox would
 * kick a full transcript sweep of its own.
 *
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
 * Start one prepared run as a `claude --bg` job in its arm's config dir.
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
 * Each job's record from `claude agents --json --all` in one config dir,
 * keyed by the job id `--bg` printed. A `--bg` launch ignores `--session-id`
 * (#2045), so the listing is the one map from job to
 * transcript.
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
		// An unreadable listing is reported per run as `state unknown` (#2045).
		return null;
	}
}

module.exports = { CALL_TIMEOUT_MS, readJobStates, sandboxEnv, start };
