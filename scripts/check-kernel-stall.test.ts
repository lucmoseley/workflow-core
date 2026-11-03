// @vitest-environment node
/*
 * Pins that check-kernel-stall.js names an RCU stall on the current boot
 * (#867), from journalctl or dmesg, and a frozen scheduler clock (#2779), and
 * fails open silently where neither can be read.
 *
 * Most cases read a fixture through WFC_KERNEL_LOG; the reader cases unset it
 * and point WFC_JOURNALCTL at lib/earlyoom-journal-fake.ts's stub and
 * WFC_DMESG at lib/dmesg-fake.ts's, so the machine's own kernel log is never
 * read. Every case reads the clock from a WFC_SCHED_CLOCK fixture, a running
 * one unless it says otherwise, so the machine's own is never read; likewise
 * CONFIG_HZ from a WFC_KERNEL_CONFIG fixture, and Windows through a WFC_WEVTUTIL
 * that is absent unless a case supplies lib/wevtutil-fake.ts's stub.
 *
 * It is a SessionStart `--notify` hook in .claude/settings.json, and
 * scripts/dispatch-sessions.sh refuses a launch on its plain run: loosen a case
 * and sessions start on a boot about to take the VM down, or a blind reader
 * holds every launch up.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dmesgLine, writeDmesg } from "./lib/dmesg-fake";
import {
	kernelLine,
	writeFailingJournalctl,
	writeJournalctl,
} from "./lib/earlyoom-journal-fake";
import { stallBootLines, writeKernelConfig } from "./lib/kernel-stall-fixture";
import { runInProcess } from "./lib/run-in-process.js";
import { writeSchedClock } from "./lib/sched-clock-fixture";
import { writeWevtutil } from "./lib/wevtutil-fake";

const SCRIPT = path.join(__dirname, "check-kernel-stall.js");

const CLEAN = [
	kernelLine(
		Date.parse("2026-10-07T15:18:35+00:00"),
		"Booting Linux on physical CPU 0x0000000000",
	),
	kernelLine(
		Date.parse("2026-10-08T01:12:01+00:00"),
		"hv_balloon: Max. dynamic memory size: 10240 MB",
	),
];
/** The stall's stamp, as kernelLine writes it. */
const STALL_STAMP = "2026-10-07T14:43:24+00:00";
const STALL_MSG = "rcu: INFO: rcu_preempt detected stalls on CPUs/tasks:";
const STALL_LINE = kernelLine(Date.parse(STALL_STAMP), STALL_MSG);
/** The stall as dmesg -T holds it, at a wall time the journal's is not. */
const DMESG_STALL = dmesgLine(Date.parse("2026-10-07T22:43:24Z"), STALL_MSG);
const STALLED = [
	...CLEAN,
	STALL_LINE,
	kernelLine(
		Date.parse(STALL_STAMP),
		"rcu: rcu_preempt kthread timer wakeup did not happen for 2502 jiffies",
	),
	kernelLine(Date.parse("2026-10-07T14:45:13+00:00"), STALL_MSG),
];

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "kernel-stall-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function logFile(lines: string[]): string {
	const at = path.join(dir, "kernel.log");
	fs.writeFileSync(at, `${lines.join("\n")}\n`);
	return at;
}

const absent = () => path.join(dir, "no-such-reader");

const kernelConfig = (hz: number) =>
	writeKernelConfig(path.join(dir, `config-${hz}.gz`), hz);

const clock = (move: { rq: number; busy: number }) =>
	writeSchedClock(path.join(dir, `clock-${move.rq}-${move.busy}`), move);
const RUNNING = { rq: 2.05, busy: 2 };
const FROZEN = { rq: 0, busy: 2 };

function run(args: string[], env: Record<string, string>) {
	const base: NodeJS.ProcessEnv = { ...process.env, GITHUB_ACTIONS: "" };
	delete base.WFC_KERNEL_LOG;
	delete base.WFC_JOURNALCTL;
	delete base.WFC_DMESG;
	return runInProcess(SCRIPT, args, {
		env: {
			...base,
			WFC_SCHED_CLOCK: clock(RUNNING),
			WFC_KERNEL_CONFIG: kernelConfig(250),
			WFC_WEVTUTIL: absent(),
			...env,
		},
	});
}

