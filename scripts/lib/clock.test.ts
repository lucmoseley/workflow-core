// @vitest-environment node

import { createRequire } from "node:module";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const CLOCK = require.resolve("./clock.js");

const loadClock = (): typeof import("./clock.js") => {
	delete require.cache[CLOCK];
	return require(CLOCK);
};

it("steps the duration clock by WFC_STEP_MS per read, from 0", () => {
	const { monotonicMs } = loadClock();
	const env = { WFC_STEP_MS: "1300" };
	expect([monotonicMs(env), monotonicMs(env), monotonicMs(env)]).toEqual([
		0, 1300, 2600,
	]);
});

it.each(["0", "-5", "1.5", "soon"])(
	"refuses a WFC_STEP_MS of %s rather than reading the real clock",
	(raw) => {
		const { monotonicMs } = loadClock();
		expect(() => monotonicMs({ WFC_STEP_MS: raw })).toThrow(
			`WFC_STEP_MS is not a whole number of ms: ${raw}`,
		);
	},
);

it("reads the real monotonic clock where WFC_STEP_MS is unset", () => {
	const { monotonicMs } = loadClock();
	const hrMs = Math.floor(Number(process.hrtime.bigint()) / 1e6);
	expect(monotonicMs({})).toBeGreaterThanOrEqual(hrMs);
});
