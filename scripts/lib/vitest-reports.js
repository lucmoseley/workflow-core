/*
 * vitest-reports.js — the per-file rows of one vitest JSON report, or of
 * every report under a directory, as one sharded Actions run's shards upload
 * them (`vitest-report-*`, #2413).
 */

const fs = require("node:fs");
const path = require("node:path");
const { reportRoot, rowsFrom } = require("./suite-timings.js");

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

module.exports = { readReports };
