// @vitest-environment node
/*
 * Pins the one verdict refill-loop.js judges each child by: null on exit 0,
 * else the exit, the error that ended it and the last line printed (#3029).
 * Breaking it misreports why a launch, stop or typed resume failed.
 */
import { describe, expect, it } from "vitest";
import { childFailure, childVerdict } from "./child-failure.js";

const timedOut = new Error("spawnSync python3 ETIMEDOUT");

describe.each([
	{
		title: "a clean exit is no failure",
		r: { status: 0, stdout: "done\n" },
		failed: null,
		failure: null,
	},
	{
		title: "a non-zero exit names the exit and the last line printed",
		r: { status: 2, stderr: "a\nwhy\n" },
		failed: "exit 2",
		failure: "exit 2: why",
	},
	{
		title: "a timed-out child names the error that ended it",
		r: { status: null, error: timedOut },
		failed: "exit null (spawnSync python3 ETIMEDOUT)",
		failure: "exit null (spawnSync python3 ETIMEDOUT)",
	},
])("$title", ({ r, failed, failure }) => {
	it("fails as the exit and the error that ended it, or null on exit 0", () =>
		expect(childVerdict(r).failed).toBe(failed));
	it("adds the last line printed to the failure, where there is one", () =>
		expect(childFailure(childVerdict(r))).toBe(failure));
});