describe("at session start (--notify)", () => {
	it("prints the warning and the recovery steps on a stalled boot", () => {
		const r = run(["--notify"], { WFC_KERNEL_LOG: logFile(STALLED) });
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("KERNEL-STALL");
		expect(r.stdout).toContain(STALL_STAMP);
		expect(r.stdout).toContain("(2 so far)");
		expect(r.stdout).toContain("sync");
		expect(r.stdout).toContain("wsl --shutdown");
	});

	it("prints nothing on a clean boot", () => {
		const r = run(["--notify"], { WFC_KERNEL_LOG: logFile(CLEAN) });
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
	});

	it("keys on the self-detected form too", () => {
		const r = run(["--notify"], {
			WFC_KERNEL_LOG: logFile([
				...CLEAN,
				"2026-09-27T13:10:19+08:00 Luctop kernel: rcu: INFO: rcu_preempt self-detected stall on CPU",
			]),
		});
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("2026-09-27T13:10:19+08:00");
	});

	it("does not key on clock-change lines, which healthy boots carry too", () => {
		const r = run(["--notify"], {
			WFC_KERNEL_LOG: logFile([
				...CLEAN,
				"2026-10-08T10:00:00+08:00 Luctop systemd-resolved[1]: Clock change detected. Flushing caches.",
			]),
		});
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
	});
});

describe("a plain run, which scripts/dispatch-sessions.sh refuses on", () => {
	it("exits 1 on a stall, naming the first stall's time, its count and the recovery", () => {
		const r = run([], { WFC_KERNEL_LOG: logFile(STALLED) });
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(STALL_STAMP);
		expect(r.stderr).toContain("FAIL: 2 RCU stall(s)");
		expect(r.stderr).toContain("wsl --shutdown");
	});

	it("exits 0 on a clean boot, saying how much it read", () => {
		const r = run([], { WFC_KERNEL_LOG: logFile(CLEAN) });
		expect(r.status).toBe(0);
		expect(r.stderr).toContain(
			"OK: no RCU stall in 2 kernel log line(s) on boot 0; the scheduler clock is running",
		);
	});
});

describe("the scheduler clock (#2779)", () => {
	it("warns at session start on a frozen clock, with the recovery steps", () => {
		const r = run(["--notify"], {
			WFC_KERNEL_LOG: logFile(CLEAN),
			WFC_SCHED_CLOCK: clock(FROZEN),
		});
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("SCHED-CLOCK-FROZEN");
		expect(r.stdout).toContain("not sharing CPU fairly");
		expect(r.stdout).toContain("busy for 2.0 CPU-s");
		expect(r.stdout).toContain("Commit what you can, then at your next chance");
		expect(r.stdout).toContain("sync");
		expect(r.stdout).toContain("wsl --shutdown");
		expect(r.stdout).toContain("Nothing was shut down");
		expect(r.stdout).not.toContain("KERNEL-STALL");
	});

	it("exits 1 on a plain run, naming the signal", () => {
		const r = run([], {
			WFC_KERNEL_LOG: logFile(CLEAN),
			WFC_SCHED_CLOCK: clock(FROZEN),
		});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("FAIL: 1 frozen scheduler clock");
	});

	it("fails on a freeze even where the kernel log cannot be read", () => {
		const r = run([], {
			WFC_KERNEL_LOG: path.join(dir, "absent"),
			WFC_SCHED_CLOCK: clock(FROZEN),
		});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("SCHED-CLOCK-FROZEN");
	});

	it("counts a clock that moved under a tenth of the busy time as frozen", () => {
		const r = run([], {
			WFC_KERNEL_LOG: logFile(CLEAN),
			WFC_SCHED_CLOCK: clock({ rq: 0.19, busy: 2 }),
		});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("SCHED-CLOCK-FROZEN");
	});

	it("reads nothing into a still clock on a machine too idle to move it", () => {
		const r = run([], {
			WFC_KERNEL_LOG: logFile(CLEAN),
			WFC_SCHED_CLOCK: clock({ rq: 0, busy: 0.4 }),
		});
		expect(r.status).toBe(0);
	});

	it("names both signals, with one set of recovery steps, where both fire", () => {
		const r = run(["--notify"], {
			WFC_KERNEL_LOG: logFile(STALLED),
			WFC_SCHED_CLOCK: clock(FROZEN),
		});
		expect(r.stdout).toContain("KERNEL-STALL");
		expect(r.stdout).toContain("SCHED-CLOCK-FROZEN");
		expect(r.stdout.match(/wsl --shutdown {2}/g)).toHaveLength(1);
		const plain = run([], {
			WFC_KERNEL_LOG: logFile(STALLED),
			WFC_SCHED_CLOCK: clock(FROZEN),
		});
		expect(plain.stderr).toContain(
			"FAIL: 2 RCU stall(s) and a frozen scheduler clock",
		);
	});

	it("says so where the clock cannot be read, and gates on the log alone", () => {
		const r = run([], {
			WFC_KERNEL_LOG: logFile(CLEAN),
			WFC_SCHED_CLOCK: path.join(dir, "absent"),
		});
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("the scheduler clock could not be read");
	});

	it("counts nothing in the --json envelope of a healthy run", () => {
		const r = run(["--json"], { WFC_KERNEL_LOG: logFile(CLEAN) });
		expect(JSON.parse(r.stdout)).toMatchObject({ outcome: "OK", count: 0 });
	});

	it("reads no clock for an earlier boot", () => {
		const r = run(["--boot", "-1"], {
			WFC_JOURNALCTL: writeJournalctl(dir, [CLEAN[0]]),
			WFC_SCHED_CLOCK: clock(FROZEN),
		});
		expect(r.status).toBe(0);
		expect(r.stderr).not.toContain("scheduler clock");
	});
});

