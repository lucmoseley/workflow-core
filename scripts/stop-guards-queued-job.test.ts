// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { cutWorktree } from "./lib/git-fixture";
import { keptSpawn } from "./lib/kept-spawn.js";

const { projectSlug } = createRequire(__filename)("./lib/project-slug.js");

const CORE = path.resolve(__dirname, "..");
const HOOKS = JSON.parse(
	fs.readFileSync(path.resolve(__dirname, "../hooks/hooks.json"), "utf8"),
);
const STOP_COMMANDS: string[] = HOOKS.hooks.Stop.flatMap(
	(group: { hooks: { command: string }[] }) =>
		group.hooks.map((h) => h.command),
);

const RESULT = [
	"Built the change.",
	"",
	"waits on you: nothing",
	"",
	"result: committed a1b2c3d, queued for the lander on queue/q1, not on main — nothing waits on you",
].join("\n");

let base: string;
let root: string;
let wt: string;
let sid: string;

const g = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

beforeEach(() => {
	base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "queued-job-")));
	root = path.join(base, "work");
	const origin = path.join(base, "origin.git");
	execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
	execFileSync("git", ["init", "-q", "-b", "main", root]);
	g(root, "config", "user.email", "t@example.com");
	g(root, "config", "user.name", "T");
	g(root, "remote", "add", "origin", origin);
	g(root, "commit", "-q", "--allow-empty", "-m", "base");
	g(root, "push", "-q", "-u", "origin", "main");
	wt = cutWorktree(root, "q1");
	g(wt, "commit", "-q", "--allow-empty", "-m", "mine");
	sid = `queued-job-${Math.random().toString(36).slice(2)}`;
	const ledger = path.join(
		base,
		"config",
		"projects",
		projectSlug(root),
		"commits",
		`${sid}.txt`,
	);
	fs.mkdirSync(path.dirname(ledger), { recursive: true });
	fs.writeFileSync(ledger, `${g(wt, "rev-parse", "HEAD")}\n`);
});

afterEach(() => {
	fs.rmSync(base, { recursive: true, force: true });
});

const queue = () => {
	g(wt, "push", "-q", "origin", "HEAD:refs/heads/queue/q1");
	g(wt, "fetch", "-q", "origin");
};

function readBlockingHooks(message: string): string[] {
	const transcript = path.join(base, "transcript.jsonl");
	fs.writeFileSync(
		transcript,
		`${JSON.stringify({ type: "user", message: { content: "go" } })}\n`,
	);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		CLAUDE_PLUGIN_ROOT: CORE,
		CLAUDE_CONFIG_DIR: path.join(base, "config"),
		CLAUDE_PROJECT_DIR: wt,
		CLAUDE_JOB_DIR: path.join(base, "job"),
		WFC_REPO_ROOT: root,
	};
	const stdin = JSON.stringify({
		session_id: sid,
		hook_event_name: "Stop",
		last_assistant_message: message,
		transcript_path: transcript,
		cwd: wt,
	});
	return STOP_COMMANDS.flatMap((command) => {
		const out = keptSpawn("boundary").spawnSync("sh", ["-c", command], {
			input: stdin,
			cwd: wt,
			env,
			encoding: "utf8",
		});
		const blocked =
			out.status === 2 || /"decision"\s*:\s*"block"/.test(out.stdout);
		return blocked ? [`${command}\n${out.stdout}${out.stderr}`] : [];
	});
}

const hasHook = (hooks: string[], script: string) =>
	hooks.some((h) => h.includes(`/scripts/${script} `));

it("lets a background job end on `result:` with its queue ref unlanded, through every Stop hook (#5501)", () => {
	queue();
	expect(readBlockingHooks(RESULT)).toEqual([]);
});

it("blocks a background job's `waiting:` with its queue ref unlanded, through guard-priced-options.js", () => {
	queue();
	const hooks = readBlockingHooks("Pushed.\n\nwaiting: the lander.");
	expect(hasHook(hooks, "guard-priced-options.js")).toBe(true);
});

it("warns a background job of a commit not yet on its queue ref, through guard-unpushed-commits.js", () => {
	expect(hasHook(readBlockingHooks(RESULT), "guard-unpushed-commits.js")).toBe(
		true,
	);
});
