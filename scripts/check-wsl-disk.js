#!/usr/bin/env node
/*
 * check-wsl-disk.js — say so when the monthly WSL disk compaction (#5044) has
 * gone quiet, on `npm run status`.
 *
 * WARNS where the last success in %LOCALAPPDATA%\wsl-compact.log is over 35
 * days old, the newest run failed, the last one ran untrimmed, the last sparse
 * watch failed, no log exists (the task is not registered), C: has under 40 GB
 * free, fstrim.timer has not fired in 14 days, or the log, C: or the timer
 * will not read (lib/wsl-disk.js's verdict).
 *
 * READS NO INTEROP (lib/wsl-disk-host.js).
 *
 * SKIPS where the kernel release carries no `microsoft`: not WSL. A kernel
 * release that will not read is WARN, never SKIP, which `npm run status` files
 * with the clean ones.
 *
 * WFC_PROC, WFC_WSL_COMPACT_LOG, WFC_WIN_C, WFC_SYSTEMCTL and WFC_NOW inject
 * each read (§N7).
 */

const { now, runCheck } = require("./lib/check");
const { judgeDisk } = require("./lib/wsl-disk.js");
const host = require("./lib/wsl-disk-host.js");

runCheck({
	name: "wsl-disk",
	usage: "node check-wsl-disk.js [--json]",
	run(ctx) {
		const kernel = host.readKernelRelease();
		if (typeof kernel === "string" && !/microsoft/i.test(kernel))
			ctx.skip("the kernel release carries no `microsoft`: not WSL.");
		/** @type {{tag: string, line: string}[]} */
		const unread =
			typeof kernel === "string"
				? []
				: [
						{
							tag: "KERNEL-UNREAD",
							line: `the kernel release would not read: ${kernel.why}.`,
						},
					];
		const verdict = judgeDisk({
			log: host.readCompactLog(),
			now: now(),
			freeGB: host.readFreeGB(),
			lastTrim: host.readLastTrim(),
		});
		const warnings = [...unread, ...verdict.warnings];
		if (warnings.length === 0)
			return { okLine: verdict.okLine, data: { okLine: verdict.okLine } };
		for (const w of warnings) {
			ctx.warn(w.tag, w.line);
			ctx.say(w.line);
		}
		return { noun: "WSL disk finding(s)", data: { warnings } };
	},
});
