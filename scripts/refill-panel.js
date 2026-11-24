#!/usr/bin/env node

const { execFile } = require("node:child_process");
const path = require("node:path");
const { pidAlive } = require("./lib/arbiter-proc.js");
const { flagValue, parseOrCode } = require("./lib/cli-args");
const { buildFocusReturn } = require("./lib/refill-panel-routes.js");
const {
	buildScreensText,
	findPanelSizes,
} = require("./lib/refill-panel-print.js");
const { openPanel } = require("./lib/refill-panel-terminal.js");
const { resolveTopic } = require("./lib/refill-panel-topic.js");
const { readViewEnv } = require("./lib/refill-panel-view-env.js");
const { withPanelSource } = require("./lib/refill-commands.js");
const { scriptPath } = require("./lib/script-path.js");
const { writeFd } = require("./lib/write-fd.js");
const { FETCH_TIMEOUT_MS } = require("./lib/pinned-code.js");

const USAGE = `usage: node ${scriptPath("refill-panel.js")} <agents-view-pid> [windows-terminal|tmux]
       node ${scriptPath("refill-panel.js")} --print [--columns <n> [--rows <n>]]

Shows the refill loop, away mode, burn mode, the goal and the repos it can serve, and changes each on a click, a goal by typing it, until that pid exits.

  --print           print the screen a pane shows, from one status read: at --columns, or at each running panel's size
  --columns <n>     the pane's width
  --rows <n>        the pane's height; every row where it is not given
`;

const LOOP_PROGRAM = path.join(__dirname, "refill-loop.js");
const BURN_PROGRAM = path.join(__dirname, "burn-mode.sh");
// guess: past the control lock's 10 s wait, workflow-core#3861
const READ_TIMEOUT_MS = 30_000;
// workflow-core#3861
const PRESS_TIMEOUT_MS = READ_TIMEOUT_MS + FETCH_TIMEOUT_MS;
// guess: need only outlast a slow cmd.exe, workflow-core#3887
const FOCUS_TIMEOUT_MS = 10_000;
const FOCUS_NOT_MOVED = { code: 0, stdout: "", stderr: "" };

/**
 * @param {string} file
 * @param {string[]} argv
 * @param {number} timeout
 * @param {NodeJS.ProcessEnv} env
 * @returns {ReturnType<import("./lib/refill-panel.js").Runner>}
 */
const runCommand = (file, argv, timeout, env) =>
	new Promise((resolve) => {
		execFile(file, argv, { timeout, env }, (err, stdout, stderr) => {
			if (!err) {
				resolve({ code: 0, stdout, stderr });
				return;
			}
			const code = typeof err.code === "number" ? err.code : 1;
			resolve({ code, stdout, stderr: stderr || err.message });
		});
	});

/**
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 */
const runLoop = (args, env) =>
	runCommand(
		process.execPath,
		[LOOP_PROGRAM, ...args],
		args[0] === "status" ? READ_TIMEOUT_MS : PRESS_TIMEOUT_MS,
		withPanelSource(env),
	);

/** @param {unknown} err */
const reportCrash = (err) =>
	writeFd(
		2,
		`refill-panel: ${err instanceof Error ? (err.stack ?? err.message) : err}\n`,
	);

/** @param {string} given */
const isCount = (given) => /^[1-9]\d*$/.test(given);

/**
 * @param {{columns: number, rows: number|null, pid?: number, tty?: string}[]} sizes
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<number>}
 */
async function printScreens(sizes, env) {
	const { text, readError } = await buildScreensText(sizes, {
		run: (args) => runLoop(args, env),
		runBurn: (args) => runCommand(BURN_PROGRAM, args, READ_TIMEOUT_MS, env),
		now: Date.now,
	});
	writeFd(1, text);
	return readError ? 1 : 0;
}

/**
 * @param {Record<string, string | true>} flags
 * @param {NodeJS.ProcessEnv} env
 * @returns {number|Promise<number>}
 */
function print(flags, env) {
	const given = {
		columns: flagValue(flags, "--columns"),
		rows: flagValue(flags, "--rows"),
	};
	for (const [name, value] of Object.entries(given))
		if (value !== undefined && !isCount(value)) {
			writeFd(2, `refill-panel: --${name} is not a count: ${value}\n${USAGE}`);
			return 2;
		}
	if (given.columns !== undefined)
		return printScreens(
			[
				{
					columns: Number(given.columns),
					rows: given.rows ? Number(given.rows) : null,
				},
			],
			env,
		);
	if (given.rows !== undefined) {
		writeFd(2, `refill-panel: --rows needs --columns\n${USAGE}`);
		return 2;
	}
	const { sizes, unsized } = findPanelSizes();
	for (const { pid, why } of unsized)
		writeFd(
			2,
			`refill-panel: panel ${pid} left out, its terminal unread: ${why}\n`,
		);
	if (sizes.length === 0) {
		writeFd(
			2,
			`refill-panel: ${unsized.length > 0 ? "no running panel's size reads" : "no panel is running"} to size the print by: give --columns\n`,
		);
		return 1;
	}
	return printScreens(sizes, env);
}

/** @param {string[]} [argv] */
function main(argv = process.argv.slice(2)) {
	const parsed = parseOrCode(argv, {
		usage: USAGE,
		flags: { "--print": "boolean", "--columns": "value", "--rows": "value" },
		min: 0,
		max: 2,
	});
	if (typeof parsed === "number") return parsed;
	if (parsed.flags["--print"]) {
		if (parsed.positionals.length > 0) {
			writeFd(2, `refill-panel: --print takes no pid\n${USAGE}`);
			return 2;
		}
		return print(parsed.flags, process.env);
	}
	if (parsed.flags["--columns"] || parsed.flags["--rows"]) {
		writeFd(2, `refill-panel: --columns and --rows go with --print\n${USAGE}`);
		return 2;
	}
	if (parsed.positionals.length === 0) {
		writeFd(2, `refill-panel: needs a pid\n${USAGE}`);
		return 2;
	}
	const [given = "", route] = parsed.positionals;
	if (!isCount(given)) {
		writeFd(2, `refill-panel: not a pid: ${given}\n${USAGE}`);
		return 2;
	}
	const env = { ...process.env, ...readViewEnv(Number(given)) };
	const focusReturn = buildFocusReturn(route, env, process.env);
	if (route !== undefined && !focusReturn) {
		writeFd(2, `refill-panel: not a route: ${route}\n${USAGE}`);
		return 2;
	}
	const pid = Number(given);
	if (!pidAlive(pid)) return 0;
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		writeFd(2, "refill-panel: needs a terminal\n");
		return 1;
	}
	openPanel({
		pid,
		stdin: process.stdin,
		stdout: process.stdout,
		proc: process,
		run: (args) => runLoop(args, env),
		runBurn: (args) => runCommand(BURN_PROGRAM, args, READ_TIMEOUT_MS, env),
		resolveTopic: (text, repos, signal) =>
			resolveTopic(text, repos, { env, signal }),
		returnFocus: focusReturn
			? () =>
					runCommand(
						focusReturn.file,
						focusReturn.args,
						FOCUS_TIMEOUT_MS,
						focusReturn.env,
					)
			: async () => FOCUS_NOT_MOVED,
		isAlive: pidAlive,
		now: Date.now,
		reportCrash,
	});
	return null;
}

module.exports = { main };

if (require.main === module) {
	const code = main();
	if (code instanceof Promise)
		code.then(
			(printed) => {
				process.exitCode = printed;
			},
			(err) => {
				reportCrash(err);
				process.exitCode = 1;
			},
		);
	else if (code !== null) process.exitCode = code;
}
