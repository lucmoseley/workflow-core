// @vitest-environment node
/*
 * Holds lib/earlyoom-journal-fake.ts to the real journalctl (§G7, #2207,
 * #3105): each case runs against the fake and the machine's own journal and
 * checks shape and verdict, never values. A week of the earlyoom journal is
 * read through lib/earlyoom-kills.js's readIncidents, the kernel log through
 * check-kernel-stall.js, each case checking the text the reader was served.
 * Loosened, every incident-filer and kernel-stall test stays green on the fake
 * while production reads nothing from what a new earlyoom or journalctl
 * prints.
 *
 * The real side runs where the earlyoom unit has journal lines, never in CI
 * (§G7 item 2).
 *
 * Case 1 is the only net for a drifted mem avail reading that no kill follows.
 *
 * Red on the real side after an earlyoom upgrade: `journalctl -u earlyoom -o
 * short-iso | tail`, then fix earlyoom-kills.js's regex, the fake's builder,
 * or IGNORED below for a line the reader has no use for.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	kernelLine,
	otherLine,
	readingLine,
	signalLine,
	writeJournalctl,
} from "./earlyoom-journal-fake";
import { runInProcess } from "./run-in-process.js";
import { writeSchedClock } from "./sched-clock-fixture";

const { readIncidents } = require("./earlyoom-kills.js");

const KERNEL_STALL = path.join(__dirname, "..", "check-kernel-stall.js");
const MIN = 60 * 1000;
/** An hour ago, to the second, so the fake's journal falls in the window. */
const T0 = Math.floor((Date.now() - 60 * MIN) / 1000) * 1000;
/**
 * How far back each side reads: a whole read outruns earlyoom-kills.js's 5 s
 * read timeout under load.
 */
const WINDOW_MS = 7 * 24 * 60 * MIN;

const FAKE_JOURNAL = [
	signalLine(T0 - 2 * MIN, 77, "dbus-daemon", { rss: 1 }),
	otherLine(T0 - MIN),
	readingLine(T0, 776),
	signalLine(T0, 658_446, "MainThread"),
	signalLine(T0 + 3000, 658_446, "MainThread", { sig: "SIGKILL" }),
	readingLine(T0 + MIN, 790, 12),
	signalLine(T0 + MIN, 369_866, "2.1.310", { rss: 450 }),
];
const FAKE_KERNEL = [kernelLine(T0, "Booting Linux on physical CPU 0x0")];

const SIGNAL = /^sending SIG\w+ to process (\d+) /;
const READING = /^mem avail:\s*(\d+)\D.*swap free:\s*(\d+)/;
const BANNER = /^sending SIG\w+ when mem/;
/** The lines earlyoom prints that the reader has no use for. */
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
/** `<stamp> <host> <ident>: `, the ident mostly `kernel`. */
const KERNEL = /^\S+ \S+ [^\s:]+: /;
/** The ident kernelLine writes. */
const KERNEL_IDENT = /^\S+ \S+ kernel: /;

/** earlyoom's own words: the line less its stamp, host and `earlyoom[pid]: `. */
const message = (line: string) => line.match(/ earlyoom\[\d+\]: (.*)$/)?.[1];

/** A message's shape: its numbers, names and signals blanked. */
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
	/** The journal lines readIncidents read, and the kills it read from them. */
	lines: string[];
	kills: Kill[];
	/** What a read with nothing to serve printed. */
	empty: string;
	/** check-kernel-stall.js's --json outcome, and the `-k` lines it read. */
	kernel: { outcome: string; lines: string[] };
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "earlyoom-contract-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/**
 * A journalctl in `dir` that runs `bin` and keeps each read's stdout. Its
 * path, and a reader of the reads it kept.
 */
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
			rq: 2,
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

/**
 * One side, its earlyoom journal read through `bin` and its kernel log through
 * `kernelBin`; `why` where readIncidents could not read.
 */
function readSide(
	name: string,
	bin: string,
	kernelBin: string,
): { side?: Side; why?: string } {
	const t = tap(name, bin);
	const was = process.env.WFC_JOURNALCTL;
	process.env.WFC_JOURNALCTL = t.at;
	try {
		const { incidents, why } = readIncidents(Date.now() - WINDOW_MS);
		if (why !== null) return { why };
		/* readIncidents widens its read until it holds every incident whole:
		 * its last read is the one its kills came from. */
		const lines = lineList(t.last());
		readIncidents(Date.now() + 24 * 60 * MIN);
		return {
			side: {
				real: name === "real",
				lines,
				kills: incidents.flatMap((i: { kills: Kill[] }) => i.kills),
				empty: t.last().trim(),
				kernel: readKernel(kernelBin, name),
			},
		};
	} finally {
		if (was === undefined) delete process.env.WFC_JOURNALCTL;
		else process.env.WFC_JOURNALCTL = was;
	}
}

/** The journal line a kill's first signal was read from; -1 where none. */
function lineOf(lines: string[], k: Kill): number {
	return lines.findIndex(
		(l) =>
			Number(message(l)?.match(SIGNAL)?.[1]) === k.pid &&
			Date.parse(l.split(" ")[0] ?? "") === Date.parse(k.at),
	);
}

const countOf = (lines: string[], re: RegExp) =>
	lines.filter((l) => re.test(message(l) ?? "")).length;

type Skip = (note?: string) => never;

/**
 * A case has `what` to check: the fake must serve it; a real journal may lack
 * it, rotated away or never logged, and the case skips.
 */
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
		check({ lines }: Side) {
			const built = [
				signalLine(T0, 1, "x"),
				readingLine(T0),
				otherLine(T0),
			].map((l) => shape(message(l) ?? ""));
			/* Since earlyoom last started: the journal's past holds what older
			 * versions printed. */
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
		check({ lines, kills }: Side) {
			expect(kills.reduce((n, k) => n + k.signals, 0)).toBe(
				countOf(lines, SIGNAL),
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
		name: "the kernel log reads in check-kernel-stall.js, in kernelLine's shape",
		check({ kernel }: Side) {
			expect(kernel.outcome).not.toBe("SKIP");
			/* A message's later lines come indented under its first. */
			const stamped = kernel.lines.filter((l) => !/^\s/.test(l));
			expect(stamped.some((l) => KERNEL_IDENT.test(l))).toBe(true);
			for (const l of stamped) {
				expect(l).toMatch(KERNEL);
				expect(Number.isNaN(Date.parse(l.split(" ")[0] ?? ""))).toBe(false);
			}
		},
	},
];

let fake: Side | undefined;
let real: { side?: Side; skip?: string } | undefined;

function readReal(): { side?: Side; skip?: string } {
	if (process.env.GITHUB_ACTIONS)
		return { skip: "CI: the live journal is the founder's machine's (§G7)" };
	const { side, why } = readSide("real", "journalctl", "journalctl");
	if (why !== undefined && !why.includes("ENOENT")) throw new Error(why);
	if (!side?.lines.some((l) => message(l) !== undefined))
		return { skip: why ?? "this host has no earlyoom unit with journal lines" };
	return { side };
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

	/* The first runs every real read, each under its reader's 5 s timeout:
	 * readIncidents' week, its empty read and the kernel log. */
	it("on the real journal", ({ skip }) => {
		real ??= readReal();
		if (!real.side) return skip(real.skip);
		c.check(real.side, skip);
	}, 25_000);
});
