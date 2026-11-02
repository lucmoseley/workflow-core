/*
 * What one morning review hands the next, from fixture review bodies (#3831).
 * Break it and a repo that did not read loses its closes and decisions, or lists
 * them twice.
 */

import { describe, expect, it } from "vitest";

const {
	buildAbsentRepos,
	buildCarryLines,
	buildHistoryStart,
	buildRepoStart,
	buildUnreadRepo,
} = require("./review-carry.js");

const SINCE = "2026-10-17T07:00:00Z";
const NOW = "2026-10-18T07:00:00Z";

describe("buildAbsentRepos (#3835)", () => {
	const buildCarriedReview = (start: string) => ({
		number: 7,
		body: `Events unread since ${start} in gone.\nEvents unread since ${start} in listed.\n`,
	});
	const missing = () => ({ carried: true, why: "no .git" });
	const at = "2026-10-01T07:00:00.000Z";
	const reads = (
		sinceAt: string,
		nowAt: string,
		absence: () => { carried: boolean; why: string } | null,
	) =>
		buildAbsentRepos({
			previous: buildCarriedReview(sinceAt),
			listed: new Set(["listed"]),
			since: SINCE,
			nowMs: Date.parse(nowAt),
			readAbsence: absence,
		});

	it("carries a missing checkout at its 30th day, with the start it had, and skips one discovery lists", () => {
		expect(reads(at, "2026-10-31T07:00:00.000Z", missing)).toEqual([
			{
				reading: null,
				unread: [{ repo: "gone", why: "no .git" }],
				unreadEvents: [{ kind: "Events", checkout: "gone", since: at }],
			},
		]);
	});

	it("ends one past its 30th day, naming what that gives up", () => {
		expect(reads(at, "2026-10-31T07:00:00.001Z", missing)).toEqual([
			{
				reading: null,
				unread: [
					{
						repo: "gone",
						why: `no .git and carried over 30 days, so its events since ${at} reach no review`,
					},
				],
				unreadEvents: [],
			},
		]);
	});

	it("gives no part for one that stays out, and none with no previous review", () => {
		expect(reads(at, "2026-10-02T07:00:00.000Z", () => null)).toEqual([]);
		expect(
			buildAbsentRepos({
				previous: undefined,
				listed: new Set(),
				since: SINCE,
				nowMs: 0,
				readAbsence: missing,
			}),
		).toEqual([]);
	});
});

describe("buildAbsentRepos on a checkout carrying one kind (#3928)", () => {
	const Old = "2026-09-01T07:00:00.000Z";
	const absent = (body: string, carried = true) =>
		buildAbsentRepos({
			previous: { number: 7, body },
			listed: new Set(),
			since: SINCE,
			nowMs: Date.parse(NOW),
			readAbsence: () => ({ carried, why: "no .git" }),
		});

	it("ends only the kind past its 30th day, and keeps carrying the other", () => {
		expect(
			absent(`Closes unread since ${Old} in wfc.\nEvents read in wfc.\n`),
		).toEqual([
			{
				reading: null,
				unread: [
					{
						repo: "wfc",
						why: `no .git and carried over 30 days, so its closes since ${Old} reach no review`,
					},
				],
				unreadEvents: [{ kind: "Decisions", checkout: "wfc", since: SINCE }],
			},
		]);
	});

	it("names each kind's own start where both end", () => {
		const [part] = absent(`Closes unread since ${Old} in wfc.\n`, false);
		expect(part.unread).toEqual([
			{
				repo: "wfc",
				why: `no .git, so its closes since ${Old} and its decisions since ${SINCE} reach no review`,
			},
		]);
		expect(part.unreadEvents).toEqual([]);
	});
});

describe("buildAbsentRepos on a checkout the previous review read (#3844)", () => {
	const read = (body: string) =>
		buildAbsentRepos({
			previous: { number: 7, body },
			listed: new Set(["listed"]),
			since: SINCE,
			nowMs: Date.parse(NOW),
			readAbsence: () => ({ carried: true, why: "no .git" }),
		});

	it("carries one with no Events unread line from the window's start, and skips one discovery lists", () => {
		expect(read("Events read in my wfc.\nEvents read in listed.\n")).toEqual([
			{
				reading: null,
				unread: [{ repo: "my wfc", why: "no .git" }],
				unreadEvents: [{ kind: "Events", checkout: "my wfc", since: SINCE }],
			},
		]);
	});
});

