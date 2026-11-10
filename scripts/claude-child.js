#!/usr/bin/env node
/*
 * claude-child.js — the one route by which a skill launches a child `claude -p`
 * session, each mode with its flags fixed here (#2040).
 *
 *   node scripts/claude-child.js usage --config-dir <dir>
 *   node scripts/claude-child.js chrome --config-dir <dir> --pages <1-6> --prompt-file <f>
 *   node scripts/claude-child.js judge --config-dir <dir> --timeout-ms <n> < prompt
 *
 * A launch spelt out in a skill is judged afresh by the auto-mode classifier
 * each time; a fixed script is what a
 * narrow allow rule can name, run bare. Background sessions go through
 * scripts/dispatch-sessions.sh, not here.
 *
 * usage   `claude -p /usage --permission-mode manual` on that seat, the
 *         flag as dispatch-sessions.sh's own /usage call passes it, so the
 *         child can approve no tool: prints both bars and spends no model
 *         tokens. Killed after 60 s, as a wedged one hangs.
 * chrome  the browser-ladder skill's Chrome child: the Chrome tools and no
 *         other, `file_upload` barred (#1080), 10 turns a page plus 5, the
 *         prompt on stdin, since `--allowedTools` takes a list and swallows
 *         a prompt after it; the JSON result on stdout. Killed after
 *         lib/child-spawn.js's limit a page.
 * judge   the gate judge's one question of one issue body (#4964), for
 *         lib/gate-judge.js: lib/gate-judge-mode.js's flags, the prompt on
 *         stdin, an empty working directory; the JSON result on stdout. Killed once --timeout-ms have passed since this
 *         script started, the auth read included.
 *
 * --config-dir must be one of this machine's own seats (lib/arbiter-store.js's
 * configDirs). There is no free-prompt mode and no way to pass another flag.
 * A launch whose auth would not bill the subscription is refused
 * (lib/launch-auth.js).
 *
 * The binary is WFC_CLAUDE_BIN, else `claude` on PATH. Joins no §N3 family:
 * it exits with the child's status, 2 on a usage error or refusal, and 1
 * where the child could not start or was killed.
 */

const { spawnSync } = require("node:child_process");
const { scriptPath } = require("./lib/script-path.js");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { caught } = require("./lib/caught.js");
const { CHROME_TIMEOUT_MS_A_PAGE } = require("./lib/child-spawn.js");
const { claudeBin } = require("./lib/claude-bin.js");
const { parseOrExit } = require("./lib/cli-args.js");
const { configDirs } = require("./lib/arbiter-store.js");
const { JUDGE_ARGS, JUDGE_TIMEOUT_EXIT } = require("./lib/gate-judge-mode.js");
const { buildSeatEnv } = require("./lib/seat-claude.js");
const { realKey } = require("./lib/deref.js");
const { launchAuthRefusal } = require("./lib/launch-auth.js");
const { writeFd } = require("./lib/write-fd.js");

const USAGE = [
	`usage: node ${scriptPath("claude-child.js")} usage --config-dir <dir>`,
	`       node ${scriptPath("claude-child.js")} chrome --config-dir <dir> --pages <1-6> --prompt-file <f>`,
	`       node ${scriptPath("claude-child.js")} judge --config-dir <dir> --timeout-ms <n> < prompt`,
].join("\n");

/* All three carried from the skill text they replace, never measured: the 60 s
 * from rescue-sessions' `timeout 60`, the 6 pages and the turn budget from
 * browser-ladder (#1070). */
const USAGE_TIMEOUT_MS = 60_000;
const MAX_PAGES = 6;
/** @param {number} pages */
const maxTurns = (pages) => 10 * pages + 5;

/**
 * @param {string} message
 * @param {1 | 2 | typeof JUDGE_TIMEOUT_EXIT} code
 * @returns {never}
 */
function fail(message, code) {
	writeFd(2, `claude-child: ${message}\n`);
	process.exit(code);
}

/** @param {string | true | undefined} given */
function seatOrFail(given) {
	if (typeof given !== "string" || given === "")
		fail(`--config-dir is required.\n${USAGE}`, 2);
	const seats = configDirs();
	if (!seats.some((s) => realKey(s) === realKey(given)))
		fail(
			`--config-dir '${given}' is not one of this machine's seats: ${seats.join(", ")}.`,
			2,
		);
	return given;
}

/** @param {string | true | undefined} given */
function pagesOrFail(given) {
	const pages = Number(given);
	if (typeof given !== "string" || !/^\d+$/.test(given) || pages < 1)
		fail(`--pages is a whole number from 1 to ${MAX_PAGES}.`, 2);
	if (pages > MAX_PAGES)
		fail(
			`--pages is at most ${MAX_PAGES} a child; split the task over several children.`,
			2,
		);
	return pages;
}

