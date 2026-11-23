// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildBisectAdvice,
	countRange,
	readRange,
	renderRange,
} from "./commit-range.js";
import { writeFaultyGit } from "./git-fault-fake";
import { defineTemplate, identityRepoTemplate } from "./git-fixture";

type Read = ReturnType<typeof readRange>;
type Listed = Extract<Read, { ok: true }>;
type Refused = Extract<Read, { ok: false }>;

let dir: string;

const git = (args: string[], cwd = dir) =>
	execFileSync("git", args, { encoding: "utf8", cwd }).trim();

function commit(subject: string, files: Record<string, string>) {
	for (const [p, body] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
		fs.writeFileSync(path.join(dir, p), body);
	}
	git(["add", "-A"]);
	git(["commit", "-m", subject]);
	return git(["rev-parse", "HEAD"]);
}

const configuredRepo = defineTemplate(identityRepoTemplate);

beforeEach(() => {
	dir = configuredRepo.instantiate(
		fs.mkdtempSync(path.join(os.tmpdir(), "commit-range-")),
	);
});

describe("readRange names every commit and the files it touched (mantahostels#945)", () => {
	it("returns the commits newest first, with their files", () => {
		const good = commit("base", { "a.txt": "1" });
		commit("second", { "b.txt": "1", "c/d.txt": "1" });
		const bad = commit("third", { "a.txt": "2" });

		const r = readRange({ good, bad, cwd: dir }) as Listed;
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
		const good = commit("base", { "a.txt": "1" });
		const bad = commit("has\ta tab in it", { "a.txt": "2" });

		const r = readRange({ good, bad, cwd: dir }) as Listed;
		expect(r.commits[0].subject).toBe("has\ta tab in it");
		expect(r.commits[0].files).toEqual(["a.txt"]);
	});

	it("counts an empty range as zero rather than failing", () => {
		const sha = commit("only", { "a.txt": "1" });

		const r = readRange({ good: sha, bad: sha, cwd: dir }) as Listed;
		expect(r).toMatchObject({ ok: true, count: 0, commits: [] });
	});

	it("reports how many it left unlisted when the range outruns the cap", () => {
		const good = commit("base", { "a.txt": "0" });
		let bad = good;
		for (let i = 1; i <= 5; i++) bad = commit(`c${i}`, { "a.txt": String(i) });

		const r = readRange({ good, bad, cwd: dir, maxListed: 2 }) as Listed;
		expect(r.count).toBe(5);
		expect(r.commits).toHaveLength(2);
		expect(r.truncated).toBe(3);
	});

	it("attributes a merge's files to the merge, not to each parent twice", () => {
		const good = commit("base", { "a.txt": "1" });
		git(["checkout", "-q", "-b", "side"]);
		commit("side work", { "side.txt": "1" });
		git(["checkout", "-q", "main"]);
		commit("main work", { "main.txt": "1" });
		git(["merge", "--no-ff", "-m", "merge side", "side"]);
		const bad = git(["rev-parse", "HEAD"]);

		const r = readRange({ good, bad, cwd: dir }) as Listed;
		expect(r.ok).toBe(true);
		expect(r.commits[0].subject).toBe("merge side");
		expect(r.commits[0].files).toEqual(["side.txt"]);
	});
});

