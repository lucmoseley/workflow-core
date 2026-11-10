// @vitest-environment node
/*
 * lib/canary-remark.js's decisions over fake ports (#4744): which sessions a
 * re-mark vouches for, which strand the move, and when no re-mark is owed.
 * Break it and a levelling pass moves `main` past a canary change that
 * refuses a live session every tool, or marks a session whose self-plugin
 * never loaded. The fakes are held to nothing but level-main.test.ts, which
 * crosses lib/canary-remark-host.js's adapters with real canaries and git.
 */

import { describe, expect, it } from "vitest";
import type { LiveSession, Remarked, RemarkPorts } from "./canary-remark.js";
import { remarkAroundMove } from "./canary-remark.js";

const ROOT = "/repo";
const SCRATCH = "/scratch";
const CANARY = "scripts/self-plugin-canary.sh";
const WRITER = "scripts/write-self-plugin-marker.sh";

interface World {
	revs: Record<string, Record<string, string>>;
	/** Each listing in turn; the last repeats. */
	listings: Array<LiveSession[] | { why: string }>;
	/** Whether the canary under `dir` passes session `id`, given what it has been marked by. */
	passes: (dir: string, id: string, markedBy: string[]) => boolean;
}

function fake(world: World) {
	const marks: Record<string, string[]> = {};
	let listed = 0;
	const ports: RemarkPorts = {
		root: ROOT,
		readAt: (rev, file) => {
			const text = world.revs[rev]?.[file];
			return text === undefined ? { absent: true } : { text };
		},
		listSessions: () => {
			const at = world.listings[Math.min(listed++, world.listings.length - 1)];
			return Array.isArray(at) ? { sessions: at } : at;
		},
		worktrees: () => [ROOT],
		deref: (p) => p,
		exists: () => true,
		hook: (script, s) => {
			const dir = script.slice(0, -`/${CANARY}`.length);
			const ok = world.passes(dir, s.sessionId, marks[s.sessionId] ?? []);
			return { ok, said: ok ? "" : `refused by ${dir}` };
		},
		mark: (writer, s) => {
			marks[s.sessionId] = [
				...(marks[s.sessionId] ?? []),
				writer.slice(0, -`/${WRITER}`.length),
			];
		},
		inScratch: (_files, run) => run(SCRATCH),
	};
	return { ports, marks };
}

const at = (id: string, cwd = ROOT): LiveSession => ({ sessionId: id, cwd });
const canaryAt = (v: string) => ({ [CANARY]: v, [WRITER]: v });

function remark(
	world: World,
	changed: string[] = [CANARY],
): { out: Remarked; moved: boolean; marks: Record<string, string[]> } {
	const { ports, marks } = fake(world);
	let moved = false;
	const out = remarkAroundMove(ports, { from: "a", to: "b", changed }, () => {
		moved = true;
		return null;
	});
	return { out, moved, marks };
}

describe("remarkAroundMove", () => {
	it("moves without listing a session where the move changes none of the canary's files", () => {
		const { out, moved } = remark(
			{
				revs: { a: canaryAt("1"), b: canaryAt("2") },
				listings: [{ why: "never read" }],
				passes: () => true,
			},
			["README.md"],
		);
		expect(moved).toBe(true);
		expect(out).toEqual({ status: "moved", late: null });
	});

	it("re-marks each vouched session with the target's writer before moving", () => {
		const { out, moved, marks } = remark({
			revs: { a: canaryAt("1"), b: canaryAt("2") },
			listings: [[at("s1")]],
			passes: (dir, _id, markedBy) =>
				dir === ROOT || markedBy.includes(SCRATCH),
		});
		expect(moved).toBe(true);
		expect(out).toEqual({ status: "moved", late: null });
		expect(marks).toEqual({ s1: [SCRATCH] });
	});

	it("does not move where the target's canary still refuses a re-marked session", () => {
		const { out, moved } = remark({
			revs: { a: canaryAt("1"), b: canaryAt("2") },
			listings: [[at("s1")]],
			passes: (dir) => dir === ROOT,
		});
		expect(moved).toBe(false);
		expect(out).toEqual({
			status: "stranding",
			stranding: {
				stranded: [
					{
						sessionId: "s1",
						projectDir: ROOT,
						refusal: `refused by ${SCRATCH}`,
					},
				],
			},
		});
	});

	it("gives no marker to a session the current canary already refuses", () => {
		const { moved, marks } = remark({
			revs: { a: canaryAt("1"), b: canaryAt("2") },
			listings: [[at("s1")]],
			passes: () => false,
		});
		expect(moved).toBe(true);
		expect(marks).toEqual({});
	});

	it("ignores a session working outside the repository's worktrees", () => {
		const { marks } = remark({
			revs: { a: canaryAt("1"), b: canaryAt("2") },
			listings: [[at("s1", "/elsewhere")]],
			passes: () => true,
		});
		expect(marks).toEqual({});
	});

	it("does not move where the live sessions cannot be listed", () => {
		const { out, moved } = remark({
			revs: { a: canaryAt("1"), b: canaryAt("2") },
			listings: [{ why: "the oracle is down" }],
			passes: () => true,
		});
		expect(moved).toBe(false);
		expect(out).toEqual({
			status: "stranding",
			stranding: { why: "the oracle is down" },
		});
	});

	it("does not move a canary that sources a file in a form the re-mark cannot follow", () => {
		const { out, moved } = remark({
			revs: {
				a: canaryAt("1"),
				b: { ...canaryAt("2"), [CANARY]: 'source "$(dirname x)/y.sh"\n' },
			},
			listings: [[]],
			passes: () => true,
		});
		expect(moved).toBe(false);
		expect(out.status).toBe("stranding");
	});

	it("after the move, re-marks a latecomer the old canary passed and the new one refuses", () => {
		const { out, marks } = remark({
			revs: { a: canaryAt("1"), b: canaryAt("2") },
			listings: [[], [at("late")]],
			/* Before the move ROOT is `from`'s; after it, `to`'s: the root
			 * passes only a session its own writer marked. */
			passes: (dir, _id, markedBy) =>
				dir === SCRATCH || markedBy.includes(ROOT),
		});
		expect(out).toEqual({ status: "moved", late: null });
		expect(marks).toEqual({ late: [ROOT] });
	});

	it("names a latecomer still refused after its re-mark", () => {
		const { out } = remark({
			revs: { a: canaryAt("1"), b: canaryAt("2") },
			listings: [[], [at("late")]],
			passes: (dir) => dir === SCRATCH,
		});
		expect(out).toEqual({
			status: "moved",
			late: {
				stranded: [
					{
						sessionId: "late",
						projectDir: ROOT,
						refusal: `refused by ${ROOT}`,
					},
				],
			},
		});
	});
});
