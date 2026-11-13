// @vitest-environment node
/*
 * measure-landing-pool.js (#5159), run for real over a fixture home: a
 * workflow-core checkout with two release tags, an adopter whose pin moved
 * to the carrying tag partway through its logs, one pinned below it and one
 * with `landing` off.
 *
 * Loosen it and a gate counts an adopter's stays from before its pin ran
 * the measured code, counts a repo that does not run it, or judges an
 * adopter's stays against workflow-core's suite time.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "measure-landing-pool.js");
const S = 1000;
const NOW = Date.now();
/* The pool's window opens 10 hours back; the adopter's pin carries from 5. */
const SINCE = NOW - 10 * 3600 * S;
const CARRIED = NOW - 5 * 3600 * S;
const iso = (t: number) => new Date(t).toISOString();

let home: string;
let core: string;
let measured: string;

const git = (cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) =>
	execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@t",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@t",
			...env,
		},
	}).trim();

const write = (file: string, text: string) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
};

const markers = (root: string) => path.join(root, ".claude", "tmp", "markers");

/** A main checkout under the fixture home carrying a config. */
const checkout = (name: string, modules: string[]) => {
	const root = path.join(home, name);
	fs.mkdirSync(root);
	git(root, ["init", "-q", "-b", "main"]);
	write(
		path.join(root, ".claude", "workflow-core.json"),
		JSON.stringify({ modules }),
	);
	return root;
};

const settings = (ref: string) =>
	JSON.stringify({
		enabledPlugins: { "workflow-core@wfc": true },
		extraKnownMarketplaces: {
			wfc: { source: { source: "github", repo: "o/wfc", ref } },
		},
	});

/** Commits a pin to `ref` at time `at`. */
const pin = (root: string, ref: string, at: number) => {
	write(path.join(root, ".claude", "settings.json"), settings(ref));
	git(root, ["add", ".claude/settings.json"]);
	const date = `${Math.floor(at / S)} +0000`;
	git(root, ["commit", "-q", "-m", `pin ${ref}`], {
		GIT_COMMITTER_DATE: date,
		GIT_AUTHOR_DATE: date,
	});
};

/** A release root commit rendered from `source`, tagged `tag`. */
const release = (tag: string, source: string) => {
	const tree = git(core, ["mktree"], {});
	const commit = git(core, [
		"commit-tree",
		tree,
		"-m",
		`Release ${tag}\n\nrendered from ${source}`,
	]);
	git(core, ["tag", tag, commit]);
};

/** A green run of `secs` seconds ending at `end`. */
const green = (end: number, secs: number, sha: string) => [
	`${iso(end - secs * S)} test-sha ${sha}`,
	`${iso(end)} fast-forward-main ${sha}`,
];

/** Queue rows for stays of the given seconds, ending one minute apart from `end` back. */
const stays = (end: number, lengths: number[]) =>
	lengths
		.flatMap((secs, k) => {
			const ref = `refs/heads/queue/s${end}-${k}`;
			const sha = String(k).padStart(40, "0");
			const at = end - k * 60 * S;
			return [
				{ at: iso(at - secs * S), event: "take", ref, sha },
				{ at: iso(at), event: "land", ref, sha },
			];
		})
		.sort((a, b) => a.at.localeCompare(b.at))
		.map((r) => JSON.stringify(r))
		.join("\n");

