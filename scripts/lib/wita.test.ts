// @vitest-environment node

import { describe, expect, it } from "vitest";

const { witaDay, calendarDaysSince } = require("./wita.js");

const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

describe("witaDay", () => {
	it("is UTC+8 with no DST, in both halves of the year", () => {
		expect(witaDay(Date.parse("2026-01-15T20:00:00Z"))).toBe(day("2026-01-16"));
		expect(witaDay(Date.parse("2026-07-15T20:00:00Z"))).toBe(day("2026-07-16"));
	});

	it("reads the evening-UTC hours as the next WITA day", () => {
		expect(witaDay(Date.parse("2026-08-20T15:59:59Z"))).toBe(day("2026-08-20"));
		expect(witaDay(Date.parse("2026-08-20T16:00:00Z"))).toBe(day("2026-08-21"));
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
		const now = Date.parse("2026-08-20T16:33:33Z");
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
