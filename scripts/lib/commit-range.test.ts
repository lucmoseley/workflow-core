// @vitest-environment node
/*
 * Pins the commit range a red sweep accuses: every commit and its files, a
 * reason rather than a throw when the range cannot be read, and the bisect
 * advice (mantahostels#945, on the attribution ruling at mantahostels#907).
 *
 * A throwaway repo per test, where the history has to be known exactly. Never
 * this repo's own — a parallel session moves HEAD mid-run, and CI clones at
 * depth 1, where an ancestor is not a revision at all.
 *
 * check-ci-status.js (a session-start hook in .claude/settings.json) and
 * report-red-suite.js (the red-sweep job in scheduled-checks.yml) both print
 * this range, so a loosened case lets a red sweep name the wrong commits, or
 * throw and report nothing.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

// biome-ignore lint/suspicious/noExplicitAny: a CJS module has no types to import
const range: any = createRequire(__filename)("./commit-range.js");

let dir: string;

const git = (args: string[], cwd = dir) =>
	execFileSync("git", args, { encoding: "utf8", cwd }).trim();

/** Commit `files` (path → contents) under `subject`; return the full sha. */
function commit(subject: string, files: Record<string, string>) {
	for (const [p, body] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
		fs.writeFileSync(path.join(dir, p), body);
	}
	git(["add", "-A"]);
	git(["commit", "-m", subject]);
	return git(["rev-parse", "HEAD"]);
}

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "commit-range-"));
	git(["init", "-q", "-b", "main"], dir);
	git(["config", "user.email", "t@example.invalid"]);
	git(["config", "user.name", "Test"]);
});

describe("readRange names every commit and the files it touched (mantahostels#945)", () => {
	it("returns the commits newest first, with their files", () => {
		const good = commit("base", { "a.txt": "1" });
		commit("second", { "b.txt": "1", "c/d.txt": "1" });
		const bad = commit("third", { "a.txt": "2" });

		const r = range.readRange({ good, bad, cwd: dir });
		expect(r.ok).toBe(true);
		expect(r.count).toBe(2);
		expect(r.commits.map((c: { subject: string }) => c.subject)).toEqual([
			"third",
			"second",
		]);
		expect(r.commits[0].files).toEqual(["a.txt"]);
		expect(r.commits[1].files).toEqual(["b.txt", "c/d.txt"]);
	});

	it("reads a subject containing a tab without splitting the record", () => {
		// The separators are %x1f/%x00 rather than a tab because a tab is legal in
		// a subject.
		const good = commit("base", { "a.txt": "1" });
		const bad = commit("has\ta tab in it", { "a.txt": "2" });

		const r = range.readRange({ good, bad, cwd: dir });
		expect(r.commits[0].subject).toBe("has\ta tab in it");
		expect(r.commits[0].files).toEqual(["a.txt"]);
	});

	it("counts an empty range as zero rather than failing", () => {
		const sha = commit("only", { "a.txt": "1" });

		const r = range.readRange({ good: sha, bad: sha, cwd: dir });
		expect(r).toMatchObject({ ok: true, count: 0, commits: [] });
	});

	it("reports how many it left unlisted when the range outruns the cap", () => {
		const good = commit("base", { "a.txt": "0" });
		let bad = good;
		for (let i = 1; i <= 5; i++) bad = commit(`c${i}`, { "a.txt": String(i) });

		const r = range.readRange({ good, bad, cwd: dir, maxListed: 2 });
		expect(r.count).toBe(5);
		expect(r.commits).toHaveLength(2);
		expect(r.truncated).toBe(3);
	});

	it("attributes a merge's files to the merge, not to each parent twice", () => {
		// --first-parent: without it a merge prints no files at all under
		// --name-only, so the range would under-report what it changed.
		const good = commit("base", { "a.txt": "1" });
		git(["checkout", "-q", "-b", "side"]);
		commit("side work", { "side.txt": "1" });
		git(["checkout", "-q", "main"]);
		commit("main work", { "main.txt": "1" });
		git(["merge", "--no-ff", "-m", "merge side", "side"]);
		const bad = git(["rev-parse", "HEAD"]);

		const r = range.readRange({ good, bad, cwd: dir });
		expect(r.ok).toBe(true);
		expect(r.commits[0].subject).toBe("merge side");
		expect(r.commits[0].files).toEqual(["side.txt"]);
	});
});

describe("a range it cannot read is a reason, never a throw (mantahostels#945)", () => {
	it("names the missing end when this clone has never fetched a sha", () => {
		const bad = commit("only", { "a.txt": "1" });
		const absent = "0123456789abcdef0123456789abcdef01234567";

		const r = range.readRange({ good: absent, bad, cwd: dir });
		expect(r.ok).toBe(false);
		expect(r.reason).toContain("0123456");
		expect(r.reason).toContain("good end");
		expect(r.reason).toContain("git fetch origin");
	});

	it("refuses two tips that are not one line of history", () => {
		commit("base", { "a.txt": "1" });
		git(["checkout", "-q", "--orphan", "other"]);
		fs.rmSync(path.join(dir, "a.txt"));
		const bad = commit("unrelated", { "z.txt": "1" });
		const good = git(["rev-parse", "main"]);

		const r = range.readRange({ good, bad, cwd: dir });
		expect(r.ok).toBe(false);
		expect(r.reason).toContain("not an ancestor");
	});

	it("says there is no range when an end is missing altogether", () => {
		expect(range.readRange({ good: "", bad: "abc", cwd: dir }).ok).toBe(false);
	});
});

