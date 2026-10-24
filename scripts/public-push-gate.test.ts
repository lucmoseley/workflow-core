// @vitest-environment node
/*
 * scripts/public-push-gate.js and its .husky/pre-push limb (#1954).
 *
 * Each case builds a throwaway repo holding the tracker's history (`old`), a
 * squashed root of its tree (`root`) grafted onto it as the clones are, and a
 * commit on that root (`next`), then judges a ref list against a remote url.
 *
 * Loosen it and one push from an old worktree publishes the tracker's whole
 * history; tighten it and the squashed root, or work built on it, can never
 * reach the public repo.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
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

const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: work, encoding: "utf8" }).trim();

const commitTree = (...args: string[]) =>
	git("-c", "user.email=t@t", "-c", "user.name=t", "commit-tree", ...args);

const writeConfig = (codeRepo: string) => {
	fs.mkdirSync(path.join(work, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(work, ".claude", "workflow-core.json"),
		JSON.stringify({
			contract: 1,
			founder: "T",
			tracker: "o/tracker",
			codeRepo,
		}),
	);
};

const refLine = (local: string, remoteRef = "refs/heads/landing") =>
	`refs/heads/x ${local} ${remoteRef} ${ZERO}\n`;

const check = (stdin: string, url = CODE_URL) =>
	runInProcess(CHECK, [url], { cwd: work, env: { ...process.env }, stdin });

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "public-push-"));
	work = path.join(tmp, "work");
	fs.mkdirSync(work);
	git("init", "-q", "-b", "main");
	const seed = commitTree(
		"-m",
		"seed",
		git("hash-object", "-t", "tree", "/dev/null"),
	);
	old = commitTree("-p", seed, "-m", "old", `${seed}^{tree}`);
	root = commitTree("-m", "squash", `${old}^{tree}`);
	git("replace", "--graft", root, old);
	next = commitTree("-p", root, "-m", "next", `${root}^{tree}`);
	git("remote", "add", "origin", CODE_URL);
	git("remote", "add", "archive", TRACKER_URL);
	git("update-ref", "refs/remotes/archive/main", old);
	writeConfig("o/code");
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

it("refuses a push to the code repo of tracker history, naming the sha and the tracker", () => {
	const r = check(refLine(old));
	expect(r.status).toBe(2);
	expect(r.stderr).toContain(old);
	expect(r.stderr).toContain("o/tracker");
	expect(r.stderr).toContain("git rebase --onto origin/main");
});

it("passes the squashed root and work on it, though the graft makes old an ancestor", () => {
	expect(git("merge-base", "--is-ancestor", old, next) === "").toBe(true);
	const r = check(refLine(root, "refs/heads/main") + refLine(next));
	expect(r.status, r.stderr).toBe(0);
	expect(r.stderr).toBe("");
});

it("refuses where one pushed ref of several carries tracker history", () => {
	const r = check(refLine(next) + refLine(old, "refs/heads/spike/x"));
	expect(r.status).toBe(2);
	expect(r.stderr).toContain(old);
	expect(r.stderr).not.toContain(next);
});

it("passes tracker history pushed to the tracker", () => {
	const r = check(refLine(old), TRACKER_URL);
	expect(r.status, r.stderr).toBe(0);
});

it("passes a deletion on the code repo", () => {
	expect(check(refLine(ZERO)).status).toBe(0);
});

it("passes everything where the code repo is the tracker", () => {
	writeConfig("o/tracker");
	const r = check(refLine(old), TRACKER_URL);
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
		const r = check(refLine(old), url);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(old);
	},
);

it("passes tracker history pushed to the tracker under another case", () => {
	expect(check(refLine(old), "git@github.com:O/Tracker.git").status).toBe(0);
});

it("refuses a push to the code repo where no remote names the tracker, naming the remedy", () => {
	git("remote", "remove", "archive");
	const r = check(refLine(next));
	expect(r.status).toBe(2);
	expect(r.stderr).toContain(
		"no fetched remote here holds the tracker's history",
	);
	expect(r.stderr).toContain(`git remote add archive ${TRACKER_URL}`);
});

it("names a fetch, not an add, where the tracker remote exists unfetched", () => {
	git("update-ref", "-d", "refs/remotes/archive/main");
	const r = check(refLine(next));
	expect(r.status).toBe(2);
	expect(r.stderr).toContain("Fetch it and push again: git fetch archive");
});

it("refuses a push by url from a clone with no remotes at all", () => {
	git("remote", "remove", "archive");
	git("remote", "remove", "origin");
	const r = check(refLine(old));
	expect(r.status).toBe(2);
	expect(r.stderr).toContain(`git remote add archive ${TRACKER_URL}`);
});

it("refuses a push to the code repo that git cannot judge, naming the fault", () => {
	const missing = "1".repeat(40);
	const r = check(refLine(missing));
	expect(r.status).toBe(2);
	expect(r.stderr).toContain(`git merge-base ${missing} exited`);
	expect(r.stderr).toContain("never let through unjudged");
});

it("sends the real parents, not the graft's, so a push of the squashed line carries no tracker commit", () => {
	const bare = path.join(tmp, "public.git");
	execFileSync("git", ["init", "-q", "--bare", bare]);
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
				env: { ...process.env, WFC_MODULES: "suites", WFC_PLUGIN_ROOT: ROOT },
			},
		);
	const refused = hook(refLine(old));
	expect(refused.status).toBe(1);
	expect(refused.stderr).toContain("shares history with the private tracker");
	const r = hook(refLine(root, "refs/heads/main"));
	expect(r.status, r.stderr).toBe(0);
});
