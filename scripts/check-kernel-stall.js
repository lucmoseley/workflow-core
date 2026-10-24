#!/usr/bin/env node
/*
 * check-kernel-stall.js — say so when the WSL kernel has reported an RCU stall
 * on the CURRENT boot, because every stall this machine has logged was followed
 * by the VM dying within about twenty minutes (workflow-core#867).
 *
 * Usage:  node scripts/check-kernel-stall.js [--boot <n>] [--notify] [--json]
 *
 * THE SIGNAL is `rcu: INFO: rcu_<flavour> detected stalls` or `… self-detected
 * stall` in the kernel log since boot. `Clock change detected` lines do NOT
 * discriminate — healthy and dying boots alike carry them — so nothing here
 * keys on them.
 *
 * TWO READERS, both scanned: `journalctl -k -b`, whose short-iso stamps give a
 * wall-clock time, then `dmesg -T`, whose ring buffer still holds what a dead
 * journald missed (§7's 4 Oct entry): a journal with lines in it can still be
 * blind to the stall. A reader counts as
 * having read only where it exited 0 and printed a real line: journalctl
 * without permission prints `-- No entries --` and exits 0, and an empty log is
 * not a clean one. Each binary is injected at WFC_JOURNALCTL / WFC_DMESG (§N7).
 *
 * FAILS OPEN, SILENTLY. Neither reader present, permitted or answering inside
 * READ_TIMEOUT_MS is SKIP, which --notify prints nothing for. The kernel log is
 * subject, not apparatus (lib/check.js), and this check must never be why a
 * session or a launch is held up.
 *
 * A STALL IS FAIL, so a plain run exits 1 — the exit `scripts/dispatch-sessions.sh`
 * refuses a launch on (exit 5, beside the wedged bridge). Under --notify it
 * exits 0 like every session-start reporter and prints the warning.
 *
 * WFC_KERNEL_LOG replaces both readers with a file in journalctl's short-iso
 * shape, the seam lib/admission.js takes WFC_MEMINFO by; it ignores --boot, and
 * an unreadable or empty one is SKIP, as the readers are.
 *
 * --boot <n> reads an earlier boot, journalctl's offset (-1 the last), for the
 * post-incident question docs/environment.md §8 starts from: the boot that
 * died is never the one a session starts on. journalctl alone reads one —
 * dmesg holds only the current boot.
 *
 * IT NEVER RECOVERS ANYTHING. It prints `sync` and `wsl --shutdown` for a human
 * to run; running either itself would kill every live session on a false
 * positive — §9's rule for Guard 2.
 *
 * IMPLICIT:  at every session start, reads this boot's kernel log and, where it holds an RCU stall, prints that the VM is dying and the sync-then-shutdown recovery; prints nothing on a clean or unreadable log.
 * JUSTIFIED: fail-safe — nothing else tells a session the VM has twenty minutes left, and a log it cannot read is silence, never a warning.
 * DEFEAT:    none at the hook; a reboot of the VM clears it, the signal being per-boot.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const { runCheck } = require("./lib/check");
const { docPath } = require("./lib/script-path.js");

/** Per reader. Measured at 0.05s for a 15-hour boot's 542 lines; the rest is margin. */
const READ_TIMEOUT_MS = 5000;

/**
 * Per reader. The largest boot journalctl held on 8 Oct 2026 was 1.93 MB
 * (19,526 lines over five days); this is ~30x that, so only a boot of months
 * would overflow it — and an overflow is a read error, so SKIP, never "clean".
 */
const MAX_BUFFER = 64 * 1024 * 1024;

const STALL = /\brcu: INFO: rcu_\w+ (?:detected stalls|self-detected stall)/;

/** @param {string} boot */
const readers = (boot) => ({
	journal: {
		cmd: process.env.WFC_JOURNALCTL || "journalctl",
		args: ["-k", "-b", boot, "--no-pager", "-o", "short-iso"],
		// `2026-10-07T22:43:24+08:00 host kernel: …`
		time: (/** @type {string} */ line) => line.split(/\s+/)[0],
	},
	dmesg: {
		cmd: process.env.WFC_DMESG || "dmesg",
		args: ["-T"],
		// `[Wed Oct  7 22:43:24 2026] …`
		time: (/** @type {string} */ line) =>
			(line.match(/^\[([^\]]+)\]/)?.[1] ?? "").replace(/\s+/g, " "),
	},
});
/** @typedef {ReturnType<typeof readers>["journal"]} Reader */