describe("renderRange gives a reader the narrowing lines (mantahostels#945)", () => {
	const commits = (n: number, files = 1) =>
		Array.from({ length: n }, (_, i) => ({
			short: `abc${i}`,
			subject: `subject ${i}`,
			files: Array.from({ length: files }, (_slot, f) => `src/f${f}.ts`),
		}));

	const opts = { good: "g".repeat(40), bad: "b".repeat(40) };

	it("lists each commit's files in full while the range is short", () => {
		const out = range
			.renderRange(
				{ ok: true, count: 2, commits: commits(2), truncated: 0 },
				opts,
			)
			.join("\n");

		expect(out).toContain("2 commit(s) since the last green run");
		expect(out).toContain("abc0  subject 0");
		expect(out).toContain("src/f0.ts");
		expect(out).not.toContain("file(s))");
	});

	it("switches to a per-commit count and an aggregate once it is long", () => {
		const out = range
			.renderRange(
				{ ok: true, count: 12, commits: commits(12, 3), truncated: 0 },
				opts,
			)
			.join("\n");

		expect(out).toContain("(3 file(s))");
		expect(out).toContain("Most-touched files in the range:");
		expect(out).toContain("12x  src/f0.ts");
	});

	it("says plainly that no commit is to blame when the range is empty", () => {
		const out = range
			.renderRange({ ok: true, count: 0, commits: [], truncated: 0 }, opts)
			.join("\n");

		expect(out).toContain("No commits between the last green run");
		expect(out).toContain("flakiness");
	});

	it("hands over the command for the commits it did not list", () => {
		const out = range
			.renderRange(
				{ ok: true, count: 200, commits: commits(2), truncated: 198 },
				opts,
			)
			.join("\n");

		expect(out).toContain("and 198 more");
		expect(out).toContain("git log --oneline");
	});

	it("passes an unreadable range's reason through instead of a list", () => {
		const out = range
			.renderRange({ ok: false, reason: "no such commit" }, opts)
			.join("\n");

		expect(out).toBe("Commit range unavailable: no such commit.");
	});
});

describe("countRange counts without paying for the file lists (mantahostels#945)", () => {
	it("returns just the number of commits between two shas", () => {
		const good = commit("base", { "a.txt": "1" });
		commit("second", { "b.txt": "1" });
		const bad = commit("third", { "c.txt": "1" });

		expect(range.countRange({ good, bad, cwd: dir })).toBe(2);
		expect(range.countRange({ good: bad, bad, cwd: dir })).toBe(0);
	});

	it("returns null for a pair that is not one line of history", () => {
		// null must not be confused with zero.
		const bad = commit("only", { "a.txt": "1" });

		expect(
			range.countRange({ good: "0".repeat(40), bad, cwd: dir }),
		).toBeNull();
		expect(range.countRange({ good: "", bad, cwd: dir })).toBeNull();
	});
});

describe("bisectAdvice offers a bisect only where it would help (mantahostels#945)", () => {
	const ends = { good: "g".repeat(40), bad: "b".repeat(40) };
	const at = (count: number) =>
		range.bisectAdvice({ ok: true, count, commits: [], truncated: 0 }, ends);

	it("says nothing at zero or one commit, which need no search", () => {
		expect(at(0)).toEqual([]);
		expect(at(1)).toEqual([]);
	});

	it("offers it plainly for a range still short enough to read", () => {
		const out = at(4).join("\n");
		expect(out).toContain("Name the commit by bisect:");
		expect(out).not.toContain("Too many to read?");
	});

	it("leads with 'too many to read' past the long-form threshold", () => {
		expect(at(20).join("\n")).toContain("Too many to read? Name the commit:");
	});

	it("hands over full shas, never abbreviations", () => {
		expect(at(4).join("\n")).toContain(
			`-f good=${ends.good} -f bad=${ends.bad}`,
		);
	});

	it("aims the command at the code repo where a repo flag is given (#1963)", () => {
		expect(
			range
				.bisectAdvice(
					{ ok: true, count: 4, commits: [], truncated: 0 },
					{ ...ends, repoFlag: " --repo o/code" },
				)
				.join("\n"),
		).toContain(`-f bad=${ends.bad} --repo o/code`);
	});

	it("still offers one when the range could not be read at all", () => {
		const out = range
			.bisectAdvice({ ok: false, reason: "no such commit" }, ends)
			.join("\n");
		expect(out).toContain("gh workflow run bisect.yml");
	});

	it("warns that a flaky test makes the answer wrong, not merely unhelpful", () => {
		expect(at(4).join("\n")).toContain("wrong rather than merely");
	});
});
