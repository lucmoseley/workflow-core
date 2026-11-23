// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { defineTemplate } from "./lib/git-fixture";
import { runInProcess } from "./lib/run-in-process.js";
import { shellQuote } from "./lib/sh-quote.js";

const ROOT = path.resolve(__dirname, "..");
const gate = (name: string) => path.join(ROOT, "scripts", name);
const ZERO = "0".repeat(40);

let tmp: string;
let shared: string;
let wt: string;
let sha: string;

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const writeConfig = (dir: string, config: object) => {
	fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, ".claude", "workflow-core.json"),
		JSON.stringify(config),
	);
};

const env = () => {
	const e: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: shared };
	delete e.WFC_MODULES;
	delete e.WFC_PLUGIN_ROOT;
	return e;
};

const carried = defineTemplate((dir) => {
	const remote = path.join(dir, "remote.git");
	const main = path.join(dir, "shared");
	const tree = path.join(dir, "wt");
	git(dir, "init", "-q", "--bare", remote);
	git(dir, "init", "-q", "-b", "main", main);
	git(main, "config", "user.email", "t@t");
	git(main, "config", "user.name", "t");
	git(main, "remote", "add", "origin", remote);
	git(main, "commit", "-q", "--allow-empty", "-m", "base");
	git(remote, "fetch", "-q", main, "main:refs/heads/main");
	writeConfig(main, {
		contract: 1,
		tracker: "o/tracker",
		codeRepo: "o/code",
	});
	git(main, "add", ".");
	git(main, "commit", "-q", "-m", "seed");
	git(main, "worktree", "add", "-q", "--detach", tree);
	git(tree, "commit", "-q", "--allow-empty", "-m", "carry");
	writeConfig(main, {
		contract: 1,
		tracker: "o/tracker",
		codeRepo: "o/tracker",
		modules: [],
	});

	const hooks = path.join(dir, "hooks");
	fs.mkdirSync(hooks);
	fs.writeFileSync(
		path.join(hooks, "pre-push"),
		`#!/bin/sh\nexec node ${shellQuote(gate("landing-push-gate.js"))}\n`,
		{ mode: 0o755 },
	);
	git(main, "config", "core.hooksPath", hooks);
});

beforeEach(() => {
	tmp = carried.instantiate(
		fs.mkdtempSync(path.join(os.tmpdir(), "pre-push-wt-config-")),
		{ extraPaths: [path.join("remote.git", "FETCH_HEAD")] },
	);
	shared = path.join(tmp, "shared");
	wt = path.join(tmp, "wt");
	sha = git(wt, "rev-parse", "HEAD");
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const pushToMain = (cwd = wt) =>
	spawnSync("git", ["push", "origin", "HEAD:refs/heads/main"], {
		cwd,
		encoding: "utf8",
		env: env(),
	});

it("refuses a worktree's unledgered push to main (#3128)", () => {
	const r = pushToMain();
	expect(r.stderr).toContain("pre-push: refused");
	expect(r.stderr).toContain(sha);
	expect(r.stderr).toContain("session-checkout.js land");
	expect(r.status).not.toBe(0);
});

it("refuses the shared checkout's unledgered push to main (#3132)", () => {
	const r = pushToMain(shared);
	expect(r.stderr).toContain("pre-push: refused");
	expect(r.stderr).toContain(git(shared, "rev-parse", "HEAD"));
	expect(r.status).not.toBe(0);
});

it("passes a worktree's push to main of a sha the canonical checkout's ledger holds (#3128)", () => {
	const markers = path.join(shared, ".claude", "tmp", "markers");
	fs.mkdirSync(markers, { recursive: true });
	fs.writeFileSync(
		path.join(markers, ".landing-green-ledger"),
		`${sha} 2026-10-26T00:00:00.000Z\n`,
	);
	const r = pushToMain();
	expect(r.status, r.stderr).toBe(0);
});

it("judges a worktree's queue push (#3128)", () => {
	const r = runInProcess(gate("landing-registry-gate.js"), [], {
		cwd: wt,
		env: env(),
		stdin: `HEAD ${sha} refs/heads/queue/wt ${ZERO}\n`,
	});
	expect(r.status, r.stderr).toBe(0);
	expect(r.stderr).toContain("holds no origin/main to judge queue/wt");
});

const pushPublic = (url: string) =>
	runInProcess(gate("public-push-gate.js"), [url], {
		cwd: wt,
		env: env(),
		stdin: `refs/heads/main ${sha} refs/heads/main ${ZERO}\n`,
	});

it("refuses a worktree's push to the code repo while the shared config joins it to the tracker (#3128)", () => {
	const r = pushPublic("https://github.com/o/code.git");
	expect(r.status).toBe(2);
	expect(r.stderr).toContain("not the tracker o/tracker");
	expect(r.stderr).toContain("Fetch it and push again");
});

it("refuses a worktree's push to the code repo while its own working copy joins it to the tracker (#3132)", () => {
	writeConfig(wt, { contract: 1, tracker: "o/tracker", codeRepo: "o/tracker" });
	const r = pushPublic("https://github.com/o/code.git");
	expect(r.status).toBe(2);
	expect(r.stderr).toContain("not the tracker o/tracker");
});

it("passes a worktree's push to the tracker it reads from its own config (#3128)", () => {
	const r = pushPublic("https://github.com/o/tracker.git");
	expect(r.status, r.stderr).toBe(0);
});
