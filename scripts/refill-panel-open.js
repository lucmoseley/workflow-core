#!/usr/bin/env node

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { pidAlive } = require("./lib/arbiter-proc.js");
const { ignoreFailure } = require("./lib/caught.js");
const { parseOrCode } = require("./lib/cli-args");
const { buildRoutes } = require("./lib/refill-panel-routes.js");
const {
	readViewColumns: readProcColumns,
	readViewEnv: readProcEnv,
} = require("./lib/refill-panel-view-env.js");
const { scriptPath } = require("./lib/script-path.js");
const { shellQuote } = require("./lib/sh-quote.js");
const { sleepSync } = require("./lib/sleep-sync.js");
const { readConfig } = require("./lib/workflow-core-config.js");
const { noop } = require("./lib/noop.js");
const { writeFd } = require("./lib/write-fd.js");

// guess: time to read the reason before the view covers it, #4066
const PRINTED_HOLD_MS = 5000;

const USAGE = `usage: node ${scriptPath("refill-panel-open.js")} [--if-enabled] <agents-view-pid>

Opens the refill-loop panel beside that agents view, by a Windows Terminal split, a
tmux split, or printing the command to run.

  --if-enabled  open nothing unless this checkout's .claude/workflow-core.json sets refillPanel;
                run the routes detached, a failure going to the refill loop's log, and where
                none exists, say why and hold it on screen for ${PRINTED_HOLD_MS / 1000} seconds
`;

const PANEL_PROGRAM = path.join(__dirname, "refill-panel.js");
// guess, #3886
const ROUTE_TIMEOUT_MS = 10_000;

/** @typedef {{ name: string, file: string, args: string[] }} Route */

/**
 * @param {string | undefined} searchPath
 * @param {string} name
 */
const isOnSearchPath = (searchPath, name) =>
	(searchPath ?? "")
		.split(path.delimiter)
		.some((dir) => dir !== "" && fs.existsSync(path.join(dir, name)));

/**
 * @param {{ file: string, args: string[] }} route
 * @param {Record<string, string | undefined>} env
 * @returns {string | null}
 */
function runRoute({ file, args }, env) {
	const ran = spawnSync(file, args, {
		env,
		stdio: "ignore",
		timeout: ROUTE_TIMEOUT_MS,
	});
	if (ran.error) return ran.error.message;
	return ran.status === 0 ? null : `exit ${ran.status}`;
}

/** @param {string} line */
function appendToLoopLog(line) {
	const { appendLoopLog } = require("./lib/refill-files.js");
	ignoreFailure(() => appendLoopLog(line));
}

/**
 * @param {Route[]} routes
 * @param {number} pid
 * @param {Record<string, string | undefined>} env
 * @returns {boolean}
 */
function detachRoutes(routes, pid, env) {
	const child = spawn(
		process.execPath,
		[__filename, "--run-routes", JSON.stringify(routes), String(pid)],
		{ detached: true, stdio: "ignore", env },
	);
	child.on("error", noop);
	child.unref();
	return child.pid !== undefined;
}

/**
 * @param {Route[]} routes
 * @param {Record<string, string | undefined>} env
 * @param {NonNullable<Deps["run"]>} run
 * @param {(text: string) => void} err
 * @returns {boolean}
 */
function openByFirstRoute(routes, env, run, err) {
	for (const route of routes) {
		const why = run(route, env);
		if (why === null) return true;
		err(`refill-panel-open: the ${route.name} route failed: ${why}\n`);
	}
	return false;
}

/**
 * @typedef {{ run?: (route: Route, env: Record<string, string | undefined>) => string | null, detach?: typeof detachRoutes, appendLog?: (text: string) => void, isOnPath?: (name: string) => boolean, isAlive?: (pid: number) => boolean, readViewEnv?: typeof readProcEnv, readViewColumns?: typeof readProcColumns, root?: string, out?: (text: string) => void, err?: (text: string) => void, wait?: (ms: number) => void }} Deps
 */

/**
 * @param {string[]} [argv]
 * @param {Record<string, string | undefined>} [ownEnv]
 * @param {Deps} [deps]
 */
function main(argv = process.argv.slice(2), ownEnv = process.env, deps = {}) {
	const {
		run = runRoute,
		detach = detachRoutes,
		appendLog = appendToLoopLog,
		readViewEnv = readProcEnv,
		readViewColumns = readProcColumns,
		isOnPath,
		isAlive = pidAlive,
		root,
		out = (text) => writeFd(1, text),
		err = (text) => writeFd(2, text),
		wait = sleepSync,
	} = deps;
	const parsed = parseOrCode(argv, {
		usage: USAGE,
		flags: { "--if-enabled": "boolean", "--run-routes": "value" },
		min: 1,
	});
	if (typeof parsed === "number") return parsed;
	const viewStart = parsed.flags["--if-enabled"];
	if (viewStart && !readConfig({ root }).refillPanel) return 0;
	const [given = ""] = parsed.positionals;
	if (!/^[1-9]\d*$/.test(given)) {
		err(`refill-panel-open: not a pid: ${given}\n${USAGE}`);
		return 2;
	}
	const pid = Number(given);
	if (!isAlive(pid)) return 0;
	const node = process.execPath;
	const printed = `${shellQuote(node)} ${shellQuote(PANEL_PROGRAM)} ${pid}\n`;
	const routesJson = parsed.flags["--run-routes"];
	if (typeof routesJson === "string") {
		/** @param {string} text */
		const logLine = (text) => appendLog(text.trimEnd());
		if (!openByFirstRoute(JSON.parse(routesJson), ownEnv, run, logLine))
			logLine(`refill-panel-open: no refill panel opened; run: ${printed}`);
		return 0;
	}
	const env = { ...ownEnv, ...readViewEnv(pid) };
	const viewColumns = readViewColumns(pid);
	if (viewColumns === null)
		err(
			"refill-panel-open: the view's width did not read: sizing the split for a usual window\n",
		);
	const routes = buildRoutes({
		env,
		isOnPath: isOnPath ?? ((name) => isOnSearchPath(env.PATH, name)),
		node,
		panel: PANEL_PROGRAM,
		pid,
		viewColumns,
	});
	if (viewStart && routes.length > 0 && detach(routes, pid, env)) return 0;
	if (openByFirstRoute(routes, env, run, err)) return 0;
	if (viewStart)
		err(
			"refill-panel-open: no refill panel opened: it needs Windows Terminal under WSL (cmd.exe and wt.exe on PATH), or tmux. From another terminal:\n",
		);
	out(printed);
	if (viewStart) wait(PRINTED_HOLD_MS);
	return 0;
}

module.exports = { main };

if (require.main === module) process.exitCode = main();
