// @vitest-environment node
/*
 * A resume reopens its session's recorded worktree, uncommitted work intact
 * (#4229 story 7, #4319): lib/refill-resume.js's readResumeTarget then
 * resumeStopped over the production adapter, with a real git worktree and
 * `claude` stubbed at WFC_CLAUDE_BIN.
 *
 * Loosen it and a session cut into its own worktree resumes in the main
 * checkout, away from its branch and its uncommitted edits.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { buildRekeyedResponse, FAKE_COPY } from "./bg-resume-fake";
import { writeClaudeStub } from "./claude-stub";
import { jobDirPath, jobStatePath } from "./job-paths.js";
import { resumeSteps } from "./refill-resume.js";
import { buildResumeIo } from "./resume-io.js";
import { JOB, SESSION } from "./resume-io-fake";
import { shellQuote } from "./sh-quote.js";

type JobLaunch = import("./refill-blocks.js").JobLaunch;

const savedEnv = { ...process.env };
let dir: string;

beforeEach(() => {
	dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "resume-wt-")));
});

afterEach(() => {
	process.env = { ...savedEnv };
	fs.rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" });

/** A checkout at `root` with one commit, and a worktree cut from it at `wt`
 * holding an edit to a tracked file and an untracked one. */
function cutWorktree(root: string, wt: string) {
	fs.mkdirSync(root);
	git(root, "init", "-q", "-b", "main");
	fs.writeFileSync(path.join(root, "tracked.txt"), "base\n");
	git(root, "add", ".");
	git(
		root,
		"-c",
		"user.name=t",
		"-c",
		"user.email=t@t",
		"commit",
		"-qm",
		"base",
	);
	git(root, "worktree", "add", "-q", "-b", "implement-7", wt);
	fs.writeFileSync(path.join(wt, "tracked.txt"), "edited\n");
	fs.writeFileSync(path.join(wt, "wip.txt"), "half done\n");
}

it("runs the --bg --resume in the job record's worktree, leaving its uncommitted work in place", () => {
	const root = path.join(dir, "repo");
	const wt = path.join(dir, "wt");
	const seat = path.join(dir, "seat");
	const bin = path.join(dir, "claude");
	const ranIn = path.join(dir, "ran-in");
	cutWorktree(root, wt);
	const record = jobStatePath(seat, JOB);
	fs.mkdirSync(jobDirPath(seat, JOB), { recursive: true });
	fs.writeFileSync(
		record,
		JSON.stringify({ sessionId: SESSION, cwd: wt, state: "stopped" }),
	);
	const woke = buildRekeyedResponse("woke", JOB, FAKE_COPY);
	const out = path.join(dir, "bg-out");
	fs.writeFileSync(out, woke.stdout);
	const running = JSON.stringify({
		sessionId: SESSION,
		cwd: wt,
		state: "working",
	});
	writeClaudeStub(bin, [
		`if [ "$1" = "--bg" ]; then pwd -P > ${shellQuote(ranIn)}; printf %s ${shellQuote(running)} > ${shellQuote(record)}; cat ${shellQuote(out)}; exit 0; fi`,
	]);
	Object.assign(process.env, {
		HOME: dir,
		CLAUDE_CONFIG_DIR: seat,
		CLAUDE_CODE_SESSION_ID: "",
		WFC_CLAUDE_BIN: bin,
		WFC_SECRETS_FILE: path.join(dir, "secrets.env"),
	});
	delete process.env.ANTHROPIC_API_KEY;
	const l = { root, issues: [7], seat, jobId: JOB } as unknown as JobLaunch;
	const logged: string[] = [];
	const steps = resumeSteps(buildResumeIo((line) => logged.push(line)));

	const target = steps.readResumeTarget(l);
	expect(target).toEqual({ sessionId: SESSION, cwd: wt });
	const r = steps.resumeStopped(
		l,
		"carry on",
		target as { sessionId: string; cwd: string },
	);

	expect(r).toMatchObject({ failed: null, jobId: JOB, copy: false });
	expect(logged).toEqual([]);
	expect(fs.readFileSync(ranIn, "utf8").trim()).toBe(wt);
	expect(fs.readFileSync(path.join(wt, "wip.txt"), "utf8")).toBe("half done\n");
	expect(git(wt, "status", "--porcelain").split("\n").sort()).toEqual([
		"",
		" M tracked.txt",
		"?? wip.txt",
	]);
});