describe("fails open, silently, where the kernel log cannot be read", () => {
	it("with neither reader present", () => {
		const env = { WFC_JOURNALCTL: absent(), WFC_DMESG: absent() };
		const notify = run(["--notify"], env);
		expect(notify.status).toBe(0);
		expect(notify.stdout).toBe("");
		const plain = run([], env);
		expect(plain.status).toBe(0);
		expect(plain.stderr).toContain("SKIP:");
		expect(plain.stderr).toContain("unknown — not no");
	});

	it("where journalctl lacks permission and dmesg is restricted", () => {
		const env = {
			WFC_JOURNALCTL: writeJournalctl(dir, []),
			WFC_DMESG: writeDmesg(dir, [DMESG_STALL], { restricted: true }),
		};
		const notify = run(["--notify"], env);
		expect(notify.status).toBe(0);
		expect(notify.stdout).toBe("");
		const plain = run([], env);
		expect(plain.status).toBe(0);
		expect(plain.stderr).toContain("SKIP:");
	});

	it("where the fixture file is missing", () => {
		const r = run([], { WFC_KERNEL_LOG: path.join(dir, "absent") });
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("SKIP:");
	});
});

describe("the readers", () => {
	it("names the time from journalctl's stamp where both hold the stall", () => {
		const r = run([], {
			WFC_JOURNALCTL: writeJournalctl(dir, [STALL_LINE]),
			WFC_DMESG: writeDmesg(dir, [
				dmesgLine(Date.parse("2026-10-01T00:00:00Z"), STALL_MSG),
			]),
		});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(STALL_STAMP);
	});

	it("finds a stall dmesg holds and a journal with lines in it missed", () => {
		const r = run([], {
			WFC_JOURNALCTL: writeJournalctl(dir, [CLEAN[0]]),
			WFC_DMESG: writeDmesg(dir, [DMESG_STALL]),
		});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("Wed Oct 7 22:43:24 2026");
	});

	it("runs nothing but the two readers, and only to read", () => {
		const calls = path.join(dir, "calls");
		const r = run(["--notify"], {
			WFC_JOURNALCTL: writeJournalctl(dir, [STALL_LINE]),
			WFC_DMESG: writeDmesg(dir, [DMESG_STALL]),
		});
		expect(r.stdout).toContain("Nothing was shut down");
		expect(fs.readFileSync(calls, "utf8").trim().split("\n")).toEqual([
			"journalctl -k -b 0 --no-pager -o short-iso",
			"dmesg -T",
		]);
	});
});

describe("--boot <n>, for the boot that already died", () => {
	it("hands journalctl the offset and never reads dmesg", () => {
		const r = run(["--boot", "-1"], {
			WFC_JOURNALCTL: writeJournalctl(dir, [STALL_LINE]),
			WFC_DMESG: writeDmesg(dir, [DMESG_STALL]),
		});
		expect(fs.readFileSync(path.join(dir, "calls"), "utf8")).toBe(
			"journalctl -k -b -1 --no-pager -o short-iso\n",
		);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("boot -1 reported 1 RCU stall(s)");
		expect(r.stderr).not.toContain("wsl --shutdown");
	});

	it("skips rather than reading the current boot from dmesg", () => {
		const r = run(["--boot", "-1"], {
			WFC_JOURNALCTL: writeFailingJournalctl(dir),
			WFC_DMESG: writeDmesg(dir, [DMESG_STALL]),
		});
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("SKIP: no reader would return boot -1");
	});

	it("refuses an offset that is not one, naming the shape it takes", () => {
		const r = run(["--boot", "yesterday"], {});
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("--boot takes journalctl's boot offset");
	});
});

