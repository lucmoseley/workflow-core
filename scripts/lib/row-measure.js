/*
 * row-measure.js — the rows a read-audit change costs the pass store (#5029),
 * judged off one set of kept audit logs by two readers.
 *
 * KEEPING A RUN. Where `KEEP_ENV` names a directory, vitest-tree-watch.ts
 * hands `keepRun` its audit log directory and the run it gave the pass
 * store's `record`, and both are copied there before the logs are removed.
 * The directory must lie outside the checkout: every child inherits the
 * variable, and one naming a checkout path is a hand the audit weighs, which
 * skews the very rows being counted. The kept logs hold the run's
 * environment, keys included, so scripts/measure-pass-store-rows.js deletes
 * them once judged.
 *
 * JUDGING. Each reader is a `scripts/lib` directory whose `read-audit.js`
 * reads the logs and whose `pass-store.js` records the run into a scratch
 * store, as the tree watch would have. A row is kept where its shard holds a
 * keyed line for the file, voiding rows aside: those say only that a fail
 * voids an older pass.
 *
 * WEIGHTS. A file's weight is how many named runs (`scope.fileFilters` set)
 * selected it in the marker store over `WINDOW_DAYS`, #4916's method.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { caught } = require("./caught.js");
const { drift, readTreeSnapshot } = require("./tree-drift.js");
const { isUnder } = require("./is-under.js");
const { parseJsonl } = require("./jsonl.js");
const { markersDir } = require("./marker-root.js");

const KEEP_ENV = "WFC_READ_AUDIT_KEEP";
const RUN_FILE = "run.json";
const RESULTS = ".test-file-results";
const WINDOW_DAYS = 14;

/**
 * @typedef {Omit<import("./pass-store.js").Run, "audits">} KeptRun
 * @typedef {{dir: string, run: KeptRun}} Kept one run's logs and its run
 * @typedef {{write: (s: string) => unknown}} Sink
 */

/**
 * Copy the audit logs in `dir` and `run` into the directory `KEEP_ENV`
 * names, where it names one. Never throws: a run that cannot be kept costs
 * the measurement, never the run.
 * @param {string|null} dir
 * @param {KeptRun|null} run
 * @param {{env?: NodeJS.ProcessEnv, err?: Sink}} [options]
 */
function keepRun(dir, run, { env = process.env, err = process.stderr } = {}) {
	const keep = env[KEEP_ENV];
	if (!keep || !dir || !run) return;
	try {
		if (isUnder(fs.realpathSync(keep), [fs.realpathSync(run.root)], path.sep)) {
			err.write(
				`row-measure.js: ${KEEP_ENV} names a directory in the checkout, which hands every child a checkout path; this run's logs are not kept (#5029)\n`,
			);
			return;
		}
		const to = path.join(keep, path.basename(dir));
		fs.cpSync(dir, to, { recursive: true });
		const startMark = run.startMark === null ? null : String(run.startMark);
		fs.writeFileSync(
			path.join(to, RUN_FILE),
			JSON.stringify({ ...run, startMark }),
		);
	} catch (e) {
		err.write(
			`row-measure.js: this run's logs are not kept (${caught(e).message ?? e}) (#5029)\n`,
		);
	}
}

/**
 * Every run kept under `keep`, by its log directory.
 * @param {string} keep
 * @returns {Kept[]}
 */
function readKept(keep) {
	return fs
		.readdirSync(keep, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => path.join(keep, e.name))
		.filter((dir) => fs.existsSync(path.join(dir, RUN_FILE)))
		.map((dir) => {
			const run = JSON.parse(fs.readFileSync(path.join(dir, RUN_FILE), "utf8"));
			const startMark = run.startMark === null ? null : BigInt(run.startMark);
			return { dir, run: { ...run, startMark } };
		});
}

/**
 * The paths the tree has moved on since `run` ended, or null where it stands
 * as the run left it. Any move drops every row the run would record, on
 * both sides, with no word said, so the measurement refuses it.
 * @param {KeptRun} run
 * @returns {string[]|null}
 */
function movedSince(run) {
	const now = readTreeSnapshot(run.root);
	if (run.after == null || now === null) return ["(the tree will not read)"];
	const moved = drift(run.after, now);
	if (moved === null) return null;
	return moved.headMoved ? ["HEAD"] : moved.moved.map((m) => m.path);
}

/**
 * The files whose shards under `storeRoot` hold a keyed row.
 * @param {string} storeRoot
 * @returns {Set<string>}
 */
function keptRows(storeRoot) {
	const dir = path.join(markersDir(storeRoot), RESULTS);
	if (!fs.existsSync(dir)) return new Set();
	const shards = fs
		.readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((e) => e.isFile())
		.map((e) => fs.readFileSync(path.join(e.parentPath, e.name), "utf8"));
	return new Set(shards.flatMap(keyedFiles));
}

