// @vitest-environment node
/*
 * Holds lib/usage-probe-fake.ts, which every `claude -p "/usage"` stub prints
 * and refreshes the seat's cache through, to the installed harness's
 * recording of one real probe (scripts/fixtures/usage-probe.json, re-recorded
 * by `node scripts/record-claude-responses.js`), read through the same
 * lib/allowance.js and lib/usage-cache.js parses; and, on the founder's
 * machine, to the live seat's cache (#3266). Breaking it costs the allowance
 * gate: a stub printing bars or a cache the harness no longer writes passes
 * tests while the probe reads nothing, or never sees its stamp move and runs
 * a minute past every refresh.
 *
 * No case runs the real probe. It rewrites the seat's cache and leaves a
 * transcript in the live config dir, which #838 keeps every test out of, and
 * no throwaway config dir holds the seat's sign-in. The recorder's run
 * stands in: it probes the seat as lib/usage-probe.js does, to its end, and
 * refuses to record a stamp that did not move. So a harness change to the
 * printed bars or to the refresh shows only once the recording is re-run.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAllowance } from "./allowance.js";
import { writeClaudeStub } from "./claude-stub";
import { readUsageCache } from "./usage-cache.js";
import {
	buildRefreshBranch,
	buildUsageCache,
	buildUsageText,
	recorded,
	recordedLimit,
} from "./usage-probe-fake";

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-probe-contract-"));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const recordedPercent = (kind: string) => recordedLimit(kind).percent;

/** The bars lib/allowance.js reads off `usageText`, under no cache. */
const printedBars = (usageText: string) => {
	const { session, weekly_all } = readAllowance({
		configDir: path.join(dir, "no-seat"),
		usageText,
	});
	return {
		session: session.percent,
		week: weekly_all.percent,
		resets: [session.resetsAt, weekly_all.resetsAt].every(Boolean),
	};
};

const keyTypes = (o: object) =>
	Object.entries(o)
		.map(([key, value]) => `${key}:${value === null ? "null" : typeof value}`)
		.sort();

/** The written bars are of `kinds`, in order, each of its recorded bar's
 * key types. */
const expectRecordedBars = (limits: { kind: string }[], kinds: string[]) => {
	expect(limits.map((l) => l.kind)).toEqual(kinds);
	for (const limit of limits)
		expect(keyTypes(limit)).toEqual(keyTypes(recordedLimit(limit.kind)));
};

describe("the /usage fake against the recording (#3266)", () => {
	it("reads its printed bars as the recorded ones read, the cache's percents", () => {
		expect(printedBars(recorded.printed.join("\n"))).toEqual({
			session: recordedPercent("session"),
			week: recordedPercent("weekly_all"),
			resets: true,
		});
		expect(printedBars(buildUsageText({ session: 12, week: 3 }))).toEqual({
			session: 12,
			week: 3,
			resets: true,
		});
	});

	it("writes a cache of the recorded shape, read fresh with its own percents", () => {
		const written = buildUsageCache({ session: 40, week: 50 }, Date.now());
		const { cachedUsageUtilization: cache } = written;
		expect(keyTypes(cache)).toEqual(keyTypes(recorded.cache));
		expectRecordedBars(cache.utilization.limits, ["session", "weekly_all"]);
		fs.writeFileSync(path.join(dir, ".claude.json"), JSON.stringify(written));
		const { session, weekly_all } = readAllowance({ configDir: dir });
		expect([session.trust, session.percent]).toEqual(["fresh", 40]);
		expect([weekly_all.trust, weekly_all.percent]).toEqual(["fresh", 50]);
	});

	it("keeps the recorded shape under a case's own reset times and account", () => {
		const resetsAt = new Date(Date.now() + 60_000).toISOString();
		const written = buildUsageCache({ session: 40, week: 50 }, Date.now(), {
			resetsAt: { session: resetsAt, week: resetsAt },
			accountUuid: "uuid-case",
		});
		const { cachedUsageUtilization: cache } = written;
		expect(keyTypes(cache)).toEqual(keyTypes(recorded.cache));
		expectRecordedBars(cache.utilization.limits, ["session", "weekly_all"]);
		fs.writeFileSync(path.join(dir, ".claude.json"), JSON.stringify(written));
		const read = readUsageCache(dir);
		expect(read.state === "ok" && read.accountUuid).toBe("uuid-case");
		const { weekly_all } = readAllowance({ configDir: dir });
		expect([weekly_all.trust, weekly_all.percent]).toEqual(["fresh", 50]);
	});

	it("writes a weekly_scoped bar of the recorded shape, read per model (#3282)", () => {
		// Any reset after the case runs would do.
		const resetsAt = new Date(Date.now() + 60_000).toISOString();
		const written = buildUsageCache({ session: 40, week: 50 }, Date.now(), {
			scoped: [{ model: "Opus", percent: 77, resetsAt }],
		});
		const limits = written.cachedUsageUtilization.utilization.limits;
		expectRecordedBars(
			limits,
			recorded.cache.utilization.limits.map((l) => l.kind),
		);
		const scope = (l: Record<string, unknown>) =>
			(l.scope ?? {}) as { model: object };
		const recordedScoped = recordedLimit("weekly_scoped");
		expect(keyTypes(scope(limits[2]))).toEqual(keyTypes(scope(recordedScoped)));
		expect(keyTypes(scope(limits[2]).model)).toEqual(
			keyTypes(scope(recordedScoped).model),
		);
		fs.writeFileSync(path.join(dir, ".claude.json"), JSON.stringify(written));
		const read = readUsageCache(dir);
		expect(
			read.state === "ok" && read.bars.find((b) => b.kind === "weekly_scoped"),
		).toMatchObject({ model: "Opus", percent: 77, resetsAt });
	});

	it("moves the cache stamp past the probe's start, as the recorded probe did", () => {
		expect(recorded.refreshedAfterMs).toBeGreaterThan(0);
		const bin = writeClaudeStub(
			path.join(dir, "claude"),
			buildRefreshBranch(dir, { session: 41, week: 51 }),
			0,
		);
		const startMs = Date.now();
		expect(spawnSync(bin).status).toBe(0);
		const cache = readUsageCache(dir);
		expect(cache.state === "ok" && cache.fetchedAtMs).toBeGreaterThan(startMs);
		expect(readAllowance({ configDir: dir }).weekly_all.percent).toBe(51);
	});
});

