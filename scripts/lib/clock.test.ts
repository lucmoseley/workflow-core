// @vitest-environment node

import { expect, it } from "vitest";
import { durationClock } from "./clock.js";

it("steps the duration clock by WFC_STEP_MS per read, from 0, each clock on its own count", () => {
	const env = { WFC_STEP_MS: "1300" };
	const clock = durationClock(env);
	const other = durationClock(env);
	expect([clock(), clock(), other(), clock()]).toEqual([0, 1300, 0, 2600]);
});

it.each(["0", "-5", "1.5", "soon"])(
	"refuses a WFC_STEP_MS of %s rather than reading the real clock",
	(raw) => {
		expect(() => durationClock({ WFC_STEP_MS: raw })).toThrow(
			`WFC_STEP_MS is not a whole number of ms: ${raw}`,
		);
	},
);

it("reads the real monotonic clock where WFC_STEP_MS is unset", () => {
	const hrMs = () => Math.floor(Number(process.hrtime.bigint()) / 1e6);
	const before = hrMs();
	const read = durationClock({})();
	expect(read).toBeGreaterThanOrEqual(before);
	expect(read).toBeLessThanOrEqual(hrMs());
});
