// @vitest-environment node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
	buildEarlyoomBannerLine,
	buildEarlyoomReadingLine,
	buildEarlyoomSignalLine,
	buildKernelLine,
	type FakeBoot,
	writeJournalctl,
} from "./journalctl-fake";
import { runInProcess } from "./run-in-process.js";
import { writeSchedClock } from "./sched-clock-fake";

const { readIncidents } = require("./earlyoom-kills.js");
const { READ_TIMEOUT_MS, readBoots } = require("./journalctl.js");

const KERNEL_STALL = path.join(__dirname, "..", "check-kernel-stall.js");
const MIN = 60 * 1000;
const T0 = Math.floor((Date.now() - 60 * MIN) / 1000) * 1000;
// guess, #3105
const WINDOW_MS = 7 * 24 * 60 * MIN;

const FAKE_JOURNAL = [
	buildEarlyoomSignalLine(Date.now() - WINDOW_MS - 10 * MIN, 41, "node"),
	buildEarlyoomSignalLine(T0 - 2 * MIN, 77, "dbus-daemon", { rss: 1 }),
	buildEarlyoomBannerLine(T0 - MIN),
	buildEarlyoomReadingLine(T0, 776),
	buildEarlyoomSignalLine(T0, 658_446, "MainThread"),
	buildEarlyoomSignalLine(T0 + 3000, 658_446, "MainThread", { sig: "SIGKILL" }),
	buildEarlyoomReadingLine(T0 + MIN, 790, 12),
	buildEarlyoomSignalLine(T0 + MIN, 369_866, "2.1.310", { rss: 450 }),
];
const FAKE_KERNEL = [buildKernelLine(T0, "Booting Linux on physical CPU 0x0")];

const SIGNAL = /^sending SIG\w+ to process (\d+) /;
const READING = /^mem avail:\s*(\d+)\D.*swap free:\s*(\d+)/;
const BANNER = /^sending SIG\w+ when mem/;
const IGNORED = [
	/^earlyoom v/,
	/^mem total: /,
	/^\s*SIG\w+ when mem <=/,
	/^Will avoid killing /,
	/^low memory! /,
	/^escalating to SIG\w+ after /,
	/^process exited after /,
	/^kill failed: /,
	/^memory situation has recovered/,
];
const KERNEL = /^\S+ \S+ [^\s:]+: /;
const KERNEL_IDENT = /^\S+ \S+ kernel: /;

const message = (line: string) => line.match(/ earlyoom\[\d+\]: (.*)$/)?.[1];

const shape = (msg: string) =>
	msg
		.replace(/"[^"]*"/g, '"X"')
		.replace(/SIG\w+/g, "SIG")
		.replace(/-?\d+(\.\d+)?/g, "N")
		.replace(/\s+/g, "");

interface Kill {
	at: string;
	pid: number;
	uid: number;
	name: string;
	rssMiB: number;
	availMiB: number | null;
	swapFreeMiB: number | null;
	signals: number;
}
interface Side {
	real: boolean;
	lines: string[];
	kills: Kill[];
	firstKeptMs: number | null;
	empty: string;
	kernel: { outcome: string; lines: string[] };
	boots: { boots: FakeBoot[]; why: string | null };
	tail: { short: string[]; cat: string[] };
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "journalctl-contract-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function tap(name: string, bin: string) {
	const at = path.join(dir, name);
	const reads = `${at}.reads`;
	fs.mkdirSync(reads, { recursive: true });
	fs.writeFileSync(
		at,
		`#!/usr/bin/env node
const fs = require("node:fs");
const r = require("node:child_process").spawnSync(${JSON.stringify(bin)}, process.argv.slice(2), {
	encoding: "utf8",
	stdio: ["ignore", "pipe", "inherit"],
	maxBuffer: Infinity,
});
if (r.error) process.stderr.write(r.error.message);
const dir = ${JSON.stringify(reads)};
if (!process.argv.includes("--list-boots"))
	fs.writeFileSync(dir + "/" + fs.readdirSync(dir).length, r.stdout ?? "");
process.stdout.write(r.stdout ?? "");
process.exitCode = r.status ?? 1;
`,
		{ mode: 0o755 },
	);
	const last = () => {
		const n = fs.readdirSync(reads).length;
		return n ? fs.readFileSync(path.join(reads, String(n - 1)), "utf8") : "";
	};
	return { at, last };
}

const lineList = (text: string) => text.split("\n").filter(Boolean);

