// @vitest-environment node
/*
 * gjd_is_job_dir — the predicate two guards share, extracted at mantahostels#2592 and
 * covered directly here at mantahostels#2652 — and gjd_job_rel beside it.
 *
 * THE LIMBS ARE ISOLATED BY CHOOSING PATHS ONLY ONE CAN MATCH, not by stubbing
 * anything, so each case below proves which limb answered it. Each runs the
 * sourced library in real bash under `set -u`, as the guards do.
 *
 * guard-job-dir-scratch.sh and guard-tracker-rules.sh, both `PreToolUse`
 * hooks, judge on this predicate, so a loosened case lets session scratch land
 * under the job directory unwarned, or fires their rule on a path outside it.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const LIB = path.resolve(__dirname, "guard-job-dir.sh");

/**
 * Is `p` under the job directory, as the shell library answers it?
 *
 * `set -u` is on, matching the guards that source this: a limb reading an unset
 * variable unguarded would kill them, and would pass a test run without it.
 */
const isJobDir = (
	p: string,
	{ jobDir, cwd }: { jobDir?: string; cwd?: string } = {},
): boolean => {
	const env: NodeJS.ProcessEnv = { ...process.env };
	// This session really runs under a job directory, so inheriting the variable
	// would silently satisfy the limb a case means to exclude.
	delete env.CLAUDE_JOB_DIR;
	if (jobDir !== undefined) env.CLAUDE_JOB_DIR = jobDir;
	const r = spawnSync(
		"bash",
		["-uc", `source "${LIB}"; gjd_is_job_dir "$1"`, "bash", p],
		{ cwd: cwd ?? "/", encoding: "utf8", env },
	);
	if (r.status === null) throw new Error(`bash did not run: ${r.error}`);
	expect(r.stderr ?? "").toBe("");
	expect([0, 1]).toContain(r.status);
	return r.status === 0;
};

describe("the unexpanded spelling, which survives with no variable at all", () => {
	it.each([
		["$CLAUDE_JOB_DIR/tmp/x.out", "the bare variable"],
		// biome-ignore lint/suspicious/noTemplateCurlyInString: a shell expansion under test, not a JS placeholder
		["${CLAUDE_JOB_DIR}/tmp/x.out", "a braced expansion"],
	])("%s is under the job directory — %s", (p) => {
		expect(isJobDir(p, {})).toBe(true);
	});
});

describe("the $CLAUDE_JOB_DIR prefix, as this process sees it", () => {
	/* `/srv/jobdir` names no dot-prefixed config directory, so the shape limb
	 * cannot answer for any of these and a match is the prefix limb's. */
	const jobDirPath = "/srv/jobdir";

	it("matches a path inside it", () => {
		expect(isJobDir("/srv/jobdir/tmp/x.out", { jobDir: jobDirPath })).toBe(
			true,
		);
	});

	it("matches the directory itself", () => {
		expect(isJobDir("/srv/jobdir", { jobDir: jobDirPath })).toBe(true);
	});

	/* THE PREFIX GUARD. Both sides get a trailing slash before the comparison
	 * for exactly this case: without it `/srv/jobdir-two` starts with
	 * `/srv/jobdir` and an unrelated sibling reads as the job directory. */
	it.each([
		["/srv/jobdir-two/tmp/x.out", "a sibling whose name extends the job dir's"],
		["/srv/jobdirx", "a sibling with no separator at all"],
	])("%s is NOT under it — %s", (p) => {
		expect(isJobDir(p, { jobDir: jobDirPath })).toBe(false);
	});

	it("matches through a trailing slash on the variable", () => {
		// The variable is the harness's to set, so `/srv/jobdir/` must answer as
		// `/srv/jobdir` does.
		expect(isJobDir("/srv/jobdir/tmp/x.out", { jobDir: "/srv/jobdir/" })).toBe(
			true,
		);
	});

	/* A relative target is resolved against the working directory before the
	 * prefix test, so the same word answers differently depending on where the
	 * command runs. Real directories, because bash reads its own `getcwd`. */
	it.each([
		["tmp/x.out", "a bare relative path"],
		["./tmp/x.out", "a dot-prefixed one"],
	])("resolves %s against the working directory — %s", (rel) => {
		const at = fs.mkdtempSync(path.join(os.tmpdir(), "gjd-"));
		const job = path.join(at, "jobdir");
		fs.mkdirSync(job);
		try {
			expect(isJobDir(rel, { jobDir: job, cwd: job })).toBe(true);
			expect(isJobDir(rel, { jobDir: job, cwd: at })).toBe(false);
		} finally {
			fs.rmSync(at, { recursive: true, force: true });
		}
	});

	it.each([
		["5", "an issue number"],
		["view", "a subcommand"],
		["x.md", "a bare filename"],
	])("never resolves %s, a word with no slash — %s (#1731)", (word) => {
		const job = fs.mkdtempSync(path.join(os.tmpdir(), "gjd-"));
		try {
			expect(isJobDir(word, { jobDir: job, cwd: job })).toBe(false);
		} finally {
			fs.rmSync(job, { recursive: true, force: true });
		}
	});
});

