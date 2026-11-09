/*
 * suite-timings.js — the per-file suite-timing dataset: vitest JSON in, rows
 * out, from one report or every report under a directory as one sharded
 * Actions run's shards upload them (`vitest-report-*`, #2413); rows in,
 * percentile shares out; and the CSV serialisation between them.
 * `readReports` reads the filesystem, and `downloadReports` and `readNewestRun`
 * GitHub; the rest are pure (#4320). `scripts/suite-timings.js` is the CLI
 * over it, and `scripts/lib/latest-timings.js` this machine's copy.
 *
 * It exists so the suite-file-timings note's percentile table can be
 * recomputed rather than merely quoted (mantahostels#2039), docs/agents/guard-registry.md §Conventions resting
 * a live rule on it.
 *
 * DURATION IS EACH FILE'S `duration`, which `scripts/vitest-json-reporter.ts`
 * adds to vitest's report: the file's run, its beforeAll and afterAll hooks
 * included, as the default reporter prints it (#4313). It is wall time inside
 * the worker and so overlaps across workers: the file-seconds total exceeds the
 * run's wall clock by roughly the worker count. That is deliberately what the
 * shares are fractions of — a share of wall clock would depend on scheduling
 * luck rather than on the files.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { caught } = require("./caught.js");
const { gh, ghJson, retryingOnceSync } = require("./gh.js");
const { resolveKey } = require("./workflow-core-config.js");

/* scheduled-checks.yml carries the `lander/batch-*` push trigger, as it calls
 * every job `main`'s sweep judges by; its green runs are the timings' source. */
const SUITE_WORKFLOW = "scheduled-checks.yml";

/* Candidates tried for reports, newest first. Untraced: a green run
 * uploads its reports, so past the first few none is coming. */
const SOURCES_TRIED = 5;
const RUNS_LISTED = 30;

/** Metadata lines are `# key: value` above the header row. */
const META_PREFIX = "# ";

/**
 * The slices https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/suite-file-timings.md tabulates, so a default run
 * reproduces that table's rows and no others. Any other set is the caller's.
 */
const DEFAULT_SLICES = [5, 10, 20, 50, 100];

/**
 * The checkout a report's file names sit under: the deepest ancestor of its
 * names under which the most of them name a file `exists` finds in this
 * checkout, else `root`. A report from an Actions runner names files under
 * the runner's own worktree, not this one, and a shard's files can all share
 * a subdirectory, so no common prefix is safe (#2413). A run in an isolated
 * worktree so keys its files under `<root>/.claude/worktrees/<name>/`, not
 * under `root` (#4352).
 *
 * @param {{ testResults?: unknown[] }} report parsed vitest JSON
 * @param {string} root this checkout
 * @param {(relative: string) => boolean} exists whether this checkout holds a path
 * @returns {string}
 */
function reportRoot(report, root, exists) {
	const results = Array.isArray(report.testResults) ? report.testResults : [];
	const names = results.map((raw) =>
		String(/** @type {Record<string, unknown>} */ (raw).name ?? ""),
	);
	let best = root;
	let found = 0;
	for (let dir = path.dirname(names[0] ?? root); ; dir = path.dirname(dir)) {
		const here = names.filter((n) => exists(path.relative(dir, n))).length;
		if (here > found) [best, found] = [dir, here];
		if (dir === path.dirname(dir)) return best;
	}
}

/**
 * Per-file rows from vitest's JSON reporter output, heaviest first.
 *
 * A FILE MISSING ITS DURATION IS KEPT WITH A NULL ONE, never dropped
 * and never zeroed (mantahostels#2039). Dropping it would silently inflate every share
 * below it; a zero would misreport a file as instant.
 *
 * @param {{ testResults?: unknown[] }} report parsed vitest JSON
 * @param {string} root repo root, so paths are recorded relative to the checkout
 * @returns {{ file: string, seconds: number|null, tests: number, status: string }[]}
 */
function rowsFrom(report, root) {
	const results = Array.isArray(report.testResults) ? report.testResults : [];
	const rows = results.map((raw) => {
		const r = /** @type {Record<string, unknown>} */ (raw);
		const ms = r.duration;
		return {
			file: path.relative(root, String(r.name ?? "")),
			seconds:
				typeof ms === "number" && Number.isFinite(ms)
					? Math.round(ms / 10) / 100
					: null,
			tests: Array.isArray(r.assertionResults) ? r.assertionResults.length : 0,
			status: String(r.status ?? "unknown"),
		};
	});
	rows.sort((a, b) => (b.seconds ?? -1) - (a.seconds ?? -1));
	return rows;
}

/* What `gh run download` prints for a run whose reports are gone or never
 * uploaded (#4292). */
const NO_ARTEFACTS = /no valid artifacts found/i;

/**
 * One run's `vitest-report-*` artefacts into `dir`: true, or false where the
 * run holds none. Any other gh failure throws, its stderr on the error.
 * @param {string} run
 * @param {string} dir
 * @returns {boolean}
 */
