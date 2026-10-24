// @vitest-environment node
/*
 * Pins that a removed or renamed helper export, entry point or command-line
 * part fails a minor release and passes only a major one carrying its
 * migration note, while an addition always passes (#463, #655).
 *
 * check-surface-contract.js diffs HEAD's helper-surface manifest against the one
 * at the last release tag, so each case tags a manifest, commits an edit to it
 * and plugin.json, and reads the verdict (#463) — in a throwaway repository,
 * since the checker reads commits and tags, never the working tree.
 *
 * It refuses the cut in `release-plugin.js` and runs as a CI step in
 * `.github/workflows/ci.yml`: loosen a case and a release can silently drop a
 * helper or flag an adopter was promised.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initGitRepo, mkScratchDir } from "./lib/git-fixture";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "check-surface-contract.js");
const MANIFEST = "scripts/lib/helper-surface.json";

let dir: string;
let repo: string;

const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const write = (rel: string, body: string) => {
	fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
	fs.writeFileSync(path.join(repo, rel), body);
};
const surface = (entryPoints: Record<string, string[]>) =>
	write(MANIFEST, JSON.stringify({ entryPoints }));
const version = (v: string) =>
	write(
		".claude-plugin/plugin.json",
		JSON.stringify({ name: "p", version: v }),
	);
const release = (tag: string) => {
	git("add", "--all");
	git("commit", "-qm", `cut ${tag}`);
	git("tag", "-a", tag, "-m", tag);
};

/* Sequential: run-in-process.js patches the process globally per call. */
const check = () => {
	git("add", "--all");
	git("commit", "-qm", "edit", "--allow-empty");
	const env = { ...process.env, CLAUDE_PROJECT_DIR: repo };
	const r = runInProcess(SCRIPT, [], { cwd: repo, env });
	const j = runInProcess(SCRIPT, ["--json"], { cwd: repo, env });
	return {
		status: r.status,
		out: `${r.stdout}${r.stderr}`,
		keys: JSON.parse(j.stdout).keys as string[],
	};
};

const V1 = { "scripts/lib/a.js": ["one", "two"], "scripts/lib/b.sh": ["b_fn"] };

