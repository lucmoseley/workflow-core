// @vitest-environment node
/*
 * concision-scope.test.ts — concision-scope.js turns steps 1 and 2 of the
 * concision-pass skill into arithmetic, so the whole correctness question is
 * the arithmetic and the boundary (mantahostels#1147, the ticket that scripted it).
 * Break it and step 1 records a wrong net-words figure, or the pass reads a
 * diff that is missing additions.
 *
 * Black-box, in a throwaway repo, per docs/code-standards-base.md §X3: the figure
 * comes out of real `git diff` output, never a hand-built fixture, because a
 * fixture would stop pinning the one thing that can drift — what git actually
 * prints.
 *
 * Every fail-closed case is paired with a positive case proving the ordinary
 * path still counts and still exits 0.
 *
 * MUTATIONS RUN (mantahostels#1114 limb 4): `net` made to ignore removed words;
 * the floor made exclusive; the unresolved path made to report a zero; the
 * hunk-start scan made a `+++`/`---` prefix test again. Each turned exactly one
 * case below red, and was reversed by its inverse edit. For the diff section
 * (#582): the cap check removed (over-cap case); the cap made inclusive (at-cap
 * and untracked cases); the diffs printed in reverse (order case); an untracked
 * file's body charged to the cap; an unresolved path listed as untracked; the
 * section printed with no diff; a table row's padding widened (byte-identical
 * case). Each turned the cases named, or its own, red, and was reversed.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "../../../../scripts/lib/run-in-process.js";

const SCOPE = path.resolve(__dirname, "concision-scope.js");

let repo: string;

const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: repo, encoding: "utf8" });

/** Writes `rel` in the throwaway repo, creating its directory. */
const write = (rel: string, body: string) => {
	fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
	fs.writeFileSync(path.join(repo, rel), body);
};

/** Stages `rel` and commits it, returning nothing — the sha is never needed. */
const commit = (rel: string | string[], message: string) => {
	git("add", "--", ...[rel].flat());
	git("commit", "-m", message);
};

/** Runs the script from inside the repo, as the skill does. */
const run = (...args: string[]) => {
	const r = runInProcess(SCOPE, args, { cwd: repo });
	return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

/** `n` distinct words, so a count is readable against the fixture. */
const filler = (n: number) =>
	Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

beforeEach(() => {
	repo = fs.mkdtempSync(path.join(os.tmpdir(), "concision-scope-"));
	git("init", "-b", "main");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "T");
	write("seed.md", "seed\n");
	commit("seed.md", "seed");
});

afterEach(() => {
	fs.rmSync(repo, { recursive: true, force: true });
});

describe("net words added, per file", () => {
	it("subtracts the words on removed lines from the words on added lines", () => {
		write("doc.md", `${filler(20)}\n`);
		commit("doc.md", "twenty words");
		const base = git("rev-parse", "HEAD").trim();
		write("doc.md", `${filler(30)}\n`);

		const { code, out } = run(base, "doc.md");

		expect(code).toBe(0);
		// The whole line changed, so the diff removes 20 and adds 30: net 10.
		expect(out).toContain("(+30 −20, diff)");
		expect(out).toMatch(/^\s+10\s+doc\.md/m);
	});

	it("scores a blank added line as nothing, where the session-wide backstop scores it as one word (mantahostels#1147)", () => {
		write("doc.md", "one\n");
		commit("doc.md", "one word");
		const base = git("rev-parse", "HEAD").trim();
		write("doc.md", "one\n\n\n\n\n");

		const { code, out } = run(base, "doc.md");

		expect(code).toBe(0);
		expect(out).toContain("(+0 −0, diff)");
	});

	it("counts a removed markdown rule, which a prefix test for the diff header swallows (mantahostels#1147)", () => {
		write("doc.md", "alpha\n---\nbeta\n");
		commit("doc.md", "a document with a horizontal rule");
		const base = git("rev-parse", "HEAD").trim();
		write("doc.md", "alpha\nbeta\n");

		const { code, out } = run(base, "doc.md");

		// The `---` line is removed content, not the diff's file header, so it
		// counts as one removed word: net −1.
		expect(code).toBe(0);
		expect(out).toContain("(+0 −1, diff)");
	});

	it("counts a brand-new untracked file whole, and says that is what it did", () => {
		write("new.md", `${filler(7)}\n`);

		const { code, out } = run("HEAD", "new.md");

		expect(code).toBe(0);
		expect(out).toContain("untracked, counted whole");
		expect(out).toMatch(/^\s+7\s+new\.md/m);
	});

	it("reports zero for a tracked file this change never touched", () => {
		write("doc.md", `${filler(20)}\n`);
		commit("doc.md", "twenty words");

		const { code, out } = run("HEAD", "doc.md");

		expect(code).toBe(0);
		expect(out).toContain("unchanged");
		expect(out).toMatch(/^\s+0\s+doc\.md/m);
	});
});