function downloadReports(run, dir) {
	try {
		gh(["run", "download", run, "-p", "vitest-report-*", "-D", dir]);
		return true;
	} catch (e) {
		if (NO_ARTEFACTS.test(String(caught(e).stderr ?? ""))) return false;
		throw e;
	}
}

/**
 * Heaviest first. Each report is relativised on its own: every shard ran in
 * a checkout of its own.
 * @param {string} source a report file, or a directory of them
 * @param {string} root the checkout the file names are made relative to
 * @returns {ReturnType<typeof rowsFrom>}
 */
function readReports(source, root) {
	const files = fs.statSync(source).isDirectory()
		? fs
				.readdirSync(source, { recursive: true, encoding: "utf8" })
				.filter((f) => f.endsWith(".json"))
				.sort()
				.map((f) => path.join(source, f))
		: [source];
	const rows = files.flatMap((f) => {
		const report = JSON.parse(fs.readFileSync(f, "utf8"));
		return rowsFrom(
			report,
			reportRoot(report, root, (rel) => fs.existsSync(path.join(root, rel))),
		);
	});
	rows.sort((a, b) => (b.seconds ?? -1) - (a.seconds ?? -1));
	return rows;
}

/* A run finished this close before the planning run was created may still
 * list as running to one shard and as green to the next. A guess: the gap
 * between a run's completion and its listing as completed is unmeasured. */
const SETTLE_MS = 120_000;

/**
 * @typedef {{ id: number, status: string, conclusion: string|null,
 *   created_at: string, updated_at: string }} ListedRun
 */

/**
 * The green runs a sharded run may take its timings from, newest first: those
 * finished SETTLE_MS before `before`, the planning run's creation. Every shard
 * of one run, and each re-run of it, shares that instant, so each picks the
 * same run (#4574). A source run re-run between two reads drops out of the
 * later one, so those shards plan apart; scheduled-checks.yml's verdict
 * compares the shards' records and turns that red.
 *
 * @param {ListedRun[]} runs
 * @param {number} before ms since the epoch
 * @returns {number[]}
 */
function timingSources(runs, before) {
	const cutoff = before - SETTLE_MS;
	return runs
		.filter(
			(r) =>
				r.status === "completed" &&
				r.conclusion === "success" &&
				Date.parse(r.created_at) < cutoff &&
				Date.parse(r.updated_at) < cutoff,
		)
		.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
		.map((r) => r.id);
}

/**
 * @template T
 * @param {() => T} read
 * @returns {T}
 */
function readOrThrow(read) {
	const r = retryingOnceSync(read);
	if (!r.ok) throw new Error(r.error);
	return r.out;
}

/**
 * @param {string} root
 * @returns {string}
 */
function readSuiteRepo(root) {
	const configured = resolveKey("codeRepo", { root });
	const repo =
		(typeof configured === "string" && configured) ||
		process.env.GITHUB_REPOSITORY;
	if (!repo) throw new Error("no codeRepo configured and no GITHUB_REPOSITORY");
	return repo;
}

/**
 * The newest green suite run finished before `before`, and its rows, made
 * relative to `root`; null where none of the newest SOURCES_TRIED holds
 * reports. A run `held` names comes back undownloaded, its rows null. Throws
 * where GitHub fails twice.
 * @param {string} repo
 * @param {number} before ms since the epoch
 * @param {string} root
 * @param {(run: number) => boolean} [held]
 * @returns {{ run: number, sha: string, rows: ReturnType<typeof readReports>|null }|null}
 */
function readNewestRun(repo, before, root, held = () => false) {
	const iso = new Date(before).toISOString().replace(/\.\d{3}Z$/, "Z");
	/** @type {(ListedRun & { head_sha: string })[]} */
	const runs = readOrThrow(
		() =>
			ghJson([
				"api",
				`repos/${repo}/actions/workflows/${SUITE_WORKFLOW}/runs?status=success&exclude_pull_requests=true&per_page=${RUNS_LISTED}&created=%3C${iso}`,
			]).workflow_runs,
	);
	const sha = new Map(runs.map((r) => [r.id, r.head_sha]));
	const work = fs.mkdtempSync(path.join(os.tmpdir(), "suite-timings-"));
	try {
		for (const run of timingSources(runs, before).slice(0, SOURCES_TRIED)) {
			if (held(run)) return { run, sha: sha.get(run) ?? "", rows: null };
			const dir = path.join(work, String(run));
			if (!readOrThrow(() => downloadReports(String(run), dir))) continue;
			const rows = readReports(dir, root);
			if (rows.length > 0) return { run, sha: sha.get(run) ?? "", rows };
		}
		return null;
	} finally {
		fs.rmSync(work, { recursive: true, force: true });
	}
}

