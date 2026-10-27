#!/usr/bin/env node
/*
 * check-kernel-stall.js — say so when the WSL VM is unhealthy, on either of
 * two signals: an RCU stall on the CURRENT boot (workflow-core#867), or a frozen scheduler
 * clock right now (workflow-core#2779). The 4 and 7 Oct 2026 stalls ended the VM within
 * ~20 minutes; the 23 Oct boot ran degraded for 2 h 10 min after its first,
 * until shut down by hand.
 *
 * Usage:  node scripts/check-kernel-stall.js [--boot <n>] [--notify] [--json]
 *
 * THE STALL SIGNAL is `rcu: INFO: rcu_<flavour> detected stalls` or `… self-detected
 * stall` in the kernel log since boot.
 *
 * TWO READERS, both scanned: `journalctl -k -b`, whose short-iso stamps give a
 * wall-clock time, then `dmesg -T`, whose ring buffer still holds what a dead
 * journald missed (§7's 4 Oct entry): a journal with lines in it can still be
 * blind to the stall. A reader counts as
 * having read only where it exited 0 and printed a real line: journalctl
 * without permission prints `-- No entries --` and exits 0, and an empty log is
 * not a clean one. Each binary is injected at WFC_JOURNALCTL / WFC_DMESG (§N7).
 *
 * THE CLOCK SIGNAL reads each CPU's `rq_cpu_time` (`/proc/schedstat` field 7,
 * ns) and the non-idle ticks in `/proc/stat`, CLOCK_WAIT_MS apart. A backward `sched_clock` step on arm64 holds
 * every run queue's clock still while the CPUs stay busy (workflow-core#2708), so the clock
 * is frozen where the machine was busy for at least MIN_BUSY_S and the run
 * queues' clocks advanced under FROZEN_RATIO of it. --boot reads no clock.
 *
 * FAILS OPEN, SILENTLY. Neither reader present, permitted or answering inside
 * READ_TIMEOUT_MS, with no clock read showing a freeze, is SKIP, which --notify
 * prints nothing for; an unreadable or absent `/proc` file is the same. The
 * kernel is subject, not apparatus (lib/check.js), and this check must never be
 * why a session or a launch is held up.
 *
 * A STALL OR A FREEZE IS FAIL, so a plain run exits 1 — the exit
 * `scripts/dispatch-sessions.sh` refuses a launch on (exit 5, beside the wedged
 * bridge). Under --notify it exits 0 like every session-start reporter and
 * prints the warning.
 *
 * WFC_KERNEL_LOG replaces both readers with a file in journalctl's short-iso
 * shape, the seam lib/admission.js takes WFC_MEMINFO by; it ignores --boot, and
 * an unreadable or empty one is SKIP, as the readers are. WFC_SCHED_CLOCK
 * replaces the clock's reads with a directory holding `before/` and `after/`,
 * each with a `schedstat` and a `stat` in `/proc`'s shape, and takes no wait.
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
 * IMPLICIT:  at every session start, reads this boot's kernel log and the scheduler clock over 1 s and, where the log holds an RCU stall or the clock is frozen, prints that the VM is unhealthy and the sync-then-shutdown recovery; prints nothing on a clean or unreadable reading.
 * JUSTIFIED: fail-safe — nothing else tells a session the VM is unhealthy, and a reading it cannot take is silence, never a warning.
 * DEFEAT:    none at the hook; a reboot of the VM clears a stall, the signal being per-boot, and a freeze clears once the clock moves.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const { runCheck } = require("./lib/check");
const { docPath } = require("./lib/script-path.js");
const { sleepSync } = require("./lib/sleep-sync.js");

/** Per reader. Measured at 0.05s for a 15-hour boot's 542 lines; the rest is margin. */
const READ_TIMEOUT_MS = 5000;

/**
 * Per reader. The largest boot journalctl held on 8 Oct 2026 was 1.93 MB
 * (19,526 lines over five days); this is ~30x that, so only a boot of months
 * would overflow it — and an overflow is a read error, so SKIP, never "clean".
 */
const MAX_BUFFER = 64 * 1024 * 1024;

/** Long enough that a healthy machine's ratio sits at 1.00–1.10. */
const CLOCK_WAIT_MS = 1000;

