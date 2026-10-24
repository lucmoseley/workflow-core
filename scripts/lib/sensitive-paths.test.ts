// @vitest-environment node
/*
 * sensitive-paths.test.ts — the sensitive-path matcher (#1617, spec #1612).
 * Break it and a change to declared sensitive code gets the standard review,
 * an undeclared adopter reads as one that declared none, or a typo in the
 * declaration takes a hook down.
 *
 * Run in process against a throwaway host root whose config each case writes,
 * and once against this repo's own declaration, since that is what its hooks
 * read. The glob semantics are git's `:(glob)` pathspec, so a table of globs is
 * matched against a real repo by `git diff` and by the matcher, and any
 * disagreement fails: a hand-written expectation would only restate a reading.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initGitRepo } from "./git-fixture";
import { runInProcess } from "./run-in-process";

const SCRIPT = path.join(__dirname, "sensitive-paths.js");
const REPO_ROOT = path.join(__dirname, "..", "..");
/* The default focus, restated so a change to it fails here. */
const DEFAULT_FOCUS = "access control and money logic";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "sensitive-paths-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/** A fixture host root under `dir` whose config declares `sensitivePaths`. */
function host(sensitivePaths?: unknown) {
	const root = path.join(dir, "host");
	fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(root, ".claude", "workflow-core.json"),
		JSON.stringify({
			contract: 1,
			founder: "F",
			...(sensitivePaths === undefined ? {} : { sensitivePaths }),
		}),
	);
	return root;
}

function run(root: string, args: string[], stdin?: string) {
	const out = runInProcess(SCRIPT, args, {
		cwd: root,
		env: { ...process.env, CLAUDE_PROJECT_DIR: root },
		...(stdin === undefined ? {} : { stdin }),
	});
	return {
		code: out.status,
		json:
			out.status === 0 && !args.includes("--names")
				? JSON.parse(out.stdout)
				: null,
		stdout: out.stdout,
		stderr: out.stderr,
	};
}

const RLS = {
	name: "RLS",
	description: "who may read or write what",
	globs: ["supabase/migrations/**"],
	focus: "who can read or write what",
	examples: ["an RLS policy"],
	live: true,
};
const MONEY = {
	name: "money",
	description: "what a guest pays",
	globs: ["lib/pricing/*.ts"],
};
const REWARDS = { name: "rewards", description: "reward-code redemption" };

describe("sensitive-paths — the declaration state", () => {
	it("reads an undeclared key as absent, standard, with no areas", () => {
		expect(run(host(), ["supabase/migrations/1.sql"]).json).toEqual({
			state: "absent",
			tier: "standard",
			matched: [],
			globless: [],
		});
	});

	it("reads [] as declared none, standard, with no areas", () => {
		expect(run(host([]), ["supabase/migrations/1.sql"]).json).toEqual({
			state: "none",
			tier: "standard",
			matched: [],
			globless: [],
		});
	});
});

describe("sensitive-paths — matching", () => {
	it("escalates on a glob hit, naming the area with its declared focus, examples, live flag and the paths it matched", () => {
		const r = run(host([RLS, MONEY]), [
			"supabase/migrations/2026_rls.sql",
			"app/page.tsx",
		]);
		expect(r.json).toEqual({
			state: "declared",
			tier: "escalated",
			matched: [
				{
					name: "RLS",
					description: "who may read or write what",
					focus: "who can read or write what",
					examples: ["an RLS policy"],
					live: true,
					paths: ["supabase/migrations/2026_rls.sql"],
				},
			],
			globless: [],
		});
	});

	it("stays standard on a miss", () => {
		expect(
			run(host([RLS, MONEY]), ["app/page.tsx", "lib/pricing/x/deep.ts"]).json,
		).toEqual({
			state: "declared",
			tier: "standard",
			matched: [],
			globless: [],
		});
	});

	it("applies the default focus, no examples and live false to an area that declares none of them", () => {
		expect(run(host([MONEY]), ["lib/pricing/rate.ts"]).json.matched).toEqual([
			{
				name: "money",
				description: "what a guest pays",
				focus: DEFAULT_FOCUS,
				examples: [],
				live: false,
				paths: ["lib/pricing/rate.ts"],
			},
		]);
	});

	it("lists a globless area whatever the paths, and never escalates on it", () => {
		const r = run(host([REWARDS, MONEY]), ["lib/rewards/redeem.ts"]);
		expect(r.json).toMatchObject({
			tier: "standard",
			matched: [],
			globless: [
				{
					name: "rewards",
					description: "reward-code redemption",
					focus: DEFAULT_FOCUS,
					examples: [],
					live: false,
				},
			],
		});
	});

	it("reads NUL-separated paths from stdin with --stdin, as git diff -z writes them", () => {
		const r = run(
			host([RLS]),
			["--stdin"],
			"app/a.ts\0supabase/migrations/1.sql\0",
		);
		expect(r.json.matched[0].paths).toEqual(["supabase/migrations/1.sql"]);
	});

	it("names a path given twice once (#2529)", () => {
		const sql = "supabase/migrations/1.sql";
		const r = run(host([RLS]), [sql, "--stdin"], `${sql}\n`);
		expect(r.json.matched[0].paths).toEqual([sql]);
	});

	it("reads newline-separated paths from stdin with --stdin", () => {
		const r = run(
			host([RLS]),
			["--stdin"],
			"app/a.ts\nsupabase/migrations/1.sql\n",
		);
		expect(r.json.matched[0].paths).toEqual(["supabase/migrations/1.sql"]);
	});

	it("prints only the matched areas' names, one per line, with --names", () => {
		const r = run(host([RLS, MONEY, REWARDS]), [
			"--names",
			"lib/pricing/rate.ts",
			"supabase/migrations/1.sql",
		]);
		expect(r.code).toBe(0);
		expect(r.stdout).toBe("RLS\nmoney\n");
	});

	it("prints nothing with --names on a miss", () => {
		const r = run(host([RLS]), ["--names", "app/a.ts"]);
		expect(r.code).toBe(0);
		expect(r.stdout).toBe("");
	});
});

