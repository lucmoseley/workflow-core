#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const { scriptPath } = require("./lib/script-path.js");
const fs = require("node:fs");
const path = require("node:path");
const { parseOrCode } = require("./lib/cli-args.js");
const { readText } = require("./lib/file-read.js");
const { CLEARED, STILL_FAILING } = require("./lib/suite-output.js");
const { reportRoot } = require("./lib/suite-timings.js");
const { writeFd } = require("./lib/write-fd.js");

/** @param {string[]} files */
const buildFileList = (files) => (files.length > 0 ? files.join(", ") : "none");

/**
 * @param {string} file
 * @param {string} root
 * @returns {{files: string[]} | {why: string}}
 */
function readFailedFiles(file, root) {
	const read = readText(file);
	if (read.state === "absent") return { why: `no report at ${file}` };
	if (read.state === "unreadable")
		return { why: `the report at ${file} cannot be read: ${read.message}` };
	/** @type {{testResults?: {name?: unknown, status?: unknown}[]}} */
	let parsed;
	try {
		parsed = JSON.parse(read.data);
	} catch {
		return { why: `the report at ${file} does not parse` };
	}
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
		usage: `usage: node ${scriptPath("retry-failed-files.js")} <report.json>`,
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
	let still = code === 0 ? [] : first.files;
	if (code !== 0 && !("why" in again) && again.files.length > 0)
		still = again.files;
	const cleared = first.files.filter((f) => !still.includes(f));
	writeFd(
		1,
		`${CLEARED} ${buildFileList(cleared)}\n${STILL_FAILING} ${buildFileList(still)}\n`,
	);
	return code;
}

if (require.main === module) process.exit(main());

module.exports = { main };
