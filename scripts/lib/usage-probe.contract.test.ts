// @vitest-environment node
/*
 * Holds lib/usage-probe-fake.ts, which every `claude -p "/usage"` stub prints
 * and refreshes the seat's cache through, to the installed harness's
 * recording of one real probe (scripts/fixtures/usage-probe.json, re-recorded
 * by `node scripts/record-claude-responses.js`), read through the same
 * lib/allowance.js and lib/usage-cache.js parses; and, on a plan seat on the
 * founder's machine, to the live seat's cache (#3266); and pins the fake's own
 * refusal of a cache with no stamp (#3969). Breaking it costs the allowance
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAllowance } from "./allowance.js";
import { writeClaudeStub } from "./claude-stub";
import { readUsageCache } from "./usage-cache.js";
import {
	buildRefreshBranch,
	buildRefreshLine,
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

const writeConfig = (text: string) =>
	fs.writeFileSync(path.join(dir, ".claude.json"), text);

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
		writeConfig(JSON.stringify(written));
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
		writeConfig(JSON.stringify(written));
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
		writeConfig(JSON.stringify(written));
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

describe("the fake's refusal of a cache it cannot re-stamp", () => {
	it("throws rather than writing a broken cache (#3969)", () => {
		// A spy, because no real seam reaches this: buildUsageCache always writes
		// the stamp it is handed.
		const stringify = vi.spyOn(JSON, "stringify").mockReturnValue("{}");
		try {
			expect(() =>
				buildRefreshLine({ session: 41, week: 51 }, "target"),
			).toThrow(/fetchedAtMs/);
		} finally {
			stringify.mockRestore();
		}
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

const readSeatConfig = (seat: string) =>
	JSON.parse(fs.readFileSync(path.join(seat, ".claude.json"), "utf8"));

/** Why `seat` has no cache to check: an API-key seat's `.claude.json` holds
 * neither a usage cache nor a sign-in (#3768). A signed-in seat with no cache
 * still runs, so a harness renaming the key fails here; so does a file that
 * fails to parse, or a cache of the wrong shape. */
function seatSkipReason(seat: string): string | undefined {
	if (readUsageCache(seat).state === "missing")
		return `no .claude.json in ${seat}`;
	let config: { cachedUsageUtilization?: unknown; oauthAccount?: unknown };
	try {
		config = readSeatConfig(seat);
	} catch {
		return undefined;
	}
	return config?.cachedUsageUtilization === undefined &&
		config?.oauthAccount === undefined
		? `${seat} is an API-key seat: its .claude.json holds no usage cache and no sign-in`
		: undefined;
}

// Residual: off the founder's machine, or on an API-key seat on it, this skips,
// and the recording goes unchecked.
function liveSkipReason(): string | undefined {
	if (process.env.CI)
		return "CI: the live seat's cache is read on the founder's machine only";
	if (!fs.existsSync("/proc/self/environ")) return "no /proc/self/environ";
	return seatSkipReason(readLiveSeat());
}

const expectCarriesBars = (seat: string) => {
	const cache = readUsageCache(seat);
	expect(cache.state).toBe("ok");
	if (cache.state !== "ok") return;
	expect(typeof cache.fetchedAtMs).toBe("number");
	expect(cache.bars.find((b) => b.kind === "weekly_all")).toMatchObject({
		percent: expect.any(Number),
	});
	// A plan with no 5-hour bar lists none (#3758); one listed carries a figure.
	const session = cache.bars.find((b) => b.kind === "session");
	if (session) expect(session.percent).toEqual(expect.any(Number));
};

it("the live seat's cache carries the bars the reader reads", ({ skip }) => {
	const reason = liveSkipReason();
	if (reason) return skip(reason);
	expectCarriesBars(readLiveSeat());
});

describe("which seats the live case skips (#3768)", () => {
	it("skips a seat with no .claude.json", () => {
		expect(seatSkipReason(dir)).toBe(`no .claude.json in ${dir}`);
	});

	it("skips, naming why, a seat with no usage cache and no sign-in", () => {
		writeConfig(JSON.stringify({ numStartups: 1 }));
		expect(seatSkipReason(dir)).toContain("is an API-key seat");
	});

	it.each([
		["a file that fails to parse", "{ not json"],
		["a signed-in seat with no cache", '{"oauthAccount":{"accountUuid":"u"}}'],
		["a cache of the wrong type", '{"cachedUsageUtilization":"x"}'],
		["a null cache", '{"cachedUsageUtilization":null}'],
		["a cache with no bars", '{"cachedUsageUtilization":{"fetchedAtMs":1}}'],
	])("runs and fails on %s", (_name, text) => {
		writeConfig(text);
		expect(seatSkipReason(dir)).toBeUndefined();
		expect(() => expectCarriesBars(dir)).toThrow();
	});

	it("runs and passes on a plan seat's cache", () => {
		writeConfig(
			JSON.stringify(buildUsageCache({ session: 40, week: 50 }, Date.now())),
		);
		expect(seatSkipReason(dir)).toBeUndefined();
		expectCarriesBars(dir);
	});
});

/** The live seat's raw `weekly_scoped` bar, parsed by hand because the
 * shape check needs the keys lib/usage-cache.js drops; a seat on no model
 * allowance caches none. */
function readLiveScopedLimit(): Record<string, unknown> | undefined {
	return readSeatConfig(
		readLiveSeat(),
	)?.cachedUsageUtilization?.utilization?.limits?.find(
		(l: { kind?: unknown }) => l?.kind === "weekly_scoped",
	);
}

// Residual: a seat on no model allowance skips this, and the recorded
// weekly_scoped bar goes unchecked against the live one.
const scopedSkipReason = () =>
	liveSkipReason() ??
	(readLiveScopedLimit()
		? undefined
		: "the live seat caches no weekly_scoped bar");

it("the live seat's weekly_scoped bar has the recorded shape (#3282)", ({
	skip,
}) => {
	const reason = scopedSkipReason();
	if (reason) return skip(reason);
	const live = readLiveScopedLimit() as Record<string, unknown>;
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
});
