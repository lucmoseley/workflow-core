const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { caught } = require("./caught.js");
const { readText } = require("./file-read.js");
const { execGit } = require("./git.js");
const { markStart, readChangedSince } = require("./tree-drift.js");
const { readMovedSinceEnd } = require("./run-steadiness.js");
const { isUnder } = require("./is-under.js");
const { parseJsonl } = require("./jsonl.js");

const KEEP_ENV = "WFC_READ_AUDIT_KEEP";
const RUN_FILE = "run.json";
const WINDOW_DAYS = 14;

/**
 * @typedef {Omit<import("./pass-store.js").Run, "audits">} RecordedRun
 * @typedef {RecordedRun & {keptMark: bigint|null}} KeptRun
 * @typedef {{dir: string, run: KeptRun}} Kept
 * @typedef {{write: (s: string) => unknown}} Sink
 * @typedef {{rows: Set<string>, audited: Set<string>,
 *   doubts: Map<string, string>, said: string[]}} Judged
 */

/** @param {bigint|null} mark */
const markOut = (mark) => (mark === null ? null : String(mark));

/** @param {unknown} mark */
const markIn = (mark) => (typeof mark === "string" ? BigInt(mark) : null);

/**
 * @param {string|null} dir
 * @param {RecordedRun|null} run
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
		fs.writeFileSync(
			path.join(to, RUN_FILE),
			JSON.stringify({
				...run,
				keptMark: markOut(markStart(run.root)),
			}),
		);
	} catch (e) {
		err.write(
			`row-measure.js: this run's logs are not kept (${caught(e).message ?? e}) (#5029)\n`,
		);
	}
}

/**
 * @param {string} keep
 * @returns {Kept[]}
 */
