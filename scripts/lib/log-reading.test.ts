// @vitest-environment node
/*
 * Pins the reading window every reporter cuts its figures at: the point
 * instant counts as reached, the cutoff is the point once reached and now
 * before it, and an event stamped at the cutoff is read (#2629). A module test
 * on a hand-built Point, since the reporters' own tests reach the point only
 * through whole log fixtures. A break moves every reporter's window, filing a
 * reading on figures read past its point.
 */

import { describe, expect, it } from "vitest";
import { isRead, readingAt } from "./log-reading.js";

const point = { point: 1000, ceiling: 2000, fixed: true, clock: 0 };

describe("readingAt", () => {
	it("reads to now while no repo is live", () => {
		expect(readingAt(null, 500)).toEqual({
			reached: false,
			cutoff: 500,
			nowMs: 500,
		});
	});

	it("reads to now before the point", () => {
		expect(readingAt(point, 999)).toEqual({
			reached: false,
			cutoff: 999,
			nowMs: 999,
		});
	});

	it("counts the point itself as reached", () => {
		expect(readingAt(point, 1000)).toEqual({
			reached: true,
			cutoff: 1000,
			nowMs: 1000,
		});
	});

	it("reads to the point once past it", () => {
		expect(readingAt(point, 1500)).toEqual({
			reached: true,
			cutoff: 1000,
			nowMs: 1500,
		});
	});
});

describe("isRead", () => {
	const at = readingAt(point, 1500);

	it("reads an event stamped at the cutoff", () => {
		expect(isRead(at, new Date(1000).toISOString())).toBe(true);
	});

	it("leaves out an event stamped after it", () => {
		expect(isRead(at, new Date(1001).toISOString())).toBe(false);
	});
});
