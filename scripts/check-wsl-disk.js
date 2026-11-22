#!/usr/bin/env node

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
			guest: host.readGuestDisk(),
			trim: { last: host.readLastTrim(), fixedAt: host.readTrimFixedAt() },
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
