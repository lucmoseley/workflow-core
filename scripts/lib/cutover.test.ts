// @vitest-environment node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { cutover, isCutOver, renderCutover } from "./cutover.js";
import { GIT_TIMEOUT_MS, type GitReader, gitReader } from "./git.js";
import { defineTemplate } from "./git-fixture";
import {
	level,
	readOrphanedEdits,
	renderBlocker,
	renderOutcome,
} from "./level-main.js";

let tmp: string;
let main: string;
let other: string;

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

const commitIn = (cwd: string, files: Record<string, string>, msg: string) => {
	for (const [name, text] of Object.entries(files))
		fs.writeFileSync(path.join(cwd, name), text);
	git(cwd, "add", "-A");
	git(cwd, "commit", "-qm", msg);
	return git(cwd, "rev-parse", "HEAD");
};

interface Agent {
	name?: string;
	sessionId: string;
	cwd?: string;
}

const ports = ({
	agents = [],
	gitIn = (dir: string) => gitReader(dir, GIT_TIMEOUT_MS),
	mergeMs = GIT_TIMEOUT_MS,
}: {
	agents?: Agent[] | { why: string };
	gitIn?: (dir: string) => GitReader;
	mergeMs?: number;
} = {}) => ({
	listed: () => (Array.isArray(agents) ? { agents } : agents),
	cut: (root: string, name: string) => {
		const dir = path.join(tmp, name);
		git(root, "worktree", "add", "-q", "--detach", dir, "origin/main");
		git(dir, "config", "user.email", "t@t");
		git(dir, "config", "user.name", "t");
		return { dir };
	},
	land: (dir: string) => {
		const queue = `queue/${path.basename(dir)}`;
		git(dir, "push", "-q", "origin", `HEAD:refs/heads/${queue}`);
		return { queue, head: git(dir, "rev-parse", "HEAD"), lander: null };
	},
	orphanedEdits: (root: string) =>
		readOrphanedEdits(root, Date.now(), () => null),
	level: (root: string) =>
		level(root, { install: () => undefined, now: Date.now() }),
	gitIn,
	mergeIn: (dir: string) => gitReader(dir, mergeMs),
});

const render = (r: ReturnType<typeof cutover>) =>
	renderCutover(r, {
		renderBlocker: (b) => renderBlocker(b, Date.now()),
		renderLevel: (o) => renderOutcome(o, Date.now()),
	}).join("\n");

const pair = defineTemplate((at) => {
	const bare = path.join(at, "origin.git");
	const first = path.join(at, "main");
	const second = path.join(at, "other");
	git(at, "init", "-q", "--bare", "-b", "main", bare);
	git(at, "clone", "-q", bare, first);
	git(first, "config", "user.email", "t@t");
	git(first, "config", "user.name", "t");
	commitIn(first, { "a.md": "a\n", "package-lock.json": "{}\n" }, "seed");
	git(first, "push", "-q", "origin", "HEAD:main", "HEAD:landing");
	git(first, "branch", "-q", "--set-upstream-to=origin/landing", "main");
	git(at, "clone", "-q", bare, second);
	git(second, "config", "user.email", "t@t");
	git(second, "config", "user.name", "t");
});

