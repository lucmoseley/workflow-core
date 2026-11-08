#!/usr/bin/env node
/*
 * list-sessions.js — every plan's sessions on this machine, read-only (#4224).
 * `claude agents --json` lists only its own CLAUDE_CONFIG_DIR's, which hid a
 * session on another plan from #4200's diagnosis.
 *
 *   node scripts/list-sessions.js [--json]
 *
 * One row per session: its config dir, name (else id), state and kind. Each
 * `sessionDirs()` dir that exists is read alone (lib/agent-liveness.js,
 * `readEverySeat`), then the live headless runs, each under the seat it runs
 * on. A dir or store that will not read is printed with its reason, and the
 * exit is 1; every other dir still prints.
 *
 * A session moved between seats shows under each dir that lists it, its state
 * telling which is current.
 *
 * `--json` prints `{rows, failures}`: each row `{configDir, sessionId, id,
 * name, state, kind, cwd}`, each failure `{configDir, why}`, `configDir`
 * null for the headless-run store.
 *
 * Joins no §N3 family: it gates nothing and is no hook. No core either: it
 * decides nothing but which stream a line goes to and the exit, which the
 * suite pins through the program itself.
 */

const { readEverySeat } = require("./lib/agent-liveness.js");
const { parseOrExit } = require("./lib/cli-args.js");

/**
 * @typedef {import("./lib/agent-liveness.js").AgentRecord} AgentRecord
 * @typedef {{configDir: string|null, sessionId: string, id: string|null,
 *   name: string|null, state: string|null, kind: string|null,
 *   cwd: string|null}} Row
 */

/**
 * @param {string|null} configDir
 * @param {AgentRecord} a
 * @returns {Row}
 */
const buildRow = (configDir, a) => ({
	configDir,
	sessionId: a.sessionId,
	id: a.id ?? null,
	name: a.name ?? null,
	state: a.state ?? null,
	kind: a.kind ?? null,
	cwd: a.cwd ?? null,
});

/**
 * Every plan's listing as rows and failures, each tagged with its config dir.
 * @returns {{rows: Row[], failures: {configDir: string|null, why: string}[]}}
 */
function readRows() {
	const { dirs, headless } = readEverySeat();
	/** @type {Row[]} */
	const rows = [];
	/** @type {{configDir: string|null, why: string}[]} */
	const failures = [];
	for (const d of dirs) {
		if (d.agents) for (const a of d.agents) rows.push(buildRow(d.dir, a));
		else failures.push({ configDir: d.dir, why: d.why });
	}
	if (headless.agents)
		for (const a of headless.agents) rows.push(buildRow(a.seat ?? null, a));
	else failures.push({ configDir: null, why: headless.why });
	return { rows, failures };
}

function main() {
	const { flags } = parseOrExit(process.argv.slice(2), {
		usage: "usage: node scripts/list-sessions.js [--json]",
		flags: { "--json": "boolean" },
	});
	const { rows, failures } = readRows();
	if (flags["--json"]) {
		process.stdout.write(`${JSON.stringify({ rows, failures }, null, 2)}\n`);
	} else {
		for (const r of rows) {
			const who = r.name ?? r.id ?? r.sessionId;
			const cells = [r.configDir ?? "(no config dir)", who, r.state, r.kind];
			process.stdout.write(`${cells.map((c) => c ?? "-").join("\t")}\n`);
		}
		for (const f of failures) {
			const where = f.configDir ?? "the headless-run store";
			process.stderr.write(`✗ ${where}: ${f.why}\n`);
		}
		if (failures.length > 0) {
			process.stderr.write(
				"Its sessions are unlisted, not absent. Read it alone with `CLAUDE_CONFIG_DIR=<dir> claude agents --json`, or the store with `ls <refill dir>/.headless-runs`.\n",
			);
		}
	}
	process.exitCode = failures.length > 0 ? 1 : 0;
}

main();
