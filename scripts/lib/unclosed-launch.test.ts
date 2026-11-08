/*
 * unclosed-launch.test.ts — which launch reads as committed and not closed
 * (#3782). A false reading sends a session to re-check finished work; a missed
 * one relaunches `/implement` on work already landed.
 */

import { describe, expect, it } from "vitest";

const {
	buildRowPrompt,
	buildVerifyPrompt,
	unclosedLaunchOf,
	unclosedLaunches,
} = require("./unclosed-launch.js");

const buildLaunch = (n: number, over: Record<string, unknown> = {}) => ({
	root: "wfc",
	issues: [n],
	prompt: `/implement ${n}`,
	finishedAt: 100,
	acts: { commit: 1 },
	...over,
});

describe("unclosedLaunches (#3782)", () => {
	it("reads a finished /implement launch that committed and did not close", () => {
		const l = buildLaunch(1);
		expect(unclosedLaunches([l])).toEqual([l]);
		expect(unclosedLaunchOf([l], "wfc", 1)).toBe(l);
	});

	it.each([
		["closed", { acts: { commit: 1, close: 1 } }],
		["made no commit", { acts: { round: 1 } }],
		["is still running", { finishedAt: null }],
		["has acts unread", { acts: "unread" }],
		["has no acts recorded", { acts: undefined }],
		["ran another command", { prompt: "/wayfinder 1" }],
		["ran a retro bundle", { issues: [1, 2] }],
	])("passes over a launch that %s", (_, over) => {
		expect(unclosedLaunches([buildLaunch(1, over)])).toEqual([]);
	});

	it("is superseded by any later launch of the ticket", () => {
		const later = buildLaunch(1, { acts: {} });
		expect(unclosedLaunches([buildLaunch(1), later])).toEqual([]);
		expect(
			unclosedLaunches([buildLaunch(1), buildLaunch(1, { finishedAt: null })]),
		).toEqual([]);
		expect(
			unclosedLaunches([
				buildLaunch(1),
				buildLaunch(1, { issues: [1, 2], acts: {} }),
			]),
		).toEqual([]);
	});

	it("is not superseded by a gate judgement's launch", () => {
		const l = buildLaunch(1);
		const judge = buildLaunch(1, {
			prompt: "/triage 1",
			acts: {},
			gate: true,
		});
		expect(unclosedLaunches([l, judge])).toEqual([l]);
	});

	it("keeps checkouts apart, as their issue numbers are", () => {
		const other = buildLaunch(1, { root: "other" });
		expect(unclosedLaunches([buildLaunch(1), other])).toHaveLength(2);
		expect(unclosedLaunchOf([other], "wfc", 1)).toBeNull();
	});
});

describe("buildVerifyPrompt (#3782)", () => {
	it("opens on the command the dispatcher's ledger keys on, and names only its issue", () => {
		const prompt = buildVerifyPrompt(3565);
		expect(prompt.startsWith("/implement 3565 ")).toBe(true);
		expect(prompt.match(/\d+/g)?.every((d: string) => d === "3565")).toBe(true);
		expect(prompt).not.toContain("\n");
	});
});

describe("buildRowPrompt (#4351)", () => {
	const row = (takes: string) => ({ root: "wfc", number: 1, takes: [takes] });

	it("checks first on an /implement row whose last launch did not close", () => {
		expect(buildRowPrompt(row("implement"), [buildLaunch(1)])).toBe(
			buildVerifyPrompt(1),
		);
	});

	it("types the row's own command otherwise", () => {
		expect(buildRowPrompt(row("implement"), [])).toBe("/implement 1");
		expect(buildRowPrompt(row("triage"), [buildLaunch(1)])).toBe("/triage 1");
	});
});
