#!/usr/bin/env node

const fs = require("node:fs");
const { caught } = require("./lib/caught.js");
const { parseOrCode, flagValue } = require("./lib/cli-args.js");
const { gh } = require("./lib/gh.js");
const { formatReport, toJson } = require("./lib/pfn-scan.js");
const { earlierFlagged, scanDump } = require("./lib/pfn-scan-host.js");
const { scriptPath } = require("./lib/script-path.js");
const { requireKey } = require("./lib/workflow-core-config.js");
const { writeFd } = require("./lib/write-fd.js");

const USAGE = `usage: node ${scriptPath("pfn-scan.js")} <dump> [--combining <text>] [--post <issue>]`;

/**
 * @param {number} issue
 * @param {string} body
 */
function postComment(issue, body) {
	gh(
		[
			"issue",
			"comment",
			String(issue),
			"--repo",
			requireKey("tracker"),
			"--body-file",
			"-",
		],
		{ input: body, stdio: ["pipe", "pipe", "pipe"] },
	);
}

/**
 * @param {string} dump
 * @param {{combining?: string, post?: number}} opts
 * @returns {string}
 */
function scanAndReport(dump, { combining = "not recorded", post } = {}) {
	const earlier = earlierFlagged(dump);
	const scan = scanDump(dump);
	fs.writeFileSync(
		`${dump}.pfnscan.json`,
		`${JSON.stringify(toJson(scan), null, "\t")}\n`,
	);
	const report = formatReport(scan, {
		dump: dump.split("/").pop() ?? dump,
		combining,
		earlier,
	});
	if (post !== undefined) postComment(post, report);
	return report;
}

/** @param {string[]} [argv] */
function main(argv = process.argv.slice(2)) {
	const parsed = parseOrCode(argv, {
		usage: USAGE,
		min: 1,
		max: 1,
		flags: { "--combining": "value", "--post": "value" },
	});
	if (typeof parsed === "number") return parsed;
	const post = flagValue(parsed.flags, "--post");
	if (post !== undefined && !/^\d+$/.test(post)) {
		writeFd(2, `--post takes an issue number: ${post}\n\n${USAGE}\n`);
		return 2;
	}
	try {
		const report = scanAndReport(parsed.positionals[0] ?? "", {
			combining: flagValue(parsed.flags, "--combining"),
			post: post === undefined ? undefined : Number(post),
		});
		writeFd(1, `${report}\n`);
		return 0;
	} catch (e) {
		writeFd(2, `pfn-scan: ${caught(e).message}\n`);
		return 1;
	}
}

if (require.main === module) process.exitCode = main();

module.exports = { main, postComment, scanAndReport };
