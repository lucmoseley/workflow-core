// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAllowance } from "./allowance.js";
import { writeClaudeStub } from "./claude-stub";
import { SESSION_PREFIX } from "./session-bar-carry.js";
import { readUsageCache } from "./usage-cache.js";
import {
	buildRefreshBranch,
	buildRefreshLine,
	buildUsageCache,
	buildUsageText,
	printedLines,
	recorded,
	recordedLimit,
	recordedLimits,
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

const KIND_ORDER = ["session", "weekly_all", "weekly_scoped"];

const expectRecordedBars = (limits: { kind: string }[], kinds: string[]) => {
	expect(limits.map((l) => l.kind)).toEqual(kinds);
	for (const limit of limits)
		expect(keyTypes(limit)).toEqual(keyTypes(recordedLimit(limit.kind)));
};

const SESSIONLESS = {
	printed: recorded.printed.filter((l) => !l.startsWith(SESSION_PREFIX)),
	limits: recorded.cache.utilization.limits.filter((l) => l.kind !== "session"),
};

describe("the /usage fake against the recording (#3266)", () => {
	it("reads its printed bars as the recorded ones read, the cache's percents", () => {
		expect(printedBars(printedLines.join("\n"))).toEqual({
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

	it("answers a seat with no session bar as the recording read without one (#5332)", () => {
		const week = recordedPercent("weekly_all");
		const reading = (opts: { configDir: string; usageText?: string }) => {
			const { session, weekly_all } = readAllowance(opts);
			return [session.trust, weekly_all.percent];
		};
		const printed = (lines: string[]) =>
			reading({
				configDir: path.join(dir, "no-seat"),
				usageText: lines.join("\n"),
			});
		const cached = (limits: unknown[]) => {
			writeConfig(
				JSON.stringify({
					cachedUsageUtilization: {
						...recorded.cache,
						fetchedAtMs: Date.now(),
						utilization: { limits },
					},
				}),
			);
			return reading({ configDir: dir });
		};
		const expected = ["unreported", week];
		expect(printed(SESSIONLESS.printed)).toEqual(expected);
		expect(printed([buildUsageText({ week })])).toEqual(expected);
		expect(
			cached(
				SESSIONLESS.limits.map((l) => ({
					...l,
					resets_at: new Date(Date.now() + 60_000).toISOString(),
				})),
			),
		).toEqual(expected);
		expect(
			cached(
				buildUsageCache({ week }, Date.now()).cachedUsageUtilization.utilization
					.limits,
			),
		).toEqual(expected);
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
		const resetsAt = new Date(Date.now() + 60_000).toISOString();
		const written = buildUsageCache({ session: 40, week: 50 }, Date.now(), {
			scoped: [{ model: "Opus", percent: 77, resetsAt }],
		});
		const limits = written.cachedUsageUtilization.utilization.limits;
		expectRecordedBars(
			limits,
			recordedLimits
				.map((l) => l.kind)
				.sort((a, b) => KIND_ORDER.indexOf(a) - KIND_ORDER.indexOf(b)),
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

const readLiveSeat = () =>
	fs
		.readFileSync("/proc/self/environ", "utf8")
		.split("\0")
		.find((entry) => entry.startsWith("CLAUDE_CONFIG_DIR="))
		?.slice("CLAUDE_CONFIG_DIR=".length) ?? path.join(os.homedir(), ".claude");

const readSeatConfig = (seat: string) =>
	JSON.parse(fs.readFileSync(path.join(seat, ".claude.json"), "utf8"));

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

function readLiveScopedLimit(): Record<string, unknown> | undefined {
	return readSeatConfig(
		readLiveSeat(),
	)?.cachedUsageUtilization?.utilization?.limits?.find(
		(l: { kind?: unknown }) => l?.kind === "weekly_scoped",
	);
}

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