/**
 * The files a shard's text holds a keyed row for.
 * @param {string} text
 * @returns {string[]}
 */
const keyedFiles = (text) =>
	parseJsonl(text)
		.rows.flatMap((line) => (Array.isArray(line.files) ? line.files : []))
		.filter((row) => typeof row?.file === "string" && row.voiding !== true)
		.map((row) => row.file);

/**
 * Each of `files` weighted by how many named runs since `since` selected it.
 * @param {Record<string, any>[]} markers
 * @param {string[]} files
 * @param {number} since epoch ms
 */
function namedRunWeights(markers, files, since) {
	const weights = new Map(files.map((f) => [f, 0]));
	let runs = 0;
	for (const m of markers) {
		if (!m?.scope?.fileFilters?.length) continue;
		if (!(Date.parse(m.at ?? m.startedAt) >= since)) continue;
		runs++;
		for (const f of m.selected ?? [])
			if (weights.has(f)) weights.set(f, Number(weights.get(f)) + 1);
	}
	return { weights, runs };
}

/**
 * `files` cut into the fewest near-equal batches of at most `max`.
 * @param {string[]} files
 * @param {number} max
 */
function batchesOf(files, max) {
	const count = Math.ceil(files.length / max);
	const size = Math.ceil(files.length / count);
	return Array.from({ length: count }, (_, i) =>
		files.slice(i * size, (i + 1) * size),
	);
}

/**
 * One reader's judgement of `kept`: the rows its pass store keeps, each file
 * its audit read and each one it doubted, and what it said.
 * @param {string} lib the reader's `scripts/lib`
 * @param {Kept[]} kept
 */
function judge(lib, kept) {
	const { readAudits } = require(path.join(lib, "read-audit.js"));
	const { record } = require(path.join(lib, "pass-store.js"));
	const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wfc-row-store-"));
	/** @type {Map<string, string>} */
	const doubts = new Map();
	/** @type {Set<string>} */
	const audited = new Set();
	/** @type {string[]} */
	const said = [];
	const err = { write: (/** @type {string} */ s) => said.push(s) };
	try {
		for (const { dir, run } of kept) {
			/** @type {Map<string, {doubt?: string}>} */
			const audits = readAudits(dir, run.root);
			for (const [f, a] of audits) {
				audited.add(f);
				if (typeof a.doubt === "string") doubts.set(f, a.doubt);
			}
			record({ ...run, audits }, { storeRoot, err, lander: false });
		}
		return { rows: keptRows(storeRoot), audited, doubts, said };
	} finally {
		fs.rmSync(storeRoot, { recursive: true, force: true });
	}
}

/**
 * @typedef {{rows: Set<string>, audited: Set<string>,
 *   doubts: Map<string, string>}} Judged
 */

/**
 * The comparison, as lines to print.
 * @param {{sample: string[], weights: Map<string, number>, runs: number,
 *   against: {name: string} & Judged, ours: {name: string} & Judged}} c
 * @returns {string[]}
 */
function summarise({ sample, weights, runs, against, ours }) {
	const total = sample.reduce((a, f) => a + Number(weights.get(f)), 0);
	const pct = (/** @type {number} */ n, /** @type {number} */ d) =>
		d === 0 ? "—" : `${((100 * n) / d).toFixed(1)}%`;
	const side = (/** @type {{name: string} & Judged} */ j) => {
		const kept = sample.filter((f) => j.rows.has(f));
		const w = kept.reduce((a, f) => a + Number(weights.get(f)), 0);
		return `| ${j.name} | ${kept.length}/${sample.length} | ${pct(w, total)} (${w}/${total}) |`;
	};
	const why = (/** @type {Judged} */ j, /** @type {string} */ f) =>
		j.doubts.get(f) ??
		(j.audited.has(f)
			? "no audit doubt: the pass store kept no row on its inputs"
			: "not audited");
	const moved = (/** @type {Judged} */ from, /** @type {Judged} */ to) =>
		sample
			.filter((f) => from.rows.has(f) && !to.rows.has(f))
			.map((f) => `- ${f} (weight ${weights.get(f)}): ${why(to, f)}`);
	const lost = moved(against, ours);
	const gained = moved(ours, against);
	return [
		`Sample: ${sample.length} files, ${ours.audited.size} audited. Named runs over ${WINDOW_DAYS} days: ${runs} (${total} file-runs on the sample).`,
		"",
		"| Reader | Rows | File-runs cached |",
		"|---|---|---|",
		side(against),
		side(ours),
		"",
		`Lost (${lost.length}), with ${ours.name}'s doubt:`,
		...lost,
		`Gained (${gained.length}), with ${against.name}'s doubt:`,
		...gained,
	];
}

module.exports = {
	KEEP_ENV,
	WINDOW_DAYS,
	batchesOf,
	judge,
	keepRun,
	keptRows,
	movedSince,
	namedRunWeights,
	readKept,
	summarise,
};
