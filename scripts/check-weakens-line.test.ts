// @vitest-environment node
/*
 * check-weakens-line.js refuses a commit that weakens a check unless its
 * message names each weakening on a `Weakens:` line (#2235). A case loosened
 * here lets a disabled guard, a dropped CI step or a skipped test land inside
 * a large commit unseen (#2203).
 *
 * Each case commits through a real commit-msg hook in a throwaway repo, the
 * seam .husky/commit-msg calls the checker from, because a pathspec commit,
 * commit-paths.js's route, hands the hook a temporary index through
 * GIT_INDEX_FILE that no in-process run would read.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initGitRepo, mkScratchDir } from "./lib/git-fixture";

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(__dirname, "check-weakens-line.js");
const RULE = fs
	.readFileSync(
		path.join(ROOT, "docs", "agents", "rules", "weakens-line.txt"),
		"utf8",
	)
	.trimEnd();

let dir: string;
let hooks: string;

const write = (file: string, body: string) => {
	fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
	fs.writeFileSync(path.join(dir, file), body);
};

/** process.env less any gate stand-down a developer has exported, which
 * every fixture commit would otherwise be refused for naming nowhere. */
const ENV = Object.fromEntries(
	Object.entries(process.env).filter(([k]) => !/^WFC_[A-Z0-9_]+_OFF$/.test(k)),
);

const gitWith = (env: Record<string, string>, ...args: string[]) =>
	spawnSync("git", args, {
		cwd: dir,
		encoding: "utf8",
		env: { ...ENV, WFC_PLUGIN_ROOT: ROOT, ...env },
	});
const git = (...args: string[]) => gitWith({}, ...args);

/** Stages every change in the tree and commits it with `message`, `env` added. */
const commit = (message: string, env: Record<string, string> = {}) => {
	git("add", "-A");
	const file = path.join(hooks, "..", `${path.basename(hooks)}-msg`);
	fs.writeFileSync(file, message);
	const r = gitWith(env, "commit", "-q", "-F", file);
	fs.rmSync(file, { force: true });
	return { status: r.status, out: r.stdout + r.stderr };
};

/** Commits the tree as HEAD, with no weakening judged against it. */
const seed = () => {
	const r = commit("seed");
	expect(r.status, r.out).toBe(0);
};

const expectRefused = (
	r: { status: number | null; out: string },
	...names: string[]
) => {
	expect(r.status).toBe(1);
	for (const name of names) expect(r.out).toContain(`Weakens: ${name}`);
	expect(r.out).toContain(RULE);
};

const CONFIG = ".claude/workflow-core.json";
const config = (body: object) => `${JSON.stringify(body, null, "\t")}\n`;

const workflow = (...steps: string[]) =>
	[
		"name: ci",
		"on: push",
		"jobs:",
		"  ci:",
		"    runs-on: ubuntu-latest",
		"    steps:",
		...steps,
		"",
	].join("\n");
const step = (name: string, run: string) =>
	`      - name: ${name}\n        run: ${run}`;

const LINT = step("Lint", "node scripts/check-foo.js");
const SUITE = step("Suite", "npm run test -- --full=coverage");

const TEST_FILE = "scripts/a.test.ts";
const testFile = (...lines: string[]) =>
	['import { it, expect } from "vitest";', ...lines, ""].join("\n");

beforeEach(() => {
	dir = mkScratchDir("weakens-line-");
	hooks = mkScratchDir("weakens-line-hooks-");
	fs.writeFileSync(
		path.join(hooks, "commit-msg"),
		`#!/bin/sh\nexec node ${JSON.stringify(SCRIPT)} "$1"\n`,
		{ mode: 0o755 },
	);
	initGitRepo(dir, hooks);
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
	fs.rmSync(hooks, { recursive: true, force: true });
});