/**
 * Median and cumulative share of file-seconds at each slice.
 *
 * Untimed rows are excluded from the total and the slices, and counted
 * separately so a caller sees the dataset was incomplete rather than inferring
 * it from a share that does not add up.
 *
 * @param {{ seconds: number|null }[]} rows
 * @param {number[]} [slices] top-N cut points
 */
function shares(rows, slices = DEFAULT_SLICES) {
	const timed = rows
		.filter((r) => r.seconds !== null)
		.map((r) => /** @type {number} */ (r.seconds))
		.sort((a, b) => b - a);
	const total = timed.reduce((a, b) => a + b, 0);
	const ascending = [...timed].sort((a, b) => a - b);
	// One middle value twice on an odd count, the two middle values on an even.
	const lower = ascending[Math.ceil(ascending.length / 2) - 1];
	const upper = ascending[Math.floor(ascending.length / 2)];
	const median =
		lower === undefined || upper === undefined ? null : (lower + upper) / 2;
	return {
		files: rows.length,
		timedFiles: timed.length,
		untimedFiles: rows.length - timed.length,
		totalSeconds: Math.round(total * 100) / 100,
		medianSeconds: median === null ? null : Math.round(median * 100) / 100,
		slices: slices
			.filter((n) => n <= timed.length)
			.map((n) => ({
				top: n,
				sharePct: total
					? Math.round(
							(timed.slice(0, n).reduce((a, b) => a + b, 0) / total) * 1000,
						) / 10
					: 0,
			})),
	};
}

/**
 * The CSV text: `# key: value` metadata, then `file,seconds,tests,status`.
 *
 * NO QUOTING, AND NO ESCAPING (mantahostels#2039). Every cell is a repo-relative test path,
 * a number, or one of vitest's own status words, and none of the three can
 * contain a comma; a quoting layer would be code no input reaches. The residual
 * is that a future column taking free text — a failure message, say — silently
 * shifts every column after it, so such a column wants the quoting first.
 *
 * An untimed row's `seconds` cell is empty, which is how `parseCsv` tells it
 * from a genuine 0.00.
 *
 * @param {ReturnType<typeof rowsFrom>} rows
 * @param {Record<string, string|number>} meta
 */
function toCsv(rows, meta) {
	const lines = Object.entries(meta).map(
		([k, v]) => `${META_PREFIX}${k}: ${v}`,
	);
	lines.push("file,seconds,tests,status");
	for (const r of rows)
		lines.push(
			`${r.file},${r.seconds === null ? "" : r.seconds.toFixed(2)},${r.tests},${r.status}`,
		);
	return `${lines.join("\n")}\n`;
}

/**
 * Rows and metadata back out of a dataset CSV.
 * @param {string} text
 */
function parseCsv(text) {
	/** @type {Record<string, string>} */
	const meta = {};
	/** @type {{ file: string, seconds: number|null, tests: number, status: string }[]} */
	const rows = [];
	let seenHeader = false;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		if (line.startsWith(META_PREFIX)) {
			const at = line.indexOf(": ");
			if (at > 0) meta[line.slice(META_PREFIX.length, at)] = line.slice(at + 2);
			continue;
		}
		if (!seenHeader) {
			seenHeader = true;
			continue;
		}
		const [file, seconds, tests, status] = line.split(",");
		if (file === undefined || status === undefined)
			throw new Error(`dataset row has fewer than four fields: ${line}`);
		rows.push({
			file,
			seconds: seconds === "" ? null : Number(seconds),
			tests: Number(tests),
			status,
		});
	}
	return { meta, rows };
}

/** @param {ReturnType<typeof shares>} s */
function formatShares(s) {
	const lines = [
		`files: ${s.files} (${s.timedFiles} timed, ${s.untimedFiles} untimed)`,
		`file-seconds: ${s.totalSeconds}`,
		`median file: ${s.medianSeconds} s`,
	];
	for (const { top, sharePct } of s.slices)
		lines.push(`top ${top}: ${sharePct}%`);
	return lines.join("\n");
}

/**
 * `key=value` pairs into a metadata object, or the first argument that is not
 * one. Returned rather than thrown so the CLI owns the exit.
 *
 * @param {string[]} pairs
 * @returns {{ meta: Record<string, string>, bad: string|null }}
 */
function parseMeta(pairs) {
	/** @type {Record<string, string>} */
	const meta = {};
	for (const pair of pairs) {
		const at = pair.indexOf("=");
		if (at < 0) return { meta, bad: pair };
		meta[pair.slice(0, at)] = pair.slice(at + 1);
	}
	return { meta, bad: null };
}

module.exports = {
	SUITE_WORKFLOW,
	downloadReports,
	readNewestRun,
	readOrThrow,
	readSuiteRepo,
	timingSources,
	reportRoot,
	rowsFrom,
	readReports,
	shares,
	toCsv,
	parseCsv,
	formatShares,
	parseMeta,
};
