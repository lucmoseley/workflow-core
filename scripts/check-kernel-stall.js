#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const zlib = require("node:zlib");
const { runCheck } = require("./lib/check");
const {
	readBoots,
	runBoundedRead,
	runJournalctl,
} = require("./lib/journalctl.js");
const { REAL_PROC } = require("./lib/proc-root.js");
const { docPath } = require("./lib/script-path.js");
const { sleepSync } = require("./lib/sleep-sync.js");

/** @typedef {{ runtime: number, busy: number }} Clock */

// guess: a healthy ratio stays far above FROZEN_RATIO, workflow-core#4092
const CLOCK_WAIT_MS = 1000;

// measured 0.97 CPU-s largest uncharged gap, doubled, workflow-core#4092
const MIN_BUSY_S = 2;

// guess under a measured healthy 0.82-1.25, workflow-core#4092
const FROZEN_RATIO = 0.1;

const CGROUP_ROOT = "/sys/fs/cgroup";

// /proc/stat counts in USER_HZ, 1/100 s on most architectures:
// https://man7.org/linux/man-pages/man5/proc_stat.5.html
const USER_HZ = 100;

// guess: between a chain's 1,867 s and the 7,032 s that fits no chain, workflow-core#4081
const LARGE_T_S = 3600;

// guess, twice the measured 5.3 min oldest leap VM, workflow-core#4081
const YOUNG_VM_S = 600;

// guess, twice the measured 1.6% widest gap, workflow-core#4081
const LEAP_GAP = 0.03;

// measured 0.12 s, 3.9 s on a degraded bridge, workflow-core#4081
const WINDOWS_READ_TIMEOUT_MS = 5000;

/** Measured at about 8 KB for the 11 boots retained on 3 Nov 2026; this is ~130x that (workflow-core#4081). */
const WINDOWS_MAX_BUFFER = 1024 * 1024;

const UNKNOWN_TIME = "an unknown time";

const UNREADABLE_RESULT = { noun: "unreadable scheduler clock", count: 1 };

const STALL = /\brcu: INFO: rcu_\w+ (?:detected stalls|self-detected stall)/;

const T_FIGURE = /\bt=(\d+) jiffies\b/;

const BOOT_BANNER = /\b(?:Booting Linux|Linux version)\b/;

/** @param {string} boot */
const readers = (boot) => ({
	journal: {
		name: "journalctl",
		read: () =>
			runJournalctl(["-k", "-b", boot, "--no-pager", "-o", "short-iso"]).stdout,
		time: (/** @type {string} */ line) => line.split(/\s+/)[0],
	},
	dmesg: {
		name: "dmesg",
		read: () => runBoundedRead(process.env.WFC_DMESG || "dmesg", ["-T"]).stdout,
		time: (/** @type {string} */ line) =>
			(line.match(/^\[([^\]]+)\]/)?.[1] ?? "").replace(/\s+/g, " "),
	},
});
/** @typedef {ReturnType<typeof readers>["journal"]} Reader */

/**
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
		const lines = parseRealLines(reader.read());
		if (lines.length > 0) logs.push({ reader, lines });
	}
	return logs;
}

/**
 * @param {string} root
 * @returns {number | null}
 */
function readRuntime(root) {
	let children;
	try {
		children = fs.readdirSync(root, { withFileTypes: true });
	} catch {
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
				return [];
			}
		});
	return usecs.length > 0 ? usecs.reduce((a, b) => a + b, 0) / 1e6 : null;
}

/**
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
		return null;
	}
	const line = stat.match(/^cpu\s+(\S.*)?$/m);
	if (runtime === null || !line?.[1]) return null;
	const cpu = line[1].split(/\s+/).map(Number);
	if (cpu.length < 8) return null;
	const busy = [0, 1, 2, 5, 6, 7].reduce((sum, i) => sum + Number(cpu[i]), 0);
	if (!Number.isFinite(busy)) return null;
	return { runtime, busy: busy / USER_HZ };
}

/**
 * @returns {Clock | null}
 */
function sampleClock() {
	const fixture = process.env.WFC_SCHED_CLOCK;
	const read = (/** @type {string} */ name) =>
		fixture
			? readClock(`${fixture}/${name}/cgroup`, `${fixture}/${name}/stat`)
			: readClock(CGROUP_ROOT, `${REAL_PROC}/stat`);
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
 * @param {Clock} d
 */
const isFrozen = (d) =>
	d.busy >= MIN_BUSY_S && d.runtime >= 0 && d.runtime < FROZEN_RATIO * d.busy;

/** @param {number} s */
const cpuS = (s) => `${s.toFixed(1)} CPU-s`;

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {string} boot
 */
function skipUnlistedBoot(ctx, boot) {
	if (boot === "0" || process.env.WFC_KERNEL_LOG) return;
	const { boots, why } = readBoots();
	const [oldest] = boots;
	if (why !== null || oldest === undefined) return;
	const n = Number(boot);
	if (n > 0 ? n <= boots.length : -n < boots.length) return;
	ctx.skip(
		`boot ${boot} is not in the readable journal: journalctl lists ${boots.length} boot(s) to this user, ` +
			`the oldest from ${new Date(oldest.from).toISOString()}. An older boot can still be on disk, ` +
			`unreadable without systemd-journal membership (${docPath("environment.md")} §8), so whether it stalled is unknown — not no.`,
	);
}

/** @param {string} text */
const parseRealLines = (text) =>
	text.split("\n").filter((l) => l.trim() && !/^(?:-- |Hint:)/.test(l));

/** @typedef {{ line: string, jiffies: number | null }} StallEvent */

/**
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

/** @param {boolean} stalled */
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
			readers: logs.map((l) => l.reader.name),
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
		{ first: stall.first, count: stall.count, reader: stall.reader.name },
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
		if (logs.length === 0) skipUnlistedBoot(ctx, boot);
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
