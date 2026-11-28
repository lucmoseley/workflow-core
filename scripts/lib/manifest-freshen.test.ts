// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { freshSandbox } from "./arbiter-testkit";
import { initGitRepo } from "./git-fixture";
import { renderFreshEdges } from "./manifest-freshen.js";
import { runInProcess } from "./run-in-process";

const COMMIT_PATHS = path.resolve(__dirname, "..", "commit-paths.js");
const DOC = ["docs", "new.md"].join("/");
const READER = "scripts/reader.test.ts";

let hooks = "";
const sb = freshSandbox((s) => {
	hooks = path.join(s.dir, "hooks");
	fs.mkdirSync(hooks);
	initGitRepo(s.repo, hooks);
	fs.mkdirSync(path.join(s.repo, "scripts"), { recursive: true });
	fs.writeFileSync(
		path.join(s.repo, READER),
		`process.cwd(); read("${DOC}");\n`,
	);
	git("add", READER);
	git("commit", "-qm", "reader");
	fs.writeFileSync(path.join(s.repo, DOC), "a new document\n");
});

function git(...args: string[]) {
	return execFileSync("git", args, { cwd: sb.repo, encoding: "utf8" });
}

const fresh = (sessionId: string | null) =>
	renderFreshEdges(sb.repo, sb.repo, { sessionId })[DOC];

describe("the pre-run freshen's render of an intent-to-add entry (#5891)", () => {
	it("leaves out one this session did not make, which no commit of its carries (#3243)", () => {
		git("add", "-N", DOC);
		expect(fresh("this-session")).toBeUndefined();
		expect(fresh(null)).toEqual([READER]);
	});

	it("keeps one this session's commit-paths.js call made, which a gate refused", () => {
		const hook = path.join(hooks, "pre-commit");
		fs.writeFileSync(hook, '#!/bin/sh\necho "gate: refused" >&2\nexit 1\n');
		fs.chmodSync(hook, 0o755);
		const r = runInProcess(COMMIT_PATHS, ["-m", "new doc", "--", DOC], {
			cwd: sb.repo,
			env: { ...process.env, CLAUDE_CODE_SESSION_ID: "this-session" },
		});
		expect(r.stderr).toContain("gate: refused");
		expect(r.status).toBe(3);
		expect(git("ls-files", "--", DOC)).toBe(`${DOC}\n`);
		expect(fresh("this-session")).toEqual([READER]);
		expect(fresh("a-neighbour")).toBeUndefined();
	});
});