function readKernel(bin: string, name: string): Side["kernel"] {
	const t = tap(`${name}-kernel`, bin);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		WFC_JOURNALCTL: t.at,
		WFC_DMESG: path.join(dir, "no-dmesg"),
		WFC_SCHED_CLOCK: writeSchedClock(path.join(dir, "clock"), {
			runtime: 2,
			busy: 2,
		}),
	};
	delete env.WFC_KERNEL_LOG;
	const r = runInProcess(KERNEL_STALL, ["--json"], { env });
	return {
		outcome: JSON.parse(r.stdout).outcome,
		lines: lineList(t.last()).filter((l) => !l.startsWith("-- ")),
	};
}

// guess, #4594
const TAIL_LINES = "5";

const asCat = (short: string[]) =>
	unindented(short.map((l) => l.replace(KERNEL, "")));
const unindented = (lines: string[]) => lines.map((l) => l.trimStart());

function readTail(bin: string): Side["tail"] {
	const read = (output: string) =>
		lineList(
			spawnSync(bin, ["-k", "-n", TAIL_LINES, "--no-pager", "-o", output], {
				encoding: "utf8",
				timeout: READ_TIMEOUT_MS,
			}).stdout ?? "",
		);
	const pair = () => ({ short: read("short-iso"), cat: read("cat") });
	const first = pair();
	return JSON.stringify(asCat(first.short)) ===
		JSON.stringify(unindented(first.cat))
		? first
		: pair();
}

function readSide(
	name: string,
	bin: string,
	kernelBin: string,
): { side?: Side; why?: string } {
	const t = tap(name, bin);
	vi.stubEnv("WFC_JOURNALCTL", t.at);
	vi.stubEnv("WFC_REFILL_DIR", path.join(dir, "refill"));
	const { incidents, why } = readIncidents(Date.now() - WINDOW_MS);
	if (why !== null) return { why };
	const lines = lineList(t.last());
	readIncidents(Date.now() + 24 * 60 * MIN);
	return {
		side: {
			real: name === "real",
			lines,
			kills: incidents.flatMap((i: { kills: Kill[] }) => i.kills),
			firstKeptMs: incidents.length > 0 ? Date.parse(incidents[0].first) : null,
			empty: t.last().trim(),
			kernel: readKernel(kernelBin, name),
			boots: readBoots(),
			tail: readTail(kernelBin),
		},
	};
}

function lineOf(lines: string[], k: Kill): number {
	return lines.findIndex(
		(l) =>
			Number(message(l)?.match(SIGNAL)?.[1]) === k.pid &&
			Date.parse(l.split(" ")[0] ?? "") === Date.parse(k.at),
	);
}

const countOf = (lines: string[], re: RegExp) =>
	lines.filter((l) => re.test(message(l) ?? "")).length;

const earlyoomLineCount = (lines: string[]) =>
	lines.filter((l) => message(l) !== undefined).length;

type Skip = (note?: string) => never;

function holds(side: Side, n: number, what: string, skip: Skip) {
	if (!side.real) expect(n, what).toBeGreaterThan(0);
	else if (n === 0) skip(`this journal holds no ${what}`);
}

interface Case {
	name: string;
	check: (side: Side, skip: Skip) => void;
}

