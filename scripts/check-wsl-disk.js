#!/usr/bin/env node
/*
 * check-wsl-disk.js — say so when the monthly WSL disk compaction (#5044) has
 * gone quiet, on `npm run status`: a missed or failed run re-fills C: with no
 * other sign.
 *
 * WARNS where the last success in %LOCALAPPDATA%\wsl-compact.log is over 35
 * days old, the newest run failed, no log exists (the task is not
 * registered), or C: has under 40 GB free (lib/wsl-disk.js's figures).
 *
 * READS NO INTEROP: the log and C:'s free space come off the /mnt/c mount, so
 * a wedged bridge cannot hang it.
 *
 * SKIPS where the kernel release carries no `microsoft`: not WSL.
 *
 * WFC_WSL_COMPACT_LOG names the log, WFC_WIN_C the mount, WFC_PROC /proc (§N7).
 */

const fs = require("node:fs");
const path = require("node:path");
const { runCheck } = require("./lib/check");
const { procRoot } = require("./lib/proc-root.js");
const disk = require("./lib/wsl-disk.js");

function isWsl() {
	try {
		return /microsoft/i.test(
			fs.readFileSync(path.join(procRoot(), "sys/kernel/osrelease"), "utf8"),
		);
	} catch {
		return false;
	}
}

runCheck({
	name: "wsl-disk",
	usage: "node check-wsl-disk.js [--json]",
	run(ctx) {
		if (!isWsl())
			ctx.skip("the kernel release carries no `microsoft`: not WSL.");
		const logPath = disk.findLog();
		const entries =
			logPath === null ? null : disk.parseLog(fs.readFileSync(logPath, "utf8"));
		const { warnings, okLine } = disk.judgeDisk({
			entries,
			now: Date.now(),
			freeGB: disk.readFreeGB(),
		});
		if (warnings.length === 0) return { okLine, data: { okLine } };
		for (const w of warnings) {
			ctx.warn(w.tag, w.line);
			ctx.say(w.line);
		}
		return { noun: "WSL disk finding(s)", data: { warnings } };
	},
});
