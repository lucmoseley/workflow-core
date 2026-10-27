#!/usr/bin/env node
/*
 * claude-child.js — the one route by which a skill launches a child `claude -p`
 * session, each mode with its flags fixed here (workflow-core#2040).
 *
 *   node scripts/claude-child.js usage --config-dir <dir>
 *   node scripts/claude-child.js chrome --config-dir <dir> --pages <1-6> --prompt-file <f>
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
 *         other, `file_upload` barred (workflow-core#1080), 10 turns a page plus 5, the
 *         prompt on stdin, since `--allowedTools` takes a list and swallows
 *         a prompt after it; the JSON result on stdout.
 *
 * --config-dir must be one of this machine's own seats (lib/arbiter-store.js's
 * configDirs). There is no free-prompt mode and no way to pass another flag.
 *
 * The binary is WFC_CLAUDE_BIN, else `claude` on PATH. Joins no §N3 family:
 * it exits with the child's status, 2 on a usage error or refusal, and 1
 * where the child could not start or was killed.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const { caught } = require("./lib/caught.js");
const { parseOrExit } = require("./lib/cli-args.js");
const { configDirs } = require("./lib/arbiter-store.js");
const { realKey } = require("./lib/deref.js");
const { writeFd } = require("./lib/write-fd.js");

const USAGE = [
	"usage: node scripts/claude-child.js usage --config-dir <dir>",
	"       node scripts/claude-child.js chrome --config-dir <dir> --pages <1-6> --prompt-file <f>",
].join("\n");

/* All three carried from the skill text they replace, never measured: the 60 s
 * from rescue-sessions' `timeout 60`, the 6 pages and the turn budget from
 * browser-ladder (workflow-core#1070). */
const USAGE_TIMEOUT_MS = 60_000;
const MAX_PAGES = 6;
/** @param {number} pages */
const maxTurns = (pages) => 10 * pages + 5;

/**
 * @param {string} message
 * @param {1 | 2} code
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

function main() {
	const { command, flags } = parseOrExit(process.argv.slice(2), {
		usage: USAGE,
		flags: { "--config-dir": "value" },
		commands: {
			usage: { usage: USAGE },
			chrome: {
				usage: USAGE,
				flags: { "--pages": "value", "--prompt-file": "value" },
			},
		},
	});
	const seat = seatOrFail(flags["--config-dir"]);

	/** @type {string[]} */
	let args;
	/** @type {import("node:child_process").SpawnSyncOptions} */
	let opts;
	if (command === "usage") {
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
		};
	}

	const r = spawnSync(process.env.WFC_CLAUDE_BIN || "claude", args, {
		...opts,
		env: { ...process.env, CLAUDE_CONFIG_DIR: seat },
	});
	if (r.error)
		fail(
			`the child did not finish (${r.error.message})${command === "usage" ? `; read the cached bars instead: node scripts/allowance.js --config-dir ${seat}` : ""}.`,
			1,
		);
	if (r.signal) fail(`the child was killed by ${r.signal}.`, 1);
	process.exitCode = r.status ?? 1;
}

main();