/**
 * Under this the machine was too idle for the run-queue clocks to say anything.
 * Untraced: set at workflow-core#2712, unmeasured below load 19.
 */
const MIN_BUSY_S = 0.5;

/**
 * Untraced: set at workflow-core#2712 well below healthy (1.00–1.10) and above frozen (0).
 */
const FROZEN_RATIO = 0.1;

/** `/proc/stat`'s tick unit, USER_HZ, which Linux fixes at 100 on arm64 and x86. */
const USER_HZ = 100;

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
		const lines = parseRealLines(text);
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
		const lines = parseRealLines(res.stdout);
		if (lines.length > 0) logs.push({ reader, lines });
	}
	return logs;
}

/**
 * One reading of the summed run-queue clocks and the machine's busy time, both
 * in seconds; null where either file is absent, unreadable or not in shape.
 * @param {string} schedstatPath
 * @param {string} statPath
 * @returns {{ rq: number, busy: number } | null}
 */
function readClock(schedstatPath, statPath) {
	let schedstat;
	let stat;
	try {
		schedstat = fs.readFileSync(schedstatPath, "utf8");
		stat = fs.readFileSync(statPath, "utf8");
	} catch {
		// Fails open, as the kernel-log readers do (workflow-core#2779).
		return null;
	}
	const rqNs = schedstat
		.split("\n")
		.filter((l) => /^cpu\d+ /.test(l))
		.map((l) => Number(l.split(/\s+/)[7]));
	const line = stat.match(/^cpu\s+(.*)$/m);
	if (rqNs.length === 0 || !line?.[1]) return null;
	const cpu = line[1].split(/\s+/).map(Number);
	if (cpu.length < 8) return null;
	// user, nice, system, irq, softirq, steal; idle and iowait are fields 3 and 4.
	const busy = [0, 1, 2, 5, 6, 7].reduce((sum, i) => sum + Number(cpu[i]), 0);
	const rq = rqNs.reduce((sum, ns) => sum + ns, 0);
	if (!Number.isFinite(rq) || !Number.isFinite(busy)) return null;
	return { rq: rq / 1e9, busy: busy / USER_HZ };
}

/**
 * How far the run-queue clocks and busy time moved across CLOCK_WAIT_MS, in
 * CPU-seconds; null where either reading failed.
 * @returns {{ rq: number, busy: number } | null}
 */
function sampleClock() {
	const fixture = process.env.WFC_SCHED_CLOCK;
	const read = (/** @type {string} */ dir) =>
		readClock(`${dir}/schedstat`, `${dir}/stat`);
	const before = read(fixture ? `${fixture}/before` : "/proc");
	if (!before) return null;
	if (!fixture) sleepSync(CLOCK_WAIT_MS);
	const after = read(fixture ? `${fixture}/after` : "/proc");
	if (!after) return null;
	return { rq: after.rq - before.rq, busy: after.busy - before.busy };
}

/** @param {{ rq: number, busy: number }} d */
const isFrozen = (d) => d.busy >= MIN_BUSY_S && d.rq < FROZEN_RATIO * d.busy;

/** @param {number} s */
const cpuS = (s) => `${s.toFixed(1)} CPU-s`;

/** @param {string} text */
const parseRealLines = (text) =>
	text.split("\n").filter((l) => l.trim() && !/^(?:-- |Hint:)/.test(l));

/**
 * The first reader's stalls, journalctl's stamps being preferred; null where no
 * reader holds one.
 * @param {{ reader: Reader, lines: string[] }[]} logs
 */
function findStalls(logs) {
	for (const { reader, lines } of logs) {
		const stalls = lines.filter((l) => STALL.test(l));
		const [firstLine] = stalls;
		if (firstLine !== undefined)
			return {
				reader,
				count: stalls.length,
				first: reader.time(firstLine) || "an unknown time",
			};
	}
	return null;
}

/**
 * @param {string} boot
 * @param {{ count: number, first: string }} stall
 */
