const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { caught } = require("./caught.js");
const { gh, ghJson, retryingOnceSync } = require("./gh.js");
const { resolveKey } = require("./workflow-core-config.js");

const SUITE_WORKFLOW = "scheduled-checks.yml";

// guess: past the first few green runs no report is coming, workflow-core#4579
const SOURCES_TRIED = 5;
const RUNS_LISTED = 30;

const META_PREFIX = "# ";

/**
 * The slices https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/suite-file-timings.md tabulates, so a default run
 * reproduces that table's rows and no others. Any other set is the caller's.
 */
const DEFAULT_SLICES = [5, 10, 20, 50, 100];

/**
 * @param {{ testResults?: unknown[] }} report
 * @param {string} root
 * @param {(relative: string) => boolean} exists
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
 * @param {{ testResults?: unknown[] }} report
 * @param {string} root
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

const NO_ARTEFACTS = /no valid artifacts found/i;

/**
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
 * @param {string} source
 * @param {string} root
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

// workflow-core#4574 guess
const SETTLE_MS = 120_000;

/**
 * @typedef {{ id: number, status: string, conclusion: string|null,
 *   created_at: string, updated_at: string }} ListedRun
 */

/**
 * @param {ListedRun[]} runs
 * @param {number} before
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
 * @param {string} repo
 * @param {number} before
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
 * @param {{ seconds: number|null }[]} rows
 * @param {number[]} [slices]
 */
function shares(rows, slices = DEFAULT_SLICES) {
	const timed = rows
		.filter((r) => r.seconds !== null)
		.map((r) => /** @type {number} */ (r.seconds))
		.sort((a, b) => b - a);
	const total = timed.reduce((a, b) => a + b, 0);
	const ascending = [...timed].sort((a, b) => a - b);
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

/** @param {string} text */
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
