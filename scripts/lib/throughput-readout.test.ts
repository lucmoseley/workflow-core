// @vitest-environment node
/*
 * throughput-readout.test.ts — the throughput readout's core (#5196). Break
 * it and a band misreads the objective: rework passes as output, a junk close
 * counts, a truncated day reads as a slow one, or a plateau is read off a
 * handful of hours.
 */

import { describe, expect, it } from "vitest";
import { LOOP_OFF } from "./concurrency";
import { readout } from "./throughput-readout";

type Records = Parameters<typeof readout>[0];
type Band = ReturnType<typeof readout>["sessions"][number];

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse("2026-11-10T00:00:00Z");
const REPO = "owner/tracker";

/** One minute line a minute over [from, from + hours), as `at` says. */
function minutes(
	from: number,
	hours: number,
	at: (t: number) => { sessions: number | null; load1?: number },
) {
	return Array.from({ length: hours * 60 }, (_, i) => {
		const t = from + i * MIN;
		const { sessions, load1 = 4 } = at(t);
		return { t, sessions, load1 };
	});
}

function records(over: Partial<Records> = {}): Records {
	return {
		since: T0,
		until: T0 + 24 * HOUR,
		cores: 8,
		eras: [],
		minutes: minutes(T0, 24, () => ({ sessions: 3 })),
		ticks: [],
		closes: [],
		days: [
			{ date: "2026-11-10", state: "read" },
			{ date: "2026-11-11", state: "read" },
		],
		commits: [],
		logRepos: [REPO],
		queue: [],
		transcripts: [],
		jobs: [],
		dispatched: [],
		...over,
	};
}

const close = (number: number, at: number, reason = "COMPLETED") => ({
	repo: REPO,
	number,
	closedAt: at,
	reason,
});

const commit = (
	sha: string,
	at: number,
	cites: number[],
	reverts: string | null = null,
) => ({ repo: REPO, sha, t: at, cites, reverts });

const band = (bands: Band[], label: string, era?: string) => {
	const b = bands.find((x) => x.band === label && (!era || x.era === era));
	if (!b) throw new Error(`no band ${label} in ${bands.map((x) => x.band)}`);
	return b;
};