describe("buildRepoStart (#3831)", () => {
	const previous = {
		number: 7,
		body: `Events unread since ${SINCE} in other.\nEvents unread since 2026-10-16T07:00:00Z in my wfc.\n`,
	};

	it("starts a checkout the previous review could not read where its events went unread from", () => {
		expect(buildRepoStart(previous, "my wfc", NOW)).toEqual({
			closes: "2026-10-16T07:00:00Z",
			decisions: "2026-10-16T07:00:00Z",
			why: null,
		});
	});

	it("starts any other checkout at the window's start", () => {
		const atWindowStart = { closes: NOW, decisions: NOW, why: null };
		expect(buildRepoStart(previous, "acme", NOW)).toEqual(atWindowStart);
		expect(buildRepoStart(undefined, "my wfc", NOW)).toEqual(atWindowStart);
	});

	it("starts at the window's start, saying so, where the line's time will not read", () => {
		const body = "Events unread since soon in wfc.\n";
		expect(buildRepoStart({ number: 7, body }, "wfc", NOW)).toEqual({
			closes: NOW,
			decisions: NOW,
			why: `#7's unread line, so events before ${NOW}`,
		});
	});

	it("starts each kind at its own line, the other at the window's start (#3928)", () => {
		const closes = "Closes unread since 2026-10-16T07:00:00Z in wfc.\n";
		expect(buildRepoStart({ number: 7, body: closes }, "wfc", NOW)).toEqual({
			closes: "2026-10-16T07:00:00Z",
			decisions: NOW,
			why: null,
		});
		const both = `${closes}Decisions unread since 2026-10-17T07:00:00Z in wfc.\n`;
		expect(buildRepoStart({ number: 7, body: both }, "wfc", NOW)).toEqual({
			closes: "2026-10-16T07:00:00Z",
			decisions: "2026-10-17T07:00:00Z",
			why: null,
		});
	});
});

describe("buildCarryLines (#3928)", () => {
	const Old = "2026-10-16T07:00:00Z";
	const both = { closes: true, decisions: true };

	it("carries nothing a review read, and only the kind it did not", () => {
		const start = { closes: Old, decisions: SINCE, why: null };
		expect(
			buildCarryLines("wfc", start, { closes: false, decisions: false }),
		).toEqual([]);
		expect(
			buildCarryLines("wfc", start, { closes: true, decisions: false }),
		).toEqual([{ kind: "Closes", checkout: "wfc", since: Old }]);
		expect(
			buildCarryLines("wfc", start, { closes: false, decisions: true }),
		).toEqual([{ kind: "Decisions", checkout: "wfc", since: SINCE }]);
	});

	it("carries both kinds as one line from one start, and as two from two", () => {
		expect(
			buildCarryLines("wfc", { closes: Old, decisions: Old, why: null }, both),
		).toEqual([{ kind: "Events", checkout: "wfc", since: Old }]);
		expect(
			buildCarryLines(
				"wfc",
				{ closes: Old, decisions: SINCE, why: null },
				both,
			),
		).toEqual([
			{ kind: "Closes", checkout: "wfc", since: Old },
			{ kind: "Decisions", checkout: "wfc", since: SINCE },
		]);
	});
});

describe("buildHistoryStart (#3928)", () => {
	it("takes the later start, as a review reading either kind read the history", () => {
		const start = {
			closes: "2026-10-16T07:00:00Z",
			decisions: "2026-10-17T07:00:00Z",
			why: null,
		};
		expect(buildHistoryStart(start)).toBe("2026-10-17T07:00:00Z");
		expect(
			buildHistoryStart({
				...start,
				closes: "2026-10-18T07:00:00Z",
			}),
		).toBe("2026-10-18T07:00:00Z");
	});
});

describe("buildUnreadRepo (#3834)", () => {
	it("names the repo and carries the checkout's start", () => {
		const start = { closes: SINCE, decisions: SINCE, why: null };
		expect(buildUnreadRepo("wfc", start, "acme/wfc", "no read")).toEqual({
			reading: null,
			unread: [{ repo: "acme/wfc", why: "no read" }],
			unreadEvents: [{ kind: "Events", checkout: "wfc", since: SINCE }],
		});
	});

	it("names a start that would not read as well", () => {
		const start = { closes: SINCE, decisions: SINCE, why: "bad line" };
		expect(buildUnreadRepo("wfc", start, "acme/wfc", "no read").unread).toEqual(
			[
				{ repo: "wfc", why: "bad line" },
				{ repo: "acme/wfc", why: "no read" },
			],
		);
	});
});
