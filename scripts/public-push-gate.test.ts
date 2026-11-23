// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { defineTemplate } from "./lib/git-fixture";
import { runInProcess } from "./lib/run-in-process.js";

const ROOT = path.resolve(__dirname, "..");
const CHECK = path.join(ROOT, "scripts", "public-push-gate.js");
const ZERO = "0".repeat(40);
const CODE_URL = "https://github.com/o/code.git";
const TRACKER_URL = "https://github.com/o/tracker.git";

let tmp: string;
let work: string;
let old: string;
let root: string;
let next: string;

const gitIn =
	(cwd: string) =>
	(...args: string[]) =>
		execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const git = (...args: string[]) => gitIn(work)(...args);

const writeConfig = (codeRepo: string, at = work) => {
	const gitAt = gitIn(at);
	fs.mkdirSync(path.join(at, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(at, ".claude", "workflow-core.json"),
		JSON.stringify({
			contract: 1,
			founder: "T",
			tracker: "o/tracker",
			codeRepo,
		}),
	);
	gitAt("add", ".claude");
	gitAt(
		"-c",
		"user.email=t@t",
		"-c",
		"user.name=t",
		"commit",
		"-q",
		"-m",
		"config",
	);
};

const buildRefLine = (local: string, remoteRef = "refs/heads/landing") =>
	`refs/heads/x ${local} ${remoteRef} ${ZERO}\n`;

const check = (stdin: string, url = CODE_URL) =>
	runInProcess(CHECK, [url], { cwd: work, env: { ...process.env }, stdin });

const bareRepo = defineTemplate((dir) => {
	execFileSync("git", ["init", "-q", "--bare", dir]);
});

let grafted = { old: "", root: "", next: "" };

const graftedRepo = defineTemplate((dir) => {
	const at = path.join(dir, "work");
	fs.mkdirSync(at);
	const gitAt = gitIn(at);
	const commitTree = (...args: string[]) =>
		gitAt("-c", "user.email=t@t", "-c", "user.name=t", "commit-tree", ...args);
	gitAt("init", "-q", "-b", "main");
	const seed = commitTree(
		"-m",
		"seed",
		gitAt("hash-object", "-t", "tree", "/dev/null"),
	);
	const oldSha = commitTree("-p", seed, "-m", "old", `${seed}^{tree}`);
	const rootSha = commitTree("-m", "squash", `${oldSha}^{tree}`);
	gitAt("replace", "--graft", rootSha, oldSha);
	const nextSha = commitTree("-p", rootSha, "-m", "next", `${rootSha}^{tree}`);
	gitAt("remote", "add", "origin", CODE_URL);
	gitAt("remote", "add", "archive", TRACKER_URL);
	gitAt("update-ref", "refs/remotes/archive/main", oldSha);
	writeConfig("o/code", at);
	grafted = { old: oldSha, root: rootSha, next: nextSha };
});

beforeEach(() => {
	tmp = graftedRepo.instantiate(
		fs.mkdtempSync(path.join(os.tmpdir(), "public-push-")),
	);
	work = path.join(tmp, "work");
	({ old, root, next } = grafted);
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

it("refuses a push to the code repo of tracker history, naming the sha and the tracker", () => {
	const r = check(buildRefLine(old));
	expect(r.status).toBe(2);
	expect(r.stderr).toContain(old);
	expect(r.stderr).toContain("o/tracker");
	expect(r.stderr).toContain("git rebase --onto origin/main");
});

it("passes the squashed root and work on it, though the graft makes old an ancestor", () => {
	expect(git("merge-base", "--is-ancestor", old, next) === "").toBe(true);
	const r = check(buildRefLine(root, "refs/heads/main") + buildRefLine(next));
	expect(r.status, r.stderr).toBe(0);
	expect(r.stderr).toBe("");
});

it("refuses where one pushed ref of several carries tracker history", () => {
	const r = check(buildRefLine(next) + buildRefLine(old, "refs/heads/spike/x"));
	expect(r.status).toBe(2);
	expect(r.stderr).toContain(old);
	expect(r.stderr).not.toContain(next);
});

it("passes tracker history pushed to the tracker", () => {
	const r = check(buildRefLine(old), TRACKER_URL);
	expect(r.status, r.stderr).toBe(0);
});

it("passes a deletion on the code repo", () => {
	expect(check(buildRefLine(ZERO)).status).toBe(0);
});

it("passes everything where the code repo is the tracker", () => {
	writeConfig("o/tracker");
	const r = check(buildRefLine(old), TRACKER_URL);
	expect(r.status, r.stderr).toBe(0);
	expect(r.stderr).toBe("");
});

it.each([
	"https://github.com/O/Code.git",
	"git@github-alt:o/code.git",
	"ssh://git@ssh.github.com:443/o/code.git",
])(
	"refuses tracker history pushed to %s, a url the code repo's own does not match",
	(url) => {
		const r = check(buildRefLine(old), url);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(old);
	},
);

it("passes tracker history pushed to the tracker under another case", () => {
	expect(check(buildRefLine(old), "git@github.com:O/Tracker.git").status).toBe(
		0,
	);
});

it("refuses a push to the code repo where no remote names the tracker, naming the remedy", () => {
	git("remote", "remove", "archive");
	const r = check(buildRefLine(next));
	expect(r.status).toBe(2);
	expect(r.stderr).toContain(
		"no fetched remote here holds the tracker's history",
	);
	expect(r.stderr).toContain(`git remote add archive ${TRACKER_URL}`);
});

it("names a fetch, not an add, where the tracker remote exists unfetched", () => {
	git("update-ref", "-d", "refs/remotes/archive/main");
	const r = check(buildRefLine(next));
	expect(r.status).toBe(2);
	expect(r.stderr).toContain("Fetch it and push again: git fetch archive");
});

it("refuses a push by url from a clone with no remotes at all", () => {
	git("remote", "remove", "archive");
	git("remote", "remove", "origin");
	const r = check(buildRefLine(old));
	expect(r.status).toBe(2);
	expect(r.stderr).toContain(`git remote add archive ${TRACKER_URL}`);
});

it("refuses a push to the code repo that git cannot judge, naming the fault", () => {
	const missing = "1".repeat(40);
	const r = check(buildRefLine(missing));
	expect(r.status).toBe(2);
	expect(r.stderr).toContain(`git merge-base ${missing} exited`);
	expect(r.stderr).toContain("never let through unjudged");
});

it("sends the real parents, not the graft's, so a push of the squashed line carries no tracker commit", () => {
	const bare = bareRepo.instantiate(path.join(tmp, "public.git"));
	git("push", "-q", "--no-verify", bare, `${next}:refs/heads/main`);
	const has = (sha: string) =>
		spawnSync("git", ["cat-file", "-e", sha], { cwd: bare }).status === 0;
	expect(has(next)).toBe(true);
	expect(has(old)).toBe(false);
});

it("makes .husky/pre-push refuse tracker history to the code repo and pass the squashed root", () => {
	const hook = (stdin: string) =>
		spawnSync(
			"sh",
			[path.join(ROOT, ".husky", "pre-push"), "origin", CODE_URL],
			{
				cwd: work,
				input: stdin,
				encoding: "utf8",
				env: { ...process.env, WFC_MODULES: "", WFC_PLUGIN_ROOT: ROOT },
			},
		);
	const refused = hook(buildRefLine(old));
	expect(refused.status).toBe(1);
	expect(refused.stderr).toContain("shares history with the private tracker");
	const r = hook(buildRefLine(root, "refs/heads/main"));
	expect(r.status, r.stderr).toBe(0);
});