/* Every case only reads the fixture, so it is built once (§X8). */
beforeAll(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "landing-pool-"));
	core = checkout("workflow-core", ["landing"]);
	write(
		path.join(core, ".claude-plugin", "plugin.json"),
		JSON.stringify({ name: "workflow-core" }),
	);
	git(core, ["add", "."]);
	git(core, ["commit", "-q", "-m", "before"]);
	const before = git(core, ["rev-parse", "HEAD"]);
	git(core, ["commit", "-q", "--allow-empty", "-m", "measured"]);
	measured = git(core, ["rev-parse", "HEAD"]);
	git(core, ["update-ref", "refs/remotes/origin/main", measured]);
	release("v2.2.0", before);
	release("v2.3.0", measured);

	/* workflow-core: a 100 s green run, so a 300 s target, and 10 stays, 1 of
	 * them over it. */
	write(
		path.join(markers(core), ".lander.log"),
		`${green(NOW - 2 * 3600 * S, 100, "c1").join("\n")}\n`,
	);
	write(
		path.join(markers(core), ".queue-log.jsonl"),
		`${stays(NOW - 600 * S, [400, 200, 200, 200, 200, 200, 200, 200, 200, 200])}\n`,
	);

	/* lodge: pinned below the code until CARRIED. A 10 s green run, so a 30 s
	 * target: its 2 stays of 40 s are over it though under workflow-core's. Its
	 * 900 s stay before CARRIED is another release's. */
	const lodge = checkout("lodge", ["landing"]);
	pin(lodge, "v2.2.0", SINCE - 3600 * S);
	pin(lodge, "v2.3.0", CARRIED);
	write(
		path.join(markers(lodge), ".lander.log"),
		`${green(NOW - 2 * 3600 * S, 10, "l1").join("\n")}\n`,
	);
	write(
		path.join(markers(lodge), ".queue-log.jsonl"),
		`${stays(CARRIED - 600 * S, [900])}\n${stays(NOW - 300 * S, [40, 40, 5, 5, 5])}\n`,
	);

	pin(checkout("behind", ["landing"]), "v2.2.0", SINCE - 3600 * S);

	checkout("quiet", []);

	/* Reaps: two in the window for workflow-core, one before it; one for lodge. */
	const reap = (t: number) => JSON.stringify({ at: iso(t), path: "x" });
	write(
		path.join(core, ".git", "wfc-reaped-worktrees.jsonl"),
		`${[reap(SINCE - 60 * S), reap(NOW - 3600 * S), reap(NOW - 60 * S)].join("\n")}\n`,
	);
	write(
		path.join(lodge, ".git", "wfc-reaped-worktrees.jsonl"),
		`${reap(NOW - 60 * S)}\n`,
	);
});

afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

const run = (args: string[], cwd = core) => {
	const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
	delete env.CLAUDE_PROJECT_DIR;
	delete env.WFC_REPO_ROOT;
	delete env.WFC_MODULES;
	return runInProcess(SCRIPT, args, { cwd, env });
};

const json = (args: string[]) => {
	const r = run([...args, "--json"]);
	expect(r.stderr).toBe("");
	expect(r.status).toBe(0);
	return JSON.parse(r.stdout);
};

it("pools every landing checkout running the sha, an adopter only from when its pin carried it", () => {
	const d = json(["stays", "--since", iso(SINCE), "--carrying", measured]);
	expect(d.repos.map((r: { name: string }) => r.name)).toEqual([
		"lodge",
		"workflow-core",
	]);
	expect(d.repos.find((r: { name: string }) => r.name === "lodge").from).toBe(
		iso(Math.floor(CARRIED / S) * S),
	);
	expect(d.left).toEqual([
		{
			name: "behind",
			why: `its pin v2.2.0 does not carry ${measured.slice(0, 9)}`,
		},
		{ name: "quiet", why: "landing is off" },
	]);
});

it("judges each checkout's stays against its own target and pools the counts", () => {
	const d = json(["stays", "--since", iso(SINCE), "--carrying", measured]);
	const byName = Object.fromEntries(
		d.repos.map((r: { name: string }) => [r.name, r]),
	);
	expect(byName["workflow-core"]).toMatchObject({
		stays: 10,
		overTarget: 1,
		targetMs: 300 * S,
	});
	expect(byName.lodge).toMatchObject({
		stays: 5,
		overTarget: 2,
		targetMs: 30 * S,
	});
	expect(d).toMatchObject({ stays: 15, overTarget: 3, over: false });
});

it("prints each checkout's count and the left-out ones in its text reading", () => {
	const r = run(["stays", "--since", iso(SINCE), "--carrying", measured]);
	expect(r.stdout).toContain("  lodge: 5 stay(s), 2 over its target of 30 s");
	expect(r.stdout).toContain("when its pin v2.3.0 first carried it");
	expect(r.stdout).toContain("quiet (landing is off)");
	expect(r.stdout).toContain(
		"pooled: 3 of 15 stay(s) over their checkout's target",
	);
});

it("counts reaps in every checkout's record, naming one with none", () => {
	const d = json(["reaps", "--since", iso(SINCE)]);
	expect(d.total).toBe(3);
	const r = run(["reaps", "--since", iso(SINCE)]);
	expect(r.stdout).toContain("  quiet: 0 (no wfc-reaped-worktrees.jsonl)");
	expect(r.stdout).toContain("  workflow-core: 2");
});

it("refuses a pooled reading outside workflow-core, and one with no --carrying", () => {
	const outside = run(
		["stays", "--since", iso(SINCE), "--carrying", measured],
		path.join(home, "lodge"),
	);
	expect(outside.status).toBe(2);
	expect(outside.stderr).toContain("runs in workflow-core");
	const bare = run(["stays", "--since", iso(SINCE)]);
	expect(bare.status).toBe(2);
	expect(bare.stderr).toContain("needs --carrying");
});
