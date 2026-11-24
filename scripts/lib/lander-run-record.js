const path = require("node:path");
const { TREE_PEAK_SAMPLE_MS } = require("./admission.js");
const { readJsonl } = require("./jsonl.js");
const { markersDir } = require("./marker-root.js");
const { DAY_MS, appendRetained } = require("./retained-jsonl.js");
const { writeFd } = require("./write-fd.js");

const RUN_RECORD = ".lander-runs.jsonl";
// guess, #3323
const RUN_RECORD_RETAIN_MS = 90 * DAY_MS;

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

/**
 * @param {string} root
 * @returns {{tester: TesterKind, suiteSeconds: number}[]}
 */
function readWholeRuns(root) {
	/** @type {Record<string, unknown>[]} */
	const rows = readJsonl(runRecordFile(root))?.rows ?? [];
	return rows
		.filter(
			(r) =>
				r.kind === "whole" && (r.verdict === "green" || r.verdict === "red"),
		)
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

module.exports = {
	RUN_RECORD_RETAIN_MS,
	localSeconds,
	readWholeRuns,
	recordRun,
};
