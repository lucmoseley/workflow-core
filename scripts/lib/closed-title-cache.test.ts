// @vitest-environment node
/*
 * Pins that the similar-title corpus reads open issues live on every call and
 * closed titles off the cache: written by a cold call, left alone within the
 * refresh interval, merged from the issues updated since its stamp once past
 * it, and treated as absent where it does not parse (#2755).
 *
 * readTrackerTitles, with its gh reads injected, over a temp-dir cache file.
 * Breaking one costs either the duplicate check its newest candidates or every
 * filing the 30-85 s whole-tracker pull the cache exists to spare.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readTrackerTitles } from "./closed-title-cache";
import { similarOpen } from "./similar-titles";

interface Row {
	number: number;
	title: string;
	state: string;
}

const T0 = Date.parse("2026-10-24T10:00:00Z");
const INSIDE = T0 + 60_000;
const PAST = T0 + 24 * 3_600_000;

const ALL: Row[] = [
	{ number: 9, state: "OPEN", title: "Generate the sitemap file nightly" },
	{ number: 8, state: "CLOSED", title: "Generate the sitemap and robots file" },
	{ number: 7, state: "OPEN", title: "Generate a robots file" },
	{ number: 6, state: "CLOSED", title: "Robots crawl budget" },
	...Array.from({ length: 40 }, (_, i) => ({
		number: 5 - i,
		state: i % 2 ? "OPEN" : "CLOSED",
		title: `Filler ticket ${i}`,
	})),
];
const OPEN = ALL.filter((r) => r.state === "OPEN");

let dir = "";
let file = "";
let calls: string[] = [];
let warned: string[] = [];

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "closed-titles-"));
	file = path.join(dir, "markers", "closed-titles", "acme__widgets.json");
	calls = [];
	warned = [];
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const deps = (
	over: { now?: number; open?: Row[]; since?: Row[] | Error } = {},
) => ({
	now: () => over.now ?? T0,
	file,
	listAll: () => {
		calls.push("all");
		return ALL;
	},
	listOpen: () => {
		calls.push("open");
		return over.open ?? OPEN;
	},
	listSince: (since: string) => {
		calls.push(`since ${since}`);
		if (over.since instanceof Error) throw over.since;
		return over.since ?? [];
	},
	warn: (t: string) => warned.push(t),
});

const readCached = () => JSON.parse(fs.readFileSync(file, "utf8"));
const numbers = (rows: Row[]) =>
	rows.map((r) => r.number).sort((a, b) => a - b);

describe("the closed-title cache", () => {
	it("pulls the whole tracker once with no cache, and writes its closed titles", () => {
		expect(readTrackerTitles("acme/widgets", deps())).toEqual(ALL);
		expect(calls).toEqual(["all"]);
		expect(warned).toEqual([]);
		expect(readCached().stamp).toBe("2026-10-24T10:00:00.000Z");
		expect(
			Object.keys(readCached().closed)
				.map(Number)
				.sort((a, b) => a - b),
		).toEqual(numbers(ALL.filter((r) => r.state === "CLOSED")));
	});

	it("reads only the open issues within the refresh interval", () => {
		readTrackerTitles("acme/widgets", deps());
		calls = [];
		const rows = readTrackerTitles("acme/widgets", deps({ now: INSIDE }));
		expect(calls).toEqual(["open"]);
		expect(numbers(rows)).toEqual(numbers(ALL));
	});

	it("lists an issue opened after the cache was written on the very next call", () => {
		readTrackerTitles("acme/widgets", deps());
		const fresh = { number: 99, state: "OPEN", title: "Generate a sitemap" };
		const rows = readTrackerTitles(
			"acme/widgets",
			deps({ now: T0 + 1000, open: [fresh, ...OPEN] }),
		);
		expect(rows).toContainEqual(fresh);
	});

	it("past the interval merges what changed since the stamp: a close moves in, a reopen moves out", () => {
		readTrackerTitles("acme/widgets", deps());
		calls = [];
		const later = PAST;
		const reopened = { number: 8, state: "open", title: ALL[1].title };
		const closed = { number: 9, state: "closed", title: ALL[0].title };
		const open = [reopened, ...OPEN.filter((r) => r.number !== 9)];
		const rows = readTrackerTitles(
			"acme/widgets",
			deps({ now: later, open, since: [reopened, closed] }),
		);
		expect(calls).toEqual(["open", "since 2026-10-24T09:55:00.000Z"]);
		expect(readCached().closed).not.toHaveProperty("8");
		expect(readCached().closed["9"]).toBe(ALL[0].title);
		expect(readCached().stamp).toBe(new Date(later).toISOString());
		expect(rows.filter((r) => r.number === 8)).toEqual([reopened]);
		expect(rows).toContainEqual({ ...closed, state: "CLOSED" });
		expect(numbers(rows)).toEqual(numbers(ALL));
	});

	it.each([
		["not JSON", "{"],
		["no stamp", JSON.stringify({ closed: {} })],
		["a bad stamp", JSON.stringify({ stamp: "never", closed: {} })],
		["no closed map", JSON.stringify({ stamp: "2026-10-24T10:00:00Z" })],
		[
			"a non-string title",
			JSON.stringify({ stamp: "2026-10-24T10:00:00Z", closed: { 1: 2 } }),
		],
		["null", "null"],
	])("treats a cache holding %s as absent, saying so", (_, bytes) => {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, bytes);
		expect(readTrackerTitles("acme/widgets", deps())).toEqual(ALL);
		expect(calls).toEqual(["all"]);
		expect(warned).toEqual([
			"the closed-title cache is unusable — pulling the whole tracker.",
		]);
		expect(readCached().stamp).toBe("2026-10-24T10:00:00.000Z");
	});

	it("warns and scores against the cache it has where the refresh fails", () => {
		readTrackerTitles("acme/widgets", deps());
		const rows = readTrackerTitles(
			"acme/widgets",
			deps({ now: PAST, since: new Error("HTTP 502: Bad Gateway") }),
		);
		expect(numbers(rows)).toEqual(numbers(ALL));
		expect(warned).toEqual([
			"could not refresh the closed-title cache (HTTP 502: Bad Gateway) — scoring against its 2026-10-24T10:00:00.000Z copy.",
		]);
		expect(readCached().stamp).toBe("2026-10-24T10:00:00.000Z");
	});

	it("throws where there is no cache and the full pull fails", () => {
		expect(() =>
			readTrackerTitles("acme/widgets", {
				...deps(),
				listAll: () => {
					throw new Error("HTTP 502: Bad Gateway");
				},
			}),
		).toThrow("HTTP 502");
	});

	it("matches a query exactly as the whole tracker does", () => {
		const query = "Generate a sitemap and robots file";
		const whole = similarOpen(query, ALL);
		expect(whole.length).toBeGreaterThan(0);
		readTrackerTitles("acme/widgets", deps());
		expect(
			similarOpen(
				query,
				readTrackerTitles("acme/widgets", deps({ now: T0 + 1 })),
			),
		).toEqual(whole);
	});
});