function stallWarning(boot, { count, first }) {
	const head =
		boot === "0"
			? `KERNEL-STALL — this WSL VM is unhealthy: the kernel reported an RCU stall at ${first}` +
				`${count > 1 ? ` (${count} so far)` : ""}.`
			: `KERNEL-STALL — boot ${boot} reported ${count} RCU stall(s), the first at ${first}.`;
	return [
		head,
		"  The 4 and 7 Oct stalls ended the VM within ~20 minutes; the 23 Oct boot ran degraded",
		`  for 2 h 10 min after its first, until shut down by hand (${docPath("environment.md")} §7).`,
	];
}

/** @param {{ rq: number, busy: number }} clock */
const clockWarning = (clock) => [
	"SCHED-CLOCK-FROZEN — this WSL VM is unhealthy: the scheduler clock is frozen, so the scheduler is not sharing CPU fairly.",
	`  Over ${CLOCK_WAIT_MS / 1000} s the CPUs were busy for ${cpuS(clock.busy)} and the run-queue clocks advanced ${cpuS(clock.rq)} (${docPath("environment.md")} §7).`,
];

/** @param {boolean} stalled a stall asks for the shutdown now, a freeze at the next chance */
const recovery = (stalled) => [
	stalled
		? "  Finish or commit what you can now, then:"
		: "  Commit what you can, then at your next chance:",
	"    sync                      # in WSL — flushes writes `wsl --shutdown` would discard",
	"    wsl --shutdown            # in Windows PowerShell, then reopen the terminal",
	"  Nothing was shut down; this check only reports.",
];

/**
 * @param {string} boot
 * @param {{ reader: Reader, lines: string[] }[]} logs
 * @param {{ count: number } | null} stall
 * @param {{ rq: number, busy: number } | null} clock
 */
function buildResult(boot, logs, stall, clock) {
	const frozen = clock !== null && isFrozen(clock);
	const read = logs.reduce((n, l) => n + l.lines.length, 0);
	const clockLine = clock
		? `the scheduler clock is running (${cpuS(clock.rq)} over ${cpuS(clock.busy)} busy)`
		: "the scheduler clock could not be read";
	return {
		okLine:
			`no RCU stall in ${read} kernel log line(s) on boot ${boot}` +
			(boot === "0" ? `; ${clockLine}.` : "."),
		noun: stall
			? `RCU stall(s)${frozen ? " and a frozen scheduler clock" : ""}`
			: "frozen scheduler clock",
		count: stall?.count ?? Number(frozen),
		data: {
			boot,
			readers: logs.map((l) => l.reader.cmd),
			lines: read,
			stalls: stall ? stall.count : 0,
			clock: clock && { ...clock, frozen },
		},
	};
}

runCheck({
	name: "kernel-stall",
	usage: "node check-kernel-stall.js [--boot <n>] [--notify] [--json]",
	valueFlags: ["--boot"],
	run(ctx) {
		const boot = ctx.value("--boot", "0");
		if (!/^-?\d+$/.test(boot))
			ctx.usageError("--boot takes journalctl's boot offset: 0, -1, -2 …");
		const logs = readKernelLog(boot);
		const clock = boot === "0" ? sampleClock() : null;
		const frozen = clock !== null && isFrozen(clock);
		if (logs.length === 0 && !frozen)
			ctx.skip(
				`no reader would return boot ${boot}'s kernel log, so whether it stalled is unknown — not no.` +
					(clock ? " The scheduler clock is running." : ""),
			);

		const stall = findStalls(logs);
		/** @type {string[]} */
		const warning = [];
		if (stall) {
			ctx.fail(
				"KERNEL-STALL",
				`the kernel reported ${stall.count} RCU stall(s) on boot ${boot}, the first at ${stall.first}`,
				{ first: stall.first, count: stall.count, reader: stall.reader.cmd },
			);
			warning.push(...stallWarning(boot, stall));
		}
		if (clock && frozen) {
			ctx.fail(
				"SCHED-CLOCK-FROZEN",
				`the run-queue clocks advanced ${cpuS(clock.rq)} while the CPUs were busy for ${cpuS(clock.busy)}`,
				{ rq: clock.rq, busy: clock.busy },
			);
			warning.push(...clockWarning(clock));
		}
		if (warning.length > 0 && boot === "0")
			warning.push(...recovery(stall !== null));
		if (warning.length > 0) ctx.say(`${warning.join("\n")}\n`);

		return buildResult(boot, logs, stall, clock);
	},
});
