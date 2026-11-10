#!/usr/bin/env node
/*
 * record-headless-run.js — re-records scripts/fixtures/headless-run.json,
 * the installed harness's side of a headless `claude -p` run (#4586): every
 * option `claude --help` lists, with whether it takes a value, each hidden
 * one lib/headless-options.js names, and the
 * `result` row of one run lib/headless-sessions.js launched, which
 * lib/headless-runs.js reads. lib/headless-run-fake.ts serves both to the
 * suites' `claude` stubs.
 *
 *   node scripts/record-headless-run.js [--key <key var>]
 *
 * The run goes on the overflow seat whose key `--key` names, else the
 * seat file's first, from an empty directory and into a throwaway run store,
 * so the refill loop never lists it. It spends one short turn on that key.
 *
 * Run it by hand after a harness upgrade, then `npm run test --
 * scripts/lib/headless-run.contract.test.ts`.
 *
 * In no family (§N3): it writes a fixture, but spends a turn to do it, so it
 * is no `generate-*` a gate may run. No suite runs it: the contract holds what
 * it writes.
 */

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
const { readJsonl } = require("./lib/jsonl.js");
const { overflowSeatsOf, readDeclaredSeats } = require("./lib/refill-seats.js");
const { writeFd } = require("./lib/write-fd.js");

const FIXTURE = path.join(__dirname, "fixtures", "headless-run.json");
const PROMPT = "Reply with the single word ok. Use no tools.";
/* A guess: one short turn ends in well under a minute. */
const WAIT_MS = 180_000;
/* Far over one short turn's $0.04, so the budget never stops
 * the turn it records. */
const BUDGET_USD = 1;
/* What the fixture carries in place of the run's own ids. */
const SYNTHETIC = {
	session_id: "5e551011-0000-4000-8000-000000000000",
	uuid: "0e5017ed-0000-4000-8000-000000000000",
};

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
	/* Required after the store is set, which they read on each call. */
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
		return { ...row, ...SYNTHETIC };
	} finally {
		await stop(record.jobId, { graceMs: 0 });
		fs.rmSync(store, { recursive: true, force: true });
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
	fs.writeFileSync(
		FIXTURE,
		`${JSON.stringify(
			{
				recordedBy: "node scripts/record-headless-run.js",
				harness,
				options,
				hidden,
				result,
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