/** @param {string | true | undefined} given */
function promptFdOrFail(given) {
	if (typeof given !== "string" || given === "")
		fail(`--prompt-file is required.\n${USAGE}`, 2);
	try {
		return fs.openSync(given, "r");
	} catch (e) {
		return fail(
			`could not read the prompt file ${given} (${caught(e).message}).`,
			2,
		);
	}
}

/**
 * The judge child's working directory: one per user, kept, since the harness
 * leaves an empty project directory in the seat for each directory a child
 * runs in. Emptied before each call, a CLAUDE.md for the child to load
 * included; refused where it is not this user's own directory.
 */
function emptyDirOrFail() {
	let dir = os.tmpdir();
	try {
		const { username, uid } = os.userInfo();
		dir = path.join(dir, `wfc-gate-judge-${username}`);
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const stat = fs.lstatSync(dir);
		if (!stat.isDirectory() || stat.uid !== uid)
			return fail(
				`the judge's working directory ${dir} is not this user's own directory.`,
				2,
			);
		for (const entry of fs.readdirSync(dir))
			fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
	} catch (e) {
		return fail(
			`the judge's working directory under ${dir} could not be made empty (${caught(e).message}).`,
			2,
		);
	}
	return dir;
}

/** @param {string | true | undefined} given */
function timeoutOrFail(given) {
	const ms = Number(given);
	if (typeof given !== "string" || !/^\d+$/.test(given) || ms < 1)
		fail("--timeout-ms is a whole number of milliseconds, 1 or more.", 2);
	return ms;
}

function main() {
	const startedAt = Date.now();
	const { command, flags } = parseOrExit(process.argv.slice(2), {
		usage: USAGE,
		flags: { "--config-dir": "value" },
		commands: {
			usage: { usage: USAGE },
			chrome: {
				usage: USAGE,
				flags: { "--pages": "value", "--prompt-file": "value" },
			},
			judge: { usage: USAGE, flags: { "--timeout-ms": "value" } },
		},
	});
	const seat = seatOrFail(flags["--config-dir"]);

	/** @type {string[]} */
	let args;
	/** @type {import("node:child_process").SpawnSyncOptions} */
	let opts;
	/** @type {number | undefined} */
	let boundMs;
	if (command === "judge") {
		boundMs = timeoutOrFail(flags["--timeout-ms"]);
		args = JUDGE_ARGS;
		opts = { stdio: "inherit", cwd: emptyDirOrFail(), killSignal: "SIGKILL" };
	} else if (command === "usage") {
		args = ["-p", "/usage", "--permission-mode", "manual"];
		opts = {
			stdio: ["ignore", "inherit", "inherit"],
			timeout: USAGE_TIMEOUT_MS,
		};
	} else {
		const pages = pagesOrFail(flags["--pages"]);
		args = [
			"-p",
			"--chrome",
			"--tools",
			"",
			"--allowedTools",
			"mcp__claude-in-chrome__*",
			"--disallowedTools",
			"mcp__claude-in-chrome__file_upload",
			"--max-turns",
			String(maxTurns(pages)),
			"--output-format",
			"json",
		];
		opts = {
			stdio: [promptFdOrFail(flags["--prompt-file"]), "inherit", "inherit"],
			timeout: CHROME_TIMEOUT_MS_A_PAGE * pages,
		};
	}

	const env = buildSeatEnv(process.env, seat);
	const bin = claudeBin(env);
	const cached =
		command === "usage"
			? ` Read the cached bars instead: node ${scriptPath("allowance.js")} --config-dir ${seat}`
			: "";
	const refusal = launchAuthRefusal({
		bin,
		env,
		cwd: typeof opts.cwd === "string" ? opts.cwd : process.cwd(),
	});
	if (refusal) fail(`${refusal}${cached}`, 2);
	if (boundMs !== undefined)
		opts.timeout = Math.max(1, boundMs - (Date.now() - startedAt));
	const r = spawnSync(bin, args, { ...opts, env });
	if (
		boundMs !== undefined &&
		r.error &&
		"code" in r.error &&
		r.error.code === "ETIMEDOUT"
	)
		fail(
			`the child was killed at its ${boundMs} ms bound.`,
			JUDGE_TIMEOUT_EXIT,
		);
	if (r.error)
		fail(`the child did not finish (${r.error.message}).${cached}`, 1);
	if (r.signal) fail(`the child was killed by ${r.signal}.`, 1);
	process.exitCode = r.status ?? 1;
}

main();
