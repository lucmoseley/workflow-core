#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const { scriptPath } = require("./lib/script-path.js");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { caught } = require("./lib/caught.js");
const { claudeBin } = require("./lib/claude-bin.js");
const {
	HIDDEN_FLAGS,
	LIVE_CALL_TIMEOUT_MS,
	parseHelpOptions,
	parseMissingValueRefusal,
} = require("./lib/headless-options.js");
const { INTERRUPT_WAIT_MS } = require("./lib/chrome-close.js");
const { STREAM_ARGS, startStreamChild } = require("./lib/chrome-stream.js");
const { readJsonl } = require("./lib/jsonl.js");
const { configDir } = require("./lib/config-dir.js");
const { launchAuthRefusal } = require("./lib/launch-auth.js");
const { buildSeatEnv } = require("./lib/seat-claude.js");
const { overflowSeatsOf, readDeclaredSeats } = require("./lib/refill-seats.js");
const { writeFd } = require("./lib/write-fd.js");

const FIXTURE = path.join(__dirname, "fixtures", "headless-run.json");
const PROMPT = "Reply with the single word ok. Use no tools.";
// #4586 guess
const WAIT_MS = 180_000;
// #4586 measured $0.04 a short turn
const BUDGET_USD = 1;
const SYNTHETIC = {
	session_id: "5e551011-0000-4000-8000-000000000000",
	uuid: "0e5017ed-0000-4000-8000-000000000000",
	credential_expires_at: "2000-01-01T00:00:00.000Z",
};
const SYNTHETIC_REQUEST_ID = "1e7e5e47-0000-4000-8000-000000000000";
const LONG_PROMPT =
	"Write a 1500-word essay on the history of the lighthouse. Use no tools.";
// #4586 guess
const INTERRUPT_AT_MS = 5000;

/** @param {string|undefined} key */
function readOverflowKey(key) {
	const list = readDeclaredSeats();
	if (list.errors.length > 0) throw new Error(list.errors.join("\n"));
	const seat = overflowSeatsOf(list.seats).find(
		(s) => key === undefined || s.keyVar === key,
	);
	if (!seat)
		throw new Error(
			key ? `${key} is no overflow seat's key` : "no overflow seat declared",
		);
	return seat.keyVar;
}

function readOptions() {
	const help = spawnSync(claudeBin(), ["--help"], {
		encoding: "utf8",
		timeout: LIVE_CALL_TIMEOUT_MS,
	});
	if (help.status !== 0)
		throw new Error(`claude --help exited ${help.status}: ${help.stderr}`);
	return parseHelpOptions(help.stdout);
}

function readHiddenOptions() {
	return HIDDEN_FLAGS.map((flag) => {
		const refused = spawnSync(claudeBin(), ["-p", flag], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: LIVE_CALL_TIMEOUT_MS,
		});
		const option = parseMissingValueRefusal(refused.stderr ?? "");
		if (!option)
			throw new Error(
				`claude -p ${flag} did not refuse a missing value: ${refused.stderr}`,
			);
		return option;
	});
}

/** @param {string} keyVar */
async function recordResult(keyVar) {
	const store = fs.mkdtempSync(path.join(os.tmpdir(), "headless-record-"));
	process.env.WFC_REFILL_DIR = store;
	// #4586
	const { launch } = require("./lib/headless-sessions.js");
	const { readEndResult, stop } = require("./lib/headless-runs.js");
	const cwd = path.join(store, "cwd");
	fs.mkdirSync(cwd);
	const launched = launch({
		keyVar,
		cwd,
		budgetUsd: BUDGET_USD,
		prompt: PROMPT,
		name: "a-recorded-headless-run",
	});
	if ("why" in launched) throw new Error(`REFUSED: ${launched.why}`);
	const { record } = launched;
	try {
		for (const end = Date.now() + WAIT_MS; Date.now() < end; ) {
			const { outcome } = readEndResult(record);
			if (outcome === "success") break;
			if (outcome !== "running")
				throw new Error(
					`the run ended ${outcome}: ${fs.readFileSync(record.stderr, "utf8")}`,
				);
			await new Promise((r) => setTimeout(r, 1000));
		}
		const row = (readJsonl(record.log)?.rows ?? []).findLast(
			(r) => r.type === "result",
		);
		if (!row) throw new Error(`no result row in ${WAIT_MS / 1000} s`);
		return synthesise(row);
	} finally {
		await stop(record.jobId, { graceMs: 0 });
		fs.rmSync(store, { recursive: true, force: true });
	}
}

/** @param {Record<string, unknown>} row */
function synthesise(row) {
	const out = { ...row };
	for (const [field, value] of Object.entries(SYNTHETIC))
		if (field in out) out[field] = value;
	if (out.response && typeof out.response === "object")
		out.response = { ...out.response, request_id: SYNTHETIC_REQUEST_ID };
	return out;
}

async function recordInterrupt() {
	const env = buildSeatEnv(process.env, configDir());
	const bin = claudeBin(env);
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "headless-record-"));
	/** @type {ReturnType<typeof startStreamChild> | undefined} */
	let run;
	try {
		const refusal = launchAuthRefusal({ bin, env, cwd, bg: false });
		if (refusal) throw new Error(`REFUSED: ${refusal}`);
		/** @type {Record<string, unknown>[]} */
		const rows = [];
		run = startStreamChild(
			bin,
			["-p", ...STREAM_ARGS, "--tools", ""],
			{ cwd, env },
			(row) => rows.push(row),
		);
		run.send(LONG_PROMPT);
		const { result, capped } = await run.turn({
			capMs: INTERRUPT_AT_MS,
			graceMs: INTERRUPT_WAIT_MS,
		});
		if (!capped)
			throw new Error(
				`the turn ended before its interrupt at ${INTERRUPT_AT_MS} ms`,
			);
		if (!result)
			throw new Error(
				`no result row ${INTERRUPT_WAIT_MS / 1000} s after the interrupt`,
			);
		const controlResponse = rows.find((r) => r.type === "control_response");
		if (!controlResponse)
			throw new Error(
				"the run answered the interrupt with no control_response",
			);
		return {
			controlResponse: synthesise(controlResponse),
			result: synthesise(result),
		};
	} finally {
		await run?.stop();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
}

const USAGE = `usage: node ${scriptPath("record-headless-run.js")} [--key <key var>]\n`;

async function main() {
	let key;
	try {
		({
			values: { key },
		} = parseArgs({ options: { key: { type: "string" } } }));
	} catch {
		writeFd(2, USAGE);
		process.exit(2);
	}
	const harness = spawnSync(claudeBin(), ["--version"], {
		encoding: "utf8",
	}).stdout.trim();
	const options = readOptions();
	const hidden = readHiddenOptions();
	const result = await recordResult(readOverflowKey(key));
	const interrupt = await recordInterrupt();
	fs.writeFileSync(
		FIXTURE,
		`${JSON.stringify(
			{
				recordedBy: "node scripts/record-headless-run.js",
				harness,
				options,
				hidden,
				result,
				interrupt,
			},
			null,
			"\t",
		)}\n`,
	);
	writeFd(1, `recorded ${FIXTURE}\n`);
}

main().catch((e) => {
	writeFd(2, `${caught(e).message}\n`);
	process.exit(1);
});
