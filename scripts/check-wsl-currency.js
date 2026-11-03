#!/usr/bin/env node
/*
 * check-wsl-currency.js — say so when this machine's WSL is behind upstream's
 * latest stable release (#4082), on `npm run status` and in the morning review.
 *
 * WARNS at one stable release behind, with no grace period. That threshold is
 * a judgement with no source, untraced. A version ahead of the latest, a
 * pre-release, is OK.
 *
 * A READ THAT FAILS IS WARN, never OK and never SKIP: `npm run status` files a
 * SKIP with the clean ones.
 *
 * SKIPS where the kernel release string carries no `microsoft`: not WSL. It
 * never decides that from wsl.exe being absent, which on WSL means interop off.
 *
 * IT NEVER UPDATES. An update ends every session, so its timing is the
 * founder's; the WARN prints the commands.
 *
 * RESIDUAL: the count reads upstream's newest 100 releases, pre-releases
 * included, so a machine further behind than that undercounts. The WARN stands.
 *
 * WFC_OSRELEASE, WFC_WSL_EXE and WFC_GH inject each read (§N7).
 */

const fs = require("node:fs");
const { caught } = require("./lib/caught.js");
const { runCheck } = require("./lib/check");
const { ghJson, parseErrLine } = require("./lib/gh");
const { RELEASE_READS, judgeCurrency } = require("./lib/wsl-currency.js");
const {
	WSL_BUDGET_MS,
	WSL_EXE,
	readInstalled,
} = require("./lib/wsl-version.js");

/**
 * With wsl.exe's budget, the two reads fit the morning review's 3 minutes.
 */
const GH_BUDGET_MS = 80_000;

function readKernelRelease() {
	try {
		return fs.readFileSync(
			process.env.WFC_OSRELEASE || "/proc/sys/kernel/osrelease",
			"utf8",
		);
	} catch (e) {
		const { code, message } = caught(e);
		// No such file: no /proc, so not Linux, so not WSL.
		return code === "ENOENT" ? "" : { why: message };
	}
}

/**
 * `any`: the shape is the endpoint's, which the core judges.
 * @param {string[]} args
 * @returns {any}
 */
function readRelease(args) {
	try {
		return ghJson(args, { timeout: GH_BUDGET_MS });
	} catch (e) {
		// Reported, not swallowed: the core names the read and this reason.
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
		if (state === "NOT_WSL")
			ctx.skip(
				"the kernel release carries no `microsoft`, so this is not WSL.",
			);
		if (state === "CURRENT")
			return { okLine: lines.join(" "), data: { state, lines } };
		ctx.warn(state === "BEHIND" ? "WSL-BEHIND" : "WSL-UNREAD", lines.join(" "));
		for (const line of lines) ctx.say(line);
		return { noun: "WSL currency finding(s)", data: { state, lines } };
	},
});
