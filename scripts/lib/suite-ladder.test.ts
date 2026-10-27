// @vitest-environment node
/*
 * lib/suite-ladder.js, in process: docs/environment.md §6's rungs and the
 * suites a `ps -eo args` listing shows running. How each reading moves the
 * suite gate's verdict is lib/suite-concurrency.test.ts's; these pin the
 * figures themselves, so a rung moved without a re-measurement fails here.
 *
 * Move a rung down unmeasured and the gate lets a suite start under the
 * headroom earlyoom kills live sessions to keep.
 */

import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { mkScratchDir } from "./git-fixture";
import { carrying } from "./proc-fake";
import { writePsStub } from "./ps-stub";
import { WHOLE_SLOT_BOUND } from "./whole-slot-bound";

interface Weight {
	resolvedFiles: number | null;
	wholeSlot: boolean;
}
interface PsRow {
	pid: number | null;
	args: string;
}
interface Running {
	total: number;
	watchers: number;
	whole: number;
	workers: number;
}

const {
	SUITE_LADDER_MEASURED_AT,
	SUITE_RESTING_MB,
	WRAPPER_ARGV0,
	readCarriedWeightOf,
	readPs,
	runningSuites,
	suiteRungMb,
} = require("./suite-ladder.js") as {
	SUITE_LADDER_MEASURED_AT: { files: number };
	SUITE_RESTING_MB: Record<number, number>;
	WRAPPER_ARGV0: RegExp;
	readCarriedWeightOf: (pid: number | null) => Weight | null;
	readPs: () => { ok: true; rows: PsRow[] } | { ok: false; error: string };
	runningSuites: (
		rows: PsRow[],
		other?: (words: string[]) => boolean,
		carriedOf?: (pid: number | null) => Weight | null,
	) => Running;
	suiteRungMb: (workers: number) => number;
};

describe("the whole-slot bound (#2931)", () => {
	it("sits at a quarter of the suite the ladder was measured on", () => {
		expect(WHOLE_SLOT_BOUND).toBe(
			Math.floor(SUITE_LADDER_MEASURED_AT.files / 4),
		);
	});
});

describe("suiteRungMb, §6's table (#2558)", () => {
	/* 794 MB + the dip + ~300 MB, rounded up to 50; past nine workers each
	 * adds the one-suite dip's share of one, EXTRAPOLATED. */
	it.each([
		[1, 1450],
		[2, 1800],
		[4, 2500],
		[5, 2900],
		[6, 3250],
		[10, 4000],
		[11, 4350],
		[15, 5750],
		[16, 6100],
		[17, 6450],
	])("rests %i vitest worker(s) on %i MB", (workers, mb) => {
		expect(suiteRungMb(workers)).toBe(mb);
	});

	it("keys each suite's resting figure on three workers a suite", () => {
		expect(SUITE_RESTING_MB).toEqual({
			1: suiteRungMb(3),
			2: suiteRungMb(6),
			3: suiteRungMb(9),
		});
	});
});

/** A `ps` listing of `lines`, none carrying a pid. */
const ps = (lines: string[]) => lines.map((args) => ({ pid: null, args }));

