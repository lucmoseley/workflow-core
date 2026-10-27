// @vitest-environment node
/*
 * allowance.js's own reader arithmetic — JSON-vs-text priority, staleness and
 * kind matching — with no subprocess. scripts/allowance.test.ts covers the
 * CLI wrapper (argv, stdin, exit codes) over the same lib. The rulings it
 * holds are #280's and #293's; `capSet` is #371's.
 *
 * Its readings gate `dispatch-sessions.sh`'s launch and `admission.js`'s
 * per-spawn re-read: loosen a case here and a stale or misread bar launches
 * sessions past the allowance, or refuses a set the allowance had room for.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { capSet, readAllowance } from "./allowance";
import { buildUsageText } from "./usage-probe-fake";

/** #280 ruling 3's five-minute window, pinned here rather than read back. */
const STALE_MS = 5 * 60 * 1000;

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "allowance-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const writeCache = (
	configDir: string,
	limits: Record<string, unknown>[],
	fetchedAtMs: number | null = Date.now(),
) => {
	fs.writeFileSync(
		path.join(configDir, ".claude.json"),
		JSON.stringify({
			cachedUsageUtilization: {
				...(fetchedAtMs === null ? {} : { fetchedAtMs }),
				utilization: { limits },
			},
		}),
	);
};

describe("JSON source (#280 ruling 1-2)", () => {
	it("matches kind: session and kind: weekly_all, ignoring weekly_scoped", () => {
		const now = Date.now();
		writeCache(dir, [
			{
				kind: "session",
				percent: 23,
				severity: "normal",
				resets_at: new Date(now + 60 * 60 * 1000).toISOString(),
			},
			{
				kind: "weekly_all",
				percent: 7,
				severity: "normal",
				resets_at: new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString(),
			},
			{ kind: "weekly_scoped", percent: 100, severity: "critical" },
		]);
		const r = readAllowance({ configDir: dir, now });
		expect(r.session).toMatchObject({
			percent: 23,
			severity: "normal",
			trust: "fresh",
		});
		expect(r.weekly_all).toMatchObject({
			percent: 7,
			severity: "normal",
			trust: "fresh",
		});
	});

	it("reads absent where the config dir carries no .claude.json at all", () => {
		const r = readAllowance({ configDir: path.join(dir, "nope") });
		expect(r.session.trust).toBe("absent");
		expect(r.weekly_all.trust).toBe("absent");
	});

	it("reads absent where cachedUsageUtilization is missing", () => {
		fs.writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({}));
		const r = readAllowance({ configDir: dir });
		expect(r.session.trust).toBe("absent");
	});

	it("reads absent where the file will not parse as JSON", () => {
		fs.writeFileSync(path.join(dir, ".claude.json"), "not json");
		const r = readAllowance({ configDir: dir });
		expect(r.session.trust).toBe("absent");
	});
});

describe("staleness (#280 ruling 3)", () => {
	it("is fresh inside the 5-minute window", () => {
		const now = Date.now();
		writeCache(
			dir,
			[{ kind: "session", percent: 23 }],
			now - (STALE_MS - 1000),
		);
		const r = readAllowance({ configDir: dir, now });
		expect(r.session.trust).toBe("fresh");
	});

	it("is stale past the 5-minute window", () => {
		const now = Date.now();
		writeCache(
			dir,
			[{ kind: "session", percent: 23 }],
			now - (STALE_MS + 1000),
		);
		const r = readAllowance({ configDir: dir, now });
		expect(r.session.trust).toBe("stale");
	});

	it("is stale once its own resets_at has passed, whatever fetchedAtMs says", () => {
		const now = Date.now();
		writeCache(
			dir,
			[
				{
					kind: "session",
					percent: 23,
					resets_at: new Date(now - 1000).toISOString(),
				},
			],
			now,
		);
		const r = readAllowance({ configDir: dir, now });
		expect(r.session.trust).toBe("stale");
	});
});

describe("text fallback (#280 ruling 1)", () => {
	const usageText = buildUsageText({ session: 12, week: 3 });

	it("falls back to the printed bars when the JSON reading is absent", () => {
		const r = readAllowance({ configDir: path.join(dir, "nope"), usageText });
		expect(r.session).toMatchObject({ percent: 12, trust: "fresh" });
		expect(r.weekly_all).toMatchObject({ percent: 3, trust: "fresh" });
	});

	it("falls back per bar when the JSON reading is stale", () => {
		const now = Date.now();
		writeCache(
			dir,
			[{ kind: "session", percent: 97 }],
			now - (STALE_MS + 1000),
		);
		const r = readAllowance({ configDir: dir, usageText, now });
		expect(r.session).toMatchObject({ percent: 12, trust: "fresh" });
	});

	it("prefers a fresh JSON reading over the text, even where both are present", () => {
		writeCache(dir, [{ kind: "session", percent: 40 }]);
		const r = readAllowance({ configDir: dir, usageText });
		expect(r.session.percent).toBe(40);
	});

	it("reads absent, not fresh, where neither source gives a value (#280 ruling 4)", () => {
		const r = readAllowance({
			configDir: path.join(dir, "nope"),
			usageText: "",
		});
		expect(r.session.trust).toBe("absent");
		expect(r.weekly_all.trust).toBe("absent");
	});
});

