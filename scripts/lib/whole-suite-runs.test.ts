// @vitest-environment node
/*
 * The lone whole suite the quiet bench's due read times (#4931). Loosen it and
 * a bench suite or a shard reads as the lone suite, so the ladder bench starts
 * on a suite its top row cannot finish, or never starts.
 */

import { expect, it } from "vitest";
import { latestLoneSuite } from "./whole-suite-runs.js";

const scope = {
	full: "flag" as const,
	modulesRun: 9,
	modulesTotal: 9,
	tests: 9,
	skipped: 0,
};
const green = (at: string, durationMs: number, over = {}) => ({
	sha: at,
	at,
	scope,
	durationMs,
	...over,
});

it("takes the latest green lone whole suite", () => {
	const lone = latestLoneSuite(
		[green("2026-11-01", 700_000), green("2026-11-02", 400_000)],
		[],
	);
	expect(lone?.durationMs).toBe(400_000);
});

it("passes over a shard and a run sized by its own --maxWorkers", () => {
	const lone = latestLoneSuite(
		[
			green("2026-11-01", 700_000),
			green("2026-11-02", 300_000, {
				scope: { ...scope, shard: { index: 1, count: 2 } },
			}),
			green("2026-11-03", 900_000, {
				argv: ["--full=other", "--maxWorkers=3"],
			}),
		],
		[],
	);
	expect(lone?.at).toBe("2026-11-01");
});

it("takes a ceiling kill of a lone whole suite after the green", () => {
	const kill = {
		sha: "k",
		at: "2026-11-02",
		ceilingKill: true,
		full: "flag",
		durationMs: 840_000,
		argv: ["--full=other"],
	};
	expect(
		latestLoneSuite([green("2026-11-01", 400_000)], [kill])?.ceilingKill,
	).toBe(true);
});

it("is null where no lone whole suite is recorded", () => {
	expect(latestLoneSuite([], [])).toBe(null);
});
