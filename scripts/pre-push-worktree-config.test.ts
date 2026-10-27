// @vitest-environment node
/*
 * The pre-push checkers read the config as committed at the pushing tree's
 * HEAD and the shared stores from the canonical checkout (#3128, #3132).
 *
 * The shared checkout's working copy holds a half-written edit turning off
 * what the committed config turns on. The landing gate's cases cross a real
 * `git push`, since git choosing the hook's working directory is what places
 * the pushing tree; the rest run in-process from the worktree.
 *
 * Loosen it and one neighbour's dirty config opens every push.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

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

// A session pushing from a worktree carries the shared checkout as its project.
const env = () => {
	const e: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: shared };
	delete e.WFC_MODULES;
	delete e.WFC_PLUGIN_ROOT;
	return e;
};

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pre-push-wt-config-"));
	const remote = path.join(tmp, "remote.git");
	shared = path.join(tmp, "shared");
	wt = path.join(tmp, "wt");
	git(tmp, "init", "-q", "--bare", remote);
	git(tmp, "init", "-q", "-b", "main", shared);
	git(shared, "config", "user.email", "t@t");
	git(shared, "config", "user.name", "t");
	git(shared, "remote", "add", "origin", remote);
	writeConfig(shared, {
		contract: 1,
		tracker: "o/tracker",
		codeRepo: "o/code",
		modules: ["suites", "landing"],
	});
	git(shared, "add", ".");
	git(shared, "commit", "-q", "-m", "seed");
	git(shared, "worktree", "add", "-q", "--detach", wt);
	git(wt, "commit", "-q", "--allow-empty", "-m", "carry");
	sha = git(wt, "rev-parse", "HEAD");
	writeConfig(shared, {
		contract: 1,
		tracker: "o/tracker",
		codeRepo: "o/tracker",
		modules: [],
	});

	const hooks = path.join(tmp, "hooks");
	fs.mkdirSync(hooks);
	fs.writeFileSync(
		path.join(hooks, "pre-push"),
		`#!/bin/sh\nexec node "${gate("landing-push-gate.js")}"\n`,
		{ mode: 0o755 },
	);
	git(shared, "config", "core.hooksPath", hooks);
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const pushToMain = (cwd = wt) =>
	spawnSync("git", ["push", "origin", "HEAD:refs/heads/main"], {
		cwd,
		encoding: "utf8",
		env: env(),
	});

it("refuses a worktree's unledgered push to main while the shared config turns landing off (#3128)", () => {
	const r = pushToMain();
	expect(r.stderr).toContain("pre-push: refused");
	expect(r.stderr).toContain(sha);
	expect(r.stderr).toContain("HEAD:landing from a worktree");
	expect(r.status).not.toBe(0);
});

it("refuses the shared checkout's unledgered push to main while its working copy turns landing off (#3132)", () => {
	const r = pushToMain(shared);
	expect(r.stderr).toContain("pre-push: refused");
	expect(r.stderr).toContain(git(shared, "rev-parse", "HEAD"));
	expect(r.status).not.toBe(0);
});

it("refuses a worktree's unledgered push to main while its own working copy turns landing off (#3132)", () => {
	writeConfig(wt, { contract: 1, modules: [] });
	const r = pushToMain();
	expect(r.stderr).toContain("pre-push: refused");
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

it("judges a worktree's push creating landing while the shared config turns landing off (#3128)", () => {
	const r = runInProcess(gate("landing-registry-gate.js"), [], {
		cwd: wt,
		env: env(),
		stdin: `refs/heads/main ${sha} refs/heads/landing ${ZERO}\n`,
	});
	expect(r.status, r.stderr).toBe(0);
	expect(r.stderr).toContain("creates landing");
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

it("skips the certificate warning on the worktree's landing module while the shared config turns suites off (#3128)", () => {
	const r = runInProcess(gate("check-test-marker.js"), [], {
		cwd: wt,
		env: env(),
		stdin: `refs/heads/main ${sha} refs/heads/landing ${ZERO}\n`,
	});
	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout + r.stderr).toContain('module "landing" is on');
});
