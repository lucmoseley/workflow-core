// @vitest-environment node
/*
 * Holds lib/dmesg-fake.ts to the real dmesg (§G7, #2207, #3362): each case
 * runs against the fake and the machine's own dmesg and checks shape and
 * verdict, never values, the kernel ring read through check-kernel-stall.js's
 * dmesg reader. Loosened, every kernel-stall reader test stays green on the
 * fake while a new dmesg prints a stamp the fake does not, or production
 * counts a refusal as a clean ring.
 *
 * The real side runs where dmesg is installed, never in CI (§G7 item 2): the
 * open-ring cases where kernel.dmesg_restrict lets it read, the restricted
 * case where it does not, and none where it fails for another reason.
 *
 * Red on the real side after a util-linux upgrade: `dmesg -T | head`, then fix
 * check-kernel-stall.js's dmesg reader or the fake's builder.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { dmesgLine, writeDmesg } from "./dmesg-fake";
import { runInProcess } from "./run-in-process.js";
import { writeSchedClock } from "./sched-clock-fixture";

const KERNEL_STALL = path.join(__dirname, "..", "check-kernel-stall.js");

/** `[Wed Oct  7 22:43:24 2026] `, ctime's shape, as `-T` stamps a line. */
const CTIME =
	/^\[(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ \d]\d \d\d:\d\d:\d\d \d{4}\] /;
/** `[    0.000000] `, seconds since boot, as a read without `-T` stamps one. */
const MONOTONIC = /^\[\s*\d+\.\d{6}\] /;

const T0 = Date.parse("2026-10-07T22:43:24Z");
const FAKE_RING = [
	dmesgLine(T0, "Booting Linux on physical CPU 0x0000000000"),
	dmesgLine(T0 + 1500, "hv_balloon: Max. dynamic memory size: 10240 MB"),
];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dmesg-contract-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

interface Read {
	status: number | null;
	stdout: string;
	stderr: string;
}
interface Side {
	/** `dmesg -T`, and `dmesg` with no flag, run directly. */
	stamped: Read;
	plain: Read;
	/** check-kernel-stall.js's --json outcome and data, dmesg its only reader. */
	verdict: { outcome: string; readers?: string[]; lines?: number };
}

function read(bin: string, args: string[]): Read {
	const r = spawnSync(bin, args, {
		encoding: "utf8",
		maxBuffer: Number.POSITIVE_INFINITY,
	});
	if (r.error) throw r.error;
	return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function readSide(name: string, bin: string): Side {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		WFC_JOURNALCTL: path.join(dir, "no-journalctl"),
		WFC_DMESG: bin,
		WFC_SCHED_CLOCK: writeSchedClock(path.join(dir, `clock-${name}`), {
			rq: 2,
			busy: 2,
		}),
	};
	delete env.WFC_KERNEL_LOG;
	const r = runInProcess(KERNEL_STALL, ["--json"], { env });
	return {
		stamped: read(bin, ["-T"]),
		plain: read(bin, []),
		verdict: JSON.parse(r.stdout),
	};
}

const lineList = (text: string) => text.split("\n").filter((l) => l.trim());

interface Case {
	name: string;
	ring: "open" | "restricted";
	check: (side: Side) => void;
}

const CASES: Case[] = [
	{
		name: "-T stamps each line in ctime's shape, bar a message's indented later lines",
		ring: "open",
		check({ stamped }: Side) {
			expect(stamped.status).toBe(0);
			const lines = lineList(stamped.stdout);
			expect(lines.length).toBeGreaterThan(0);
			for (const l of lines) {
				if (/^\s/.test(l)) continue;
				expect(l).toMatch(CTIME);
			}
			expect(lines[0]).toMatch(CTIME);
		},
	},
	{
		name: "without -T a line is stamped in seconds since boot",
		ring: "open",
		check({ plain }: Side) {
			expect(plain.status).toBe(0);
			expect(lineList(plain.stdout)[0]).toMatch(MONOTONIC);
		},
	},
	{
		name: "check-kernel-stall.js reads every line -T served",
		ring: "open",
		check({ stamped, verdict }: Side) {
			expect(verdict.outcome).not.toBe("SKIP");
			expect(verdict.readers).toHaveLength(1);
			/* A live ring can grow between the two reads. */
			expect(verdict.lines).toBeGreaterThanOrEqual(
				lineList(stamped.stdout).length,
			);
		},
	},
	{
		name: "a restricted ring refuses with nothing on stdout, which reads as SKIP",
		ring: "restricted",
		check({ stamped, verdict }: Side) {
			expect(stamped.status).not.toBe(0);
			expect(stamped.stdout).toBe("");
			expect(stamped.stderr.trim()).not.toBe("");
			expect(verdict.outcome).toBe("SKIP");
		},
	},
];

const fakes: Partial<Record<Case["ring"], Side>> = {};
let real: { side?: Side; ring?: Case["ring"]; skip?: string } | undefined;

function readReal(): { side?: Side; ring?: Case["ring"]; skip?: string } {
	if (process.env.GITHUB_ACTIONS)
		return { skip: "CI: the live ring is the founder's machine's (§G7)" };
	let side: Side;
	try {
		side = readSide("real", "dmesg");
	} catch (e) {
		return { skip: `no dmesg here: ${(e as Error).message}` };
	}
	if (side.stamped.status === 0) return { side, ring: "open" };
	if (/not permitted/i.test(side.stamped.stderr))
		return { side, ring: "restricted" };
	return { skip: `dmesg -T failed: ${side.stamped.stderr.trim()}` };
}

describe.each(CASES)("$name", (c) => {
	it("on the fake", () => {
		fakes[c.ring] ??= readSide(
			`fake-${c.ring}`,
			writeDmesg(path.join(dir, `fake-${c.ring}`), FAKE_RING, {
				restricted: c.ring === "restricted",
			}),
		);
		c.check(fakes[c.ring] as Side);
	});

	/* The first runs every real read: dmesg -T, dmesg, and check-kernel-stall.js's
	 * under its 5 s READ_TIMEOUT_MS; the two direct reads took 0.02 s here. */
	it("on the real dmesg", ({ skip }) => {
		real ??= readReal();
		if (!real.side) return skip(real.skip);
		if (real.ring !== c.ring) return skip(`dmesg's ring is ${real.ring} here`);
		c.check(real.side);
	}, 15_000);
});
