#!/usr/bin/env node
const fs = require("node:fs");
const { scriptPath } = require("./lib/script-path.js");
const { caught } = require("./lib/caught.js");
const { parseOrCode } = require("./lib/cli-args.js");
const { ghJson } = require("./lib/gh.js");
const { writeFd } = require("./lib/write-fd.js");
const {
	readNewestRun,
	readOrThrow,
	readSuiteRepo,
	readReports,
	shares,
	toCsv,
	parseCsv,
	formatShares,
	parseMeta,
} = require("./lib/suite-timings.js");
const { worktreeRoot } = require("./lib/host-root.js");

const USAGE = `Usage:
  node ${scriptPath("suite-timings.js")} extract <vitest.json|dir> <out.csv> [key=value ...]
  node ${scriptPath("suite-timings.js")} latest <out.csv> [--before-run <run-id>]
  node ${scriptPath("suite-timings.js")} shares <dataset.csv>

Produce the JSON with:
  WFC_VITEST_JSON=<vitest.json> npm run test -- --full=<cause>
A dir merges every *.json under it, as one sharded run's reports:
  gh run download <run-id> -R lucmoseley/workflow-core -p 'vitest-report-*' -D <dir>
`;

/** @type {import("./lib/cli-args.js").CliSpec} */
const CLI = {
	usage: USAGE,
	commands: {
		extract: { usage: USAGE, min: 2, max: Number.POSITIVE_INFINITY },
		latest: { usage: USAGE, min: 1, flags: { "--before-run": "value" } },
		shares: { usage: USAGE, min: 1 },
	},
};

/** @param {string} s */
const out = (s) => writeFd(1, `${s}\n`);
/** @param {string} s */
const err = (s) => writeFd(2, `${s}\n`);

const ROOT = worktreeRoot();

/** @param {string|undefined} beforeRun */
function latestRows(beforeRun) {
	const repo = readSuiteRepo(ROOT);
	const before =
		beforeRun === undefined
			? Date.now()
			: Date.parse(
					readOrThrow(() =>
						ghJson(["api", `repos/${repo}/actions/runs/${beforeRun}`]),
					).created_at,
				);
	if (!Number.isFinite(before))
		throw new Error(`run ${beforeRun} has no creation time`);
	return readNewestRun(repo, before, ROOT);
}

const annotation = process.env.GITHUB_ACTIONS ? "::warning::" : "";

/**
 * @param {string} target
 * @param {string|undefined} beforeRun
 * @returns {number}
 */
function latest(target, beforeRun) {
	let found;
	try {
		found = latestRows(beforeRun);
	} catch (e) {
		err(
			`${annotation}suite-timings: no run read (${caught(e).message.trim()})`,
		);
		found = null;
	}
	if (found === null || found.rows === null) {
		err(
			`${annotation}suite-timings: no timings read — this shard plans by file count`,
		);
		fs.writeFileSync(target, toCsv([], { run: "none" }));
		out(`an empty dataset → ${target}`);
		return 0;
	}
	fs.writeFileSync(
		target,
		toCsv(found.rows, { run: found.run, sha: found.sha }),
	);
	out(`${found.rows.length} files from run ${found.run} → ${target}`);
	return 0;
}

/**
 * @param {string[]} argv
 * @returns {number}
 */
function main(argv = process.argv.slice(2)) {
	const parsed = parseOrCode(argv, CLI);
	if (typeof parsed === "number") return parsed === 0 ? 0 : 1;
	const { command, positionals, flags } = parsed;
	if (command === "latest") {
		const [target] = positionals;
		if (target === undefined)
			throw new Error("parseOrCode's min: 1 let a missing <out.csv> through");
		const beforeRun = flags["--before-run"];
		return latest(
			target,
			typeof beforeRun === "string" ? beforeRun : undefined,
		);
	}
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
		const rows = readReports(source, ROOT);
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

if (require.main === module) process.exit(main());
