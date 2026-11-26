// @vitest-environment node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { freshSandbox, live, store } from "./lib/arbiter-testkit";
import { defineTemplate } from "./lib/git-fixture";
import { gitIn } from "./lib/repo-tree-testkit";
import { runInProcess } from "./lib/run-in-process";

const GUARD = path.resolve(__dirname, "guard-dispatch.js");
const BACKSTOP = path.resolve(__dirname, "concision-backstop.sh");

const ME = "session-under-test";
const OTHER = "parallel-session";

const git = (...args: string[]) => gitIn(sb.repo, ...args);

const repo = defineTemplate((dir) => {
	gitIn(dir, "init", "-q", "-b", "main", ".");
	gitIn(dir, "config", "user.email", "test@example.com");
	gitIn(dir, "config", "user.name", "test");
	gitIn(dir, "config", "branch.main.merge", "refs/heads/landing");
	fs.writeFileSync(path.join(dir, "seed.md"), "seed\n");
	gitIn(dir, "add", "seed.md");
	gitIn(dir, "commit", "-qm", "init");
});

const sb = freshSandbox((fresh) => {
	repo.instantiate(fresh.repo);
	fs.mkdirSync(path.join(fresh.repo, "docs"), { recursive: true });
	git("config", "core.hooksPath", path.join(fresh.dir, "no-hooks"));
	fs.mkdirSync(path.join(fresh.repo, "scripts"), { recursive: true });
});

const env = () => ({
	...process.env,
	CLAUDE_PROJECT_DIR: sb.repo,
	CLAUDE_CONFIG_DIR: sb.home,
});

function runGuard(command: string, sid = ME) {
	const r = runInProcess(GUARD, [], {
		cwd: sb.repo,
		stdin: JSON.stringify({
			session_id: sid,
			hook_event_name: "PreToolUse",
			tool_name: "Bash",
			tool_input: { command },
		}),
		env: env(),
	});
	expect(r.status).toBe(0);
	const log = sb.errorLog();
	expect(fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "").toBe("");
	expect(r.stdout.trim()).toBe("");
	return r;
}

function runBackstop(mode: "start" | "stop", sid = ME) {
	const r = spawnSync(BACKSTOP, [mode], {
		cwd: sb.repo,
		encoding: "utf8",
		input: JSON.stringify({ session_id: sid }),
		env: env(),
	});
	if (r.status === null) throw new Error(`backstop did not run: ${r.error}`);
	if (!r.stdout?.trim()) return null;
	return JSON.parse(r.stdout).reason as string;
}

const BIG_CODE = Array.from(
	{ length: 30 },
	(_, i) => `echo "line ${i} of a real edit"`,
).join("\n");

describe("the credit chain end to end (mantahostels#2806)", () => {
	it("drives a realistic Bash write through the guard, the judge and the ledger, and the backstop's code signal fires on it", () => {
		fs.writeFileSync(path.join(sb.repo, "scripts", "x.sh"), "echo a\n");
		git("add", "scripts/x.sh");
		git("commit", "-qm", "a script to edit", "--", "scripts/x.sh");
		runBackstop("start");

		runGuard("sed -i s/a/b/ scripts/x.sh");

		expect(store.readWritesBy(ME)).toEqual(["scripts/x.sh"]);

		fs.writeFileSync(path.join(sb.repo, "scripts", "x.sh"), `${BIG_CODE}\n`);

		const reason = runBackstop("stop");
		expect(reason).toContain("code-review");
		expect(reason).toContain("scripts/x.sh");
	});

	it("does not credit a path a live neighbour holds, but does credit an uncontended path in the same command, and the code signal never names the held path", () => {
		store.acquire("scripts/y.sh", live(sb, OTHER));

		fs.writeFileSync(path.join(sb.repo, "scripts", "y.sh"), "echo a\n");
		fs.writeFileSync(path.join(sb.repo, "scripts", "z.sh"), "echo a\n");
		git("add", "scripts/y.sh", "scripts/z.sh");
		git(
			"commit",
			"-qm",
			"one script a neighbour holds, one free",
			"--",
			"scripts/y.sh",
			"scripts/z.sh",
		);
		runBackstop("start");

		runGuard("sed -i s/a/b/ scripts/y.sh scripts/z.sh");

		expect(store.readWritesBy(ME)).toEqual(["scripts/z.sh"]);

		fs.writeFileSync(path.join(sb.repo, "scripts", "y.sh"), `${BIG_CODE}\n`);
		fs.writeFileSync(path.join(sb.repo, "scripts", "z.sh"), `${BIG_CODE}\n`);

		const reason = runBackstop("stop");
		expect(reason).toContain("scripts/z.sh");
		expect(reason).not.toContain("scripts/y.sh");
	});
});