describe("check-weakens-line (#2235)", () => {
	it.each<{ case: string; before: object; after: object; name: string }>([
		{
			case: "a disabled entry added",
			before: { modules: ["suites"] },
			after: { modules: ["suites"], disabled: ["guard-x.sh"] },
			name: "guard-x.sh",
		},
		{
			case: "a module dropped",
			before: { modules: ["suites", "roadmap"] },
			after: { modules: ["roadmap"] },
			name: "suites",
		},
	])(
		"refuses $case from the config until a Weakens: line names it",
		({ before, after, name }) => {
			write(CONFIG, config(before));
			seed();
			write(CONFIG, config(after));
			expectRefused(commit("turn it off"), name);
			expect(
				commit(`turn it off\n\nWeakens: ${name} — breaks #1\n`).status,
			).toBe(0);
		},
	);

	it.each<{ case: string; after: string[]; name: string }>([
		{
			case: "a check script's step removed",
			after: [SUITE],
			name: "check-foo.js",
		},
		{
			case: "a check script's step commented out",
			after: [
				LINT.split("\n")
					.map((l) => `#${l}`)
					.join("\n"),
				SUITE,
			],
			name: "check-foo.js",
		},
		{
			case: "the test command's step removed",
			after: [LINT],
			name: "npm run test",
		},
	])(
		"refuses $case from a workflow until a Weakens: line names it",
		({ after, name }) => {
			write(".github/workflows/ci.yml", workflow(LINT, SUITE));
			seed();
			write(".github/workflows/ci.yml", workflow(...after));
			expectRefused(commit("trim ci"), name);
			expect(commit(`trim ci\n\nWeakens: ${name} — flaky, #1\n`).status).toBe(
				0,
			);
		},
	);

	it("passes a workflow whose gate steps are reordered and renamed, every command still run", () => {
		write(".github/workflows/ci.yml", workflow(LINT, SUITE));
		seed();
		write(
			".github/workflows/ci.yml",
			workflow(SUITE, step("Lint the scripts", "node scripts/check-foo.js")),
		);
		expect(commit("reorder ci").status).toBe(0);
	});

	it("refuses a deleted workflow, naming every gate command it ran", () => {
		write(".github/workflows/ci.yml", workflow(LINT, SUITE));
		seed();
		fs.rmSync(path.join(dir, ".github/workflows/ci.yml"));
		expectRefused(commit("drop ci"), "check-foo.js", "npm run test");
	});

	it.each([
		["it.skip", '\tit.skip("b", () => expect(1).toBe(1));'],
		["describe.skipIf", 'describe.skipIf(!process.env.CI)("b", () => {});'],
	])(
		"refuses a %s added to a test file HEAD holds until a Weakens: line names it",
		(_, line) => {
			write(TEST_FILE, testFile('it("a", () => expect(1).toBe(1));'));
			seed();
			write(TEST_FILE, testFile('it("a", () => expect(1).toBe(1));', line));
			expectRefused(commit("skip it"), "a.test.ts");
			expect(commit("skip it\n\nWeakens: a.test.ts — hangs, #1\n").status).toBe(
				0,
			);
		},
	);

	it("refuses a skip added to a .spec. test file HEAD holds, naming it (#2271)", () => {
		const spec = "src/a.spec.ts";
		write(spec, testFile('it("a", () => expect(1).toBe(1));'));
		seed();
		write(spec, testFile('it.skip("a", () => expect(1).toBe(1));'));
		expectRefused(commit("skip it"), "a.spec.ts");
	});

	it.each([
		["mark.skip", '@pytest.mark.skip(reason="x")\n'],
		["mark.xfail", "@pytest.mark.xfail\n"],
		["a module-wide pytestmark", 'pytestmark = pytest.mark.skip(reason="x")\n'],
	])(
		"refuses a pytest %s added to a Python test file HEAD holds until a Weakens: line names it",
		(_, line) => {
			write("scripts/test_a.py", "def test_a():\n    assert True\n");
			seed();
			write(
				"scripts/test_a.py",
				`import pytest\n\n${line}def test_a():\n    assert True\n`,
			);
			expectRefused(commit("skip it"), "test_a.py");
			expect(commit("skip it\n\nWeakens: test_a.py — hangs, #1\n").status).toBe(
				0,
			);
		},
	);

	it.each([
		[
			"a longer file name holding it",
			"a.test.ts",
			"Weakens: data.test.ts — #1",
		],
		[
			"a longer command holding it",
			"npm run test",
			"Weakens: npm run test:py — #1",
		],
	])("refuses where the Weakens: line names only %s", (_, name, line) => {
		if (name === "a.test.ts") {
			write(TEST_FILE, testFile('it("a", () => expect(1).toBe(1));'));
			seed();
			write(TEST_FILE, testFile('it.skip("a", () => expect(1).toBe(1));'));
		} else {
			write(".github/workflows/ci.yml", workflow(LINT, SUITE));
			seed();
			write(".github/workflows/ci.yml", workflow(LINT));
		}
		expectRefused(commit(`weaken\n\n${line}\n`), name);
	});

	it("judges a pathspec commit's temporary index, as commit-paths.js commits", () => {
		write(CONFIG, config({ modules: ["suites"] }));
		write("b.md", "b\n");
		seed();
		write(CONFIG, config({ modules: [] }));
		write("b.md", "c\n");
		git("add", "b.md");
		const r = git("commit", "-q", "-m", "off", "--", CONFIG);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("Weakens: suites");
	});

	it("refuses a skip added under a rename, naming the new file", () => {
		/* Enough unchanged lines that git still pairs the two as a rename. */
		const cases = ["b", "c", "d", "e"].map(
			(n) => `it("${n}", () => expect(1).toBe(1));`,
		);
		write(TEST_FILE, testFile('it("a", () => expect(1).toBe(1));', ...cases));
		seed();
		fs.rmSync(path.join(dir, TEST_FILE));
		write(
			"scripts/b.test.ts",
			testFile('it.skip("a", () => expect(1).toBe(1));', ...cases),
		);
		expectRefused(commit("rename and skip"), "b.test.ts");
	});

	it("passes a new test file's own skipIf on a tool's presence", () => {
		write(
			TEST_FILE,
			testFile('describe.skipIf(!hasGh)("gh", () => { it("a", () => {}); });'),
		);
		expect(commit("add a test").status).toBe(0);
	});

	it("passes a skip quoted inside a test's own fixture string", () => {
		write(TEST_FILE, testFile('it("a", () => expect(1).toBe(1));'));
		seed();
		write(
			TEST_FILE,
			testFile('it("a", () => expect("it.skip(").toBe("it.skip("));'),
		);
		expect(commit("quote a skip").status).toBe(0);
	});

	it("refuses mantahostels 59c506122's shape: a new config disabling a guard and a CI check dropped, its prose naming no Weakens: line (#2203)", () => {
		write(
			".github/workflows/ci.yml",
			workflow(
				LINT,
				step("Snapshots", "node scripts/check-snapshot-restatements.js"),
			),
		);
		seed();
		write(".github/workflows/ci.yml", workflow(LINT));
		write(
			CONFIG,
			config({ modules: ["roadmap"], disabled: ["guard-vitest-wrapper.sh"] }),
		);
		const r = commit(
			"Run the agent workflow from the pinned release\n\nDeclined core guard: guard-vitest-wrapper.sh, in .claude/workflow-core.json's `disabled` — it would refuse each one.\n",
		);
		expectRefused(
			r,
			"guard-vitest-wrapper.sh",
			"check-snapshot-restatements.js",
		);
	});

	it("passes where one Weakens: line of two names one weakening and the other names the rest", () => {
		write(CONFIG, config({ modules: ["suites", "roadmap"] }));
		seed();
		write(CONFIG, config({ modules: [], disabled: ["guard-x.sh"] }));
		const r = commit(
			"off\n\nWeakens: guard-x.sh — #1\nWeakens: suites and roadmap — #2\n",
		);
		expect(r.status).toBe(0);
	});

	it("names only the weakening a Weakens: line leaves out", () => {
		write(CONFIG, config({ modules: ["suites"] }));
		seed();
		write(CONFIG, config({ modules: [], disabled: ["guard-x.sh"] }));
		const r = commit("off\n\nWeakens: guard-x.sh — #1\n");
		expectRefused(r, "suites");
		expect(r.out).not.toContain("Weakens: guard-x.sh — <why>");
	});

	it("refuses a commit run under a gate's WFC_<NAME>_OFF stand-down until a Weakens: line names the variable, and passes one set empty (#2394)", () => {
		const off = (v: string) => ({ WFC_UPSTREAM_RECORD_OFF: v });
		write("notes.md", "a\n");
		seed();
		write("notes.md", "b\n");
		expect(commit("empty", off("")).status).toBe(0);
		write("notes.md", "c\n");
		expectRefused(commit("lock", off("1")), "WFC_UPSTREAM_RECORD_OFF");
		expect(
			commit(
				"lock\n\nWeakens: WFC_UPSTREAM_RECORD_OFF — GitHub down, #1\n",
				off("1"),
			).status,
		).toBe(0);
	});

	it("passes a repo's first commit, which has no HEAD to weaken", () => {
		const fresh = mkScratchDir("weakens-line-fresh-");
		try {
			const run = (...args: string[]) =>
				spawnSync("git", args, { cwd: fresh, encoding: "utf8" });
			run("init", "-q", "-b", "main", ".");
			run("config", "user.email", "test@example.com");
			run("config", "user.name", "test");
			run("config", "core.hooksPath", hooks);
			fs.mkdirSync(path.join(fresh, ".claude"));
			fs.writeFileSync(
				path.join(fresh, CONFIG),
				config({ disabled: ["guard-x.sh"] }),
			);
			run("add", "-A");
			const r = run("commit", "-qm", "init");
			expect(r.status).toBe(0);
			expect(r.stdout + r.stderr).toContain(
				"no HEAD, so nothing existed to weaken",
			);
		} finally {
			fs.rmSync(fresh, { recursive: true, force: true });
		}
	});
	it("refuses, naming git, where WFC_GIT names a git that exits 1 (#2864)", () => {
		const shim = path.join(hooks, "git");
		fs.writeFileSync(shim, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
		write("b.md", "b\n");
		const r = commit("b", { WFC_GIT: shim });
		expect(r.status, r.out).toBe(1);
		expect(r.out).toContain("git rev-parse HEAD would not answer");
	});
});

describe(".husky/commit-msg runs check-weakens-line.js (#2235)", () => {
	beforeEach(() => {
		/* Husky runs its hook files through sh; git's own copy is not executable. */
		fs.writeFileSync(
			path.join(hooks, "commit-msg"),
			`#!/bin/sh\nexec sh ${JSON.stringify(path.join(ROOT, ".husky", "commit-msg"))} "$1"\n`,
			{ mode: 0o755 },
		);
	});

	it("refuses an unnamed weakening on an ordinary commit", () => {
		write(CONFIG, config({ modules: ["suites"] }));
		seed();
		write(CONFIG, config({ modules: [] }));
		expectRefused(commit("off"), "suites");
	});

	it("stands down on a merge, whose joined commits were judged on their own", () => {
		write(CONFIG, config({ modules: ["suites"] }));
		seed();
		git("checkout", "-q", "-b", "side");
		write(CONFIG, config({ modules: [] }));
		expect(commit("off\n\nWeakens: suites — #1\n").status).toBe(0);
		git("checkout", "-q", "main");
		write("b.md", "b\n");
		seed();
		const r = git("merge", "--no-ff", "-q", "-m", "merge side", "side");
		expect(r.status, r.stderr).toBe(0);
	});
});
