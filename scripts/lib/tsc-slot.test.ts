// @vitest-environment node
/*
 * lib/tsc-slot.js (#3163): the type-check slot's rung, its count off `ps`,
 * and which words launch `tsc`. Break it and two `tsc` run at once into the
 * 10 GB cap, as #3113's earlyoom kill did, or a launch goes uncounted.
 */
import { describe, expect, it } from "vitest";
import { DRAW_MARGIN_MB } from "./suite-ladder";

const { TSC_PEAK_MB, TSC_RUNG_MB, tscDenial, isTscLaunch } =
	require("./tsc-slot.js") as {
		TSC_PEAK_MB: number;
		TSC_RUNG_MB: number;
		tscDenial: (
			rows: { pid: number | null; args: string }[] | null,
			mb: number | null,
			climbMb?: number,
			windows?:
				| { state: "fresh"; mb: number; ageS: number }
				| { state: "absent" }
				| { state: "stale"; why: string },
		) => {
			limb: string;
			pids?: (number | null)[];
			memory?: { mb: number; rungMb: number; climbMb?: number };
			mb?: number;
			rungMb?: number;
			climbMb?: number;
			needMb?: number;
		} | null;
		isTscLaunch: (words: string[]) => boolean;
	};

const rows = (...args: string[]) => args.map((a) => ({ pid: null, args: a }));

describe("lib/tsc-slot.js", () => {
	it("prices the rung at the measured 2,045 MB peak above earlyoom's floor and the margin", () => {
		// 794 + 2045 + 300 = 3139, up to the next 50.
		expect(TSC_RUNG_MB).toBe(3150);
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
			TSC_RUNG_MB - 1,
			{ limb: "memory", mb: TSC_RUNG_MB - 1, rungMb: TSC_RUNG_MB },
		],
		[
			"one running under the rung, naming both (#4359)",
			[{ pid: 4242, args: "node /r/node_modules/.bin/tsc" }],
			TSC_RUNG_MB - 1,
			{
				limb: "count",
				pids: [4242],
				memory: { mb: TSC_RUNG_MB - 1, rungMb: TSC_RUNG_MB },
			},
		],
		["neither", rows("bash -l"), TSC_RUNG_MB, null],
		["`ps` and MemAvailable both unread", null, null, null],
	])("denies on %s", (_label, ps, mb, expected) => {
		expect(tscDenial(ps, mb)).toEqual(expected);
	});

	it("charges what a climbing suite has yet to draw on the rung, naming it apart (#3416)", () => {
		const mb = TSC_RUNG_MB + 250;
		expect(tscDenial(rows("bash -l"), mb, 251)).toEqual({
			limb: "memory",
			mb,
			rungMb: TSC_RUNG_MB,
			climbMb: 251,
		});
		expect(tscDenial(rows("bash -l"), mb, 250)).toBeNull();
	});

	it("holds a `tsc` the guest admits while Windows has less free than its peak, the climb and the margin (#4557)", () => {
		const windows = (mb: number) => ({ state: "fresh" as const, mb, ageS: 30 });
		// Peak + 100 climb + the margin.
		const needMb = TSC_PEAK_MB + 100 + DRAW_MARGIN_MB;
		expect(tscDenial(rows("bash -l"), 9000, 100, windows(needMb - 1))).toEqual({
			limb: "windows",
			mb: needMb - 1,
			needMb,
		});
		expect(tscDenial(rows("bash -l"), 9000, 100, windows(needMb))).toBeNull();
		// The guest rung is named first.
		expect(
			tscDenial(rows("bash -l"), TSC_RUNG_MB - 1, 0, windows(10)),
		).toMatchObject({
			limb: "memory",
		});
	});

	it("fails open on a Windows reading that is stale or absent (#4557)", () => {
		for (const windows of [
			{ state: "absent" as const },
			{ state: "stale" as const, why: "old" },
		])
			expect(tscDenial(rows("bash -l"), 9000, 0, windows)).toBeNull();
	});

	it.each([
		["tsc --noEmit", true],
		["node_modules/.bin/tsc", true],
		["npx tsc -p x", true],
		["npm exec tsc", true],
		["node /r/node_modules/typescript/bin/tsc -p x", true],
		["npx tsx a.ts", false],
		["npm run typecheck", false],
		["node scripts/queue-run.js --tsc -- tsc", false],
		["cat tsconfig.json", false],
	])("reads `%s` as a tsc launch: %s", (command, expected) => {
		expect(isTscLaunch(command.split(" "))).toBe(expected);
	});
});
