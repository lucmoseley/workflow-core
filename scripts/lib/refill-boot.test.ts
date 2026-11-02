// @vitest-environment node
/*
 * Whether a boot restarts the loop (#3878), and the line that says why. Loosen
 * it and a boot undoes a stop, or leaves a loop down that nothing stopped.
 */
import { describe, expect, it } from "vitest";
import { bootVerdictOf } from "./refill-boot.js";

const START = 1000;
const control = {
	noProgressFrom: START,
	stopRequested: false,
	seats: [],
	scope: { mode: "normal" as const, repos: [], goals: {} },
};
const found = {
	control,
	damaged: null,
	stopped: null,
	pid: null,
	self: 7,
};
const stoppedAt = (at: number) => ({
	at,
	reason: "no-progress",
	detail: "three launches made no progress",
});

describe("bootVerdictOf", () => {
	it.each([
		["no stop on record", {}],
		["a stop record older than the start", { stopped: stoppedAt(START - 1) }],
		["a pidfile naming this process", { pid: 7 }],
	])("resumes on %s, naming the start it keeps", (_name, over) => {
		expect(bootVerdictOf({ ...found, ...over })).toEqual({
			resume: true,
			line: `boot resume: resumed the loop counting from ${new Date(START).toISOString()}`,
		});
	});

	it.each([
		["a running loop", { pid: 8 }, "already running, pid 8"],
		["a damaged control", { damaged: "it is damaged" }, "it is damaged"],
		["no control", { control: null }, "no start on record"],
		[
			"a stop by command",
			{ control: { ...control, stopRequested: true } },
			"stopped by command",
		],
		[
			"a loop that ended itself since its start",
			{ stopped: stoppedAt(START) },
			"the loop ended itself: three launches made no progress",
		],
	])("refuses %s, saying so", (_name, over, why) => {
		expect(bootVerdictOf({ ...found, ...over })).toEqual({
			resume: false,
			line: `boot resume: not resumed: ${why}`,
		});
	});
});
