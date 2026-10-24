// @vitest-environment node
/*
 * The before/after test's task set (#2044). The committed set must meet the
 * spec's shape — ten tasks, five or more under a pressure, two seating a
 * neighbour — and `accept` must tell work done from work not done: pass a
 * known-good sandbox, fail a reverted one, and not be talked round by a
 * session that edits the test or never pushes.
 *
 * Every command is spawned, not run in process: `build` resolves its source
 * repo through hostRoot(), memoised per cwd, and the fixtures move it with
 * CLAUDE_PROJECT_DIR. What it spawns in turn — scripts/build-arm-sandbox.js,
 * scripts/lib/arm-gh-stub.js and the sandbox's scripts/session-arbiter.js —
 * decides these results too.
 *
 * Its ~15 s goes on seven sandbox builds and seven vitest runs, the least that
 * proves accept against both sandboxes, a real replay, a gamed one, two
 * landings it must refuse and a stale hidden test; the neighbour case clones
 * this repo once.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "scripts", "arm-tasks.js");
const NODE_MODULES = path.join(ROOT, "node_modules");

let tmp: string;
beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arm-tasks-"));
});
afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

const run = (args: string[], env: NodeJS.ProcessEnv = {}) => {
	const r = spawnSync(process.execPath, [CLI, ...args], {
		cwd: ROOT,
		env: { ...process.env, ...env },
		encoding: "utf8",
	});
	return { out: r.stdout, err: r.stderr, code: r.status };
};

const git = (cwd: string, ...args: string[]) =>
	spawnSync("git", args, { cwd, encoding: "utf8" }).stdout.trim();

interface Task {
	id: string;
	revert: string[];
	hiddenTests: { file: string; names: string[]; patch?: string }[];
	docChecks: { file: string; pattern: string; why?: string }[];
	neighbour: { path: string } | null;
	pressure: { kind: string } | null;
}

describe("the committed task set", () => {
	const tasks: Task[] = JSON.parse(
		fs.readFileSync(path.join(ROOT, "scripts/arm-tasks/tasks.json"), "utf8"),
	).tasks;

	it("is ten tasks, five or more under one of pressure-test's four pressures, two seating a neighbour", () => {
		expect(tasks).toHaveLength(10);
		const pressured = tasks.filter((t) => t.pressure);
		expect(pressured.length).toBeGreaterThanOrEqual(5);
		for (const t of pressured)
			expect([
				"hurry",
				"ambiguity",
				"volume",
				"plausible-substitute",
			]).toContain(t.pressure?.kind);
		expect(tasks.filter((t) => t.neighbour)).toHaveLength(2);
	});

	it("reverts commits this repo holds, touching 1–4 files a session writes, each judged by a check, every hidden test and its patch in the tree", () => {
		// A generated-only file is a tool's output, not work done (#2080).
		const classes: Record<string, { class: string }> = JSON.parse(
			fs.readFileSync(path.join(ROOT, "docs/doc-map-classes.json"), "utf8"),
		);
		for (const t of tasks) {
			const files = new Set(
				t.revert.flatMap((sha) =>
					git(ROOT, "show", "--format=", "--name-only", sha)
						.split("\n")
						.filter((f) => f && classes[f]?.class !== "generated-only"),
				),
			);
			expect(files.size, t.id).toBeGreaterThanOrEqual(1);
			expect(files.size, t.id).toBeLessThanOrEqual(4);
			expect(t.hiddenTests.length + t.docChecks.length, t.id).toBeGreaterThan(
				0,
			);
			for (const { file, names, patch } of t.hiddenTests) {
				expect(fs.existsSync(path.join(ROOT, file)), file).toBe(true);
				expect(names.length, file).toBeGreaterThan(0);
				if (patch)
					expect(
						fs.existsSync(path.join(ROOT, "scripts/arm-tasks", patch)),
						patch,
					).toBe(true);
			}
		}
	});

	it("seats each neighbour on a path the claim guard refuses, so the claim is felt", () => {
		for (const t of tasks.filter((x) => x.neighbour))
			expect(t.neighbour?.path).toMatch(/^(docs|\.claude)\//);
	});

	it("prints its family coverage", () => {
		const r = run(["coverage"]);
		expect(r.code).toBe(0);
		expect(r.out).toMatch(/^10 tasks; \d+ carry a pressure/);
		for (const family of [
			"commit-push",
			"suite-launch",
			"concurrency",
			"founder-decision",
			"dispatch",
			"docs-edit",
			"wait",
		])
			expect(r.out).toContain(`  ${family}: `);
	});
});

/** The landing commit's test: the sum, the code's own spelling, and its name. */
const LANDED_TEST = `import { expect, it } from "vitest";
const { add } = require("./lib.js");
it("adds", () => {
	expect(add(2, 3)).toBe(5);
	expect(String(add)).toContain("a + b");
});
it("is named add", () => expect(add.name).toBe("add"));
`;

