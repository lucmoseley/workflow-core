// @vitest-environment node
/*
 * lib/tsc-slot.js (#3163): the type-check slot's rung, its count off `ps`,
 * and which words launch `tsc`. Break it and two `tsc` run at once into the
 * 10 GB cap, as #3113's earlyoom kill did, or a launch goes uncounted.
 */
import { describe, expect, it } from "vitest";

const { TSC_RUNG_MB, tscDenial, isTscLaunch } = require("./tsc-slot.js") as {
	TSC_RUNG_MB: number;
	tscDenial: (
		rows: { pid: number | null; args: string }[] | null,
		mb: number | null,
	) => { limb: string; mb?: number; rungMb?: number } | null;
	isTscLaunch: (words: string[]) => boolean;
};

const rows = (...args: string[]) => args.map((a) => ({ pid: null, args: a }));

describe("lib/tsc-slot.js", () => {
	it("prices the rung at the measured 1,638 MB peak above earlyoom's floor and the margin", () => {
		// 794 + 1638 + 300 = 2732, up to the next 50.
		expect(TSC_RUNG_MB).toBe(2750);
	});

	it("counts a `tsc` by its runner path, never npm's, a shell's or a wrapper's line", () => {
		const decoys = rows(
			"sh -c tsc --noEmit && tsc -p tsconfig.strict.json --noEmit",
			"npm exec tsc --noEmit",
			"vim tsconfig.json",
			"timeout 300 node /r/node_modules/.bin/tsc",
		);
		expect(tscDenial(decoys, 9000)).toBeNull();
		for (const runner of [
			"node /r/node_modules/.bin/tsc --noEmit",
			"/usr/bin/node /r/node_modules/typescript/bin/tsc -p hooks/tsconfig.json",
		])
			expect(tscDenial([...decoys, ...rows(runner)], 9000)).toEqual({
				limb: "count",
			});
	});

	it.each([
		[
			"one running",
			rows("node /r/node_modules/.bin/tsc"),
			9000,
			{ limb: "count" },
		],
		[
			"MemAvailable under the rung",
			rows("bash -l"),
			2749,
			{ limb: "memory", mb: 2749, rungMb: 2750 },
		],
		["neither", rows("bash -l"), 2750, null],
		["`ps` and MemAvailable both unread", null, null, null],
	])("denies on %s", (_label, ps, mb, expected) => {
		expect(tscDenial(ps, mb)).toEqual(expected);
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