describe("the 150-word floor", () => {
	it("sends a file at exactly 150 net words to a fresh reader", () => {
		write("doc.md", `${filler(150)}\n`);

		const { code, out } = run("HEAD", "doc.md");

		expect(code).toBe(0);
		expect(out).toContain(
			"at or over 150 → step 3: send this file to a fresh reader",
		);
		expect(out).toContain("1 at or over the 150 floor");
	});

	it("keeps a file at 149 net words in the session", () => {
		write("doc.md", `${filler(149)}\n`);

		const { code, out } = run("HEAD", "doc.md");

		expect(code).toBe(0);
		expect(out).toContain("under 150 → step 2: read the additions yourself");
		expect(out).toContain("0 at or over the 150 floor");
	});
});

describe("fails closed rather than reporting a quiet zero (mantahostels#1147)", () => {
	it("reports a path that is neither in the diff nor on disk as unresolved, and exits 3", () => {
		write("real.md", `${filler(200)}\n`);

		const { code, out } = run("HEAD", "real.md", "typo.md");

		expect(code).toBe(3);
		expect(out).toContain("UNRESOLVED");
		expect(out).toContain("typo.md");
		expect(out).toContain("check the path");
		// The path that IS resolvable is still counted — a bad path costs its
		// neighbours nothing.
		expect(out).toContain("at or over 150");
	});

	it("exits 0 when every named path resolves", () => {
		write("real.md", `${filler(200)}\n`);

		const { code, out } = run("HEAD", "real.md");

		expect(code).toBe(0);
		expect(out).not.toContain("UNRESOLVED");
	});

	it("refuses a fixed point git cannot resolve, and names the way out for a baseline file", () => {
		const { code, out } = run("docs/baseline.md", "seed.md");

		expect(code).toBe(1);
		expect(out).toContain("is not a commit this repository can resolve");
		expect(out).toContain("diff it yourself and count");
	});

	it("refuses an invocation naming no paths, and says why a repo-wide figure is wrong", () => {
		const { code, out } = run("HEAD");

		expect(code).toBe(1);
		expect(out).toContain("usage: concision-scope.js <fixed-point> <path>...");
		expect(out).toContain("parallel session");
	});
});

