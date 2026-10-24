// @vitest-environment node
/*
 * usage-cache.js's own suite (#377): a seat's usage bars are read off
 * `limits[]`, a missing or unreadable cache is told apart from a readable one,
 * and a reset is passed only once its time has come. The parse runs against a
 * temp config dir, never a real seat's `.claude.json`.
 *
 * `allowance.js` sizes `/pick-next`'s launch and `seat-utilisation.js` the
 * session-start seat check from it; loosen a case and a bar misread as clear
 * launches sessions into a spent allowance.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasResetPassed, readUsageCache } from "./usage-cache";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-cache-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const write = (body: string) =>
	fs.writeFileSync(path.join(dir, ".claude.json"), body);

describe("readUsageCache (#377 ruling 3)", () => {
	it("reads missing where there is no .claude.json", () => {
		expect(readUsageCache(dir)).toEqual({ state: "missing" });
	});

	it("reads unreadable on bad JSON and on a file with no cachedUsageUtilization", () => {
		write('{"cach');
		expect(readUsageCache(dir)).toEqual({ state: "unreadable" });
		write("{}");
		expect(readUsageCache(dir)).toEqual({ state: "unreadable" });
	});

	it("returns every limits[] entry normalised, mistyped fields as null", () => {
		write(
			JSON.stringify({
				cachedUsageUtilization: {
					fetchedAtMs: 5,
					accountUuid: "u",
					utilization: {
						limits: [
							{
								kind: "session",
								percent: 6,
								resets_at: "R",
								severity: "normal",
							},
							{
								kind: "weekly_scoped",
								percent: "41",
								scope: { model: { display_name: "Fable" } },
							},
						],
					},
				},
			}),
		);
		expect(readUsageCache(dir)).toEqual({
			state: "ok",
			fetchedAtMs: 5,
			accountUuid: "u",
			bars: [
				{
					kind: "session",
					percent: 6,
					severity: "normal",
					resetsAt: "R",
					model: null,
				},
				{
					kind: "weekly_scoped",
					percent: null,
					severity: null,
					resetsAt: null,
					model: "Fable",
				},
			],
		});
	});
});

describe("hasResetPassed (#377 ruling 2)", () => {
	const at = "2026-09-26T12:00:00Z";
	it("is true at and after the reset, false before it", () => {
		expect(hasResetPassed(at, Date.parse(at))).toBe(true);
		expect(hasResetPassed(at, Date.parse(at) - 1)).toBe(false);
	});

	it("is false where the reset is null or will not parse", () => {
		expect(hasResetPassed(null, Date.now())).toBe(false);
		expect(hasResetPassed("soon", Date.now())).toBe(false);
	});
});
