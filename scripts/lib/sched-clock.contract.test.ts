// @vitest-environment node
/*
 * Holds lib/sched-clock-fake.ts's writeSchedClock to the real cgroup and /proc
 * files (#4092): check-kernel-stall.js reads each the same way.
 *
 * Red on the real side after a kernel update:
 * `cat /sys/fs/cgroup/*\/cpu.stat`, then fix readClock and ~/memwatch.sh's
 * `sched_clock`, or find another source (docs/environment.md §7).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./run-in-process";
import { writeSchedClock } from "./sched-clock-fake";

const REAL_ROOT = "/sys/fs/cgroup";
const SCRIPT = path.join(__dirname, "..", "check-kernel-stall.js");

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "sched-clock-contract-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function readClockNow(clock?: string) {
	const log = path.join(dir, "kernel.log");
	fs.writeFileSync(
		log,
		"2026-11-03T15:00:00+08:00 host kernel: Linux version 6.18\n",
	);
	const env: NodeJS.ProcessEnv = { ...process.env, WFC_KERNEL_LOG: log };
	delete env.WFC_SCHED_CLOCK;
	if (clock) env.WFC_SCHED_CLOCK = clock;
	const r = runInProcess(SCRIPT, ["--json"], { env });
	return JSON.parse(r.stdout).clock;
}

describe.each([
	{
		side: "the fixture",
		clock: () =>
			writeSchedClock(path.join(dir, "clock"), { runtime: 2, busy: 2 }),
		present: (): boolean => true,
	},
	{
		side: "the real files",
		clock: () => undefined,
		present: (): boolean => fs.existsSync(`${REAL_ROOT}/cpu.stat`),
	},
])("$side", ({ clock, present }) => {
	it("gives a clock reading in figures", ({ skip }) => {
		if (!present()) return skip(`no ${REAL_ROOT} here`);
		const read = readClockNow(clock());
		expect(Number.isFinite(read.runtime)).toBe(true);
		expect(Number.isFinite(read.busy)).toBe(true);
		expect(typeof read.frozen).toBe("boolean");
	});
});

describe("the real cgroup children", () => {
	it("each carry the usage_usec line the fixture writes", ({ skip }) => {
		if (!fs.existsSync(`${REAL_ROOT}/cpu.stat`))
			return skip(`no ${REAL_ROOT} here`);
		const children = fs
			.readdirSync(REAL_ROOT, { withFileTypes: true })
			.filter((c) => c.isDirectory());
		expect(children.length).toBeGreaterThan(0);
		const line = /^usage_usec \d+$/m;
		for (const c of children)
			expect(
				fs.readFileSync(path.join(REAL_ROOT, c.name, "cpu.stat"), "utf8"),
			).toMatch(line);
		const fake = writeSchedClock(path.join(dir, "shape"), {
			runtime: 2,
			busy: 2,
		});
		expect(
			fs.readFileSync(
				path.join(fake, "after/cgroup/user.slice/cpu.stat"),
				"utf8",
			),
		).toMatch(line);
	});
});
