import { describe, expect, it } from "vitest";
import {
	BREAKER_OPEN,
	buildLaunchRoom,
	buildSpentRoom,
	PROBE_HELD,
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

	it("names a probe hold over an open breaker, and leaves no room under either", () => {
		const all = { holds: [probe], breakerRoom: { [ROOT]: 0 } };
		expect(roomOf(all).heldWhy(ROOT)).toBe(PROBE_HELD);
		expect(roomOf({ holds: [probe] }).launchLeft(ROOT)).toBe(0);
		const open = roomOf({ ...all, holds: [] });
		expect(open.heldWhy(ROOT)).toBe(BREAKER_OPEN);
		expect(open.launchLeft(ROOT)).toBe(0);
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

describe("buildSpentRoom", () => {
	it("charges each start to its own checkout alone", () => {
		const room = buildSpentRoom((root) => (root === ROOT ? 1 : 2));
		room.spend(ROOT);
		expect(room.left(ROOT)).toBe(0);
		expect(room.left("/home/u/other")).toBe(2);
	});
});
