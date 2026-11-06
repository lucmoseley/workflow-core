#!/usr/bin/env node
/*
 * retry-failed-files.js — re-runs, once, the test files a Vitest JSON report
 * marks failed, so a lander run's flake costs one more step in the same
 * Actions job rather than a second run (#4545).
 *
 *   node scripts/retry-failed-files.js <report.json>
 *
 * ci.yml's "Retry failed files" step runs it on a `lander/*` push after a
 * failed Vitest step. A file the re-run passes is the green the lander's own
 * re-run would give; one it fails again the lander reads off this step's log,
 * and takes no re-run of its own (lib/actions-tester.js's `retried`).
 *
 * Exit codes: the re-run's own; 1 where the report is missing, will not parse
 * or marks no file failed, as the shard then failed with no test to re-run;
 * 2 on a command line it refuses.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { parseOrCode } = require("./lib/cli-args.js");
const { writeFd } = require("./lib/write-fd.js");

/**
 * The repo-relative files `report` marks failed, else why none.
 * @param {string} report a Vitest JSON report's text
 * @param {string} root
 * @returns {{files: string[]} | {why: string}}
 */
function failedFiles(report, root) {
	/** @type {{testResults?: {name?: unknown, status?: unknown}[]}} */
	let parsed;
	try {
		parsed = JSON.parse(report);
	} catch {
		return { why: "the report does not parse" };
	}
	const files = (parsed.testResults ?? []).flatMap((r) =>
		r.status === "failed" && typeof r.name === "string"
			? [path.relative(root, r.name)]
			: [],
	);
	return files.length > 0
		? { files }
		: { why: "the report marks no file failed" };
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
	const read = fs.existsSync(report)
		? failedFiles(fs.readFileSync(report, "utf8"), root)
		: { why: `no report at ${report}` };
	if ("why" in read) {
		writeFd(2, `retry-failed-files: ${read.why}: nothing to re-run.\n`);
		return 1;
	}
	writeFd(
		1,
		`retry-failed-files: re-running ${read.files.length} failed file(s) once (#4545): ${read.files.join(", ")}\n`,
	);
	const r = spawnSync("npm", ["run", "test", "--", ...read.files], {
		cwd: root,
		stdio: "inherit",
		env: { ...process.env, WFC_VITEST_JSON: "" },
	});
	return r.status ?? 1;
}

if (require.main === module) process.exit(main());

module.exports = { failedFiles, main };