describe("capSet (#371)", () => {
	const figures = { session: 1.5, weekly_all: 0.1 };
	const thresholds = { session: 90, weekly_all: 97 };
	const none = { session: 0, weekly_all: 0 };

	it("launches the whole set below both thresholds, whatever the running spend", () => {
		const r = capSet({
			readings: { session: 89, weekly_all: 96 },
			thresholds,
			members: 7,
			runningPoints: { session: 50, weekly_all: 50 },
			perSessionPoints: figures,
		});
		expect(r).toMatchObject({ launch: 7, binding: null, warned: [] });
	});

	it("launches X: the shortest prefix whose cumulative spend reaches the headroom", () => {
		// Headroom 100 − 94 − 1 = 5; 3 × 1.5 = 4.5 falls short, 4 × 1.5 = 6 reaches it.
		const r = capSet({
			readings: { session: 94, weekly_all: 10 },
			thresholds,
			members: 7,
			runningPoints: { session: 1, weekly_all: 0 },
			perSessionPoints: figures,
		});
		expect(r.launch).toBe(4);
		expect(r.binding).toMatchObject({ bar: "session", reading: 94, fits: 4 });
	});

	it("stops at the member that lands exactly on 100%", () => {
		// Headroom 3: 2 × 1.5 = 3 reaches it, so a third is not launched.
		const r = capSet({
			readings: { session: 97, weekly_all: 10 },
			thresholds,
			members: 5,
			runningPoints: none,
			perSessionPoints: figures,
		});
		expect(r.launch).toBe(2);
	});

	it("launches one where the running sessions leave exactly a session's headroom", () => {
		// #371's 11 Oct 2026 reversal: headroom 100 − 99 − 0.8 is 0.2 to within
		// rounding, one session ~0.2, so the X loop gives one, not the floor.
		const r = capSet({
			readings: { session: 10, weekly_all: 99 },
			thresholds,
			members: 6,
			runningPoints: { session: 0, weekly_all: 0.8 },
			perSessionPoints: { session: 1.5, weekly_all: 0.2 },
		});
		expect(r.launch).toBe(1);
	});

	it("binds on the smaller count where both bars are warned", () => {
		const r = capSet({
			readings: { session: 91, weekly_all: 99.5 },
			thresholds,
			members: 7,
			runningPoints: none,
			perSessionPoints: figures,
		});
		// session: 9 / 1.5 → 6; weekly: 0.5 / 0.1 → 5.
		expect(r.warned.map((b) => [b.bar, b.fits])).toEqual([
			["session", 6],
			["weekly_all", 5],
		]);
		expect(r).toMatchObject({ launch: 5, binding: { bar: "weekly_all" } });
	});

	it("launches one where running sessions already fill the headroom but the bar is under 100%", () => {
		const r = capSet({
			readings: { session: 95, weekly_all: 10 },
			thresholds,
			members: 3,
			runningPoints: { session: 6, weekly_all: 0 },
			perSessionPoints: figures,
		});
		expect(r).toMatchObject({ launch: 1, floored: true });
	});

	it("reports a launch the X loop reaches as not floored (#2432)", () => {
		const r = capSet({
			readings: { session: 94, weekly_all: 10 },
			thresholds,
			members: 7,
			runningPoints: { session: 1, weekly_all: 0 },
			perSessionPoints: figures,
		});
		expect(r).toMatchObject({ launch: 4, floored: false });
	});

	it("reports no floor where another warned bar reads 100% (#2432)", () => {
		const r = capSet({
			readings: { session: 95, weekly_all: 100 },
			thresholds,
			members: 3,
			runningPoints: { session: 6, weekly_all: 0 },
			perSessionPoints: figures,
		});
		expect(r).toMatchObject({ launch: 0, floored: false });
	});

	it("never lets rounding buy a member past X", () => {
		// Headroom 100 − 90 − 0.1 = 9.9; 6 × 1.65 rounds to 9.899999999999999.
		const r = capSet({
			readings: { session: 90, weekly_all: 10 },
			thresholds,
			members: 10,
			runningPoints: { session: 0.1, weekly_all: 0 },
			perSessionPoints: { session: 1.65, weekly_all: 0.1 },
		});
		expect(r.launch).toBe(6);
	});

	it("launches nothing for an empty set at a warned bar", () => {
		const r = capSet({
			readings: { session: 95, weekly_all: 10 },
			thresholds,
			members: 0,
			runningPoints: { session: 6, weekly_all: 0 },
			perSessionPoints: figures,
		});
		expect(r.launch).toBe(0);
	});

	it("binds on a bar at 100% where both are warned", () => {
		const r = capSet({
			readings: { session: 92, weekly_all: 100 },
			thresholds,
			members: 4,
			runningPoints: none,
			perSessionPoints: figures,
		});
		expect(r).toMatchObject({ launch: 0, binding: { bar: "weekly_all" } });
	});

	it("binds on the floor of one where the other warned bar counts more", () => {
		const r = capSet({
			readings: { session: 91, weekly_all: 98 },
			thresholds,
			members: 4,
			runningPoints: { session: 0, weekly_all: 3 },
			perSessionPoints: figures,
		});
		expect(r.warned.map((b) => [b.bar, b.fits])).toEqual([
			["session", 4],
			["weekly_all", 1],
		]);
		expect(r).toMatchObject({ launch: 1, floored: true });
	});

	it("launches nothing once the bar reads 100%", () => {
		const r = capSet({
			readings: { session: 100, weekly_all: 10 },
			thresholds,
			members: 3,
			runningPoints: none,
			perSessionPoints: figures,
		});
		expect(r.launch).toBe(0);
	});

	it("never launches more than the set holds", () => {
		const r = capSet({
			readings: { session: 90, weekly_all: 10 },
			thresholds,
			members: 2,
			runningPoints: none,
			perSessionPoints: figures,
		});
		expect(r.launch).toBe(2);
		expect(r.binding?.fits).toBe(2);
	});
});