function readKept(keep) {
	return fs
		.readdirSync(keep, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.flatMap((e) => {
			const dir = path.join(keep, e.name);
			const got = readText(path.join(dir, RUN_FILE));
			if (got.state !== "read") return [];
			const run = JSON.parse(got.data);
			return [
				{
					dir,
					run: {
						...run,
						keptMark: markIn(run.keptMark),
					},
				},
			];
		});
}

/**
 * @param {KeptRun} run
 * @returns {string[]|null}
 */
function movedSince(run) {
	const moved =
		run.steadiness == null
			? "unknown"
			: readMovedSinceEnd(run.steadiness, run.root);
	if (moved === "unknown") return ["(the tree will not read)"];
	if (moved?.headMoved) return ["HEAD"];
	if (moved) return moved.moved.map((m) => m.path);
	const tracked = String(
		execGit(["ls-files", "-z"], { cwd: run.root, encoding: "utf8" }),
	)
		.split("\0")
		.filter(Boolean);
	const touched = readChangedSince(run.root, tracked, run.keptMark);
	if (touched === null) return ["(no mark of when the run was kept)"];
	return touched.size > 0 ? [...touched] : null;
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
const filesUnder = (dir) =>
	fs
		.readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((e) => e.isFile())
		.map((e) => path.join(e.parentPath, e.name));

/**
 * @param {string} text
 * @returns {string[]}
 */
const cachingFiles = (text) =>
	parseJsonl(text)
		.rows.flatMap((line) => (Array.isArray(line.files) ? line.files : []))
		.filter(
			(row) =>
				typeof row?.file === "string" &&
				row.outcome === "pass" &&
				row.voiding !== true,
		)
		.map((row) => row.file);

/**
 * @param {string} storeRoot
 * @returns {Set<string>}
 */
const readCachingRows = (storeRoot) =>
	new Set(
		filesUnder(storeRoot).flatMap((f) =>
			cachingFiles(fs.readFileSync(f, "utf8")),
		),
	);

/** @param {{sha?: unknown, at?: unknown}} m */
const runKey = (m) => `${m.sha} ${m.at}`;

/**
 * @param {unknown[]} markers
 * @param {string[]} files
 * @param {number} since
 * @param {Set<string>} own
 */
function namedRunWeights(markers, files, since, own) {
	/** @type {Map<string, number>} */
	const weights = new Map(files.map((f) => [f, 0]));
	const counted = markers.filter((m) => isCountedRun(m, since, own));
	for (const m of counted)
		for (const f of Array.isArray(m.selected) ? m.selected : []) {
			const w = weights.get(f);
			if (w !== undefined) weights.set(f, w + 1);
		}
	return { weights, runs: counted.length };
}

/**
 * @param {unknown} marker
 * @param {number} since
 * @param {Set<string>} own
 * @returns {marker is Record<string, any>}
 */
function isCountedRun(marker, since, own) {
	if (marker === null || typeof marker !== "object") return false;
	const m = /** @type {Record<string, any>} */ (marker);
	return (
		Boolean(m.scope?.fileFilters?.length) &&
		!own.has(runKey(m)) &&
		Date.parse(m.at ?? m.startedAt) >= since
	);
}

/**
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

/** @param {string} lib */
function buildJudge(lib) {
	const { readAudits } = require(path.join(lib, "read-audit.js"));
	const { record } = require(path.join(lib, "pass-store.js"));
	const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wfc-row-store-"));
	/** @type {Judged} */
	const judged = {
		rows: new Set(),
		audited: new Set(),
		doubts: new Map(),
		said: [],
	};
	const err = { write: (/** @type {string} */ s) => judged.said.push(s) };
	return {
		/** @param {Kept} kept */
		add({ dir, run }) {
			const { keptMark: _, ...recorded } = run;
			/** @type {Map<string, {doubt?: string}>} */
			const audits = readAudits(dir, run.root);
			for (const [f, a] of audits) {
				judged.audited.add(f);
				if (typeof a.doubt === "string") judged.doubts.set(f, a.doubt);
			}
			record({ ...recorded, audits }, { storeRoot, err, rowless: false });
		},
		/** @returns {Judged} */
		read: () => ({ ...judged, rows: readCachingRows(storeRoot) }),
		dispose: () => fs.rmSync(storeRoot, { recursive: true, force: true }),
	};
}

/**
 * @param {{sample: string[], weights: Map<string, number>, runs: number,
 *   against: {name: string} & Judged, ours: {name: string} & Judged}} c
 * @returns {string[]}
 */
function summarise({ sample, weights, runs, against, ours }) {
	const weightOf = (/** @type {string} */ f) => weights.get(f) ?? 0;
	const total = sample.reduce((a, f) => a + weightOf(f), 0);
	const pct = (/** @type {number} */ n, /** @type {number} */ d) =>
		d === 0 ? "—" : `${((100 * n) / d).toFixed(1)}%`;
	const tableRow = (/** @type {{name: string} & Judged} */ j) => {
		const cached = sample.filter((f) => j.rows.has(f));
		const w = cached.reduce((a, f) => a + weightOf(f), 0);
		return `| ${j.name} | ${cached.length}/${sample.length} | ${pct(w, total)} (${w}/${total}) |`;
	};
	const why = (/** @type {Judged} */ j, /** @type {string} */ f) =>
		j.doubts.get(f) ??
		(j.audited.has(f)
			? "no audit doubt: the pass store cached no row on its inputs"
			: "not audited");
	const cachedOnlyBy = (
		/** @type {Judged} */ by,
		/** @type {Judged} */ other,
	) =>
		sample
			.filter((f) => by.rows.has(f) && !other.rows.has(f))
			.map((f) => `- ${f} (weight ${weightOf(f)}): ${why(other, f)}`);
	const lost = cachedOnlyBy(against, ours);
	const gained = cachedOnlyBy(ours, against);
	return [
		`Sample: ${sample.length} files, ${ours.audited.size} audited. Named runs over ${WINDOW_DAYS} days: ${runs} (${total} file-runs on the sample).`,
		"",
		"| Reader | Rows caching | File-runs cached |",
		"|---|---|---|",
		tableRow(against),
		tableRow(ours),
		"",
		`Lost (${lost.length}), with ${ours.name}'s doubt:`,
		...lost,
		`Gained (${gained.length}), with ${against.name}'s doubt:`,
		...gained,
	];
}

/**
 * @param {Record<string, string|true>} flags
 * @param {number} defaultMax
 * @returns {{refusal: string} | {against: string, logs: string|null,
 *   keep: boolean, max: number}}
 */
function readOptions(flags, defaultMax) {
	const against = flags["--against"];
	if (typeof against !== "string") return { refusal: "--against is required" };
	const given = flags["--batch-files"];
	const max = typeof given === "string" ? Number(given) : defaultMax;
	if (!Number.isInteger(max) || max < 1)
		return { refusal: "--batch-files takes a whole number above 0" };
	const logs = flags["--logs"];
	return {
		against,
		logs: typeof logs === "string" ? logs : null,
		keep: flags["--keep"] === true,
		max,
	};
}

module.exports = {
	KEEP_ENV,
	WINDOW_DAYS,
	batchesOf,
	buildJudge,
	keepRun,
	movedSince,
	namedRunWeights,
	readKept,
	readOptions,
	runKey,
	summarise,
};
