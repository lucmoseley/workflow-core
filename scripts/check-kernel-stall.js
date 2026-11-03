#!/usr/bin/env node
/*
 * check-kernel-stall.js — say so when the WSL VM is unhealthy, on either of
 * two signals: an RCU stall on the CURRENT boot (#867), or a frozen scheduler
 * clock right now (#2779). The 4 and 7 Oct 2026 stalls ended the VM within
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
 * EACH STALL'S FIGURE (#4081) is its `t=<n> jiffies`, in seconds at the kernel's
 * CONFIG_HZ, beside the VM's age and, for a large one, Windows uptime at the
 * stall: the newest Kernel-General Event 12 before it. CLOCK-LEAP names a `t`
 * near that uptime on a young VM, where the VM's clock leapt forward by about
 * the host's uptime; LARGE-T names any other large `t`, giving no cause. Windows
 * is read only once a large `t` is found, and a reading it cannot take leaves the stall reported with that
 * figure unknown. An earlier boot's `t` converts at the running kernel's
 * CONFIG_HZ.
 *
 * THE CLOCK SIGNAL reads the summed `usage_usec` of the cgroup root's direct
 * children and the non-idle ticks in `/proc/stat`, CLOCK_WAIT_MS apart. A backward
 * `sched_clock` step on arm64 holds every run queue's clock still while the CPUs
 * stay busy (#2708), so the clock is frozen where the machine was busy for at least
 * MIN_BUSY_S and the tasks' run time advanced under FROZEN_RATIO of it. --boot reads
 * no clock.
 *
 * WHY THOSE FILES (#4092). A cgroup's figure takes the delta each task's
 * sum_exec_runtime takes (kernel/sched/fair.c update_se), which stops in a freeze
 * (#2681), and keeps an exited task's time, where a sum over tasks loses it.
 * The children, never the root's own file: a true root's figure is built from the
 * tick counters `/proc/stat` reads (kernel/cgroup/rstat.c root_cgroup_cputime), so
 * it would never disagree with them.
 *
 * FAILS OPEN. Neither reader present, permitted or answering inside
 * READ_TIMEOUT_MS, with no clock read showing a freeze, is SKIP, which --notify
 * prints nothing for. A clock it cannot read is WARN on a plain run, not the SKIP
 * an unavailable subject otherwise is, since `npm run status` hides a SKIP's body;
 * --notify raises nothing for it, as no session can act on the line (#4092). Never
 * FAIL, whose exit would refuse every launch on a kernel lacking the source. The
 * kernel is subject, not apparatus (lib/check.js), and this check must never be why
 * a session or a launch is held up.
 *
 * A STALL OR A FREEZE IS FAIL, so a plain run exits 1 — the exit
 * `scripts/dispatch-sessions.sh` refuses a launch on (exit 5, beside the wedged
 * bridge). Under --notify it exits 0 like every session-start reporter and
 * prints the warning.
 *
 * WFC_KERNEL_LOG replaces both readers with a file in journalctl's short-iso
 * shape, the seam lib/proc-root.js's meminfoPath takes WFC_MEMINFO by; it
 * ignores --boot, and an unreadable or empty one is SKIP, as the readers are.
 * WFC_KERNEL_CONFIG replaces /proc/config.gz, and WFC_WEVTUTIL the Windows reader.
 * WFC_SCHED_CLOCK replaces the clock's reads with a directory holding
 * `before/` and `after/`, each with a `cgroup/` root and a `stat` in the real
 * files' shape, and takes no wait.
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
 * IMPLICIT:  at every session start, reads this boot's kernel log and the scheduler clock over 1 s and, where the log holds an RCU stall or the clock is frozen, prints that the VM is unhealthy and the sync-then-shutdown recovery, reading the Windows event log once where a stall's `t` is large; prints nothing on a clean or unreadable reading.
 * JUSTIFIED: fail-safe — nothing else tells a session the VM is unhealthy, and a reading it cannot take is silence, never a warning.
 * DEFEAT:    none at the hook; a reboot of the VM clears a stall, the signal being per-boot, and a freeze clears once the clock moves.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const zlib = require("node:zlib");
const { runCheck } = require("./lib/check");
const { REAL_PROC } = require("./lib/proc-root.js");
const { docPath } = require("./lib/script-path.js");
const { sleepSync } = require("./lib/sleep-sync.js");

/** @typedef {{ runtime: number, busy: number }} Clock */