describe("the shape, for a hook environment that never carried the variable", () => {
	it.each([
		["/home/someone/.claude/jobs/abc123/tmp/x.out", "the ordinary config dir"],
		["/home/someone/.claude2/jobs/abc123/tmp/x.out", "a numbered one"],
	])("%s is under the job directory — %s", (p) => {
		expect(isJobDir(p, {})).toBe(true);
	});

	it.each([
		[
			"/home/someone/work/jobs/42/tmp/x.out",
			"an ordinary jobs/ directory in a repo, which the dot-prefix excludes",
		],
		[
			"/home/someone/.claude/jobs/abc123",
			"the job directory itself, which the limb's trailing `/*` does not reach",
		],
		["/home/someone/.claude/tmp/x.out", "the sanctioned session scratch path"],
	])("%s is NOT — %s", (p) => {
		expect(isJobDir(p, {})).toBe(false);
	});

	it("answers on shape alone even where the variable points elsewhere", () => {
		expect(
			isJobDir("/home/someone/.claude/jobs/abc123/tmp/x.out", {
				jobDir: "/srv/jobdir",
			}),
		).toBe(true);
	});
});

// #1139
describe("gjd_job_rel — where under the job directory a path sits", () => {
	const jobRel = (p: string, jobDir?: string): string | null => {
		const env: NodeJS.ProcessEnv = { ...process.env };
		delete env.CLAUDE_JOB_DIR;
		if (jobDir !== undefined) env.CLAUDE_JOB_DIR = jobDir;
		const r = spawnSync(
			"bash",
			["-uc", `source "${LIB}"; gjd_job_rel "$1"`, "bash", p],
			{ cwd: "/", encoding: "utf8", env },
		);
		expect(r.stderr ?? "").toBe("");
		return r.status === 0 ? r.stdout : null;
	};

	it.each([
		["$CLAUDE_JOB_DIR/tmp/a.md", undefined, "the unexpanded variable"],
		// biome-ignore lint/suspicious/noTemplateCurlyInString: a shell expansion under test, not a JS placeholder
		["${CLAUDE_JOB_DIR}/tmp/a.md", undefined, "a braced expansion"],
		["/srv/jobdir/tmp/a.md", "/srv/jobdir", "the live variable"],
		["/home/u/.claude2/jobs/abc/tmp/a.md", undefined, "the shape"],
	])("places %s at tmp/a.md — %s", (p, jobDir, _label) => {
		expect(jobRel(p, jobDir)).toBe("tmp/a.md");
	});

	it.each([
		["/srv/jobdir", "the job directory itself"],
		["/home/u/work/jobs/42/tmp/a.md", "an ordinary jobs/ directory"],
		/* gjd_is_job_dir's glob lets `*` span a slash and says yes here; this
		 * declines to place it, so the guard warns rather than refuses. */
		[
			"/home/u/.claude2/x/jobs/a/tmp/f",
			"a shape the predicate's glob alone reaches",
		],
	])("does not place %s — %s", (p) => {
		expect(jobRel(p, "/srv/jobdir")).toBeNull();
	});
});