describe("each stall's t figure (#4081)", () => {
	/* The retained Windows boots around these stalls (Kernel-General Event 12). */
	const WindowsBoots = [
		"2026-09-14T20:47:22Z",
		"2026-10-04T13:35:35Z",
		"2026-11-02T17:52:54Z",
	].map(Date.parse);
	const windows = () => writeWevtutil(path.join(dir, "win"), WindowsBoots);
	const windowsCalls = () => path.join(dir, "win", "calls");
	const Leap = {
		vmStart: "2026-11-03T12:19:37+08:00",
		stalled: "2026-11-03T12:21:48+08:00",
		jiffies: 9_435_698,
	};

	function stalledBoot({
		vmStart,
		stalled,
		jiffies,
	}: {
		vmStart: string;
		stalled: string;
		jiffies: number;
	}) {
		return logFile(
			stallBootLines(Date.parse(vmStart), Date.parse(stalled), jiffies),
		);
	}

	const figures = (stdout: string) => JSON.parse(stdout).stallFigures;

	it.each([
		{
			when: "17 Sep",
			vmStart: "2026-09-17T16:59:16+08:00",
			stalled: "2026-09-17T17:04:34+08:00",
			jiffies: 54_174_601,
			tS: 216_698,
			vmAgeS: 318,
			windowsUptimeS: 217_032,
		},
		{
			when: "22 Sep",
			vmStart: "2026-09-22T16:20:35+08:00",
			stalled: "2026-09-22T16:24:21+08:00",
			jiffies: 158_995_772,
			tS: 635_983,
			vmAgeS: 226,
			windowsUptimeS: 646_619,
		},
		{
			when: "3 Nov",
			...Leap,
			tS: 37_743,
			vmAgeS: 131,
			windowsUptimeS: 37_734,
		},
	])("names the $when stall a CLOCK-LEAP, with its three figures", (c) => {
		const env = {
			WFC_KERNEL_LOG: stalledBoot(c),
			WFC_WEVTUTIL: windows(),
		};
		const plain = run(["--boot", "-1"], env);
		expect(plain.status).toBe(1);
		expect(plain.stderr).toContain("CLOCK-LEAP");
		expect(plain.stderr).toContain(`t=${c.jiffies} jiffies, ${c.tS} s`);
		expect(plain.stderr).toContain(`VM age ${c.vmAgeS} s`);
		expect(plain.stderr).toContain(`Windows uptime ${c.windowsUptimeS} s`);
		expect(figures(run(["--boot", "-1", "--json"], env).stdout)).toEqual([
			{
				at: expect.any(String),
				jiffies: c.jiffies,
				tS: c.tS,
				vmAgeS: c.vmAgeS,
				windowsUptimeS: c.windowsUptimeS,
				kind: "clock-leap",
			},
		]);
	});

	it.each([
		{
			boot: "-24",
			vmStart: "2026-09-18T13:25:48+08:00",
			stalled: "2026-09-22T15:56:56+08:00",
			jiffies: 98_670_506,
			vmAgeS: 354_668,
			windowsUptimeS: 644_974,
		},
		{
			boot: "-18",
			vmStart: "2026-10-04T21:47:11+08:00",
			stalled: "2026-10-07T22:51:51+08:00",
			jiffies: 39_758_081,
			vmAgeS: 263_080,
			windowsUptimeS: 263_776,
		},
	])("names boot $boot's large t on its own line, with no cause", (c) => {
		const r = run(["--boot", c.boot], {
			WFC_KERNEL_LOG: stalledBoot(c),
			WFC_WEVTUTIL: windows(),
		});
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(/^LARGE-T — t=\d+ jiffies/m);
		expect(r.stderr).not.toContain("CLOCK-LEAP");
		expect(r.stderr).toContain(`VM age ${c.vmAgeS} s`);
		expect(r.stderr).toContain(`Windows uptime ${c.windowsUptimeS} s`);
	});

	it("says neither of an ordinary 15,000 jiffies, and never reads Windows for one", () => {
		const r = run([], {
			WFC_KERNEL_LOG: stalledBoot({ ...Leap, jiffies: 15_002 }),
			WFC_WEVTUTIL: windows(),
		});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("KERNEL-STALL");
		expect(r.stderr).not.toContain("CLOCK-LEAP");
		expect(r.stderr).not.toContain("LARGE-T");
		expect(fs.existsSync(windowsCalls())).toBe(false);
	});

	it("spawns no Windows process on a clean run", () => {
		const r = run(["--notify"], {
			WFC_KERNEL_LOG: logFile(CLEAN),
			WFC_WEVTUTIL: windows(),
		});
		expect(r.stdout).toBe("");
		expect(fs.existsSync(windowsCalls())).toBe(false);
	});

	it("reads Windows once however many large figures the boot holds", () => {
		const log = stalledBoot(Leap);
		const later = Date.parse("2026-11-03T12:22:48+08:00");
		fs.appendFileSync(
			log,
			`${kernelLine(later, STALL_MSG)}\n${kernelLine(later, "rcu: \t(detected by 1, t=9450698 jiffies, g=1, q=1 ncpus=8)")}\n`,
		);
		const r = run(["--json"], {
			WFC_KERNEL_LOG: log,
			WFC_WEVTUTIL: windows(),
		});
		expect(figures(r.stdout).map((f: { tS: number }) => f.tS)).toEqual([
			37_743, 37_803,
		]);
		expect(fs.readFileSync(windowsCalls(), "utf8").trim().split("\n")).toEqual([
			"wevtutil qe System /q:*[System[Provider[@Name='Microsoft-Windows-Kernel-General'] and EventID=12]] /f:xml",
		]);
	});

	it.each([
		{ state: "absent", bin: absent },
		{
			state: "failing",
			bin: () => writeWevtutil(path.join(dir, "win"), [], { fails: true }),
		},
		{
			state: "holding no boot before the stall",
			bin: () =>
				writeWevtutil(path.join(dir, "win"), [
					Date.parse("2026-12-01T00:00:00Z"),
				]),
		},
	])(
		"still reports the stall, uptime unknown, with Windows $state",
		({ bin }) => {
			const env = { WFC_KERNEL_LOG: stalledBoot(Leap), WFC_WEVTUTIL: bin() };
			const r = run([], env);
			expect(r.status).toBe(1);
			expect(r.stderr).toContain("KERNEL-STALL");
			expect(r.stderr).toContain("LARGE-T");
			expect(r.stderr).toContain("Windows uptime unknown");
			const notify = run(["--notify"], env);
			expect(notify.status).toBe(0);
			expect(notify.stdout).toContain("Windows uptime unknown");
		},
	);

	it("converts at the kernel's CONFIG_HZ, assuming none", () => {
		const r = run(["--json"], {
			WFC_KERNEL_LOG: stalledBoot(Leap),
			WFC_KERNEL_CONFIG: kernelConfig(1000),
			WFC_WEVTUTIL: windows(),
		});
		expect(figures(r.stdout)[0]).toMatchObject({ tS: 9436, kind: "large-t" });
	});

	it("says so where CONFIG_HZ is unreadable, and still reports the stall", () => {
		const r = run([], {
			WFC_KERNEL_LOG: stalledBoot(Leap),
			WFC_KERNEL_CONFIG: absent(),
			WFC_WEVTUTIL: windows(),
		});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("could not be converted");
		expect(fs.existsSync(windowsCalls())).toBe(false);
	});

	it("leaves VM age unknown, and names no leap, on a log not starting at the boot", () => {
		const at = Date.parse(Leap.stalled);
		const r = run([], {
			WFC_KERNEL_LOG: logFile([
				kernelLine(at, STALL_MSG),
				kernelLine(
					at,
					"rcu: \t(detected by 1, t=9435698 jiffies, g=1, q=1 ncpus=8)",
				),
			]),
			WFC_WEVTUTIL: windows(),
		});
		expect(r.stderr).toContain("VM age unknown");
		expect(r.stderr).toContain("LARGE-T");
		expect(r.stderr).not.toContain("CLOCK-LEAP");
	});

	it("names no leap on an old VM whose t matches Windows uptime", () => {
		const r = run([], {
			WFC_KERNEL_LOG: stalledBoot({
				...Leap,
				vmStart: "2026-11-03T12:09:00+08:00",
			}),
			WFC_WEVTUTIL: windows(),
		});
		expect(r.stderr).toContain("LARGE-T");
		expect(r.stderr).not.toContain("CLOCK-LEAP");
	});

	it("gives the hung-shutdown escalation with the recovery, on the running boot alone", () => {
		const log = logFile(STALLED);
		const now = run(["--notify"], { WFC_KERNEL_LOG: log });
		const hang = now.stdout.indexOf("`wsl --shutdown` itself hangs");
		expect(hang).toBeGreaterThan(now.stdout.indexOf("wsl --shutdown  "));
		expect(now.stdout.indexOf("hcsdiag list")).toBeGreaterThan(hang);
		expect(now.stdout.indexOf("hcsdiag kill <GUID>")).toBeGreaterThan(hang);
		expect(now.stdout).toContain("restart Windows only if that fails");
		expect(now.stdout).toContain("unmeasured");
		expect(run(["--boot", "-1"], { WFC_KERNEL_LOG: log }).stderr).not.toContain(
			"hcsdiag",
		);
	});
});
