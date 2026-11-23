#!/usr/bin/env node

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
const { projectSlug } = require("./lib/project-slug.js");
const { JUDGE_ARGS } = require("./lib/gate-judge-mode.js");
const { launchAuthRefusal } = require("./lib/launch-auth.js");
const { scriptPath } = require("./lib/script-path.js");
const { buildSeatEnv } = require("./lib/seat-claude.js");
const { writeFd } = require("./lib/write-fd.js");

const FIXTURE = path.join(__dirname, "fixtures", "gate-judge-reply.json");
const LAUNCHER = path.join(__dirname, "claude-child.js");
const BODY =
	"Re-check the queue depth once 300 landings have been logged.\n\n**Gate basis:** the ticket asks for 300 landings.\n";
// #4964 guess
const WAIT_MS = 120_000;
const SYNTHETIC = {
	session_id: "5e551011-0000-4000-8000-000000000000",
	uuid: "0e5017ed-0000-4000-8000-000000000000",
};

/** @param {string} dir */
function readEntries(dir) {
	try {
		return fs.readdirSync(dir, { recursive: true }).map(String);
	} catch {
		return [];
	}
}

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

function recordObserved() {
	const seat = configDir();
	const env = buildSeatEnv(process.env, seat);
	const bin = claudeBin(env);
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gate-judge-record-"));
	try {
		const refusal = launchAuthRefusal({ bin, env, cwd, bg: false });
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
		const project = path.join(
			seat,
			"projects",
			projectSlug(fs.realpathSync(cwd)),
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
				recordedBy: `node ${scriptPath("record-gate-judge-reply.js")}`,
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