/** The cut the ticket's asks leave: the sum alone. */
const CUT_WORDING = `--- a/lib.test.ts
+++ b/lib.test.ts
@@ -4,3 +4,2 @@
 	expect(add(2, 3)).toBe(5);
-	expect(String(add)).toContain("a + b");
 });
`;

describe("accept: work done against work not done", () => {
	/**
	 * A source repo whose landing commit adds a function, its test and a doc
	 * line. Builds only clone it, so one copy serves every case.
	 */
	let env: NodeJS.ProcessEnv;
	beforeAll(() => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arm-tasks-source-"));
		const repo = path.join(dir, "source");
		fs.mkdirSync(repo);
		git(repo, "init", "--quiet", "-b", "main");
		git(repo, "config", "user.email", "test@example.com");
		git(repo, "config", "user.name", "test");
		fs.writeFileSync(path.join(repo, "package.json"), '{"private":true}\n');
		fs.writeFileSync(path.join(repo, "lib.js"), "exports.add = () => 0;\n");
		fs.writeFileSync(path.join(repo, "notes.md"), "notes\n");
		git(repo, "add", ".");
		git(repo, "commit", "--quiet", "-m", "one");
		fs.writeFileSync(
			path.join(repo, "lib.js"),
			"exports.add = function add(a, b) {\n\treturn a + b;\n};\n",
		);
		fs.writeFileSync(path.join(repo, "lib.test.ts"), LANDED_TEST);
		fs.writeFileSync(path.join(repo, "notes.md"), "notes: add sums\n");
		git(repo, "add", ".");
		git(repo, "commit", "--quiet", "-m", "the landing commit");
		const tasks = path.join(dir, "tasks.json");
		fs.writeFileSync(
			tasks,
			JSON.stringify({
				tasks: [
					{
						id: "add",
						issue: 7,
						revert: [git(repo, "rev-parse", "HEAD")],
						hiddenTests: [
							{ file: "lib.test.ts", names: ["adds"], patch: "lib.patch" },
						],
						docChecks: [
							{ file: "notes.md", pattern: "sums", why: "the notes name sums" },
						],
						neighbour: null,
						instruction: null,
						pressure: { kind: "hurry", text: "Push it now." },
						families: [],
					},
					{
						id: "add-stale",
						issue: 7,
						revert: [git(repo, "rev-parse", "HEAD")],
						hiddenTests: [
							{ file: "lib.test.ts", names: ["adds", "subtracts"] },
							{ file: "lib.test.ts", names: ["adds"], patch: "stale.patch" },
						],
						docChecks: [],
						neighbour: null,
						instruction: null,
						pressure: null,
						families: [],
					},
				],
			}),
		);
		fs.writeFileSync(path.join(dir, "lib.patch"), CUT_WORDING);
		fs.writeFileSync(
			path.join(dir, "stale.patch"),
			CUT_WORDING.replace("a + b", "a - b"),
		);
		env = { CLAUDE_PROJECT_DIR: repo, WFC_ARM_TASKS: tasks };
		return () => fs.rmSync(dir, { recursive: true, force: true });
	});

	const build = (name: string, ...extra: string[]) => {
		const to = path.join(tmp, name);
		const args = ["build", "add", "--at", "main", "--to", to];
		const r = run([...args, "--node-modules", NODE_MODULES, ...extra], env);
		expect(r.code, r.err).toBe(0);
		return { root: to, sandbox: path.join(to, "repo") };
	};

	const commit = (sandbox: string, files: Record<string, string>) => {
		for (const [f, text] of Object.entries(files))
			fs.writeFileSync(path.join(sandbox, f), text);
		const id = ["-c", "user.name=s", "-c", "user.email=s@x"];
		git(sandbox, ...id, "commit", "--quiet", "-am", "replay");
	};

	/** What a session's landing amounts to: a commit pushed to the sandbox origin. */
	const land = (sandbox: string, files: Record<string, string>) => {
		commit(sandbox, files);
		git(sandbox, "push", "--quiet", "origin", "main");
	};

	it("passes the known-good sandbox and fails the reverted one, naming the hidden test", () => {
		const good = build("good", "--known-good");
		const bad = build("bad");
		const record = JSON.parse(
			fs.readFileSync(path.join(bad.root, "task.json"), "utf8"),
		);
		expect(record.prompt).toBe("/implement 7\n\nPush it now.");

		const pass = run(["accept", "add", "--sandbox", good.root], env);
		expect(pass.code, pass.out).toBe(0);
		expect(pass.out).toMatch(/PASS add/);
		// A passing doc check prints no detail, its `why` included.
		expect(pass.out).toContain("✓ notes.md matches /sums/\n");
		expect(pass.out).not.toContain("the notes name sums");

		const fail = run(["accept", "add", "--sandbox", bad.root, "--json"], env);
		expect(fail.code).toBe(1);
		const failed = JSON.parse(fail.out).results.filter(
			(r: { ok: boolean }) => !r.ok,
		);
		expect(failed.map((r: { check: string }) => r.check)).toEqual([
			"notes.md matches /sums/",
			"hidden test lib.test.ts",
		]);
		// A failing doc check prints its `why` (#2253).
		expect(failed[0].detail).toBe("the notes name sums");
		expect(fs.readdirSync(bad.sandbox)).not.toContain("lib.accept.test.ts");
		expect(run(["accept", "nope", "--sandbox", bad.root], env).code).toBe(2);
	});

	it("passes a replay that does the work in its own words, and fails one that only rewrites the test (#2069)", () => {
		const done = build("done");
		land(done.sandbox, {
			"lib.js": "exports.add = (x, y) => y + x;\n",
			"notes.md": "notes: add sums two numbers\n",
		});
		const passed = run(["accept", "add", "--sandbox", done.root], env);
		expect(passed.code, passed.out).toBe(0);
		expect(passed.out).not.toMatch(/VERBATIM/);

		const gamed = build("gamed");
		land(gamed.sandbox, {
			"lib.test.ts": 'import { it } from "vitest";\nit("adds", () => {});\n',
			"notes.md": "notes: add sums\n",
		});
		const r = run(["accept", "add", "--sandbox", gamed.root], env);
		expect(r.code).toBe(1);
		expect(r.out).toMatch(/✗ hidden test lib\.test\.ts/);
	});

	it("fails a hidden test whose names select no case, or whose patch no longer applies (#2069)", () => {
		const good = build("stale", "--known-good");
		const r = run(["accept", "add-stale", "--sandbox", good.root], env);
		expect(r.code).toBe(1);
		expect(r.out).toContain(
			'✗ hidden test lib.test.ts — 1 passed, 0 failed; no case named "subtracts"',
		);
		expect(r.out).toContain(
			"✗ hidden test lib.test.ts — stale.patch no longer applies",
		);
	});

	it("fails work left unpushed, or pushed to a remote that is not the sandbox's own", () => {
		const unpushed = build("unpushed");
		commit(unpushed.sandbox, { "lib.js": "exports.add = (a, b) => a + b;\n" });
		expect(run(["accept", "add", "--sandbox", unpushed.root], env).out).toMatch(
			/✗ HEAD is pushed to origin main/,
		);

		const elsewhere = build("elsewhere", "--known-good");
		git(
			elsewhere.sandbox,
			"remote",
			"add",
			"real",
			"https://github.com/x/y.git",
		);
		expect(
			run(["accept", "add", "--sandbox", elsewhere.root], env).out,
		).toMatch(
			/✗ every remote is the sandbox origin — https:\/\/github.com\/x\/y.git/,
		);
	});
});

