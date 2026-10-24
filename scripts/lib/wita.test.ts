// @vitest-environment node
/*
 * Pins the WITA (UTC+8, no DST) calendar day and the whole-day age of a written
 * date, across the 16:00 UTC boundary where WITA and UTC disagree.
 *
 * The instants are pinned rather than taken from the clock: the whole point of
 * the unit is that the answer differs from the UTC one for eight hours a day,
 * so a test reading the real clock would prove it only between 16:00 and
 * midnight UTC (mantahostels#919).
 *
 * Breaking it lets `check-doc-map-markers.js`, a step of the scheduled sweep in
 * `.github/workflows/roadmap-digest.yml`, read a marker written in the WITA
 * evening as dated tomorrow and fail CI.
 */

import { describe, expect, it } from "vitest";

const { witaDay, calendarDaysSince } = require("./wita.js");

/** A date written the way a document writes one, as the checkers parse it. */
const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

describe("witaDay", () => {
	it("is UTC+8 with no DST, in both halves of the year", () => {
		// January and July land on the same offset — Indonesia keeps no DST.
		expect(witaDay(Date.parse("2026-01-15T20:00:00Z"))).toBe(day("2026-01-16"));
		expect(witaDay(Date.parse("2026-07-15T20:00:00Z"))).toBe(day("2026-07-16"));
	});

	it("reads the evening-UTC hours as the next WITA day", () => {
		// 16:00 UTC is midnight WITA: the first instant of the following day.
		expect(witaDay(Date.parse("2026-08-20T15:59:59Z"))).toBe(day("2026-08-20"));
		expect(witaDay(Date.parse("2026-08-20T16:00:00Z"))).toBe(day("2026-08-21"));
		// The instant that failed CI on c95009a: 21 August in WITA, 20th in UTC.
		expect(witaDay(Date.parse("2026-08-20T16:33:33Z"))).toBe(day("2026-08-21"));
	});

	it("agrees with UTC for the other sixteen hours", () => {
		expect(witaDay(Date.parse("2026-08-21T00:49:00Z"))).toBe(day("2026-08-21"));
		expect(witaDay(Date.parse("2026-08-21T15:00:00Z"))).toBe(day("2026-08-21"));
	});

	it("defaults to now and lands on a midnight", () => {
		expect(witaDay() % 86_400_000).toBe(0);
	});
});

describe("calendarDaysSince", () => {
	it("counts whole WITA days, so a date written today is nought days old", () => {
		const now = Date.parse("2026-08-20T16:33:33Z"); // 21 August, 00:33 WITA
		expect(calendarDaysSince(day("2026-08-21"), now)).toBe(0);
		expect(calendarDaysSince(day("2026-08-20"), now)).toBe(1);
		expect(calendarDaysSince(day("2026-07-22"), now)).toBe(30);
	});

	it("is negative only for a date genuinely ahead of the WITA calendar", () => {
		const now = Date.parse("2026-08-20T16:33:33Z");
		expect(calendarDaysSince(day("2026-08-22"), now)).toBe(-1);
	});

	it("never returns a fraction, whatever the hour", () => {
		for (const h of [0, 7, 8, 15, 16, 23])
			expect(
				Number.isInteger(
					calendarDaysSince(
						day("2026-08-01"),
						Date.parse(`2026-08-20T${String(h).padStart(2, "0")}:17:41Z`),
					),
				),
			).toBe(true);
	});
});