/** Per reader. Measured at 0.05s for a 15-hour boot's 542 lines; the rest is margin. */
const READ_TIMEOUT_MS = 5000;

/**
 * Per reader. The largest boot journalctl held on 8 Oct 2026 was 1.93 MB
 * (19,526 lines over five days); this is ~30x that, so only a boot of months
 * would overflow it — and an overflow is a read error, so SKIP, never "clean".
 */
const MAX_BUFFER = 64 * 1024 * 1024;

/** Long enough that a healthy machine's ratio stays far above FROZEN_RATIO (#4092). */
const CLOCK_WAIT_MS = 1000;

/**
 * Under this, the busy time can all be kernel work no cgroup is charged for, so a
 * still sum says nothing. Untraced margin: about twice the largest such gap read
 * in a second, 0.97 CPU-s under writeback at load 9-25, none read on a quiet
 * machine (#4092). A freeze's onset read 6.5-6.9 busy CPU-s a second (#2681).
 */
const MIN_BUSY_S = 2;

/**
 * Untraced: below this source's healthy ratio, 0.82-1.25 over 1 s under five loads
 * (#4092), and above frozen, 0 by the kernel source with no frozen sample yet.
 */
const FROZEN_RATIO = 0.1;

const CGROUP_ROOT = "/sys/fs/cgroup";

/** `/proc/stat`'s tick unit, USER_HZ, which Linux fixes at 100 on arm64 and x86. */
const USER_HZ = 100;

/**
 * From here a `t` is reported. Untraced, set between the largest figure in a
 * chain of one stall's reprints (466,907 jiffies, 1,867 s) and
 * the smallest large one that fits no chain (1,757,889 jiffies, 7,032 s).
 */
const LARGE_T_S = 3600;

/**
 * Oldest VM a CLOCK-LEAP is named on. Untraced: about twice the oldest of the
 * three measured leaps, whose VMs were 2.2-5.3 min old (#4081).
 */
const YOUNG_VM_S = 600;

/**
 * Widest gap between `t` and Windows uptime a CLOCK-LEAP is named on, as a
 * fraction of uptime. Untraced: about twice the widest of the three measured
 * gaps, 0.02-1.6% (#4081).
 */
const LEAP_GAP = 0.03;

/**
 * Measured at 0.12 s on 3 Nov 2026; §9's degraded bridge reads 3.9 s a call,
 * which this still clears (#4081).
 */
const WINDOWS_READ_TIMEOUT_MS = 5000;

/** Measured at about 8 KB for the 11 boots retained on 3 Nov 2026; this is ~130x that (#4081). */
const WINDOWS_MAX_BUFFER = 1024 * 1024;

const UNKNOWN_TIME = "an unknown time";

const UNREADABLE_RESULT = { noun: "unreadable scheduler clock", count: 1 };

const STALL = /\brcu: INFO: rcu_\w+ (?:detected stalls|self-detected stall)/;

/** `(t=9435698 jiffies g=…` or `(detected by 1, t=15002 jiffies, g=…`. */
const T_FIGURE = /\bt=(\d+) jiffies\b/;

