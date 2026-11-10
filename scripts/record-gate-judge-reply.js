#!/usr/bin/env node
/*
 * record-gate-judge-reply.js — re-records scripts/fixtures/gate-judge-reply.json,
 * the installed harness's side of the gate judge's launch (#4964): the
 * `result` row claude-child.js's `judge` mode prints, which lib/gate-judge.js
 * reads and lib/gate-judge-fake.ts serves to the suites, and what a second
 * call under the same flags was seen to load and leave behind — its tools,
 * MCP servers, slash commands, plugins, hook events and transcripts.
 *
 *   node scripts/record-gate-judge-reply.js
 *
 * Both calls go on this session's own seat and spend one short Haiku turn
 * each. Run it by hand after a harness upgrade, then `npm run test --
 * scripts/lib/gate-judge.contract.test.ts`.
 *
 * In no family (§N3): it writes a fixture, but spends turns to do it, so it
 * is no `generate-*` a gate may run. No suite runs it: the contract holds what
 * it writes.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { caught } = require("./lib/caught.js");
const { claudeBin } = require("./lib/claude-bin.js");
const { configDir } = require("./lib/config-dir.js");
const { buildPrompt } = require("./lib/gate-judge.js");
const { parseJsonl } = require("./lib/jsonl.js");
const { JUDGE_ARGS } = require("./lib/gate-judge-mode.js");
const { launchAuthRefusal } = require("./lib/launch-auth.js");
const { scriptPath } = require("./lib/script-path.js");
const { buildSeatEnv } = require("./lib/seat-claude.js");
const { writeFd } = require("./lib/write-fd.js");

const FIXTURE = path.join(__dirname, "fixtures", "gate-judge-reply.json");
const LAUNCHER = path.join(__dirname, "claude-child.js");
/* Written for the recording: a wait on data and a basis that restates it. */
const BODY =
	"Re-check the queue depth once 300 landings have been logged.\n\n**Gate basis:** the ticket asks for 300 landings.\n";
/* A guess: one short Haiku turn has taken 5 to 8 s. */
const WAIT_MS = 120_000;
/* What the fixture carries in place of the run's own ids. */
const SYNTHETIC = {
	session_id: "5e551011-0000-4000-8000-000000000000",
	uuid: "0e5017ed-0000-4000-8000-000000000000",
};

/**
 * The files in `dir`, none where it does not exist.
 * @param {string} dir
 */
function readEntries(dir) {
	try {
		return fs.readdirSync(dir, { recursive: true }).map(String);
	} catch {
		return [];
	}
}

/** The `result` row of one call in the judge mode. */
function recordResult() {
	const r = spawnSync(
		process.execPath,
		[
			LAUNCHER,
			"judge",
			"--config-dir",
			configDir(),
			"--timeout-ms",
			String(WAIT_MS),
		],
		{ input: buildPrompt(BODY), encoding: "utf8" },
	);
	if (r.status !== 0)
		throw new Error(`the judge mode exited ${r.status}: ${r.stderr}`);
	const { credential_expires_at: _expiry, ...row } = JSON.parse(r.stdout);
	return { ...row, ...SYNTHETIC };
}

/**
 * What a call under the judge mode's flags loads and leaves, read off its
 * event stream and the seat's transcript store.
 */
function recordObserved() {
	const seat = configDir();
	const env = buildSeatEnv(process.env, seat);
	const bin = claudeBin(env);
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gate-judge-record-"));
	try {
		const refusal = launchAuthRefusal({ bin, env, cwd });
		if (refusal) throw new Error(`REFUSED: ${refusal}`);
		const args = JUDGE_ARGS.map((a) => (a === "json" ? "stream-json" : a));
		const r = spawnSync(bin, [...args, "--verbose", "--include-hook-events"], {
			input: buildPrompt(BODY),
			encoding: "utf8",
			env,
			cwd,
			timeout: WAIT_MS,
		});
		if (r.status !== 0)
			throw new Error(`the observed call exited ${r.status}: ${r.stderr}`);
		/* The harness leaves the directory's project folder, holding an empty
		 * `memory`. */
		const project = path.join(
			seat,
			"projects",
			fs.realpathSync(cwd).replace(/[^a-zA-Z0-9]/g, "-"),
		);
		const left = readEntries(project);
		if (left.every((f) => f === "memory"))
			fs.rmSync(project, { recursive: true, force: true });
		const { rows } = parseJsonl(r.stdout);
		const init =
			/** @type {{tools: string[], mcp_servers: unknown[], slash_commands: unknown[], plugins: {name: string, path: string}[]}|undefined} */ (
				/** @type {unknown} */ (rows.find((row) => row.subtype === "init"))
			);
		if (!init) throw new Error("the observed call printed no init row");
		return {
			tools: init.tools,
			mcpServers: init.mcp_servers.length,
			slashCommands: init.slash_commands.length,
			/* A builtin plugin ships in the binary and carries no hook. */
			plugins: init.plugins
				.filter((p) => p.path !== "builtin")
				.map((p) => p.name),
			hookEvents: rows.filter((row) => String(row.subtype).startsWith("hook"))
				.length,
			transcripts: left.filter((f) => f.endsWith(".jsonl")).length,
		};
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

const USAGE = `usage: node ${scriptPath("record-gate-judge-reply.js")}\n`;

function main() {
	try {
		parseArgs({ options: {} });
	} catch {
		writeFd(2, USAGE);
		process.exit(2);
	}
	const version = spawnSync(claudeBin(), ["--version"], { encoding: "utf8" });
	if (version.status !== 0)
		throw new Error(`${claudeBin()} --version did not run.`);
	const harness = version.stdout.trim();
	const result = recordResult();
	const observed = recordObserved();
	fs.writeFileSync(
		FIXTURE,
		`${JSON.stringify(
			{
				recordedBy: "node scripts/record-gate-judge-reply.js",
				harness,
				body: BODY,
				result,
				observed,
			},
			null,
			"\t",
		)}\n`,
	);
	writeFd(1, `recorded ${FIXTURE}\n`);
}

try {
	main();
} catch (e) {
	writeFd(2, `${caught(e).message}\n`);
	process.exit(1);
}
