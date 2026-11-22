#!/usr/bin/env node
// cli-args-exempt: #5150

const { fileIssue, FileIssueCrash } = require("./lib/file-issue-core.js");
const { buildHostPorts } = require("./lib/file-issue-host.js");
const { writeFd } = require("./lib/write-fd.js");

/** @param {import("./lib/file-issue-core.js").Outcome} written */
const write = ({ stdout, stderr }) => {
	if (stdout) writeFd(1, stdout);
	if (stderr) writeFd(2, stderr);
};

try {
	const outcome = fileIssue(process.argv.slice(2), buildHostPorts());
	write(outcome);
	process.exitCode = outcome.code;
} catch (e) {
	if (!(e instanceof FileIssueCrash)) throw e;
	write(e.written);
	throw e.cause;
}