describe("runningSuites, the runs `ps` shows (mantahostels#1906, #2560)", () => {
	it("counts the runner line, never the npm wrapper, a worker or a near-named binary", () => {
		expect(
			runningSuites(
				ps([
					"sh -c NODE_OPTIONS=--max-old-space-size=2048 vitest run",
					"node /r/node_modules/.bin/vitest-not-vitest run",
					"node /r/node_modules/.bin/vitest run",
					"node /r/node_modules/vitest/dist/workers/forks.js",
				]),
			),
		).toEqual({ total: 1, watchers: 0, whole: 1, workers: 5 });
	});

	it("reads an empty listing as nothing running", () => {
		expect(runningSuites([])).toEqual({
			total: 0,
			watchers: 0,
			whole: 0,
			workers: 0,
		});
	});

	it("weighs a part-suite by its files, taking no whole slot", () => {
		expect(
			runningSuites(ps(["node /r/node_modules/.bin/vitest run a.test.ts"])),
		).toEqual({ total: 1, watchers: 0, whole: 0, workers: 1 });
	});

	it("counts a watcher as whole, and as a watcher", () => {
		expect(runningSuites(ps(["node /r/node_modules/.bin/vitest"]))).toEqual({
			total: 1,
			watchers: 1,
			whole: 1,
			workers: 5,
		});
	});

	it("skips a `vitest list` probe (#1180) and a shell or wrapper line (#1127)", () => {
		expect(
			runningSuites(
				ps([
					"node /r/node_modules/.bin/vitest list --changed HEAD",
					"timeout 300 node_modules/.bin/vitest run",
					"-bash node_modules/.bin/vitest run",
				]),
			),
		).toEqual({ total: 0, watchers: 0, whole: 0, workers: 0 });
		expect(WRAPPER_ARGV0.test("/usr/bin/zsh x")).toBe(true);
		expect(WRAPPER_ARGV0.test("node x")).toBe(false);
	});

	it("counts a line the other-runner reader names as a whole one-shot (#330)", () => {
		expect(
			runningSuites(ps(["pytest -x", "ls"]), (w) => w[0] === "pytest"),
		).toEqual({ total: 1, watchers: 0, whole: 1, workers: 5 });
	});
});

describe("a running run's carried weight (#2931)", () => {
	/* A `--changed` or full run's runner line names no file. */
	const bare = "node /r/node_modules/.bin/vitest run";

	it("weighs a runner by the weight its process carries over its words", () => {
		const carried = (pid: number | null) =>
			pid === 12 ? { resolvedFiles: 40, wholeSlot: false } : null;
		expect(
			runningSuites(
				[
					{ pid: 11, args: "bash -l" },
					{ pid: 12, args: bare },
					{ pid: 13, args: bare },
				],
				undefined,
				carried,
			),
		).toEqual({ total: 2, watchers: 0, whole: 1, workers: 5 + 5 });
	});

	describe("off WFC_PS and WFC_PROC", () => {
		const dir = mkScratchDir("ps-");
		afterAll(() => {
			vi.unstubAllEnvs();
			fs.rmSync(dir, { recursive: true, force: true });
		});
		const readPsListing = (lines: string[]) => {
			vi.stubEnv("WFC_PS", writePsStub(dir, lines));
			return readPs();
		};

		it("splits a `pid=,args=` listing, a line with no pid keeping its words", () => {
			expect(readPsListing([`  12 ${bare}`, "COMMAND", "7 bash -l"])).toEqual({
				ok: true,
				rows: [
					{ pid: 12, args: bare },
					{ pid: null, args: "COMMAND" },
					{ pid: 7, args: "bash -l" },
					{ pid: null, args: "" },
				],
			});
		});

		it("reads an empty listing or a failed `ps` as unread", () => {
			expect(readPsListing([])).toEqual({
				ok: false,
				error: "ps listed nothing",
			});
			vi.stubEnv("WFC_PS", writePsStub(dir, [], { fails: true }));
			expect(readPs()).toEqual({ ok: false, error: "ps: cannot read /proc" });
		});

		it("reads each runner's launch record off its process", () => {
			const proc = path.join(dir, "proc");
			vi.stubEnv("WFC_PROC", proc);
			carrying(proc, 21, { resolvedFiles: 50, wholeSlot: false });
			carrying(proc, 22, {
				resolvedFiles: SUITE_LADDER_MEASURED_AT.files,
				wholeSlot: true,
			});
			const read = readPsListing([
				`21 ${bare}`,
				`22 ${bare}`,
				`23 ${bare} a.test.ts`,
			]);
			if (!read.ok) throw new Error(read.error);
			expect(runningSuites(read.rows, undefined, readCarriedWeightOf)).toEqual({
				total: 3,
				watchers: 0,
				whole: 1,
				workers: 5 + 5 + 1,
			});
		});
	});
});
