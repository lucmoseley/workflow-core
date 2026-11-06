#!/usr/bin/env node
/*
 * retry-failed-files.js — re-runs, once, the test files a Vitest JSON report
 * marks failed, so a lander batch's flake costs one more step in the same
 * Actions job rather than a second run (#4545).
 *
 *   node scripts/retry-failed-files.js <report.json>
 *
 * ci.yml's "Retry failed files" step runs it on a `lander/batch` push after
 * a failed Vitest step. The re-run writes its own report beside the first,
 * which stays the uploaded one. Its last line
 * names the files still failing, `STILL_FAILING` below: lib/actions-tester.js
 * takes the batch's failing files from that line alone, since `--log-failed`
 * also prints the first run's failures from the step that went on past them.
 *
 * In no family: it gates nothing itself, its exit being the re-run's, and
 * writes no file of the repo's (§N3).
 *
 * Exit codes: the re-run's own; 1 where the report is missing, will not parse
 * or marks no file failed; 2 on a command line it refuses.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { parseOrCode } = require("./lib/cli-args.js");
const { reportRoot } = require("./lib/suite-timings.js");
const { writeFd } = require("./lib/write-fd.js");

/* The line lib/actions-tester.js reads the batch's failing files from. */
const STILL_FAILING = "retry-failed-files: still failing after one retry:";

/**
 * The repo-relative files the report at `file` marks failed, else why none.
 * @param {string} file
 * @param {string} root
 * @returns {{files: string[]} | {why: string}}
 */
function readFailedFiles(file, root) {
	if (!fs.existsSync(file)) return { why: `no report at ${file}` };
	/** @type {{testResults?: {name?: unknown, status?: unknown}[]}} */
	let parsed;
	try {
		parsed = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return { why: `the report at ${file} does not parse` };
	}
	/* An isolated worktree's run names its files under that tree (#4560). */
	const under = reportRoot(parsed, root, (rel) =>
		fs.existsSync(path.join(root, rel)),
	);
	return {
		files: (parsed.testResults ?? []).flatMap((r) =>
			r.status === "failed" && typeof r.name === "string"
				? [path.relative(under, r.name)]
				: [],
		),
	};
}

/** @param {string[]} [argv] @returns {number} */
function main(argv = process.argv.slice(2)) {
	const parsed = parseOrCode(argv, {
		usage: "usage: node scripts/retry-failed-files.js <report.json>",
		min: 1,
	});
	if (typeof parsed === "number") return parsed;
	const [report = ""] = parsed.positionals;
	const root = process.cwd();
	const first = readFailedFiles(report, root);
	if ("why" in first || first.files.length === 0) {
		const why = "why" in first ? first.why : "the report marks no file failed";
		writeFd(2, `retry-failed-files: ${why}: nothing to re-run.\n`);
		return 1;
	}
	writeFd(
		1,
		`retry-failed-files: re-running ${first.files.length} failed file(s) once: ${first.files.join(", ")}\n`,
	);
	const retryReport = report.replace(/(\.json)?$/, ".retry.json");
	const r = spawnSync("npm", ["run", "test", "--", ...first.files], {
		cwd: root,
		stdio: "inherit",
		env: { ...process.env, WFC_VITEST_JSON: retryReport },
	});
	const code = r.status ?? 1;
	const again = readFailedFiles(retryReport, root);
	/* A failed re-run whose report is unread or names no failure leaves the
	 * first run's files standing. */
	let still = code === 0 ? [] : first.files;
	if (code !== 0 && !("why" in again) && again.files.length > 0)
		still = again.files;
	writeFd(
		1,
		`${STILL_FAILING} ${still.length > 0 ? still.join(", ") : "none"}\n`,
	);
	return code;
}

if (require.main === module) process.exit(main());

module.exports = { main, STILL_FAILING };
