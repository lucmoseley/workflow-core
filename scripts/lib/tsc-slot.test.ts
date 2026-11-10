// @vitest-environment node
/*
 * lib/tsc-slot.js (#3163): the type-check slot's rung, its count off `ps`,
 * and which words launch `tsc`. Break it and two `tsc` run at once into the
 * 10 GB cap, as #3113's earlyoom kill did, or a launch goes uncounted.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const { launchPeakMb, runnerPeakMb, tscDenial, tscLaunchBin } =
	require("./tsc-slot.js") as {
		launchPeakMb: (
			dir: string,
			launch?: { bin?: string; readMajor?: (bin: string) => number | null },
		) => number;
		runnerPeakMb: (
			row: { pid: number | null; args: string },
			readMajor?: (bin: string) => number | null,
		) => number;
		tscDenial: (
			rows: { pid: number | null; args: string }[] | null,
			mb: number | null,
			climbMb?: number,
			limbs?: {
				windows?:
					| { state: "fresh"; mb: number; ageS: number }
					| { state: "absent" }
					| { state: "stale"; why: string };
				peakMb?: number;
			},
		) => {
			limb: string;
			pids?: (number | null)[];
			memory?: { mb: number; rungMb: number; climbMb?: number };
			mb?: number;
			rungMb?: number;
			climbMb?: number;
		} | null;
		tscLaunchBin: (words: string[]) => string | null;
	};
const { rungMb } = require("./suite-ladder.js") as {
	rungMb: (peakMb: number) => number;
};
const { chargeMb } = require("./launch-charge.js") as {
	chargeMb: (launch: { kind: "tsc"; major: number }) => number;
};
const TSC_PEAKS_MB = {
	5: chargeMb({ kind: "tsc", major: 5 }),
	7: chargeMb({ kind: "tsc", major: 7 }),
};

const rung5 = rungMb(TSC_PEAKS_MB[5]);

const rows = (...args: string[]) => args.map((a) => ({ pid: null, args: a }));

describe("lib/tsc-slot.js", () => {
	it("prices the rung at the measured 2,045 MB peak above earlyoom's floor and the margin", () => {
		// 794 + 2045 + 300 = 3139, up to the next 50.
		expect(rung5).toBe(3150);
	});

	/* Recorded off `ps` during a 7.0.2 pass on node 24.18 (#4892): the
	 * launcher, then the same PID as the native compiler after `execve`. */
	const root = "/r/.claude/worktrees/w/node_modules";
	const launcher7 = `node ${root}/@typescript/native/bin/tsc -p tsconfig.json --noEmit --checkers 2`;
	const native7 = `${root}/@typescript/typescript-linux-arm64/lib/tsc -p tsconfig.json --noEmit --checkers 2`;

	it.each([
		["through `.bin`", `node ${root}/.bin/tsc --noEmit --checkers 2`],
		["by its resolved path, as typecheck-mods.js runs it", launcher7],
		["as the native compiler its launcher became", native7],
	])(
		"counts a TypeScript 7 runner %s as one runner (#4892)",
		(_label, line) => {
			expect(tscDenial([{ pid: 7, args: line }], 9000)).toEqual({
				limb: "count",
				pids: [7],
			});
		},
	);

	it("counts a launcher and the native child it spawned without `execve` as one runner (#4892)", () => {
		const pair = [
			{ pid: 7, args: launcher7 },
			{ pid: 8, args: native7 },
		];
		expect(tscDenial(pair, 9000)).toEqual({ limb: "count", pids: [7] });
		// A native compiler of another tree, or other arguments, is its own runner.
		const other = native7.replace("/w/", "/v/");
		expect(tscDenial([...pair, { pid: 9, args: other }], 9000)).toEqual({
			limb: "count",
			pids: [7, 9],
		});
	});

	it("pairs a launcher through a linked `node_modules`, by a relative path, with its native child (#4892)", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tsc-slot-"));
		try {
			const store = path.join(dir, "store", "node_modules");
			const at = (rel: string) => {
				fs.mkdirSync(path.dirname(path.join(store, rel)), { recursive: true });
				fs.writeFileSync(path.join(store, rel), "");
			};
			at("@typescript/native/bin/tsc");
			at("@typescript/typescript-linux-arm64/lib/tsc");
			fs.mkdirSync(path.join(store, ".bin"));
			fs.symlinkSync(
				"../@typescript/native/bin/tsc",
				path.join(store, ".bin", "tsc"),
			);
			fs.mkdirSync(path.join(dir, "wt"));
			fs.symlinkSync(store, path.join(dir, "wt", "node_modules"));
			const bin = path.relative(
				process.cwd(),
				path.join(dir, "wt", "node_modules", ".bin", "tsc"),
			);
			const pair = [
				{ pid: process.pid, args: `node ${bin} --noEmit` },
				{
					pid: 8,
					args: `${store}/@typescript/typescript-linux-arm64/lib/tsc --noEmit`,
				},
			];
			expect(tscDenial(pair, 9000)).toEqual({
				limb: "count",
				pids: [process.pid],
			});
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("never counts a 7.0 waiter's or wrapper's line (#3276, #4892)", () => {
		const decoys = rows(
			`node scripts/queue-run.js --tsc -- ${native7}`,
			`node scripts/queue-run.js --tsc -- ${launcher7}`,
			`sh -c ${native7}`,
			`timeout 300 ${native7}`,
		);
		expect(tscDenial(decoys, 9000)).toBeNull();
	});

	it("charges a running `tsc` its own compiler's peak (#4892)", () => {
		const major = (m: number | null) => () => m;
		const line = (args: string, pid: number | null = null) => ({ pid, args });
		expect(runnerPeakMb(line(native7), major(null))).toBe(TSC_PEAKS_MB[7]);
		expect(runnerPeakMb(line(launcher7), major(7))).toBe(TSC_PEAKS_MB[7]);
		const bin = "node /r/node_modules/.bin/tsc";
		expect(runnerPeakMb(line(bin), major(5))).toBe(2045);
		// A version that will not read, 6.0 among them, is charged the highest.
		expect(runnerPeakMb(line(bin), major(null))).toBe(2045);
		expect(runnerPeakMb(line(`${bin}6`), major(6))).toBe(2045);
	});

	it("reads a relative launcher path against its own process's directory, never the reader's (#4892)", () => {
		const seen: string[] = [];
		const read = (bin: string) => {
			seen.push(bin);
			return 7;
		};
		const relative = "node node_modules/.bin/tsc --noEmit";
		expect(runnerPeakMb({ pid: 42, args: relative }, read)).toBe(
			TSC_PEAKS_MB[7],
		);
		expect(seen).toEqual(["/proc/42/cwd/node_modules/.bin/tsc"]);
		// With no PID to read its directory by, the highest.
		expect(runnerPeakMb({ pid: null, args: relative }, read)).toBe(2045);
		expect(seen).toHaveLength(1);
	});

	it("charges a launch the peak of the compiler `.bin/tsc` resolves to from its directory up (#4892)", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tsc-slot-"));
		try {
			const tree = (name: string, version: string) => {
				const pkg = path.join(dir, name, "node_modules", "pkg");
				fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
				fs.writeFileSync(
					path.join(pkg, "package.json"),
					JSON.stringify({ version }),
				);
				fs.writeFileSync(path.join(pkg, "bin", "tsc"), "");
				const bin = path.join(dir, name, "node_modules", ".bin");
				fs.mkdirSync(bin);
				fs.symlinkSync("../pkg/bin/tsc", path.join(bin, "tsc"));
				fs.mkdirSync(path.join(dir, name, "sub"));
				return path.join(dir, name, "sub");
			};
			expect(launchPeakMb(tree("seven", "7.0.2"))).toBe(TSC_PEAKS_MB[7]);
			const six = tree("six", "6.0.3");
			fs.renameSync(
				path.join(dir, "six", "node_modules", ".bin", "tsc"),
				path.join(dir, "six", "node_modules", ".bin", "tsc6"),
			);
			// 6.0, launched as `tsc6`, is charged the highest.
			expect(launchPeakMb(six, { bin: "tsc6" })).toBe(2045);
			expect(launchPeakMb(tree("five", "5.9.3"))).toBe(2045);
			expect(launchPeakMb(dir)).toBe(2045);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("holds a launch on its own compiler's rung (#4892)", () => {
		const rung7 = rungMb(TSC_PEAKS_MB[7]);
		expect(rung7).toBeLessThan(rung5);
		expect(
			tscDenial(rows("bash -l"), rung7, 0, { peakMb: TSC_PEAKS_MB[7] }),
		).toBeNull();
		expect(
			tscDenial(rows("bash -l"), rung7 - 1, 0, { peakMb: TSC_PEAKS_MB[7] }),
		).toEqual({ limb: "memory", mb: rung7 - 1, rungMb: rung7 });
		// The same reading holds a 5.x launch.
		expect(
			tscDenial(rows("bash -l"), rung7, 0, { peakMb: 2045 }),
		).toMatchObject({
			limb: "memory",
			rungMb: rung5,
		});
	});

	it("counts a `tsc` by its runner path, never npm's, a shell's, a wrapper's or a queued waiter's line", () => {
		const decoys = rows(
			"sh -c tsc --noEmit && tsc -p tsconfig.strict.json --noEmit",
			"npm exec tsc --noEmit",
			"vim tsconfig.json",
			"timeout 300 node /r/node_modules/.bin/tsc",
			"node scripts/queue-run.js --tsc -- node_modules/.bin/tsc -p . --noEmit",
		);
		expect(tscDenial(decoys, 9000)).toBeNull();
		for (const runner of [
			"node /r/node_modules/.bin/tsc --noEmit",
			"/usr/bin/node /r/node_modules/typescript/bin/tsc -p hooks/tsconfig.json",
			// A session worktree's cold `tsc`, its `node_modules` a store link (#4245).
			"node /r/.claude/worktrees/implement-1-3fa9c1/node_modules/.bin/tsc --noEmit",
		])
			expect(tscDenial([...decoys, ...rows(runner)], 9000)).toEqual({
				limb: "count",
				pids: [null],
			});
	});

	it.each([
		[
			"one running, naming its PID (#4359)",
			[{ pid: 4242, args: "node /r/node_modules/.bin/tsc" }],
			9000,
			{ limb: "count", pids: [4242] },
		],
		[
			"MemAvailable under the rung",
			rows("bash -l"),
			rung5 - 1,
			{ limb: "memory", mb: rung5 - 1, rungMb: rung5 },
		],
		[
			"one running under the rung, naming both (#4359)",
			[{ pid: 4242, args: "node /r/node_modules/.bin/tsc" }],
			rung5 - 1,
			{
				limb: "count",
				pids: [4242],
				memory: { mb: rung5 - 1, rungMb: rung5 },
			},
		],
		["neither", rows("bash -l"), rung5, null],
		["`ps` and MemAvailable both unread", null, null, null],
	])("denies on %s", (_label, ps, mb, expected) => {
		expect(tscDenial(ps, mb)).toEqual(expected);
	});

	it("charges what a climbing suite has yet to draw on the rung, naming it apart (#3416)", () => {
		const mb = rung5 + 250;
		expect(tscDenial(rows("bash -l"), mb, 251)).toEqual({
			limb: "memory",
			mb,
			rungMb: rung5,
			climbMb: 251,
		});
		expect(tscDenial(rows("bash -l"), mb, 250)).toBeNull();
	});

	it("holds a `tsc` the guest admits while Windows is under its floor (#4557, #4850)", () => {
		const windows = (mb: number) => ({ state: "fresh" as const, mb, ageS: 30 });
		expect(
			tscDenial(rows("bash -l"), 9000, 100, { windows: windows(999) }),
		).toEqual({
			limb: "windows",
			mb: 999,
		});
		expect(
			tscDenial(rows("bash -l"), 9000, 100, { windows: windows(1000) }),
		).toBeNull();
		// The guest rung is named first.
		expect(
			tscDenial(rows("bash -l"), rung5 - 1, 0, { windows: windows(10) }),
		).toMatchObject({
			limb: "memory",
		});
	});

	it("fails open on a Windows reading that is stale or absent (#4557)", () => {
		for (const windows of [
			{ state: "absent" as const },
			{ state: "stale" as const, why: "old" },
		])
			expect(tscDenial(rows("bash -l"), 9000, 0, { windows })).toBeNull();
	});

	it.each([
		["tsc --noEmit", true],
		["node_modules/.bin/tsc", true],
		["npx tsc -p x", true],
		["npm exec tsc", true],
		["node /r/node_modules/typescript/bin/tsc -p x", true],
		["node /r/node_modules/@typescript/native/bin/tsc -p x", true],
		["/r/node_modules/@typescript/typescript-linux-arm64/lib/tsc -p x", true],
		["node_modules/.bin/tsc6 -p tsconfig.build.json", true],
		["npx tsc6", true],
		["npx tsx a.ts", false],
		["npm run typecheck", false],
		["node scripts/queue-run.js --tsc -- tsc", false],
		["cat tsconfig.json", false],
	])("reads `%s` as a tsc launch: %s", (command, expected) => {
		expect(tscLaunchBin(command.split(" ")) !== null).toBe(expected);
	});

	it.each([
		["tsc --noEmit", "tsc"],
		["node_modules/.bin/tsc6 -p x", "tsc6"],
		["npm exec tsc6", "tsc6"],
		["npm run typecheck", null],
	])("names `%s`'s binary %s (#4892)", (command, bin) => {
		expect(tscLaunchBin(command.split(" "))).toBe(bin);
	});
});