beforeEach(() => {
	tmp = pair.instantiate(
		fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cutover-"))),
	);
	main = path.join(tmp, "main");
	other = path.join(tmp, "other");
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

it("refuses while a session stands in the main checkout, changing nothing", () => {
	const r = cutover(
		main,
		ports({ agents: [{ name: "live", sessionId: "s", cwd: main }] }),
	);
	expect(r).toEqual({ status: "occupied", sessions: ["live"] });
	expect(isCutOver(main)).toBe(false);
	expect(render(r)).toContain("still stand in the main checkout");
});

it("counts a session in a subdirectory of the main checkout, not one in a linked worktree under it", () => {
	const sub = path.join(main, "docs");
	fs.mkdirSync(sub);
	const linked = path.join(main, ".claude", "worktrees", "wt");
	git(main, "worktree", "add", "-q", "--detach", linked);
	const r = cutover(
		main,
		ports({
			agents: [
				{ name: "below", sessionId: "b", cwd: `${sub}/` },
				{ name: "linked", sessionId: "l", cwd: linked },
			],
		}),
	);
	expect(r).toEqual({ status: "occupied", sessions: ["below"] });
});

it("refuses where no listing can show the main checkout empty", () => {
	expect(cutover(main, ports({ agents: { why: "no oracle" } }))).toEqual({
		status: "unlisted",
		why: "no oracle",
	});
	expect(isCutOver(main)).toBe(false);
});

it("pushes main's local commits to a queue ref, reports each edit left by name, and removes the upstream", () => {
	const own = commitIn(main, { "local.md": "mine\n" }, "local only");
	commitIn(other, { "b.md": "b\n" }, "a neighbour's");
	git(other, "push", "-q", "origin", "HEAD:main");
	fs.writeFileSync(path.join(main, "a.md"), "edited\n");
	fs.writeFileSync(path.join(main, "stray.md"), "new\n");

	const r = cutover(
		main,
		ports({ agents: [{ name: "elsewhere", sessionId: "e", cwd: other }] }),
	);

	expect(r.status).toBe("cut-over");
	git(main, "fetch", "-q", "origin");
	git(
		main,
		"merge-base",
		"--is-ancestor",
		own,
		`origin/queue/cutover-main-${own.slice(0, 9)}`,
	);
	expect(isCutOver(main)).toBe(true);
	expect(fs.readFileSync(path.join(main, "a.md"), "utf8")).toBe("edited\n");
	const text = render(r);
	expect(text).toContain("pushed main's 1 local commit(s)");
	expect(text).toContain("to queue/cutover-main-");
	expect(text).toContain(
		"2 edit(s) remain in the main checkout, none discarded",
	);
	expect(text).toContain("  a.md — ");
	expect(text).toContain("  stray.md — ");
	expect(text).toContain("once the lander takes them");
});

it("leaves the mark where merging main's commits conflicts, naming the files", () => {
	commitIn(main, { "a.md": "main's\n" }, "local only");
	commitIn(other, { "a.md": "landing's\n" }, "a neighbour's");
	git(other, "push", "-q", "origin", "HEAD:main");

	const r = cutover(main, ports());

	expect(r).toMatchObject({ status: "unmerged", local: 1, files: ["a.md"] });
	expect(r).toHaveProperty(
		"why",
		expect.stringContaining("CONFLICT (content)"),
	);
	expect(isCutOver(main)).toBe(false);
	expect(render(r)).toContain("session-checkout.js land");
});

it("cuts over with nothing to land, and a second run only reports", () => {
	const first = cutover(main, ports());
	expect(first).toMatchObject({
		status: "cut-over",
		already: false,
		landed: null,
	});
	const second = cutover(
		main,
		ports({ agents: [{ name: "late", sessionId: "l", cwd: main }] }),
	);
	expect(second).toMatchObject({ status: "cut-over", already: true });
	expect(render(second)).toContain("main is level with origin/main");
});

// guess, #5824: slept for real, outrunning MERGE_LIMIT_MS by a second
const GATE_SLEEP_S = 2;
// guess, #5824: a merge-port limit well under the gate's sleep
const MERGE_LIMIT_MS = 1000;

const slowMergeGate = () => {
	const hooks = path.join(main, ".git", "hooks");
	fs.mkdirSync(hooks, { recursive: true });
	fs.writeFileSync(
		path.join(hooks, "pre-merge-commit"),
		`#!/bin/sh\nsleep ${GATE_SLEEP_S}\n`,
		{ mode: 0o755 },
	);
	commitIn(main, { "local.md": "mine\n" }, "local only");
	commitIn(other, { "b.md": "b\n" }, "a neighbour's");
	git(other, "push", "-q", "origin", "HEAD:main");
};

it("refuses a merge whose gate outruns the merge port's limit, naming no files — the pair of the landing case below (#5824)", () => {
	slowMergeGate();
	expect(cutover(main, ports({ mergeMs: MERGE_LIMIT_MS }))).toMatchObject({
		status: "unmerged",
		local: 1,
		files: [],
	});
	expect(isCutOver(main)).toBe(false);
});

it("lands through that same slow gate when the merge port outlasts it, no merge reaching the short reader — the pair of the refusal above (#5824)", () => {
	slowMergeGate();
	const viaGitIn: string[][] = [];
	const recording = (dir: string): GitReader => {
		const read = gitReader(dir, GIT_TIMEOUT_MS);
		return (args, noMatch) => {
			viaGitIn.push(args);
			return read(args, noMatch);
		};
	};
	expect(
		cutover(main, ports({ gitIn: recording, mergeMs: 60_000 })),
	).toMatchObject({ status: "cut-over", landed: { count: 1 } });
	expect(isCutOver(main)).toBe(true);
	expect(viaGitIn.some((args) => args[0] === "fetch")).toBe(true);
	expect(viaGitIn.filter((args) => args[0] === "merge")).toEqual([]);
});
