// @vitest-environment node
/*
 * Whether a boot restarts the loop (#3878), and the line that says why. Loosen
 * it and a boot undoes a stop, or leaves a loop down that nothing stopped. And when
 * a tick trusts an empty listing (#3880): loosen that and a daemon's fault finishes
 * sessions still running.
 */
import { describe, expect, it } from "vitest";
import { bootVerdictOf, isEmptyListingTrusted } from "./refill-boot.js";
import { parseState } from "./refill-loop.js";

const START = 1000;
const control = {
	noProgressFrom: START,
	stopRequested: false,
	seats: [],
	scope: { mode: "normal" as const, repos: [], goal: null },
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
	reason: "control-damaged",
	detail: "/c is damaged",
});

describe("bootVerdictOf", () => {
	it.each([
		["no stop on record", {}],
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
			"a stop by command the loop recorded, the control since overtaken",
			{ stopped: { at: START, reason: "explicit", detail: "asked" } },
			"stopped by command",
		],
		[
			"a loop that ended itself",
			{ stopped: stoppedAt(START) },
			"the loop ended itself: /c is damaged",
		],
	])("refuses %s, saying so", (_name, over, why) => {
		expect(bootVerdictOf({ ...found, ...over })).toEqual({
			resume: false,
			line: `boot resume: not resumed: ${why}`,
		});
	});
});

describe("isEmptyListingTrusted (#3880)", () => {
	const buildLaunch = (over: object) => ({
		root: "/r",
		issues: [1],
		prompt: "/implement 1",
		seat: "/s",
		jobId: "j",
		launchedAt: START,
		finishedAt: null,
		...over,
	});
	const killed = {
		bootKilled: { at: START, sessionId: "s", cwd: "/r", tries: 0 },
	};
	const isTrusted = (launches: object[], bootedAt?: number) =>
		isEmptyListingTrusted(
			parseState({ launches, ...(bootedAt ? { bootedAt } : {}) }),
		);

	it("trusts one on the boot's own tick, whatever the launches", () => {
		expect(isTrusted([buildLaunch({})], START)).toBe(true);
	});

	it("trusts one while killed launches wait and no session should be listed", () => {
		expect(isTrusted([buildLaunch(killed)])).toBe(true);
	});

	it("does not once a session it set running should be listed", () => {
		expect(isTrusted([buildLaunch(killed), buildLaunch({ jobId: "k" })])).toBe(
			false,
		);
	});

	it("does not with no boot and none killed", () => {
		expect(isTrusted([buildLaunch({})])).toBe(false);
		expect(isTrusted([])).toBe(false);
	});
});
