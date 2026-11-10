// @vitest-environment node
/*
 * lib/queue-owner.js's owner read (#4950, spec #4947), at its own seam: a
 * fixture worktree under a sandbox host, job records under a sandbox config
 * dir, and oracle listings handed in.
 *
 * Loosen it and the queue lander defers a drop for good behind a session
 * that ended, lost its worktree or was never there, or tickets a drop its
 * owning session is still fixing; or a listing that would not read stops
 * the lander's run instead of reading as stopped.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ListedSessions } from "./agent-liveness.js";
import { readOwner } from "./queue-owner.js";

let tmp: string;
let root: string;
let tree: string;
let seat: string;
let said: string[];

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "queue-owner-")));
	root = path.join(tmp, "repo");
	tree = path.join(root, ".claude", "worktrees", "wt-1");
	seat = path.join(tmp, "home", ".claude");
	fs.mkdirSync(tree, { recursive: true });
	fs.mkdirSync(seat, { recursive: true });
	said = [];
	vi.stubEnv("CLAUDE_CONFIG_DIR", seat);
});

afterEach(() => {
	vi.unstubAllEnvs();
	fs.rmSync(tmp, { recursive: true, force: true });
});

/** A job record naming `sessionId` with `cwd`. */
const job = (sessionId: string, cwd: string) => {
	const dir = path.join(seat, "jobs", sessionId.slice(0, 8));
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "state.json"),
		JSON.stringify({ sessionId, cwd, updatedAt: "2026-11-10T00:00:00Z" }),
	);
};

/** A listing of `sessions`, each with its cwd, `terminal` among them ended. */
const listing = (
	sessions: Record<string, string>,
	terminal: string[] = [],
): ListedSessions => ({
	ids: new Set(Object.keys(sessions)),
	names: new Map(),
	finished: new Set(),
	terminal: new Set(terminal),
	pids: new Map(),
	cwds: new Map(Object.entries(sessions)),
});

/** The read of `queue/wt-1` over the sandbox, with `listed` the oracle's. */
const read = (
	listed: () => ListedSessions,
	worktrees: () => string[] | null = () => [tree],
) =>
	readOwner(root, "wt-1", {
		worktrees,
		listed,
		say: (line) => said.push(line),
	});

describe("readOwner", () => {
	it("reads working where a listed, unended session's cwd lies in the queue ref's worktree", () => {
		expect(read(() => listing({ s1: path.join(tree, "scripts") }))).toBe(
			"working",
		);
	});

	it("reads working off a job record's cwd where the oracle lists the session with none", () => {
		job("s1-session", tree);

		expect(read(() => listing({ "s1-session": "" }))).toBe("working");
	});

	it("reads stopped where the owning session is terminal", () => {
		expect(read(() => listing({ s1: tree }, ["s1"]))).toBe("stopped");
	});

	it("reads stopped where the session a job record names is no longer listed", () => {
		job("s1-session", tree);

		expect(read(() => listing({ other: path.join(root, "elsewhere") }))).toBe(
			"stopped",
		);
	});

	it("reads stopped, asking no listing, where the worktree is gone from git's list or from disk", () => {
		const listed = vi.fn(() => listing({ s1: tree }));

		expect(read(listed, () => [])).toBe("stopped");
		fs.rmSync(tree, { recursive: true });
		expect(read(listed)).toBe("stopped");
		expect(listed).not.toHaveBeenCalled();
	});

	it("reads stopped where no session's cwd lies in the worktree, another name's worktree among them", () => {
		const other = path.join(root, ".claude", "worktrees", "wt-10");
		fs.mkdirSync(other);

		expect(
			read(
				() => listing({ s1: other }),
				() => [tree, other],
			),
		).toBe("stopped");
	});

	it("says nothing where the read stands, working or stopped", () => {
		read(() => listing({ s1: tree }));
		read(() => listing({ s1: tree }, ["s1"]));

		expect(said).toEqual([]);
	});

	it("reads stopped, saying why, where the read is in doubt: a listing that would not read or threw, or worktrees git would not list", () => {
		expect(read(() => ({ why: "the oracle timed out" }))).toBe("stopped");
		expect(
			read(() => {
				throw new Error("spawn failed");
			}),
		).toBe("stopped");
		expect(
			read(
				() => listing({ s1: tree }),
				() => null,
			),
		).toBe("stopped");
		expect(said).toEqual(
			["the oracle timed out", "spawn failed", "git listed no worktrees"].map(
				(why) =>
					`queue-lander: the owning session of queue/wt-1 could not be read, so it reads as stopped: ${why}`,
			),
		);
	});
});
