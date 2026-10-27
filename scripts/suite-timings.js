#!/usr/bin/env node
/*
 * suite-timings.js — the CLI over scripts/lib/suite-timings.js. `extract`
 * turns one vitest JSON run into a tracked per-file dataset; `shares`
 * recomputes the percentile table from a dataset already committed.
 *
 * IT JOINS NO FAMILY (§G4, §N3, mantahostels#2039). It gates nothing, so it is no
 * `check-*` and owes none of that alphabet; it is not a hook, so it is no
 * `guard-*`; `generate-*` fits `extract` and not `shares`, which writes
 * nothing. Exit is 0 or 1 — never 2, which would read as `check-*`'s BROKEN
 * from a script outside that contract.
 */

const fs = require("node:fs");
const path = require("node:path");
const { parseOrCode } = require("./lib/cli-args.js");
const { writeFd } = require("./lib/write-fd.js");
const {
	reportRoot,
	rowsFrom,
	shares,
	toCsv,
	parseCsv,
	formatShares,
	parseMeta,
} = require("./lib/suite-timings.js");
const { hostRoot } = require("./lib/host-root.js");

const USAGE = `Usage:
  node scripts/suite-timings.js extract <vitest.json|dir> <out.csv> [key=value ...]
  node scripts/suite-timings.js shares <dataset.csv>

Produce the JSON with:
  npm run test -- --full=<cause> --reporter=default --reporter=json --outputFile.json=<vitest.json>
A dir merges every *.json under it, as one sharded run's reports:
  gh run download <run-id> -R lucmoseley/workflow-core -p 'vitest-report-*' -D <dir>
`;

const CLI = {
	usage: USAGE,
	commands: {
		extract: { usage: USAGE, min: 2, max: Number.POSITIVE_INFINITY },
		shares: { usage: USAGE, min: 1 },
	},
};

/*
 * writeFd, not console (§N6). Every path here precedes process.exit, and
 * this script is read from Bash by an agent, whose stdout is a pipe — node
 * drops whatever is still buffered to a pipe when the process exits.
 */
/** @param {string} s */
const out = (s) => writeFd(1, `${s}\n`);
/** @param {string} s */
const err = (s) => writeFd(2, `${s}\n`);

/* The vitest report's file names are host-repo paths, so they are relativised
 * against the host root (#1), never `__dirname` — a plugin install's own
 * checkout is not the tree the suite ran over. */
const ROOT = hostRoot();

/**
 * The rows of one vitest JSON report, or of every report under a directory,
 * as the shard jobs of one Actions run upload them (#2413). Each report is
 * relativised on its own: every shard ran in a checkout of its own.
 * @param {string} source
 * @returns {ReturnType<typeof rowsFrom>}
 */
function readRows(source) {
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
			reportRoot(report, ROOT, (rel) => fs.existsSync(path.join(ROOT, rel))),
		);
	});
	rows.sort((a, b) => (b.seconds ?? -1) - (a.seconds ?? -1));
	return rows;
}

/**
 * @param {string[]} argv
 * @returns {number} exit code
 */
function main(argv = process.argv.slice(2)) {
	const parsed = parseOrCode(argv, CLI);
	/* A refusal exits 1, never cli-args' 2 (see the header). */
	if (typeof parsed === "number") return parsed === 0 ? 0 : 1;
	const { command, positionals } = parsed;
	if (command === "extract") {
		const [source, target, ...pairs] = positionals;
		if (source === undefined || target === undefined)
			throw new Error("parseOrCode's min: 2 let a missing path through");
		const { meta, bad } = parseMeta(pairs);
		if (bad !== null) {
			err(
				`suite-timings: "${bad}" is not key=value — metadata is written as run=... sha=...`,
			);
			return 1;
		}
		const rows = readRows(source);
		fs.writeFileSync(target, toCsv(rows, meta));
		out(`${rows.length} files → ${target}`);
		out(formatShares(shares(rows)));
		return 0;
	}
	const [source] = positionals;
	if (source === undefined)
		throw new Error("parseOrCode's min: 1 let a missing <dataset.csv> through");
	out(formatShares(shares(parseCsv(fs.readFileSync(source, "utf8")).rows)));
	return 0;
}

/* Exports nothing (§N7): the seam is scripts/lib/suite-timings.js, and the
 * test drives this file end to end through scripts/lib/run-in-process.js,
 * which loads it as the entry module so this guard fires as it does under
 * node. */
if (require.main === module) process.exit(main());
