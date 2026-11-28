// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { freshSandbox, store } from "./arbiter-testkit";
import { defineTemplate, initGitRepo } from "./git-fixture";
import { renderFreshEdges } from "./manifest-freshen.js";
import { runInProcess } from "./run-in-process";
import { launchSnapshotTree } from "./tree-drift.js";

const COMMIT_PATHS = path.resolve(__dirname, "..", "commit-paths.js");
const DOC = "docs/new.md";
const READER = "scripts/reader.test.ts";
const SESSION = "this-session";

const readerRepo = defineTemplate((dir) => {
	initGitRepo(dir, path.join(dir, ".git", "hooks"));
	fs.mkdirSync(path.join(dir, "scripts"));
	fs.writeFileSync(path.join(dir, READER), `process.cwd(); read("${DOC}");\n`);
	execFileSync("git", ["add", READER], { cwd: dir });
	execFileSync("git", ["commit", "-qm", "reader"], { cwd: dir });
});

let hooks = "";
const sb = freshSandbox((s) => {
	hooks = path.join(s.dir, "hooks");
	fs.mkdirSync(hooks);
	readerRepo.instantiate(s.repo);
	git("config", "core.hooksPath", hooks);
	fs.mkdirSync(path.join(s.repo, "docs"), { recursive: true });
	fs.writeFileSync(path.join(s.repo, DOC), "a new document\n");
});

function git(...args: string[]) {
	return execFileSync("git", args, { cwd: sb.repo, encoding: "utf8" });
}

function openSnapshot() {
	const tree = launchSnapshotTree(sb.repo);
	const sha = git("commit-tree", tree, "-p", "HEAD", "-m", "snapshot").trim();
	const dir = fs.mkdtempSync(path.join(sb.dir, "snapshot-"));
	git("worktree", "add", "-q", "--detach", dir, sha);
	return dir;
}

const freshIn = (snapshot: string, sessionId: string | null) =>
	renderFreshEdges(snapshot, sb.repo, { sessionId })[DOC];
const fresh = (sessionId: string | null) => freshIn(openSnapshot(), sessionId);

const unreadableLedger = () =>
	fs.mkdirSync(store.paths.ledger(SESSION), { recursive: true });

const refusingGate = () => {
	const hook = path.join(hooks, "pre-commit");
	fs.writeFileSync(hook, '#!/bin/sh\necho "gate: refused" >&2\nexit 1\n');
	fs.chmodSync(hook, 0o755);
};

const commitPaths = () =>
	runInProcess(COMMIT_PATHS, ["-m", "new doc", "--", DOC], {
		cwd: sb.repo,
		env: { ...process.env, CLAUDE_CODE_SESSION_ID: SESSION },
	});

describe("the pre-run freshen's render of an intent-to-add entry (#5891)", () => {
	it("leaves out one this session did not make, which no commit of its carries (#3243)", () => {
		git("add", "-N", DOC);
		expect(fresh(SESSION)).toBeUndefined();
	});

	it("keeps every one where it cannot tell whose they are", () => {
		git("add", "-N", DOC);
		const snapshot = openSnapshot();
		expect(freshIn(snapshot, null)).toEqual([READER]);
		unreadableLedger();
		expect(freshIn(snapshot, SESSION)).toEqual([READER]);
	});

	it("keeps one this session's commit-paths.js call made, which a gate refused", () => {
		refusingGate();
		const r = commitPaths();
		expect(r.stderr).toContain("gate: refused");
		expect(r.status).toBe(3);
		expect(git("ls-files", "--", DOC)).toBe(`${DOC}\n`);
		const snapshot = openSnapshot();
		expect(freshIn(snapshot, SESSION)).toEqual([READER]);
		expect(freshIn(snapshot, "a-neighbour")).toBeUndefined();
	});

	it("goes on to the commit where the intent-add will not record, saying the freshen will leave it out", () => {
		refusingGate();
		unreadableLedger();
		const r = commitPaths();
		expect(r.stderr).toMatch(
			/intent-add of docs\/new\.md was not recorded as this session's/,
		);
		expect(r.stderr).toContain("gate: refused");
		expect(r.status).toBe(3);
	});
});
