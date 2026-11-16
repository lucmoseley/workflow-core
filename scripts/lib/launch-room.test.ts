/*
 * launch-room.test.ts — a checkout's launch room from its unproven run, pause,
 * breaker and probe holds, each read and spent in one place (#5290).
 */

import { describe, expect, it } from "vitest";
import {
	BREAKER_OPEN,
	buildLaunchRoom,
	PROBE_HELD,
	REPO_PAUSED,
	spendable,
	UNPROVEN_HELD,
} from "./launch-room.js";

type RoomInput = import("./launch-room.js").RoomInput;
type LaunchRecord = import("./refill-decide.js").LaunchRecord;

const NOW = Date.parse("2026-11-16T12:00:00Z");
const ROOT = "/home/u/repo";
const running = (n: number): LaunchRecord =>
	({
		root: ROOT,
		jobId: `job${n}`,
		launchedAt: NOW - n,
		finishedAt: null,
	}) as LaunchRecord;
const pause = { by: "no-progress", at: NOW };
const probe = { root: ROOT, kind: "probe" as const, issue: 1, raisedAt: NOW };

const roomOf = (over: Partial<RoomInput> = {}) =>
	buildLaunchRoom({ history: [], lastActAt: {}, ...over });

describe("buildLaunchRoom", () => {
	it("gives a free checkout the whole unproven run, spent one start at a time", () => {
		const room = roomOf({ history: [running(1)] });
		expect(room.launchLeft(ROOT)).toBe(2);
		room.spend(ROOT);
		room.spend(ROOT);
		expect(room.launchLeft(ROOT)).toBe(0);
		expect(room.spentWhy(ROOT)).toBe(UNPROVEN_HELD);
		expect(room.heldWhy(ROOT)).toBeNull();
	});

	it("names a probe hold over an open breaker over a pause, and leaves no room under any", () => {
		const all = {
			holds: [probe],
			breakerRoom: { [ROOT]: 0 },
			repoPaused: { [ROOT]: pause },
		};
		expect(roomOf(all).heldWhy(ROOT)).toBe(PROBE_HELD);
		expect(roomOf({ ...all, holds: [] }).heldWhy(ROOT)).toBe(BREAKER_OPEN);
		const paused = roomOf({ repoPaused: { [ROOT]: pause } });
		expect(paused.heldWhy(ROOT)).toBe(REPO_PAUSED);
		expect(paused.launchLeft(ROOT)).toBe(0);
		expect(paused.resumeLeft(ROOT)).toBe(0);
	});

	it("stops nothing for a park hold", () => {
		const room = roomOf({ holds: [{ ...probe, kind: "park" }] });
		expect(room.heldWhy(ROOT)).toBeNull();
		expect(room.launchLeft(ROOT)).toBe(3);
	});

	it("admits an open breaker's one trial launch but no resume", () => {
		const room = roomOf({ breakerRoom: { [ROOT]: 1 } });
		expect(room.heldWhy(ROOT)).toBeNull();
		expect(room.launchLeft(ROOT)).toBe(1);
		expect(room.resumeLeft(ROOT)).toBe(0);
		room.spend(ROOT);
		expect(room.spentWhy(ROOT)).toBe(BREAKER_OPEN);
	});
});

describe("spendable", () => {
	it("charges each start to its own checkout alone", () => {
		const room = spendable((root) => (root === ROOT ? 1 : 2));
		room.spend(ROOT);
		expect(room.left(ROOT)).toBe(0);
		expect(room.left("/home/u/other")).toBe(2);
	});
});