beforeEach(() => {
	dir = mkScratchDir("surface-contract-test-");
	repo = path.join(dir, "repo");
	fs.mkdirSync(path.join(dir, "no-hooks"));
	initGitRepo(repo, path.join(dir, "no-hooks"));
	surface(V1);
	version("1.0.0");
	release("v1.0.0");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("check-surface-contract", () => {
	it("passes an added export and an added entry point, bumped or not", () => {
		surface({
			...V1,
			"scripts/lib/a.js": ["one", "two", "three"],
			"scripts/lib/c.js": ["c"],
		});
		for (const v of ["1.0.0", "1.0.1", "1.1.0", "2.0.0"]) {
			version(v);
			const r = check();
			expect(r.status).toBe(0);
			expect(r.out).toMatch(
				/OK: .*keeps every export v1\.0\.0 promised, and adds 2/,
			);
		}
	});

	it("fails a removed export on a minor cut, naming it", () => {
		surface({ ...V1, "scripts/lib/a.js": ["one"] });
		version("1.1.0");
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("scripts/lib/a.js no longer lists two");
		expect(r.out).toContain(
			"Either restore the entries, or bump plugin.json to the next major and\nwrite migrations/v1.1.0.md",
		);
		expect(r.keys).toEqual(["removed:scripts/lib/a.js#two"]);
	});

	it("fails a renamed export on a minor cut, as a removal keyed to the old export, naming both versions", () => {
		surface({ ...V1, "scripts/lib/a.js": ["one", "twoRenamed"] });
		version("1.1.0");
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			"a rename\nreads as a removal. v1.1.0 is not a major bump over v1.0.0",
		);
		expect(r.keys).toEqual(["removed:scripts/lib/a.js#two"]);
	});

	it("fails a removed entry point on a minor cut, naming the file", () => {
		surface({ "scripts/lib/a.js": ["one", "two"] });
		version("1.1.0");
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			"scripts/lib/b.sh is no longer a surface entry point",
		);
		expect(r.keys).toEqual(["removed:scripts/lib/b.sh"]);
	});

	it("passes a removal and a rename on a major cut carrying its migration note", () => {
		surface({ "scripts/lib/a.js": ["one", "twoRenamed"] });
		version("2.0.0");
		write("migrations/v2.0.0.md", "# v2.0.0\n");
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toMatch(
			/OK: v2\.0\.0 is a major bump over v1\.0\.0 carrying migrations\/v2\.0\.0\.md/,
		);
	});

	it("fails a removal and a rename on a major cut with no migration note, naming the missing note", () => {
		surface({ "scripts/lib/a.js": ["oneRenamed"] });
		version("2.0.0");
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("ships no migrations/v2.0.0.md");
		expect(r.keys).toEqual([
			"removed:scripts/lib/a.js#one",
			"removed:scripts/lib/a.js#two",
			"removed:scripts/lib/b.sh",
		]);
	});

	it("judges against the highest tag, reading v1.10.0 above v1.9.0", () => {
		version("1.9.0");
		release("v1.9.0");
		surface({ ...V1, "scripts/lib/a.js": ["one", "two", "ten"] });
		version("1.10.0");
		release("v1.10.0");
		surface(V1);
		version("1.10.1");
		const r = check();
		expect(r.status).toBe(1);
		expect(r.out).toContain("v1.10.1 is not a major bump over v1.10.0");
		expect(r.keys).toEqual(["removed:scripts/lib/a.js#ten"]);
	});

	it("skips where no release has been tagged", () => {
		git("tag", "-d", "v1.0.0");
		surface({});
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toMatch(/SKIP: no release tag yet/);
	});

	it("skips where the last release carried no manifest", () => {
		git("rm", "-q", MANIFEST);
		version("1.0.1");
		release("v1.0.1");
		surface({});
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toMatch(
			/SKIP: v1\.0\.1 ships no scripts\/lib\/helper-surface\.json/,
		);
	});

	it("skips a repo declaring no surface", () => {
		fs.rmSync(path.join(repo, MANIFEST));
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toMatch(/SKIP: this repo declares no helper surface/);
	});

	describe("a listed command's argv contract (#655)", () => {
		const cmd = "scripts/x.js";
		const X = {
			positionals: [{ name: "profile", values: ["a", "b"] }, { name: "file" }],
			flags: [{ name: "--data-file" }, { name: "--no-claim" }],
			exit: { 0: "ok", 1: "refused" },
		};
		const commands = (c: Record<string, unknown>) =>
			write(MANIFEST, JSON.stringify({ entryPoints: V1, commands: c }));

		beforeEach(() => {
			commands({ [cmd]: X });
			version("1.0.1");
			release("v1.0.1");
		});

		it("passes an added flag, positional value, trailing positional and command on a minor cut", () => {
			commands({
				[cmd]: {
					positionals: [
						{ name: "profile", values: ["a", "b", "c"] },
						{ name: "file" },
						{ name: "extra" },
					],
					flags: [...X.flags, { name: "--new" }],
					exit: { ...X.exit, 2: "broken" },
				},
				"scripts/y.js": { positionals: [], flags: [], exit: {} },
			});
			version("1.1.0");
			expect(check().status).toBe(0);
		});

		it("fails each dropped part on a minor cut, naming it", () => {
			commands({
				[cmd]: {
					positionals: [{ name: "file" }, { name: "profile" }],
					flags: [{ name: "--no-claim" }],
					exit: { 0: "ok" },
				},
			});
			version("1.1.0");
			const r = check();
			expect(r.status).toBe(1);
			expect(r.out).toContain(
				"scripts/x.js no longer takes profile as positional 1",
			);
			expect(r.out).toContain(
				"scripts/x.js no longer lists the flag --data-file",
			);
			expect(r.keys).toEqual([
				"removed:scripts/x.js#--data-file",
				"removed:scripts/x.js#exit:1",
				"removed:scripts/x.js#positional:file",
				"removed:scripts/x.js#positional:profile",
			]);
		});

		it("fails a dropped positional value and a dropped command, naming each", () => {
			commands({});
			version("1.1.0");
			const gone = check();
			expect(gone.status).toBe(1);
			expect(gone.out).toContain("scripts/x.js is no longer a surface command");
			expect(gone.keys).toEqual(["removed:scripts/x.js"]);
			commands({
				[cmd]: {
					...X,
					positionals: [{ name: "profile", values: ["a"] }, { name: "file" }],
				},
			});
			expect(check().keys).toEqual(["removed:scripts/x.js#profile=b"]);
		});

		it("passes a dropped command on a major cut carrying its migration note", () => {
			commands({});
			version("2.0.0");
			write("migrations/v2.0.0.md", "# v2.0.0\n");
			expect(check().status).toBe(0);
		});

		it("is broken on a command with no positionals list", () => {
			commands({ [cmd]: { flags: [], exit: {} } });
			const r = check();
			expect(r.status).toBe(2);
			expect(r.out).toMatch(/BROKEN: .*commands are not each/);
		});
	});

	it("is broken on a manifest with no entryPoints object", () => {
		write(MANIFEST, JSON.stringify({ entryPoints: ["scripts/lib/a.js"] }));
		const r = check();
		expect(r.status).toBe(2);
		expect(r.out).toMatch(
			/BROKEN: scripts\/lib\/helper-surface\.json has no entryPoints object/,
		);
	});
});
