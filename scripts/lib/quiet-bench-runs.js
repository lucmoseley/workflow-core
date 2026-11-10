/*
 * quiet-bench-runs.js — the quiet bench route's kept runs (workflow-core#3852): one directory
 * a run, named for when it began, under the loop's machine-wide directory
 * (lib/refill-dir.js), outside `.claude/tmp/`, which lib/scratch-sweep.js reaps.
 */

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { readText } = require("./file-read.js");
const { gh } = require("./gh.js");
const { parseJsonl } = require("./jsonl.js");
const {
	LADDER_BENCH,
	LADDER_STAMP,
	buildRunComment,
} = require("./quiet-bench.js");
const { refillPath } = require("./refill-dir.js");
const { resolveKey } = require("./workflow-core-config.js");

const LADDER_FILE = "ladder.txt";
const MACHINE_FILE = "machine.jsonl";
const RESULT_FILE = "result.json";
const POSTED_FILE = "posted";

function quietBenchFiles() {
	return {
		state: refillPath(".refill-quiet-bench.json"),
		pid: refillPath(".refill-quiet-bench.pid"),
		log: refillPath(".refill-quiet-bench.log"),
		runs: refillPath("quiet-bench-runs"),
	};
}

/**
 * @param {string} file
 */
function readTextIfAny(file) {
	try {
		return fs.readFileSync(file, "utf8");
	} catch (e) {
		if (caught(e).code === "ENOENT") return null;
		throw e;
	}
}

/* The first words of the line `bench_suite_concurrency.py`'s
 * `killed_at_ceiling` matches in a suite's log. */
const CEILING_LINE = /^SUITE CEILING\b/m;

/**
 * How many of a row's suites the ceiling killed, read from their logs
 * (`run-<count>-<row>-<suite>.log`), for a row kept before the bench wrote
 * `ceiling_killed` itself. A log not read leaves it unknown, which no count
 * takes as a whole run (workflow-core#4031).
 * @param {string} dir
 * @param {import("./quiet-bench.js").BenchRow} row
 * @param {number} index the row's place in the run
 * @returns {number|undefined}
 */
function readCeilingKilled(dir, row, index) {
	let killed = 0;
	for (let i = 0; i < (row.suites ?? 0); i++) {
		const log = readText(path.join(dir, `run-${row.suites}-${index}-${i}.log`));
		if (log.state !== "read") return;
		if (CEILING_LINE.test(log.data)) killed++;
	}
	return killed;
}

/**
 * A run's rows: its `results.json`, which the bench rewrites after each row, so a
 * read through a rewrite reads as none until the next.
 * @param {string} dir
 * @returns {import("./quiet-bench.js").BenchRow[]}
 */
function readRunRows(dir) {
	const text = readTextIfAny(path.join(dir, "results.json"));
	if (text === null) return [];
	let rows;
	try {
		rows = JSON.parse(text);
	} catch {
		return [];
	}
	if (!Array.isArray(rows)) return [];
	return rows.map(
		(/** @type {import("./quiet-bench.js").BenchRow} */ row, i) =>
			row.ceiling_killed === undefined && row.suites !== undefined
				? { ...row, ceiling_killed: readCeilingKilled(dir, row, i) }
				: row,
	);
}

/**
 * @returns {import("./quiet-bench.js").KeptRun[]}
 */
function readKeptRuns() {
	const { runs } = quietBenchFiles();
	let ids;
	try {
		ids = fs.readdirSync(runs);
	} catch (e) {
		if (caught(e).code === "ENOENT") return [];
		throw e;
	}
	return ids
		.sort()
		.reverse()
		.map((id) => {
			const dir = path.join(runs, id);
			return {
				id,
				dir,
				rows: readRunRows(dir),
				ladder: readTextIfAny(path.join(dir, LADDER_FILE)),
			};
		});
}

/**
 * @param {Date} at
 */
function createRun(at) {
	const id = at.toISOString().replaceAll(":", "-");
	const dir = path.join(quietBenchFiles().runs, id);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, LADDER_FILE), LADDER_STAMP);
	return { id, dir };
}

/**
 * @param {string} dir
 * @param {import("./quiet-bench.js").MachineReading} reading
 */
const appendMachineReading = (dir, reading) =>
	fs.appendFileSync(
		path.join(dir, MACHINE_FILE),
		`${JSON.stringify(reading)}\n`,
	);

/**
 * @param {string} dir
 * @param {{ending: string, endedAt: number}} result
 */
const writeRunResult = (dir, result) =>
	fs.writeFileSync(path.join(dir, RESULT_FILE), JSON.stringify(result));

/**
 * @param {string} dir
 * @returns {{ending: string, endedAt: number}|null}
 */
function readRunResult(dir) {
	const text = readTextIfAny(path.join(dir, RESULT_FILE));
	return text === null ? null : JSON.parse(text);
}

/**
 * @param {import("./quiet-bench.js").KeptRun} run
 * @param {string} root
 * @throws where `gh` fails, the marker left absent
 */
function postRun(run, root) {
	const machine = /** @type {import("./quiet-bench.js").MachineReading[]} */ (
		parseJsonl(readTextIfAny(path.join(run.dir, MACHINE_FILE)) ?? "").rows
	);
	gh([
		"issue",
		"comment",
		String(LADDER_BENCH.issue),
		"--repo",
		String(resolveKey("tracker", { root })),
		"--body",
		buildRunComment({
			...run,
			ending:
				readRunResult(run.dir)?.ending ?? "its runner died with no result",
			machine,
		}),
	]);
	fs.writeFileSync(path.join(run.dir, POSTED_FILE), "");
}

const readUnpostedRuns = () =>
	readKeptRuns().filter(
		({ dir }) => !fs.existsSync(path.join(dir, POSTED_FILE)),
	);

module.exports = {
	appendMachineReading,
	createRun,
	postRun,
	quietBenchFiles,
	readKeptRuns,
	readRunResult,
	readRunRows,
	readUnpostedRuns,
	writeRunResult,
};
