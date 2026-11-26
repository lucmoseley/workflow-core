const path = require("node:path");
const { TREE_PEAK_SAMPLE_MS } = require("./admission.js");
const { readText } = require("./file-read.js");
const { parseJsonl, readJsonl } = require("./jsonl.js");
const { markersDir } = require("./marker-root.js");
const { DAY_MS, appendRetained } = require("./retained-jsonl.js");
const { writeFd } = require("./write-fd.js");

const RUN_RECORD = ".lander-runs.jsonl";
// guess, #3323
const RUN_RECORD_RETAIN_MS = 90 * DAY_MS;
// guess, #5705
const PEAK_RUNS = 20;
// guess, #5705
const PEAK_RUN_FLOOR = 10;

/** @typedef {"local" | "actions"} TesterKind */

/**
 * @typedef {{sha: string, kind: "whole" | "named", files: number,
 *   shards: number, peakMb?: number, samples?: number,
 *   verdict: import("./queue-lander.js").Verdict["kind"], tester: TesterKind,
 *   suiteSeconds: number}} RunLine
 */

/** @param {string} root */
const runRecordFile = (root) => path.join(markersDir(root), RUN_RECORD);

/**
 * @param {string} root
 * @param {RunLine} run
 */
function recordRun(root, run) {
	const file = runRecordFile(root);
	const landed = appendRetained(
		file,
		{ at: new Date().toISOString(), ...run },
		RUN_RECORD_RETAIN_MS,
	);
	if (!landed) writeFd(2, `lander: run record unwritten: ${file}\n`);
}

/** @param {number} samples */
const localSeconds = (samples) => (samples * TREE_PEAK_SAMPLE_MS) / 1000;

/** @param {Record<string, unknown>} r */
const isJudgedWholeRun = (r) =>
	r.kind === "whole" && (r.verdict === "green" || r.verdict === "red");

/**
 * @param {string} root
 * @returns {{tester: TesterKind, suiteSeconds: number}[]}
 */
function readWholeRuns(root) {
	/** @type {Record<string, unknown>[]} */
	const rows = readJsonl(runRecordFile(root))?.rows ?? [];
	return rows
		.filter(isJudgedWholeRun)
		.map((r) => ({
			tester: /** @type {TesterKind} */ (
				r.tester === "actions" ? "actions" : "local"
			),
			suiteSeconds:
				typeof r.suiteSeconds === "number"
					? r.suiteSeconds
					: localSeconds(Number(r.samples) || 0),
		}))
		.reverse();
}

/**
 * @param {string} root
 * @returns {{peakMb: number} | {why: string}}
 */
function readWholePeak(root) {
	const file = runRecordFile(root);
	const read = readText(file);
	if (read.state === "unreadable")
		return { why: `the run record ${file} would not read (${read.message})` };
	/** @type {Record<string, unknown>[]} */
	const rows = read.state === "read" ? parseJsonl(read.data).rows : [];
	const peaks = rows
		.filter(
			(r) =>
				isJudgedWholeRun(r) &&
				r.tester !== "actions" &&
				typeof r.peakMb === "number" &&
				r.peakMb > 0,
		)
		.slice(-PEAK_RUNS)
		.map((r) => Number(r.peakMb));
	if (peaks.length < PEAK_RUN_FLOOR)
		return {
			why: `${peaks.length} measured local whole runs in ${file}, under the ${PEAK_RUN_FLOOR} a peak needs`,
		};
	return { peakMb: Math.max(...peaks) };
}

module.exports = {
	RUN_RECORD_RETAIN_MS,
	localSeconds,
	readWholePeak,
	readWholeRuns,
	recordRun,
};