describe("sensitive-paths — a malformed declaration", () => {
	it("warns on each fault and still exits 0, keeping what it can read", () => {
		const r = run(
			host([
				{ description: "no name", globs: ["x/**"] },
				{ ...RLS, globs: ["supabase/migrations/**", 7], live: "yes" },
				{ ...RLS, description: undefined },
			]),
			["supabase/migrations/1.sql"],
		);
		expect(r.code).toBe(0);
		expect(r.stderr).toContain(
			'"sensitivePaths[0]" has no "name" string — entry dropped',
		);
		expect(r.stderr).toContain(
			'"sensitivePaths[1].globs[1]" is not a non-empty string — glob dropped',
		);
		expect(r.stderr).toContain(
			'"sensitivePaths[1].live" is not a boolean — read as its default',
		);
		expect(r.stderr).toContain('"sensitivePaths[2].name" repeats "RLS"');
		expect(r.stderr).toContain(
			'"sensitivePaths[2].description" is not a non-empty string — read as its default',
		);
		expect(r.json.tier).toBe("escalated");
		expect(r.json.matched.map((a: { live: boolean }) => a.live)).toEqual([
			false,
			true,
		]);
	});

	it("reads a sensitivePaths that is not an array as absent, and warns", () => {
		const r = run(host({ RLS }), ["supabase/migrations/1.sql"]);
		expect([r.code, r.json.state]).toEqual([0, "absent"]);
		expect(r.stderr).toContain(
			'"sensitivePaths" is not an array — read as its default',
		);
	});

	it("exits 2, BROKEN, on a config that does not parse", () => {
		const root = host();
		fs.writeFileSync(path.join(root, ".claude", "workflow-core.json"), "{");
		const r = run(root, ["a.ts"]);
		expect(r.code).toBe(2);
		expect(r.stderr).toMatch(/^BROKEN: .*does not parse/);
	});
});

describe("sensitive-paths — workflow-core's own declaration", () => {
	it("reports secret handling touched for a path under its globs", () => {
		const { json: m } = run(REPO_ROOT, ["scripts/lib/token-shapes.js"]);
		expect(m.tier).toBe("escalated");
		expect(m.matched).toMatchObject([
			{
				name: "secret handling",
				focus:
					"what secret slips past the scan or gets written where git keeps it",
				live: false,
			},
		]);
	});
});

const FILES = [
	"scripts/x.js",
	"scripts/lib/token-shapes.js",
	"scripts/lib/deep/y.js",
	"top.sql",
	"supabase/migrations/1.sql",
	"a/b/c/z.sql",
	"a/b.txt",
	"we*ird.js",
	"sc[r]ipts/q.js",
];
const GLOBS = [
	"scripts",
	"scripts/",
	"scripts/lib",
	"scrip",
	"a/b",
	"top.sql/",
	"./scripts/x.js",
	"scripts//x.js",
	"scripts/*",
	"s*",
	"*.sql",
	"**",
	"**/*.sql",
	"**/lib",
	"**/lib/**",
	"supabase/**",
	"a/**/z.sql",
	"a/**/b.txt",
	"a/**b.txt",
	"scripts/lib*",
	"a/?.txt",
	"scripts/l[i]b/*",
	"scripts/[!a]*",
	"scripts/[^a]*",
	"[[:alpha:]]op.sql",
	"we\\*ird.js",
	"a/***",
	"***/z.sql",
	"a/***/z.sql",
	"a/**\\/z.sql",
	"sc[r]ipts",
	"sc[r]ipts/q.js",
];

describe("sensitive-paths — parity with git's :(glob) pathspec", () => {
	it("matches every case exactly as git diff does", () => {
		const root = path.join(dir, "repo");
		const hooks = path.join(dir, "hooks");
		fs.mkdirSync(hooks);
		initGitRepo(root, hooks);
		for (const f of FILES) {
			fs.mkdirSync(path.join(root, path.dirname(f)), { recursive: true });
			fs.writeFileSync(path.join(root, f), "");
		}
		const git = (args: string[]) =>
			execFileSync("git", args, { cwd: root, encoding: "utf8" });
		git(["add", "-A"]);
		git(["commit", "-qm", "files"]);
		/* One declared area per glob, so a single run answers for all of them. */
		const { json } = run(
			host(GLOBS.map((g) => ({ name: g, description: g, globs: [g] }))),
			FILES,
		);
		const ours = (g: string) =>
			[
				...(json.matched.find((m: { name: string }) => m.name === g)?.paths ??
					[]),
			].sort();
		for (const g of GLOBS) {
			const byGit = git([
				"diff",
				"--name-only",
				"HEAD~1",
				"HEAD",
				"--",
				`:(glob)${g}`,
			])
				.split("\n")
				.filter(Boolean)
				.sort();
			expect([g, ours(g)]).toEqual([g, byGit]);
		}
	});
});