/** The config dir the runner was started with: vitest.setup.ts re-points
 * this worker's at a sandbox (#838). */
const readLiveSeat = () =>
	fs
		.readFileSync("/proc/self/environ", "utf8")
		.split("\0")
		.find((entry) => entry.startsWith("CLAUDE_CONFIG_DIR="))
		?.slice("CLAUDE_CONFIG_DIR=".length) ?? path.join(os.homedir(), ".claude");

// Residual: off the founder's machine this skips, and the recording goes unchecked.
function liveSkipReason(): string | undefined {
	if (process.env.CI)
		return "CI: the live seat's cache is read on the founder's machine only";
	if (!fs.existsSync("/proc/self/environ")) return "no /proc/self/environ";
	if (readUsageCache(readLiveSeat()).state === "missing")
		return `no .claude.json in ${readLiveSeat()}`;
	return undefined;
}

it.skipIf(liveSkipReason())(
	"the live seat's cache carries the bars the reader reads",
	() => {
		const live = readUsageCache(readLiveSeat());
		expect(live.state).toBe("ok");
		if (live.state !== "ok") return;
		expect(typeof live.fetchedAtMs).toBe("number");
		for (const kind of ["session", "weekly_all"])
			expect(live.bars.find((b) => b.kind === kind)).toMatchObject({
				percent: expect.any(Number),
			});
	},
);

/** The live seat's raw `weekly_scoped` bar, parsed by hand because the
 * shape check needs the keys lib/usage-cache.js drops; a seat on no model
 * allowance caches none. */
function liveScopedLimit(): Record<string, unknown> | undefined {
	const parsed = JSON.parse(
		fs.readFileSync(path.join(readLiveSeat(), ".claude.json"), "utf8"),
	);
	return parsed?.cachedUsageUtilization?.utilization?.limits?.find(
		(l: { kind?: unknown }) => l?.kind === "weekly_scoped",
	);
}

// Residual: a seat on no model allowance skips this, and the recorded
// weekly_scoped bar goes unchecked against the live one.
const scopedSkipReason = () =>
	liveSkipReason() ??
	(liveScopedLimit() ? undefined : "the live seat caches no weekly_scoped bar");

it.skipIf(scopedSkipReason())(
	"the live seat's weekly_scoped bar has the recorded shape (#3282)",
	() => {
		const live = liveScopedLimit() as Record<string, unknown>;
		const recordedScoped = recordedLimit("weekly_scoped");
		expect(keyTypes(live)).toEqual(keyTypes(recordedScoped));
		const model = (l: Record<string, unknown>) =>
			(l.scope as { model: object }).model;
		expect(keyTypes(live.scope as object)).toEqual(
			keyTypes(recordedScoped.scope as object),
		);
		expect(keyTypes(model(live))).toEqual(keyTypes(model(recordedScoped)));
		const read = readUsageCache(readLiveSeat());
		expect(
			read.state === "ok" && read.bars.find((b) => b.kind === "weekly_scoped"),
		).toMatchObject({ model: expect.any(String), percent: expect.any(Number) });
	},
);