describe("the diff it counted from, printed after the total (#582)", () => {
	/** The total line, which the diff section must follow. */
	const totalLine = /net words added across \d+ path\(s\)/;

	/** Size of what `git diff` prints for one path. */
	const diffBytes = (base: string, rel: string) =>
		Buffer.byteLength(git("diff", base, "--", rel));

	/**
	 * Commits an empty `doc.md` and rewrites it as one line sized so the diff
	 * against that commit is exactly `target` bytes, measured off a probe.
	 */
	const diffOfSize = (target: number) => {
		write("doc.md", "");
		commit("doc.md", "empty");
		const base = git("rev-parse", "HEAD").trim();
		write("doc.md", "x\n");
		const header = diffBytes(base, "doc.md") - 2;
		write("doc.md", `${"x".repeat(target - header - 1)}\n`);
		expect(diffBytes(base, "doc.md")).toBe(target);
		return base;
	};

	it("prints each named path's diff, in the order named, after the total line", () => {
		write("a.md", "alpha\n");
		write("b.md", "beta\n");
		write("c.md", "gamma\n");
		commit(["a.md", "b.md", "c.md"], "three");
		const base = git("rev-parse", "HEAD").trim();
		write("a.md", "alpha one\n");
		write("b.md", "beta two\n");
		write("c.md", "gamma three\n");

		const { code, out } = run(base, "b.md", "a.md");

		expect(code).toBe(0);
		const tail = out.slice(out.search(totalLine));
		expect(tail).toContain(`Diff against ${base}`);
		expect(tail).toContain("+beta two");
		expect(tail).toContain("+alpha one");
		expect(tail.indexOf("+beta two")).toBeLessThan(tail.indexOf("+alpha one"));
		// Only the named paths — c.md changed too, but was not named.
		expect(out).not.toContain("gamma");
	});

	it("prints the diff at exactly the 24,000-byte cap", () => {
		const base = diffOfSize(24_000);

		const { code, out } = run(base, "doc.md");

		expect(code).toBe(0);
		expect(out).toContain("(24000 bytes)");
		expect(out).toContain("+xxxx");
		expect(out).not.toContain("withheld");
	});

	it("withholds the whole diff one byte over the cap, naming the files, size, cap and command", () => {
		const base = diffOfSize(24_001);

		const { code, out } = run(base, "doc.md");

		expect(code).toBe(0);
		expect(out).toContain(
			"Diff withheld: 24001 bytes across 1 file(s), over the 24000-byte cap.",
		);
		expect(out).toContain(`Read it with: git diff ${base} -- doc.md`);
		expect(out).not.toContain("+xxxx");
		expect(out).not.toMatch(/^@@/m);
	});

	it("lists an untracked path to read whole, and charges it nothing against the cap", () => {
		const base = diffOfSize(24_000);
		write("new.md", `${"y".repeat(5000)}\n`);

		const { code, out } = run(base, "doc.md", "new.md");

		expect(code).toBe(0);
		expect(out).toContain("untracked, read the file whole: new.md");
		// The tracked diff alone sits at the cap, so it still prints.
		expect(out).toContain("(24000 bytes)");
		expect(out).not.toContain("withheld");
	});

	it("prints no diff for an unresolved path, and still exits 3", () => {
		write("real.md", "real\n");
		commit("real.md", "real");
		const base = git("rev-parse", "HEAD").trim();
		write("real.md", "real edit\n");

		const { code, out } = run(base, "real.md", "typo.md");

		expect(code).toBe(3);
		expect(out).toContain("+real edit");
		expect(out).not.toMatch(/diff --git a\/typo\.md/);
		expect(out).not.toContain("read the file whole: typo.md");
	});

	it("prints no diff section for a path with no changes", () => {
		const { code, out } = run("HEAD", "seed.md");

		expect(code).toBe(0);
		expect(out.slice(out.search(totalLine))).not.toContain("\n\n");
	});

	it("leaves the table and total lines byte-identical to the format before the diff section", () => {
		write("doc.md", "one two\n");
		commit("doc.md", "two words");
		const base = git("rev-parse", "HEAD").trim();
		write("doc.md", "one two three\n");

		const { out } = run(base, "doc.md");

		expect(out.split("\n").slice(0, 3).join("\n")).toBe(
			"       1  doc.md  (+3 −2, diff)  under 150 → step 2: read the additions yourself, then step 5\n" +
				"\n" +
				`       1  net words added across 1 path(s) against ${base}; 0 at or over the 150 floor`,
		);
	});
});