/**
 * Every reader that read, with its real lines — empty where none did.
 * @param {string} boot
 * @returns {{ reader: Reader, lines: string[] }[]}
 */
function readKernelLog(boot) {
	const { journal, dmesg } = readers(boot);
	const fixture = process.env.WFC_KERNEL_LOG;
	if (fixture) {
		let text;
		try {
			text = fs.readFileSync(fixture, "utf8");
		} catch {
			return [];
		}
		const lines = realLines(text);
		return lines.length > 0 ? [{ reader: journal, lines }] : [];
	}
	const logs = [];
	for (const reader of boot === "0" ? [journal, dmesg] : [journal]) {
		const res = spawnSync(reader.cmd, reader.args, {
			encoding: "utf8",
			timeout: READ_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "ignore"],
			maxBuffer: MAX_BUFFER,
		});
		if (res.error || res.status !== 0) continue;
		const lines = realLines(res.stdout);
		if (lines.length > 0) logs.push({ reader, lines });
	}
	return logs;
}

/** @param {string} text */
const realLines = (text) =>
	text.split("\n").filter((l) => l.trim() && !/^(?:-- |Hint:)/.test(l));

runCheck({
	name: "kernel-stall",
	usage: "node check-kernel-stall.js [--boot <n>] [--notify] [--json]",
	valueFlags: ["--boot"],
	run(ctx) {
		const boot = ctx.value("--boot", "0");
		if (!/^-?\d+$/.test(boot))
			ctx.usageError("--boot takes journalctl's boot offset: 0, -1, -2 …");
		const logs = readKernelLog(boot);
		if (logs.length === 0)
			ctx.skip(
				`no reader would return boot ${boot}'s kernel log, so whether it stalled is unknown — not no.`,
			);

		// The first reader to hold a stall answers; journalctl's stamps are preferred.
		const hit = logs
			.map(({ reader, lines }) => ({
				reader,
				stalls: lines.filter((l) => STALL.test(l)),
			}))
			.find((h) => h.stalls.length);
		const stalls = hit ? hit.stalls : [];
		const [firstStall] = stalls;
		if (hit && firstStall !== undefined) {
			const first = hit.reader.time(firstStall) || "an unknown time";
			ctx.fail(
				"KERNEL-STALL",
				`the kernel reported ${stalls.length} RCU stall(s) on boot ${boot}, the first at ${first}`,
				{ first, count: stalls.length, reader: hit.reader.cmd },
			);
			if (boot === "0")
				ctx.say(
					`KERNEL-STALL — this WSL VM is unhealthy: the kernel reported an RCU stall at ${first}` +
						`${stalls.length > 1 ? ` (${stalls.length} so far)` : ""}.\n` +
						`  Every stall logged here has ended the VM within ~20 minutes (${docPath("environment.md")} §7).\n` +
						"  Finish or commit what you can now, then:\n" +
						"    sync                      # in WSL — flushes writes `wsl --shutdown` would discard\n" +
						"    wsl --shutdown            # in Windows PowerShell, then reopen the terminal\n" +
						"  Nothing was shut down; this check only reports.\n",
				);
			else
				ctx.say(
					`KERNEL-STALL — boot ${boot} reported ${stalls.length} RCU stall(s), the first at ${first}.\n` +
						`  Every stall logged here has ended its boot within ~20 minutes (${docPath("environment.md")} §7).\n`,
				);
		}

		const read = logs.reduce((n, l) => n + l.lines.length, 0);
		return {
			okLine: `no RCU stall in ${read} kernel log line(s) on boot ${boot}.`,
			noun: "RCU stall(s)",
			count: stalls.length,
			data: {
				boot,
				readers: logs.map((l) => l.reader.cmd),
				lines: read,
				stalls: stalls.length,
			},
		};
	},
});
