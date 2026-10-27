/*
 * suite-timings.js — the pure half of the per-file suite-timing dataset:
 * vitest JSON in, rows out; rows in, percentile shares out; and the CSV
 * serialisation between them. `scripts/suite-timings.js` is the CLI over it.
 *
 * It exists so the suite-file-timings note's percentile table can be
 * recomputed rather than merely quoted (mantahostels#2039), docs/agents/guard-registry.md §Conventions resting
 * a live rule on it.
 *
 * DURATION IS endTime - startTime PER FILE, which is wall time inside the
 * worker and so overlaps across workers: the file-seconds total exceeds the
 * run's wall clock by roughly the worker count. That is deliberately what the
 * shares are fractions of — a share of wall clock would depend on scheduling
 * luck rather than on the files.
 */

const path = require("node:path");

/** Metadata lines are `# key: value` above the header row. */
const META_PREFIX = "# ";

/**
 * The slices https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/suite-file-timings.md tabulates, so a default run
 * reproduces that table's rows and no others. Any other set is the caller's.
 */
const DEFAULT_SLICES = [5, 10, 20, 50, 100];

/**
 * The checkout a report's file names sit under: `root` where every name is
 * inside it, else the ancestor of its names under which the most of them
 * name a file `exists` finds in this checkout. A report from an Actions
 * runner names files under the runner's own worktree, not this one, and a
 * shard's files can all share a subdirectory, so no common prefix is safe
 * (#2413).
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
	if (names.every((n) => n.startsWith(`${root}${path.sep}`))) return root;
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
 * A FILE MISSING EITHER TIMESTAMP IS KEPT WITH A NULL DURATION, never dropped
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
		const start = Number(r.startTime);
		const end = Number(r.endTime);
		const timed = Number.isFinite(start) && Number.isFinite(end);
		return {
			file: path.relative(root, String(r.name ?? "")),
			seconds: timed ? Math.round((end - start) / 10) / 100 : null,
			tests: Array.isArray(r.assertionResults) ? r.assertionResults.length : 0,
			status: String(r.status ?? "unknown"),
		};
	});
	rows.sort((a, b) => (b.seconds ?? -1) - (a.seconds ?? -1));
	return rows;
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
	reportRoot,
	rowsFrom,
	shares,
	toCsv,
	parseCsv,
	formatShares,
	parseMeta,
};
