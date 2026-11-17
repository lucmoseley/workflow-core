/*
 * unclosed-launch.test.ts — which launch reads as committed and not closed
 * (#3782). A false reading sends a session to re-check finished work; a missed
 * one relaunches `/implement` on work already landed. And which reads as
 * having ended with no act (#5399): a missed one relaunches a ticket whose
 * session released it ungated, until the no-progress brake pauses the repo.
 */

import { describe, expect, it } from "vitest";

const {
	buildGateFirstPrompt,
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

describe("the gate-first prompt (#5399)", () => {
	const row = { root: "wfc", number: 1, takes: ["implement"] };
	const actless = (over: Record<string, unknown> = {}) =>
		buildLaunch(1, { acts: {}, ...over });

	it("opens on the command the dispatcher's ledger keys on, and names only its issue", () => {
		const prompt = buildGateFirstPrompt(5399);
		expect(prompt.startsWith("/implement 5399 ")).toBe(true);
		expect(prompt.match(/\d+/g)?.every((d: string) => d === "5399")).toBe(true);
		expect(prompt).not.toContain("\n");
		expect(prompt).toContain("blocked-ticket-gate");
	});

	it.each([
		["no act line at all", {}],
		["every kind counted zero", { commit: 0, close: 0 }],
	])("follows a finished /implement launch with %s", (_, acts) => {
		expect(buildRowPrompt(row, [actless({ acts })])).toBe(
			buildGateFirstPrompt(1),
		);
	});

	it.each([
		["made an act", { acts: { gate: 1 } }],
		["is still running", { finishedAt: null }],
		["has acts unread", { acts: "unread" }],
		["has no acts recorded", { acts: undefined }],
		["ran another command", { prompt: "/triage 1" }],
		["ran a retro bundle", { issues: [1, 2] }],
	])("types the plain command after a launch that %s", (_, over) => {
		expect(buildRowPrompt(row, [actless(over)])).toBe("/implement 1");
	});

	it("is superseded by a later launch that acted, not by a gate judgement's", () => {
		expect(
			buildRowPrompt(row, [actless(), buildLaunch(1, { acts: { block: 1 } })]),
		).toBe("/implement 1");
		const judge = actless({ prompt: "/triage 1", gate: true });
		expect(buildRowPrompt(row, [actless(), judge])).toBe(
			buildGateFirstPrompt(1),
		);
	});

	it("leaves a row of another command and another checkout alone", () => {
		expect(buildRowPrompt({ ...row, takes: ["triage"] }, [actless()])).toBe(
			"/triage 1",
		);
		expect(buildRowPrompt(row, [actless({ root: "other" })])).toBe(
			"/implement 1",
		);
	});
});
