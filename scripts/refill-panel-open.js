#!/usr/bin/env node
/*
 * refill-panel-open.js — opens the refill-loop panel beside an agents view (#3886,
 * spec #3596), by the first route that works: a Windows
 * Terminal split, a tmux split, or printing the command.
 *
 *   node scripts/refill-panel-open.js [--if-enabled] <agents-view-pid>
 *
 * An agents alias calls it with --if-enabled and its own pid just before `exec claude
 * agents`, which keeps that pid: bash's `$BASHPID` is the only way to hand it over,
 * and no mod hook can see a view (#3886). Find the pid of an open view for a by-hand
 * run with `pgrep -a claude`; a Windows Terminal split then lands beside the active
 * pane, which wt.exe gives no way to name.
 *
 * Joins no §N3 family: it gates nothing and is no hook.
 *
 * The alias's `exec` draws over a printed command, so under --if-enabled it says why
 * no panel opened and holds that on screen first (#4066). Keys typed in the hold stay
 * unread, for the view. Residual: every view start on a terminal with no route pays
 * the hold, and turning the key off is the only way out of it.
 *
 * Exit codes: 0 once a route opened it or it printed the command, or where the key
 * is off or the pid is gone; 2 on a command line it refuses.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { pidAlive } = require("./lib/arbiter-proc.js");
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
const { writeFd } = require("./lib/write-fd.js");

/* Untraced, a first guess: time to read the reason before the view covers it. */
const PRINTED_HOLD_MS = 5000;

const USAGE = `usage: node ${scriptPath("refill-panel-open.js")} [--if-enabled] <agents-view-pid>

Opens the refill-loop panel beside that agents view, by a Windows Terminal split, a
tmux split, or printing the command to run.

  --if-enabled  open nothing unless this checkout's .claude/workflow-core.json sets refillPanel;
                where only printing is left, say why and hold it on screen for ${PRINTED_HOLD_MS / 1000} seconds
`;

const PANEL_PROGRAM = path.join(__dirname, "refill-panel.js");
/* Untraced, a first guess: the view waits on this call. */
const ROUTE_TIMEOUT_MS = 10_000;

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
 * @param {Record<string, string | undefined>} env the view's, whose `TMUX` names the tmux server
 * @returns {string | null} why it failed, null where it ran and exited 0
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

/**
 * @param {string[]} [argv]
 * @param {Record<string, string | undefined>} [ownEnv]
 * @param {{ run?: (route: { name: string, file: string, args: string[] }, env: Record<string, string | undefined>) => string | null, isOnPath?: (name: string) => boolean, isAlive?: (pid: number) => boolean, readViewEnv?: typeof readProcEnv, readViewColumns?: typeof readProcColumns, root?: string, out?: (text: string) => void, err?: (text: string) => void, wait?: (ms: number) => void }} [deps]
 */
function main(argv = process.argv.slice(2), ownEnv = process.env, deps = {}) {
	const {
		run = runRoute,
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
		flags: { "--if-enabled": "boolean" },
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
	const env = { ...ownEnv, ...readViewEnv(pid) };
	const node = process.execPath;
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
	for (const route of routes) {
		const why = run(route, env);
		if (why === null) return 0;
		err(`refill-panel-open: the ${route.name} route failed: ${why}\n`);
	}
	if (viewStart)
		err(
			"refill-panel-open: no refill panel opened: it needs Windows Terminal under WSL (cmd.exe and wt.exe on PATH), or tmux. From another terminal:\n",
		);
	out(`${shellQuote(node)} ${shellQuote(PANEL_PROGRAM)} ${pid}\n`);
	if (viewStart) wait(PRINTED_HOLD_MS);
	return 0;
}

module.exports = { main };

if (require.main === module) process.exitCode = main();