/** A kernel log whose first line is this starts at the boot, so dates the VM. */
const BOOT_BANNER = /\b(?:Booting Linux|Linux version)\b/;

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
 * Seconds of run time summed over `root`'s direct children; null where none reads,
 * which the check reports. One child alone unread is a race with its exit, so it is
 * left out unprinted, and the fall reads as not frozen (#4092).
 * @param {string} root
 * @returns {number | null}
 */
function readRuntime(root) {
	let children;
	try {
		children = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		// Fails open, as the kernel-log readers do (#2779); the check reports it (#4092).
		return null;
	}
	const usecs = children
		.filter((c) => c.isDirectory())
		.flatMap((c) => {
			try {
				const text = fs.readFileSync(`${root}/${c.name}/cpu.stat`, "utf8");
				const usec = text.match(/^usage_usec (\d+)$/m)?.[1];
				return usec ? [Number(usec)] : [];
			} catch {
				// A child gone mid-read, in this function's comment (#4092).
				return [];
			}
		});
	return usecs.length > 0 ? usecs.reduce((a, b) => a + b, 0) / 1e6 : null;
}

/**
 * One reading of the tasks' summed run time and the machine's busy time, both
 * in seconds; null where either is absent, unreadable or not in shape.
 * @param {string} cgroupRoot
 * @param {string} statPath
 * @returns {Clock | null}
 */
function readClock(cgroupRoot, statPath) {
	const runtime = readRuntime(cgroupRoot);
	let stat;
	try {
		stat = fs.readFileSync(statPath, "utf8");
	} catch {
		// Fails open, as the kernel-log readers do (#2779); the check reports it (#4092).
		return null;
	}
	const line = stat.match(/^cpu\s+(\S.*)?$/m);
	if (runtime === null || !line?.[1]) return null;
	const cpu = line[1].split(/\s+/).map(Number);
	if (cpu.length < 8) return null;
	// user, nice, system, irq, softirq, steal; idle and iowait are fields 3 and 4.
	const busy = [0, 1, 2, 5, 6, 7].reduce((sum, i) => sum + Number(cpu[i]), 0);
	if (!Number.isFinite(busy)) return null;
	return { runtime, busy: busy / USER_HZ };
}

/**
 * How far the tasks' run time and busy time moved across CLOCK_WAIT_MS, in
 * CPU-seconds; null where either reading failed.
 * @returns {Clock | null}
 */
function sampleClock() {
	const fixture = process.env.WFC_SCHED_CLOCK;
	const read = (/** @type {string} */ name) =>
		fixture
			? readClock(`${fixture}/${name}/cgroup`, `${fixture}/${name}/stat`)
			: /* Its seam is WFC_SCHED_CLOCK; a WFC_PROC fake carries no clock. */
				readClock(CGROUP_ROOT, `${REAL_PROC}/stat`);
	const before = read("before");
	if (!before) return null;
	if (!fixture) sleepSync(CLOCK_WAIT_MS);
	const after = read("after");
	if (!after) return null;
	return {
		runtime: after.runtime - before.runtime,
		busy: after.busy - before.busy,
	};
}

/**
 * A negative move is a child cgroup leaving with its total, which says nothing.
 * @param {Clock} d
 */
const isFrozen = (d) =>
	d.busy >= MIN_BUSY_S && d.runtime >= 0 && d.runtime < FROZEN_RATIO * d.busy;

/** @param {number} s */
const cpuS = (s) => `${s.toFixed(1)} CPU-s`;

/** @param {string} text */
const parseRealLines = (text) =>
	text.split("\n").filter((l) => l.trim() && !/^(?:-- |Hint:)/.test(l));

/** @typedef {{ line: string, jiffies: number | null }} StallEvent */

/**
 * Each stall in `lines`, with the `t` the lines after it give, null where the
 * log lost that line.
 * @param {string[]} lines
 * @returns {StallEvent[]}
 */
function parseStallEvents(lines) {
	/** @type {StallEvent[]} */
	const events = [];
	for (const line of lines) {
		if (STALL.test(line)) events.push({ line, jiffies: null });
		const last = events.at(-1);
		const t = line.match(T_FIGURE)?.[1];
		if (last && last.jiffies === null && t) last.jiffies = Number(t);
	}
	return events;
}

/**
 * The first reader's stalls, journalctl's stamps being preferred; null where no
 * reader holds one.
 * @param {{ reader: Reader, lines: string[] }[]} logs
 */
function findStalls(logs) {
	for (const { reader, lines } of logs) {
		const events = parseStallEvents(lines);
		const [firstEvent] = events;
		if (firstEvent !== undefined)
			return {
				reader,
				lines,
				events,
				count: events.length,
				first: reader.time(firstEvent.line) || UNKNOWN_TIME,
			};
	}
	return null;
}

/**
 * The running kernel's CONFIG_HZ; null where its config cannot be read, which
 * the warning says (#4081).
 * @returns {number | null}
 */
function readKernelHz() {
	try {
		const gz = fs.readFileSync(
			process.env.WFC_KERNEL_CONFIG || `${REAL_PROC}/config.gz`,
		);
		const hz = zlib
			.gunzipSync(gz)
			.toString()
			.match(/^CONFIG_HZ=(\d+)$/m)?.[1];
		return hz ? Number(hz) : null;
	} catch {
		return null;
	}
}

/**
 * Every Windows boot the event log retains, as ms since the epoch; empty where
 * it cannot be read, which the warning prints as uptime unknown (#4081).
 * wevtutil's XML carries UTC stamps whatever the locale.
 * @returns {number[]}
 */
function readWindowsBoots() {
	const res = spawnSync(
		process.env.WFC_WEVTUTIL || "wevtutil.exe",
		[
			"qe",
			"System",
			"/q:*[System[Provider[@Name='Microsoft-Windows-Kernel-General'] and EventID=12]]",
			"/f:xml",
		],
		{
			encoding: "utf8",
			timeout: WINDOWS_READ_TIMEOUT_MS,
			// A call stuck on the interop bridge ignores TERM (#4081, §9).
			killSignal: "SIGKILL",
			stdio: ["ignore", "pipe", "ignore"],
			maxBuffer: WINDOWS_MAX_BUFFER,
		},
	);
	if (res.error || res.status !== 0) return [];
	return [...res.stdout.matchAll(/<TimeCreated SystemTime='([^']+)'/g)]
		.flatMap((m) => (m[1] ? [Date.parse(m[1])] : []))
		.filter(Number.isFinite);
}

/** @typedef {"clock-leap" | "large-t" | "ordinary" | "unconverted"} StallKind */

/**
 * @param {number | null} tS
 * @param {number | null} vmAgeS
 * @param {number | null} uptimeS
 * @returns {StallKind}
 */
function classify(tS, vmAgeS, uptimeS) {
	if (tS === null) return "unconverted";
	if (tS < LARGE_T_S) return "ordinary";
	const leapt =
		vmAgeS !== null &&
		vmAgeS <= YOUNG_VM_S &&
		uptimeS !== null &&
		Math.abs(tS - uptimeS) <= LEAP_GAP * uptimeS;
	return leapt ? "clock-leap" : "large-t";
}

/**
 * Each stall's `t`, the VM's age and, for a large `t` alone, Windows uptime,
 * all at the stall's own stamp.
 * @param {{ reader: Reader, lines: string[], events: StallEvent[] }} stall
 */
function buildStallFigures({ reader, lines, events }) {
	const hz = readKernelHz();
	/** @param {string} line */
	const stampOf = (line) => Date.parse(reader.time(line) ?? "");
	const [firstLine = ""] = lines;
	const vmStart = BOOT_BANNER.test(firstLine) ? stampOf(firstLine) : Number.NaN;
	/** @type {number[] | undefined} */
	let windowsBoots;
	return events.map(({ line, jiffies }) => {
		const at = stampOf(line);
		const tS = jiffies !== null && hz ? Math.round(jiffies / hz) : null;
		const age = Math.round((at - vmStart) / 1000);
		const vmAgeS = Number.isFinite(age) ? age : null;
		let windowsUptimeS = null;
		if (tS !== null && tS >= LARGE_T_S) {
			windowsBoots ??= readWindowsBoots();
			const before = windowsBoots.filter((b) => b <= at);
			if (before.length > 0)
				windowsUptimeS = Math.round((at - Math.max(...before)) / 1000);
		}
		return {
			at: reader.time(line) || UNKNOWN_TIME,
			jiffies,
			tS,
			vmAgeS,
			windowsUptimeS,
			kind: classify(tS, vmAgeS, windowsUptimeS),
		};
	});
}
/** @typedef {ReturnType<typeof buildStallFigures>[number]} StallFigure */

/** @param {number | null} s */
const seconds = (s) => (s === null ? "unknown" : `${s} s`);

/** @type {Partial<Record<StallKind, { tag: string, tail: string }>>} */
const FIGURE_REPORTS = {
	"clock-leap": {
		tag: "CLOCK-LEAP",
		tail: `the VM's clock leapt forward by about the host's uptime (${docPath("environment.md")} §7)`,
	},
	"large-t": { tag: "LARGE-T", tail: "a large figure, no cause named" },
};

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

/** @param {Clock} clock */
const clockWarning = (clock) => [
	"SCHED-CLOCK-FROZEN — this WSL VM is unhealthy: the scheduler clock is frozen, so the scheduler is not sharing CPU fairly.",
	`  Over ${CLOCK_WAIT_MS / 1000} s the CPUs were busy for ${cpuS(clock.busy)} and the tasks ran for ${cpuS(clock.runtime)} (${docPath("environment.md")} §7).`,
];

/** @param {boolean} stalled a stall asks for the shutdown now, a freeze at the next chance */
const recovery = (stalled) => [
	stalled
		? "  Finish or commit what you can now, then:"
		: "  Commit what you can, then at your next chance:",
	"    sync                      # in WSL — flushes writes `wsl --shutdown` would discard",
	"    wsl --shutdown            # in Windows PowerShell, then reopen the terminal",
	"  If `wsl --shutdown` itself hangs, in an elevated PowerShell:",
	"    hcsdiag list",
	"    hcsdiag kill <GUID>",
	`  and restart Windows only if that fails; hcsdiag's effect on a clock leap is unmeasured (${docPath("environment.md")} §8).`,
	"  Nothing was shut down; this check only reports.",
];

/**
 * @param {string} boot
 * @param {{ reader: Reader, lines: string[] }[]} logs
 * @param {{ count: number, figures: StallFigure[] } | null} stall
 * @param {Clock | null} clock
 */
function buildResult(boot, logs, stall, clock) {
	const frozen = clock !== null && isFrozen(clock);
	const read = logs.reduce((n, l) => n + l.lines.length, 0);
	const clockLine = clock
		? `the scheduler clock is running (${cpuS(clock.runtime)} over ${cpuS(clock.busy)} busy)`
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
			stallFigures: stall ? stall.figures : [],
			clock: clock && { ...clock, frozen },
		},
	};
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {string} boot
 * @param {NonNullable<ReturnType<typeof findStalls>> & { figures: StallFigure[] }} stall
 */
