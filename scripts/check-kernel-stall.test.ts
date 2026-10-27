// @vitest-environment node
/*
 * Pins that check-kernel-stall.js names an RCU stall on the current boot
 * (#867), from journalctl or dmesg, and a frozen scheduler clock (#2779), and
 * fails open silently where neither can be read.
 *
 * Most cases read a fixture through WFC_KERNEL_LOG; the reader cases unset it
 * and point WFC_JOURNALCTL and WFC_DMESG at stubs, so the machine's own kernel
 * log is never read. Every case reads the clock from a WFC_SCHED_CLOCK fixture,
 * a running one unless it says otherwise, so the machine's own is never read.
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
import { runInProcess } from "./lib/run-in-process.js";
import { writeSchedClock } from "./lib/sched-clock-fixture";

const SCRIPT = path.join(__dirname, "check-kernel-stall.js");

const CLEAN = [
	"2026-10-07T23:18:35+08:00 Luctop kernel: Booting Linux on physical CPU 0x0000000000",
	"2026-10-08T09:12:01+08:00 Luctop kernel: hv_balloon: Max. dynamic memory size: 10240 MB",
];
const STALL_LINE =
	"2026-10-07T22:43:24+08:00 Luctop kernel: rcu: INFO: rcu_preempt detected stalls on CPUs/tasks:";
const STALLED = [
	...CLEAN,
	STALL_LINE,
	"2026-10-07T22:43:24+08:00 Luctop kernel: rcu: rcu_preempt kthread timer wakeup did not happen for 2502 jiffies",
	"2026-10-07T22:45:13+08:00 Luctop kernel: rcu: INFO: rcu_preempt detected stalls on CPUs/tasks:",
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

function stub(name: string, body: string): string {
	const at = path.join(dir, name);
	fs.writeFileSync(at, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
	return at;
}

const absent = () => path.join(dir, "no-such-reader");

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
		env: { ...base, WFC_SCHED_CLOCK: clock(RUNNING), ...env },
	});
}

describe("at session start (--notify)", () => {
	it("prints the warning and the recovery steps on a stalled boot", () => {
		const r = run(["--notify"], { WFC_KERNEL_LOG: logFile(STALLED) });
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("KERNEL-STALL");
		expect(r.stdout).toContain("2026-10-07T22:43:24+08:00");
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
		expect(r.stderr).toContain("2026-10-07T22:43:24+08:00");
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
			WFC_JOURNALCTL: stub("journalctl", `echo '${CLEAN[0]}'`),
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
			WFC_JOURNALCTL: stub("journalctl", "echo '-- No entries --'; exit 0"),
			WFC_DMESG: stub(
				"dmesg",
				"echo 'dmesg: read kernel buffer failed: Operation not permitted' >&2; exit 1",
			),
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
			WFC_JOURNALCTL: stub("journalctl", `echo '${STALL_LINE}'`),
			WFC_DMESG: stub(
				"dmesg",
				"echo '[Thu Oct  1 00:00:00 2026] rcu: INFO: rcu_preempt detected stalls on CPUs/tasks:'",
			),
		});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("2026-10-07T22:43:24+08:00");
	});

	it("finds a stall dmesg holds and a journal with lines in it missed", () => {
		const r = run([], {
			WFC_JOURNALCTL: stub("journalctl", `echo '${CLEAN[0]}'`),
			WFC_DMESG: stub(
				"dmesg",
				'[ "$1" = -T ] || exit 2; echo "[Wed Oct  7 22:43:24 2026] rcu: INFO: rcu_preempt detected stalls on CPUs/tasks:"',
			),
		});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("Wed Oct 7 22:43:24 2026");
	});

	it("runs nothing but the two readers, and only to read", () => {
		const calls = path.join(dir, "calls");
		const logging = (name: string) =>
			stub(name, `echo "${name} $*" >> "${calls}"; echo '${STALL_LINE}'`);
		const r = run(["--notify"], {
			WFC_JOURNALCTL: logging("journalctl"),
			WFC_DMESG: logging("dmesg"),
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
			WFC_JOURNALCTL: stub(
				"journalctl",
				`[ "$3" = -1 ] || exit 2; echo '${STALL_LINE}'`,
			),
			WFC_DMESG: stub("dmesg", "exit 3"),
		});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("boot -1 reported 1 RCU stall(s)");
		expect(r.stderr).not.toContain("wsl --shutdown");
	});

	it("skips rather than reading the current boot from dmesg", () => {
		const r = run(["--boot", "-1"], {
			WFC_JOURNALCTL: stub("journalctl", "exit 1"),
			WFC_DMESG: stub("dmesg", `echo '${STALL_LINE}'`),
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