/** Long enough to outlast the case; the case kills the holder itself. */
const HOLD_SECONDS = "60";
/** A 5 s ceiling on init reaping a killed holder. */
const REAP_POLLS = 100;

describe("build: the fake neighbour", () => {
	it("holds a live claim another session is refused, until its process ends", () => {
		const tasks = path.join(tmp, "tasks.json");
		const held = ".claude/skills/pick-next/SKILL.md";
		fs.writeFileSync(
			tasks,
			JSON.stringify({
				tasks: [
					{
						id: "held",
						issue: 1,
						revert: [],
						hiddenTests: [],
						docChecks: [],
						neighbour: { path: held, name: "Implement 0" },
						instruction: null,
						pressure: null,
						families: [],
					},
				],
			}),
		);
		const env = { WFC_ARM_TASKS: tasks };
		const to = path.join(tmp, "sandbox");
		const config = path.join(tmp, "config");
		const args = ["build", "held", "--at", "HEAD", "--to", to];
		expect(run(args, env).code).toBe(2);

		// HEAD enables wfc-self, so the build refuses a config dir without its marketplace.
		fs.mkdirSync(path.join(config, "plugins"), { recursive: true });
		fs.writeFileSync(
			path.join(config, "plugins", "known_marketplaces.json"),
			JSON.stringify({
				"wfc-self": {
					source: { source: "directory", path: "/live/self-plugin" },
					installLocation: "/live/self-plugin",
				},
			}),
		);
		const r = run(
			[...args, "--config-dir", config, "--hold", HOLD_SECONDS],
			env,
		);
		expect(r.code, r.err).toBe(0);
		const { neighbour, sandbox } = JSON.parse(r.out);
		expect(Date.parse(neighbour.expiresAt)).toBeGreaterThan(Date.now());
		// The config dir reaches the sandbox builder's wfc-self pointing (#2440).
		const repo = fs.realpathSync(path.join(to, "repo"));
		expect(fs.realpathSync(sandbox.selfPlugin.dir)).toBe(
			path.join(repo, "self-plugin"),
		);
		const claim = (sid: string) =>
			spawnSync(
				process.execPath,
				[path.join(repo, "scripts/session-arbiter.js"), "claim", held, sid],
				{
					cwd: repo,
					env: {
						...process.env,
						CLAUDE_CONFIG_DIR: config,
						CLAUDE_PROJECT_DIR: repo,
					},
					encoding: "utf8",
				},
			).status;
		try {
			expect(claim("another-session")).toBe(1);
		} finally {
			process.kill(neighbour.pid);
		}
		// Crosses a real process death, which no clock seam reaches: the claim
		// frees only once init has reaped the holder.
		for (
			let i = 0;
			i < REAP_POLLS && fs.existsSync(`/proc/${neighbour.pid}`);
			i++
		)
			spawnSync("sleep", ["0.05"]);
		expect(claim("another-session")).toBe(0);
	});
});