function reportStall(ctx, boot, stall) {
	ctx.fail(
		"KERNEL-STALL",
		`the kernel reported ${stall.count} RCU stall(s) on boot ${boot}, the first at ${stall.first}`,
		{ first: stall.first, count: stall.count, reader: stall.reader.cmd },
	);
	const warning = stallWarning(boot, stall);
	for (const f of stall.figures) {
		const report = FIGURE_REPORTS[f.kind];
		if (!report) continue;
		const message = `t=${f.jiffies} jiffies, ${f.tS} s, at ${f.at}; VM age ${seconds(f.vmAgeS)}; Windows uptime ${seconds(f.windowsUptimeS)}: ${report.tail}`;
		ctx.fail(report.tag, message, f);
		warning.push(`${report.tag} — ${message}.`);
	}
	if (stall.figures.some((f) => f.kind === "unconverted"))
		warning.push(
			"  A stall's `t` could not be converted to seconds, so a clock leap cannot be told from it: the log lost the figure or CONFIG_HZ is unreadable.",
		);
	return warning;
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {Clock} clock
 */
function reportFrozen(ctx, clock) {
	ctx.fail(
		"SCHED-CLOCK-FROZEN",
		`the tasks ran for ${cpuS(clock.runtime)} while the CPUs were busy for ${cpuS(clock.busy)}`,
		{ runtime: clock.runtime, busy: clock.busy },
	);
	return clockWarning(clock);
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {boolean} logRead
 */
function reportUnreadable(ctx, logRead) {
	const message =
		`no reading from ${CGROUP_ROOT}/*/cpu.stat and ${REAL_PROC}/stat, so a frozen clock cannot be seen and cannot refuse a launch` +
		(logRead ? "" : "; no reader returned the kernel log either");
	ctx.warn("SCHED-CLOCK-UNREADABLE", message);
	ctx.say(
		`SCHED-CLOCK-UNREADABLE — ${message} (${docPath("environment.md")} §8).`,
	);
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {string} boot
 * @param {string[]} warning
 * @param {boolean} stalled
 */
function sayWarning(ctx, boot, warning, stalled) {
	if (warning.length === 0) return;
	const steps = boot === "0" ? recovery(stalled) : [];
	ctx.say(`${[...warning, ...steps].join("\n")}\n`);
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
		const clockBlind = boot === "0" && !clock && !ctx.notify;
		if (logs.length === 0 && !frozen && !clockBlind)
			ctx.skip(
				`no reader would return boot ${boot}'s kernel log, so whether it stalled is unknown — not no.` +
					(clock ? " The scheduler clock is running." : ""),
			);

		const found = findStalls(logs);
		const stall = found && { ...found, figures: buildStallFigures(found) };
		/** @type {string[]} */
		const warning = stall ? reportStall(ctx, boot, stall) : [];
		if (clock && frozen) warning.push(...reportFrozen(ctx, clock));
		sayWarning(ctx, boot, warning, stall !== null);
		const result = buildResult(boot, logs, stall, clock);
		if (!clockBlind) return result;
		reportUnreadable(ctx, logs.length > 0);
		return stall ? result : { ...result, ...UNREADABLE_RESULT };
	},
});