describe("a range it cannot read is a reason, never a throw (mantahostels#945)", () => {
	it("names the missing end when this clone has never fetched a sha", () => {
		const bad = commit("only", { "a.txt": "1" });
		const absent = "0123456789abcdef0123456789abcdef01234567";

		const r = readRange({ good: absent, bad, cwd: dir }) as Refused;
		expect(r.ok).toBe(false);
		expect(r.reason).toContain("0123456");
		expect(r.reason).toContain("good end");
		expect(r.reason).toContain("git fetch origin");
	});

	it("names a git that will not answer as that failure, never a sha to fetch (#3152)", () => {
		const bad = commit("only", { "a.txt": "1" });
		const faulty = writeFaultyGit(
			{ words: ["rev-parse", "--verify"] },
			{ script: 'echo "fatal: index file corrupt" >&2\nexit 128' },
			{ under: dir },
		);
		vi.stubEnv("WFC_GIT", faulty.git);
		const r = readRange({ good: bad, bad, cwd: dir }) as Refused;
		expect(r.ok).toBe(false);
		expect(r.reason).toContain("git would not resolve");
		expect(r.reason).toContain("index file corrupt");
		expect(r.reason).not.toContain("git fetch origin");
	});

	it("refuses two tips that are not one line of history", () => {
		commit("base", { "a.txt": "1" });
		git(["checkout", "-q", "--orphan", "other"]);
		fs.rmSync(path.join(dir, "a.txt"));
		const bad = commit("unrelated", { "z.txt": "1" });
		const good = git(["rev-parse", "main"]);

		const r = readRange({ good, bad, cwd: dir }) as Refused;
		expect(r.ok).toBe(false);
		expect(r.reason).toContain("not an ancestor");
	});

	it("says there is no range when an end is missing altogether", () => {
		expect(readRange({ good: "", bad: "abc", cwd: dir }).ok).toBe(false);
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
		const out = renderRange(
			{ ok: true, count: 2, commits: commits(2), truncated: 0 },
			opts,
		).join("\n");

		expect(out).toContain("2 commit(s) since the last green run");
		expect(out).toContain("abc0  subject 0");
		expect(out).toContain("src/f0.ts");
		expect(out).not.toContain("file(s))");
	});

	it("switches to a per-commit count and an aggregate once it is long", () => {
		const out = renderRange(
			{ ok: true, count: 12, commits: commits(12, 3), truncated: 0 },
			opts,
		).join("\n");

		expect(out).toContain("(3 file(s))");
		expect(out).toContain("Most-touched files in the range:");
		expect(out).toContain("12x  src/f0.ts");
	});

	it("says plainly that no commit is to blame when the range is empty", () => {
		const out = renderRange(
			{ ok: true, count: 0, commits: [], truncated: 0 },
			opts,
		).join("\n");

		expect(out).toContain("No commits between the last green run");
		expect(out).toContain("flakiness");
	});

	it("hands over the command for the commits it did not list", () => {
		const out = renderRange(
			{ ok: true, count: 200, commits: commits(2), truncated: 198 },
			opts,
		).join("\n");

		expect(out).toContain("and 198 more");
		expect(out).toContain("git log --oneline");
	});

	it("passes an unreadable range's reason through instead of a list", () => {
		const out = renderRange({ ok: false, reason: "no such commit" }, opts).join(
			"\n",
		);

		expect(out).toBe("Commit range unavailable: no such commit.");
	});
});

describe("countRange counts without paying for the file lists (mantahostels#945)", () => {
	it("returns just the number of commits between two shas", () => {
		const good = commit("base", { "a.txt": "1" });
		commit("second", { "b.txt": "1" });
		const bad = commit("third", { "c.txt": "1" });

		expect(countRange({ good, bad, cwd: dir })).toBe(2);
		expect(countRange({ good: bad, bad, cwd: dir })).toBe(0);
	});

	it("returns null for a pair that is not one line of history", () => {
		const bad = commit("only", { "a.txt": "1" });

		expect(countRange({ good: "0".repeat(40), bad, cwd: dir })).toBeNull();
		expect(countRange({ good: "", bad, cwd: dir })).toBeNull();
	});
});

describe("buildBisectAdvice offers a bisect only where it would help (mantahostels#945)", () => {
	const ends = { good: "g".repeat(40), bad: "b".repeat(40) };
	const at = (count: number) =>
		buildBisectAdvice({ ok: true, count, commits: [], truncated: 0 }, ends);

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
			buildBisectAdvice(
				{ ok: true, count: 4, commits: [], truncated: 0 },
				{ ...ends, repoFlag: " --repo o/code" },
			).join("\n"),
		).toContain(`-f bad=${ends.bad} --repo o/code`);
	});

	it("still offers one when the range could not be read at all", () => {
		const out = buildBisectAdvice(
			{ ok: false, reason: "no such commit" },
			ends,
		).join("\n");
		expect(out).toContain("gh workflow run bisect.yml");
	});

	it("warns that a flaky test makes the answer wrong, not merely unhelpful", () => {
		expect(at(4).join("\n")).toContain("wrong rather than merely");
	});
});
