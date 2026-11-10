// @vitest-environment node
/*
 * The cutover's core (#4248) against real git: a bare origin carrying `main` and
 * `landing`, and a main checkout cloned from it whose `main` tracks
 * `landing`, as the shared-tree model set it. The session listing is
 * injected; the cut is a detached worktree from `origin/main`, and the land a
 * push of `HEAD` to that worktree's queue ref, as lib/session-checkout.js's do, without
 * its dependency store or lander start. The program's boundary set is
 * scripts/cutover-main-checkout.test.ts.
 *
 * Loosen it and the main checkout is cut over under a live session, a local
 * commit is lost rather than landed, an edit there is discarded, or a
 * conflicted merge flips the mark anyway.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { cutover, isCutOver, renderCutover } from "./cutover.js";
import { GIT_TIMEOUT_MS, gitReader } from "./git.js";
import {
	level,
	readOrphanedEdits,
	renderBlocker,
	renderOutcome,
} from "./level-main.js";

let tmp: string;
let origin: string;
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
	on = true,
}: {
	agents?: Agent[] | { why: string };
	on?: boolean;
} = {}) => ({
	moduleOn: () => on,
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
	gitIn: (dir: string) => gitReader(dir, GIT_TIMEOUT_MS),
});

const render = (r: ReturnType<typeof cutover>) =>
	renderCutover(r, {
		renderBlocker: (b) => renderBlocker(b, Date.now()),
		renderLevel: (o) => renderOutcome(o, Date.now()),
	}).join("\n");

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cutover-")));
	origin = path.join(tmp, "origin.git");
	main = path.join(tmp, "main");
	other = path.join(tmp, "other");
	git(tmp, "init", "-q", "--bare", "-b", "main", origin);
	git(tmp, "clone", "-q", origin, main);
	git(main, "config", "user.email", "t@t");
	git(main, "config", "user.name", "t");
	commitIn(main, { "a.md": "a\n", "package-lock.json": "{}\n" }, "seed");
	git(main, "push", "-q", "origin", "HEAD:main", "HEAD:landing");
	git(main, "branch", "-q", "--set-upstream-to=origin/landing", "main");
	git(tmp, "clone", "-q", origin, other);
	git(other, "config", "user.email", "t@t");
	git(other, "config", "user.name", "t");
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
	/* git merge says why on stdout, its stderr empty. */
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

it("does nothing with the `landing` module off", () => {
	expect(cutover(main, ports({ on: false }))).toEqual({ status: "module-off" });
	expect(isCutOver(main)).toBe(false);
});
