/*
 * row-measure.js — the rows a read-audit change costs the pass store (#5029),
 * judged off one set of kept audit logs by two readers.
 *
 * KEEPING A RUN. Where `KEEP_ENV` names a directory, vitest-tree-watch.ts
 * hands `keepRun` its audit log directory and the run it gave the pass
 * store's `record`, and both are copied there before the logs are removed.
 * The directory must lie outside the
 * checkout: every child inherits the variable, and one naming a checkout
 * path is a hand the audit weighs, which skews the very rows being counted.
 * The kept logs hold the run's environment, keys included, so
 * scripts/measure-pass-store-rows.js deletes them once judged.
 *
 * JUDGING. Each reader is a `scripts/lib` directory whose `read-audit.js`
 * reads the logs and whose `pass-store.js` records the run into a scratch
 * store, as the tree watch would have. A row caches where its shard holds a
 * keyed pass for the file: a fail runs it, and a voiding row says only that
 * a fail voids an older pass. The whole scratch store is read, wherever the
 * reader's layout puts its shards.
 *
 * WEIGHTS. A file's weight is how many named runs (`scope.fileFilters` set)
 * selected it in the marker store over `WINDOW_DAYS`, workflow-core#4916's method, the
 * measurement's own batches aside. An earlier measurement's batches in the
 * window still count.
 */

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
 *   the run the tree watch handed the pass store, its audits aside
 * @typedef {RecordedRun & {keptMark: bigint|null}} KeptRun
 *   `keptMark` a `markStart` mark taken as the run was kept, null where none
 *   was taken
 * @typedef {{dir: string, run: KeptRun}} Kept one run's logs and its run
 * @typedef {{write: (s: string) => unknown}} Sink
 * @typedef {{rows: Set<string>, audited: Set<string>,
 *   doubts: Map<string, string>, said: string[]}} Judged
 *   the files a reader's store caches, each its audit read, each it doubted
 *   with why, and what its pass store said
 */

/** The kept mark, as JSON carries it. @param {bigint|null} mark */
const markOut = (mark) => (mark === null ? null : String(mark));

/** The kept mark JSON carried. @param {unknown} mark */
const markIn = (mark) => (typeof mark === "string" ? BigInt(mark) : null);

/**
 * Copy the audit logs in `dir` and `run` into the directory `KEEP_ENV`
 * names, where it names one. Never throws.
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
 * Every run kept under `keep`, by its log directory.
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
 * The paths the tree has moved on since `run` was kept, or null where it
 * stands as the run left it. A tracked file rewritten, or only touched,
 * since then drops the rows resting on it on both sides with no word said,
 * so the measurement refuses it.
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
 * Every file under `dir`, at any depth.
 * @param {string} dir
 * @returns {string[]}
 */
const filesUnder = (dir) =>
	fs
		.readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((e) => e.isFile())
		.map((e) => path.join(e.parentPath, e.name));

/**
 * The files a shard's text holds a keyed pass for.
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
 * The files the store under `storeRoot` caches.
 * @param {string} storeRoot
 * @returns {Set<string>}
 */
const readCachingRows = (storeRoot) =>
	new Set(
		filesUnder(storeRoot).flatMap((f) =>
			cachingFiles(fs.readFileSync(f, "utf8")),
		),
	);

/**
 * A marker's run, as the kept run's `sha` and `at` name it.
 * @param {{sha?: unknown, at?: unknown}} m
 */
const runKey = (m) => `${m.sha} ${m.at}`;

/**
 * Each of `files` weighted by how many named runs since `since` selected it,
 * the runs `own` names aside.
 * @param {unknown[]} markers
 * @param {string[]} files
 * @param {number} since epoch ms
 * @param {Set<string>} own `runKey`s of the measurement's own batches
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
 * Whether `marker` is a named run dated since `since` that `own` does not
 * name.
 * @param {unknown} marker
 * @param {number} since
 * @param {Set<string>} own
 * @returns {marker is Record<string, any>} a marker line, whose shape test-pass-marker.js owns
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
 * A judge over the reader at `lib`, recording each kept run handed to `add`
 * into one scratch store.
 * `dispose` removes the store.
 * @param {string} lib the reader's `scripts/lib`
 */
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
			record({ ...recorded, audits }, { storeRoot, err, lander: false });
		},
		/** @returns {Judged} */
		read: () => ({ ...judged, rows: readCachingRows(storeRoot) }),
		dispose: () => fs.rmSync(storeRoot, { recursive: true, force: true }),
	};
}

/**
 * The comparison, as lines to print.
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
 * The command's options off its parsed flags, or the refusal they earn.
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
