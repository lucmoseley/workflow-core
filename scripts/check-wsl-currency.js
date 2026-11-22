#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./lib/caught.js");
const { runCheck } = require("./lib/check");
const { ghJson, parseErrLine } = require("./lib/gh");
const { procRoot } = require("./lib/proc-root.js");
const { RELEASE_READS, judgeCurrency } = require("./lib/wsl-currency.js");
const {
	WSL_BUDGET_MS,
	WSL_EXE,
	readInstalled,
} = require("./lib/wsl-version.js");

// #4082 guess
const GH_BUDGET_MS = 80_000;

function readKernelRelease() {
	try {
		return fs.readFileSync(
			path.join(procRoot(), "sys/kernel/osrelease"),
			"utf8",
		);
	} catch (e) {
		const { code, message } = caught(e);
		return code === "ENOENT" ? "" : { why: message };
	}
}

/**
 * @param {string[]} args
 * @returns {any}
 */
function readRelease(args) {
	try {
		return ghJson(args, { timeout: GH_BUDGET_MS });
	} catch (e) {
		return { why: parseErrLine(e) };
	}
}

runCheck({
	name: "wsl-currency",
	usage: "node check-wsl-currency.js [--json]",
	run(ctx) {
		const { state, lines } = judgeCurrency({
			readKernelRelease,
			readInstalled: () =>
				readInstalled(process.env.WFC_WSL_EXE || WSL_EXE, WSL_BUDGET_MS),
			readLatest: () => readRelease(RELEASE_READS.latest),
			readReleases: () => readRelease(RELEASE_READS.releases),
		});
		if (state === "NOT_WSL") ctx.skip(lines.join(" "));
		if (state === "CURRENT")
			return { okLine: lines.join(" "), data: { state, lines } };
		ctx.warn(state === "BEHIND" ? "WSL-BEHIND" : "WSL-UNREAD", lines.join(" "));
		for (const line of lines) ctx.say(line);
		return { noun: "WSL currency finding(s)", data: { state, lines } };
	},
});