describe("throughput readout", () => {
	it("bands hours by mean sessions and reports total closes per hour and per session-hour", () => {
		const r = readout(
			records({
				minutes: minutes(T0, 24, (t) => ({
					sessions: t < T0 + 12 * HOUR ? 3 : 6,
				})),
				closes: [
					close(1, T0 + 1 * HOUR),
					close(2, T0 + 2 * HOUR),
					close(3, T0 + 13 * HOUR),
				],
			}),
		);
		const three = band(r.sessions, "3");
		expect(three.hours).toBe(12);
		expect(three.counted).toBe(2);
		expect(three.closesPerHour).toBeCloseTo(2 / 12);
		expect(three.sessionHours).toBe(36);
		expect(three.closesPerSessionHour).toBeCloseTo(2 / 36);
		expect(band(r.sessions, "6").counted).toBe(1);
	});

	it("never counts a NOT_PLANNED close", () => {
		const r = readout(
			records({
				closes: [close(1, T0 + HOUR), close(2, T0 + HOUR, "NOT_PLANNED")],
			}),
		);
		expect(band(r.sessions, "3").closes).toBe(1);
	});

	it("reports a 1,000-result day as truncated and counts none of its closes", () => {
		const r = readout(
			records({
				until: T0 + 48 * HOUR,
				minutes: minutes(T0, 48, () => ({ sessions: 3 })),
				days: [
					{ date: "2026-11-10", state: "read" },
					{ date: "2026-11-11", state: "truncated" },
				],
				closes: [close(1, T0 + HOUR), close(2, T0 + 30 * HOUR)],
			}),
		);
		expect(r.truncatedDays).toEqual(["2026-11-11"]);
		const three = band(r.sessions, "3");
		expect(three.counted).toBe(1);
		expect(three.closesPerHour).toBeCloseTo(1 / 24);
		expect(r.lacking).toContainEqual(
			expect.objectContaining({ source: "closes", hours: 24 }),
		);
	});

	it("bands hours by mean load1 at 2, 3 and 4 per core", () => {
		const loadAt = (t: number) => {
			if (t < T0 + 6 * HOUR) return 10;
			return t < T0 + 12 * HOUR ? 20 : 40;
		};
		const r = readout(
			records({
				minutes: minutes(T0, 24, (t) => ({
					sessions: 3,
					load1: loadAt(t),
				})),
				cores: 8,
			}),
		);
		expect(r.load.map((b) => [b.band, b.hours])).toEqual([
			["<16", 6],
			["16–24", 6],
			["32+", 12],
		]);
		const four = readout(records({ cores: 4 }));
		expect(four.load.map((b) => b.band)).toEqual(["<8"]);
	});

	it("subtracts a reverted close, counts a revert's revert as standing, and a re-land once", () => {
		const r = readout(
			records({
				closes: [
					close(1, T0 + HOUR),
					close(2, T0 + HOUR),
					close(3, T0 + HOUR),
					close(4, T0 + 2 * HOUR),
					close(4, T0 + 5 * HOUR),
				],
				commits: [
					commit("a", T0, [1]),
					commit("ra", T0 + 2 * HOUR, [1], "a"),
					commit("b", T0, [2]),
					commit("rb", T0 + 2 * HOUR, [2], "b"),
					commit("rrb", T0 + 3 * HOUR, [2], "rb"),
					commit("c", T0, [3]),
					commit("rc", T0 + 2 * HOUR, [3], "c"),
					commit("c2", T0 + 3 * HOUR, [3]),
					commit("d", T0, [4]),
					commit("d2", T0 + 4 * HOUR, [4]),
				],
			}),
		);
		const three = band(r.sessions, "3");
		expect(three.closes).toBe(4);
		expect(three.reverted).toBe(1);
		expect(three.counted).toBe(3);
		expect(three.revertRate).toBeCloseTo(1 / 4);
		expect(three.commitsPerClose).toBeCloseTo((1 + 1 + 2 + 2) / 4);
	});

	it("names the repos whose commit log went unread and leaves them out of commits per close", () => {
		const r = readout(
			records({
				closes: [
					close(1, T0 + HOUR),
					{ ...close(9, T0 + HOUR), repo: "owner/other" },
				],
				commits: [commit("a", T0, [1]), commit("b", T0, [1])],
			}),
		);
		expect(r.commitsUnread).toEqual([{ repo: "owner/other", closes: 1 }]);
		expect(band(r.sessions, "3").commitsPerClose).toBe(2);
	});

	it("reports the share of session time queued from the queue's wait spans", () => {
		const r = readout(
			records({
				queue: [
					{ st: T0, en: T0 + HOUR },
					{ st: T0 + 2 * HOUR, en: T0 + 3 * HOUR },
				],
			}),
		);
		expect(band(r.sessions, "3").queueShare).toBeCloseTo(2 / (24 * 3));
	});

	it("fits the marginal queue wait per added session over hours at 5+ sessions", () => {
		const sessionsAt = (t: number) => 5 + (Math.floor((t - T0) / HOUR) % 4);
		const queue = Array.from({ length: 24 }, (_, h) => {
			const st = T0 + h * HOUR;
			const s = sessionsAt(st);
			return { st, en: st + (s - 5) * 10 * MIN };
		});
		const r = readout(
			records({
				minutes: minutes(T0, 24, (t) => ({ sessions: sessionsAt(t) })),
				queue,
			}),
		);
		const [m] = r.marginalQueueWait;
		expect(m?.hours).toBe(24);
		expect(m?.slope).toBeCloseTo(10);
		expect(m?.ci?.[0]).toBeCloseTo(10);
		expect(m?.ci?.[1]).toBeCloseTo(10);
		expect(m?.thin).toBe(false);
		const low = readout(records());
		expect(low.marginalQueueWait[0]?.slope).toBe(null);
	});

	it("fits the marginal wait over every hour its 5-session band holds, and marks it thin under 10 hours", () => {
		const sessionsAt = (t: number) => ((t - T0) / HOUR < 3 ? 4.6 : 6.6);
		const queue = Array.from({ length: 6 }, (_, h) => {
			const st = T0 + h * HOUR;
			return { st, en: st + (h < 3 ? 6 : 26) * MIN };
		});
		const r = readout(
			records({
				until: T0 + 6 * HOUR,
				minutes: minutes(T0, 6, (t) => ({ sessions: sessionsAt(t) })),
				queue,
			}),
		);
		expect(band(r.sessions, "5").hours).toBe(3);
		const [m] = r.marginalQueueWait;
		expect(m?.hours).toBe(6);
		expect(m?.slope).toBeCloseTo(10);
		expect(m?.thin).toBe(true);
	});

	it("reports the median Bash round-trip and hook-timeout refusals per hour", () => {
		const r = readout(
			records({
				transcripts: [
					{ t: T0 + MIN, bash: [1, 2], hto: 1 },
					{ t: T0 + 2 * MIN, bash: [9], hto: 2 },
				],
			}),
		);
		const three = band(r.sessions, "3");
		expect(three.bashMedianS).toBe(2);
		expect(three.refusalsPerHour).toBeCloseTo(3 / 24);
	});

	it("shares time by the limb a fresh tick shows binding, and takes its live count where the loop ran", () => {
		const r = readout(
			records({
				ticks: [
					{ t: T0, live: 3, loop: null, limb: "load" as const },
					{ t: T0 + 6 * HOUR, live: 3, loop: null, limb: "memory" as const },
					{ t: T0 + 12 * HOUR, live: 9, loop: null, limb: "none" as const },
					{
						t: T0 + 18 * HOUR,
						live: 9,
						loop: LOOP_OFF,
						limb: "sessions" as const,
					},
				].flatMap((x) =>
					Array.from({ length: 36 }, (_, i) => ({
						...x,
						t: x.t + i * 10 * MIN,
					})),
				),
			}),
		);
		const three = band(r.sessions, "3");
		expect(three.hours).toBe(18);
		expect(three.limbShare?.load).toBeCloseTo(6 / 18);
		expect(three.limbShare?.memory).toBeCloseTo(6 / 18);
		expect(three.limbShare?.sessions).toBeCloseTo(6 / 18);
		expect(band(r.sessions, "9").hours).toBe(6);
	});

	it("reads a session with no dispatch row and a non-bg template as hand-opened", () => {
		const r = readout(
			records({
				jobs: [
					{ id: "hand", template: "claude", st: T0, en: T0 + 2 * HOUR },
					{ id: "sent", template: "claude", st: T0, en: T0 + HOUR },
					{ id: "bg", template: "bg", st: T0, en: T0 + 3 * HOUR },
				],
				dispatched: ["sent"],
			}),
		);
		const three = band(r.sessions, "3");
		expect(three.handOpenedHours).toBe(2);
		expect(three.dispatchedHours).toBe(4);
	});

	it("splits bands at an era cut", () => {
		const r = readout(
			records({
				eras: [{ label: "after", from: T0 + 10 * HOUR + 30 * MIN }],
				closes: [close(1, T0 + HOUR), close(2, T0 + 20 * HOUR)],
			}),
		);
		expect(r.sessions.map((b) => [b.era, b.band, b.hours])).toEqual([
			["window start", "3", 10.5],
			["after", "3", 13.5],
		]);
		expect(band(r.sessions, "3", "after").counted).toBe(1);
	});

	it("keeps only an hour's covered minutes across a WSL restart", () => {
		const r = readout(
			records({
				minutes: [
					...minutes(T0, 10, () => ({ sessions: 3 })),
					...minutes(T0 + 10 * HOUR + 40 * MIN, 14, () => ({
						sessions: 3,
					})).filter((m) => m.t < T0 + 24 * HOUR),
				],
				closes: [
					close(1, T0 + 10 * HOUR + 10 * MIN),
					close(2, T0 + 10 * HOUR + 50 * MIN),
				],
			}),
		);
		const three = band(r.sessions, "3");
		expect(three.hours).toBeCloseTo(10 + 13 + 20 / 60);
		expect(three.counted).toBe(1);
		expect(r.lacking).toContainEqual(
			expect.objectContaining({
				source: "minute log",
				hours: expect.closeTo(40 / 60),
			}),
		);
	});

	it("marks a band under 10 hours thin and states no plateau from it", () => {
		const r = readout(
			records({
				minutes: minutes(T0, 24, (t) => ({
					sessions: t < T0 + 20 * HOUR ? 3 : 6,
				})),
				closes: [
					close(1, T0 + 21 * HOUR),
					close(2, T0 + 22 * HOUR),
					close(3, T0 + 5 * HOUR),
				],
			}),
		);
		expect(band(r.sessions, "6").thin).toBe(true);
		expect(band(r.sessions, "3").thin).toBe(false);
		expect(r.plateau).toEqual([
			{ era: "window start", peak: "3", from: "3", none: null },
		]);
		const allThin = readout(
			records({
				until: T0 + 5 * HOUR,
				minutes: minutes(T0, 5, () => ({ sessions: 3 })),
			}),
		);
		expect(allThin.plateau[0]?.peak).toBe(null);
	});

	it("names a source that would not read and drops it from the figures that need it", () => {
		const r = readout(
			records({ queue: null, transcripts: null, jobs: null, ticks: null }),
		);
		const three = band(r.sessions, "3");
		expect(three.queueShare).toBe(null);
		expect(three.bashMedianS).toBe(null);
		expect(three.limbShare).toBe(null);
		expect(three.handOpenedHours).toBe(null);
		expect(r.lacking.map((x) => x.source)).toEqual([
			"binding limb",
			"queue-exit log",
			"transcripts",
			"job records",
		]);
	});
});