const CASES: Case[] = [
	{
		name: "every earlyoom line is a shape the fake builds or one the reader ignores",
		check(side: Side, skip: Skip) {
			const { lines } = side;
			holds(side, earlyoomLineCount(lines), "earlyoom line", skip);
			const built = [
				buildEarlyoomSignalLine(T0, 1, "x"),
				buildEarlyoomReadingLine(T0),
				buildEarlyoomBannerLine(T0),
			].map((l) => shape(message(l) ?? ""));
			const start = lines.findLastIndex((l) =>
				/^earlyoom v/.test(message(l) ?? ""),
			);
			for (const l of lines.slice(Math.max(start, 0))) {
				const msg = message(l);
				if (msg === undefined) continue;
				const known =
					built.includes(shape(msg)) || IGNORED.some((re) => re.test(msg));
				expect(known, l).toBe(true);
			}
		},
	},
	{
		name: "every signal line reads as one signal, and no other line does",
		check(side: Side, skip: Skip) {
			const { lines, kills, firstKeptMs } = side;
			holds(side, earlyoomLineCount(lines), "earlyoom line", skip);
			const kept =
				firstKeptMs === null
					? []
					: lines.filter(
							(l) => Date.parse(l.split(" ")[0] ?? "") >= firstKeptMs,
						);
			expect(kills.reduce((n, k) => n + k.signals, 0)).toBe(
				countOf(kept, SIGNAL),
			);
		},
	},
	{
		name: "a kill carries its signal line's pid, uid, comm and VmRSS",
		check(side: Side, skip: Skip) {
			const { lines, kills } = side;
			holds(side, kills.length, "kill", skip);
			for (const k of kills) {
				const at = lineOf(lines, k);
				expect(at).toBeGreaterThanOrEqual(0);
				const line = lines[at] ?? "";
				expect(line).toContain(` to process ${k.pid} `);
				expect(line).toContain(` uid ${k.uid} `);
				expect(line).toContain(`"${k.name}"`);
				expect(line).toContain(`VmRSS ${k.rssMiB} MiB`);
			}
		},
	},
	{
		name: "a kill carries the mem avail and swap free reading before it",
		check(side: Side, skip: Skip) {
			const { lines, kills } = side;
			holds(side, countOf(lines, READING), "mem avail reading", skip);
			for (const k of kills) {
				const at = lineOf(lines, k);
				expect(at).toBeGreaterThanOrEqual(0);
				const r = lines
					.slice(0, at)
					.map((l) => message(l)?.match(READING))
					.findLast(Boolean);
				expect([k.availMiB, k.swapFreeMiB]).toEqual(
					r ? [Number(r[1]), Number(r[2])] : [null, null],
				);
			}
		},
	},
	{
		name: "earlyoom's startup banner reads as no kill",
		check(side: Side, skip: Skip) {
			const { lines, kills } = side;
			holds(side, countOf(lines, BANNER), "startup banner", skip);
			for (const k of kills) {
				const at = lineOf(lines, k);
				expect(at).toBeGreaterThanOrEqual(0);
				expect(message(lines[at] ?? "")).not.toMatch(BANNER);
			}
		},
	},
	{
		name: "a read with nothing to serve prints -- No entries --",
		check({ empty }: Side) {
			expect(empty).toBe("-- No entries --");
		},
	},
	{
		name: "the kernel log reads in check-kernel-stall.js, in buildKernelLine's shape",
		check(side: Side, skip: Skip) {
			const { kernel } = side;
			const stamped = kernel.lines.filter((l) => !/^\s/.test(l));
			holds(side, side.tail.short.length, "kernel line", skip);
			expect(kernel.outcome).not.toBe("SKIP");
			expect(stamped.some((l) => KERNEL_IDENT.test(l))).toBe(true);
			for (const l of stamped) {
				expect(l).toMatch(KERNEL);
				expect(Number.isNaN(Date.parse(l.split(" ")[0] ?? ""))).toBe(false);
			}
		},
	},
	{
		name: "the boot list reads as boots, each a 32-hex id over a span, oldest first",
		check({ boots: { boots, why } }: Side) {
			expect(why).toBeNull();
			expect(boots.length).toBeGreaterThan(0);
			let after = Number.NEGATIVE_INFINITY;
			for (const b of boots) {
				expect(b.id).toMatch(/^[0-9a-f]{32}$/);
				expect(b.from).toBeGreaterThan(after);
				expect(b.to).toBeGreaterThanOrEqual(b.from);
				after = b.to;
			}
		},
	},
	{
		name: "-o cat prints each line's message alone, less its stamp, host and ident",
		check(side: Side, skip: Skip) {
			const { tail } = side;
			holds(side, tail.short.length, "kernel line", skip);
			expect(unindented(tail.cat)).toEqual(asCat(tail.short));
		},
	},
];

let fake: Side | undefined;
let real: { side?: Side; skip?: string } | undefined;

function readReal(): { side?: Side; skip?: string } {
	if (process.env.GITHUB_ACTIONS)
		return { skip: "CI: the live journal is the founder's machine's (§G7)" };
	const { side, why } = readSide("real", "journalctl", "journalctl");
	if (why === undefined) return { side };
	if (why.includes("ENOENT")) return { skip: why };
	throw new Error(why);
}

describe.each(CASES)("$name", (c) => {
	it("on the fake", ({ skip }) => {
		fake ??= readSide(
			"fake",
			writeJournalctl(path.join(dir, "earlyoom"), FAKE_JOURNAL),
			writeJournalctl(path.join(dir, "kernel"), FAKE_KERNEL),
		).side;
		c.check(fake as Side, skip);
	});

	it("on the real journal", ({ skip }) => {
		real ??= readReal();
		if (!real.side) return skip(real.skip);
		c.check(real.side, skip);
	}, 45_000);
});
