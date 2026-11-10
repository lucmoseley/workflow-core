#!/usr/bin/env node
/*
 * quiet-bench-run.js — the quiet bench route's runner and its kept rows' reading
 * (lib/quiet-bench.js, workflow-core#3852).
 *
 *   node scripts/quiet-bench-run.js run    run the bench in the cwd's checkout
 *   node scripts/quiet-bench-run.js rows   print the kept rows' reading
 *
 * A tick retries a post that fails.
 *
 * Joins no §N3 family: `run` reports through its kept run and the issue, and
 * `rows`, a gate check, prints a reading and exits 0.
 */

const { spawn } = require("node:child_process");
const { scriptPath } = require("./lib/script-path.js");
const fs = require("node:fs");
const path = require("node:path");
const { buildErrorText } = require("./lib/caught.js");
const { spawnChild } = require("./lib/child-spawn.js");
const { parseOrExit } = require("./lib/cli-args.js");
const { readLoad1 } = require("./lib/cpu-sample.js");
const { pidLock } = require("./lib/pid-lock.js");
const {
	BENCH_RUNNER,
	LADDER_BENCH,
	LADDER_STAMP,
	buildEnding,
	buildRowsReading,
	parseFree,
} = require("./lib/quiet-bench.js");
const {
	appendMachineReading,
	createRun,
	postRun,
	quietBenchFiles,
	readKeptRuns,
	readRunRows,
	writeRunResult,
} = require("./lib/quiet-bench-runs.js");
const { writeFd } = require("./lib/write-fd.js");

const USAGE = `usage: node ${scriptPath("quiet-bench-run.js")} run | rows`;

/* A guess: the shortest row is minutes long. */
const ROW_POLL_MS = 30 * 1000;
/* A guess: `free` reads one file. */
const FREE_TIMEOUT_MS = 10 * 1000;

/**
 * @param {string} label
 */
const readMachine = (label) => ({
	label,
	...parseFree(spawnChild("free", ["-m"], { timeout: FREE_TIMEOUT_MS }).stdout),
	load1: readLoad1(),
});

/**
 * @param {string} root
 * @param {string} dir
 * @returns {Promise<{status: number|null, signal: string|null}>}
 */
function runBench(root, dir) {
	const log = path.join(dir, "bench.log");
	const fd = fs.openSync(log, "a");
	const child = spawn(
		"python3",
		[path.join(root, LADDER_BENCH.script), ...LADDER_BENCH.args],
		{
			cwd: root,
			env: { ...process.env, OUTDIR: dir },
			stdio: ["ignore", fd, fd],
		},
	);
	fs.closeSync(fd);
	const stop = () => child.kill("SIGTERM");
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
	let seen = 0;
	const poll = setInterval(() => {
		const rows = readRunRows(dir).length;
		if (rows === seen) return;
		seen = rows;
		appendMachineReading(dir, readMachine(`after row ${rows}`));
	}, ROW_POLL_MS);
	return new Promise((resolve) => {
		const done = (
			/** @type {number|null} */ status,
			/** @type {string|null} */ signal,
		) => {
			clearInterval(poll);
			resolve({ status, signal });
		};
		child.on("error", (e) => {
			fs.appendFileSync(log, `${e.message}\n`);
			done(1, null);
		});
		child.on("close", done);
	});
}

async function run() {
	const files = quietBenchFiles();
	fs.mkdirSync(files.runs, { recursive: true });
	const lock = pidLock(files.pid, BENCH_RUNNER);
	if (!lock.acquire()) return;
	try {
		const root = process.cwd();
		const { id, dir } = createRun(new Date());
		appendMachineReading(dir, readMachine("before the bench"));
		const { status, signal } = await runBench(root, dir);
		appendMachineReading(dir, readMachine("at its end"));
		const tail =
			fs
				.readFileSync(path.join(dir, "bench.log"), "utf8")
				.trim()
				.split("\n")
				.at(-1) ?? "";
		writeRunResult(dir, {
			ending: buildEnding(status, signal, tail),
			endedAt: Date.now(),
		});
		try {
			postRun({ id, dir, rows: readRunRows(dir), ladder: LADDER_STAMP }, root);
		} catch (e) {
			writeFd(
				2,
				`not posted to #${LADDER_BENCH.issue}: ${buildErrorText(e)}\n`,
			);
		}
	} finally {
		lock.release();
	}
}

async function main() {
	const { command } = parseOrExit(process.argv.slice(2), {
		usage: USAGE,
		commands: { run: { usage: USAGE }, rows: { usage: USAGE } },
	});
	if (command === "run") await run();
	else writeFd(1, `${buildRowsReading(readKeptRuns())}\n`);
}

if (require.main === module)
	main().catch((e) => {
		writeFd(2, `${buildErrorText(e)}\n`);
		process.exitCode = 1;
	});
