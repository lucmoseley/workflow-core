// @vitest-environment node
/*
 * Pins that the cut refuses, writing nothing, on a live process in the adopter,
 * a dirty tree, a dangling spawn or a racing hook, and otherwise cuts in one
 * commit after the tag, printing the way back before any write.
 *
 * The cut is run against a synthetic adopter under `--spec`, with a stub plugin
 * root, init and Biome, so the cut's own steps run without mantahostels or
 * this machine's plugin registry (#423). Unexercised here: `--pin`'s install,
 * the real pre-commit stack and the MANTA spec itself — those are proved on a
 * clone of mantahostels, reported on #423.
 *
 * It is run once, by hand, to switch mantahostels onto the plugin: loosen a
 * case and the cut swaps hooks under a live Manta session, or leaves a half-cut
 * repo with no rollback recipe.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeProcRoot, writeCwd } from "./lib/proc-fake";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.join(__dirname, "cut-mantahostels.js");

const made: string[] = [];
afterEach(() => {
	for (const dir of made.splice(0))
		fs.rmSync(dir, { recursive: true, force: true });
});

function put(root: string, rel: string, body: string, mode?: number) {
	fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
	fs.writeFileSync(path.join(root, rel), body, mode ? { mode } : undefined);
}

const SPEC = {
	setsFile: "docs/cut-sets.json",
	claudeMdBase: "HEAD",
	claudeMd: {
		remove: [[2, 3]],
		replace: [{ line: 4, find: "L4", with: "L4b" }],
		insertAfter: [{ line: 1, text: "@.claude/workflow-core.md" }],
	},
	keep: ["scripts/keep.sh"],
	move: { "scripts/data.json": ".claude/data.json" },
	deleteAlso: [".github/workflows/extra.yml"],
	edits: [{ path: "config.yml", find: "beta", replace: "gamma" }],
	packageScripts: { test: "vitest run" },
	packageComments: {},
	docMapRoles: { "CLAUDE.md": "The fixture's instructions" },
	register: {},
	config: { contract: 1, name: "Fixture", modules: ["roadmap"] },
	ranking: {
		from: "skill/rank.md",
		startsWith: "**Rank first.**",
		to: ".claude/ranking.md",
		heading: "# ranking",
	},
	localGates: {
		to: ".husky/pre-commit.local",
		anchors: ["node scripts/gate.js"],
		header: "# the fixture's own gates",
	},
	regenerate: ['git config cut.regenerated "$WFC_PLUGIN_ROOT"'],
	minPin: "v1.1.18",
	commitMessage: "Cut the fixture over",
};

/**
 * The stub init sets the hooks path and exits `FAKE_INIT_EXIT`.
 */
function fixture(pluginHooks: object = {}) {
	const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cut-")));
	made.push(base);
	const dir = path.join(base, "adopter");
	const plugin = path.join(base, "plugin");
	fs.mkdirSync(dir);
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: dir, encoding: "utf8" });
	git("init", "-q", "-b", "main", ".");
	/* An identity, so the cut's own commit is not refused for want of one. */
	git("config", "user.email", "fixture@example.invalid");
	git("config", "user.name", "Cut Fixture");

	put(dir, "CLAUDE.md", "L1\nL2\nL3\nL4\nL5\n");
	put(
		dir,
		SPEC.setsFile,
		JSON.stringify({
			mantaAt: "HEAD",
			delete: ["scripts/old.js", "scripts/keep.sh", "scripts/data.json"],
			replacedByPlugin: [],
			settingsHooksKept: ["scripts/native.js"],
			keepNativeShared: [],
		}),
	);
	put(dir, "scripts/old.js", "module.exports = 1;\n");
	put(dir, "scripts/keep.sh", "echo kept\n");
	put(dir, "scripts/data.json", "{}\n");
	put(dir, "scripts/native.js", "// returns updatedInput\n");
	put(dir, ".github/workflows/extra.yml", "on: push\n");
	put(dir, "skill/rank.md", "# Skill\n\n**Rank first.** Then the rest.\n");
	put(
		dir,
		".husky/pre-commit",
		"# the one gate\nif node scripts/gate.js; then\n\texit 1\nfi\n",
	);
	put(dir, "config.yml", "alpha\nbeta\n");
	put(
		dir,
		"package.json",
		JSON.stringify({
			scripts: { old: "node scripts/old.js", test: "vitest" },
			comments: { "scripts.old": "runs the old one" },
		}),
	);
	put(
		dir,
		"docs/doc-map-classes.json",
		JSON.stringify({
			"CLAUDE.md": {
				section: "A",
				class: "canonical",
				role: null,
				consumes: [
					{ kind: "path", ref: "scripts/old.js" },
					{ kind: "glob", ref: "gone/*" },
					{ kind: "path", ref: "scripts/keep.sh" },
					{ kind: "path", ref: "init-adopter.js" },
					{ kind: "note", ref: "scripts/nowhere.js" },
				],
			},
			"docs/other.md": {
				section: "A",
				class: "canonical",
				role: null,
				consumes: [{ kind: "path", ref: "scripts/old.js" }],
			},
			"scripts/old.js": { section: "A", class: "derived", role: null },
		}),
	);
	put(
		dir,
		".claude/settings.json",
		JSON.stringify({
			hooks: {
				PreToolUse: [
					{
						matcher: "Bash",
						hooks: [
							{ type: "command", command: "node scripts/old.js" },
							{ type: "command", command: "node scripts/native.js" },
						],
					},
				],
			},
		}),
	);
	put(dir, ".gitignore", "node_modules/\n");
	put(dir, "node_modules/.bin/biome", "#!/bin/sh\nexit 0\n", 0o755);
	git("add", "-A");
	git("commit", "-q", "-m", "fixture");

	put(
		plugin,
		"scripts/init-adopter.js",
		[
			'const { execFileSync } = require("node:child_process");',
			'const fs = require("node:fs");',
			'const root = process.argv[process.argv.indexOf("--root") + 1];',
			'fs.writeFileSync(root + "/.claude/workflow-core.md", "# core\\n");',
			'execFileSync("git", ["config", "core.hooksPath", ".husky"], { cwd: root });',
			"process.exit(Number(process.env.FAKE_INIT_EXIT || 0));",
		].join("\n"),
	);
	put(
		plugin,
		"scripts/check-guard-registry.js",
		'console.log("OK: stub registry");\n',
	);
	put(plugin, "hooks/hooks.json", JSON.stringify({ hooks: pluginHooks }));

	const specPath = path.join(base, "spec.json");
	put(base, "spec.json", JSON.stringify(SPEC));
	const cut = (env: NodeJS.ProcessEnv = {}) =>
		runInProcess(
			SCRIPT,
			["--root", dir, "--plugin-root", plugin, "--spec", specPath],
			{ env: { ...process.env, ...env } },
		);
	const read = (rel: string) => fs.readFileSync(path.join(dir, rel), "utf8");
	const tagged = () =>
		git("tag", "--list", "pre-wfc-cut").trim() === "pre-wfc-cut";
	return { dir, plugin, git, cut, read, tagged };
}

describe("cut-mantahostels.js", () => {
	it("cuts in one commit after the tag, printing the recipe before any write", () => {
		const f = fixture();
		const head = f.git("rev-parse", "HEAD").trim();
		const r = f.cut();
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);

		expect(r.stdout.indexOf("ROLLBACK")).toBeGreaterThanOrEqual(0);
		expect(r.stdout.indexOf("ROLLBACK")).toBeLessThan(
			r.stdout.indexOf("tagged"),
		);
		expect(f.git("rev-parse", "pre-wfc-cut").trim()).toBe(head);
		expect(f.git("rev-list", "--count", "pre-wfc-cut..HEAD").trim()).toBe("1");
		expect(f.git("log", "-1", "--format=%s").trim()).toBe(SPEC.commitMessage);
		expect(f.git("status", "--porcelain")).toBe("");

		expect(JSON.parse(f.read(".claude/workflow-core.json"))).toEqual(
			SPEC.config,
		);
		for (const gone of [
			"scripts/old.js",
			"scripts/data.json",
			".github/workflows/extra.yml",
		])
			expect(fs.existsSync(path.join(f.dir, gone))).toBe(false);
		expect(f.read("scripts/keep.sh")).toBe("echo kept\n");
		expect(f.read(".claude/data.json")).toBe("{}\n");
		expect(f.read(".claude/ranking.md")).toBe(
			"# ranking\n\n**Rank first.** Then the rest.\n",
		);
		expect(f.read(".husky/pre-commit.local")).toContain(
			"# the one gate\nif node scripts/gate.js; then",
		);
		expect(f.read("config.yml")).toBe("alpha\ngamma\n");

		const claudeMd = "L1\n@.claude/workflow-core.md\nL4b\nL5\n";
		expect(f.read("CLAUDE.md")).toBe(claudeMd);
		expect(r.stdout).toContain(
			`CLAUDE.md keeps ${Buffer.byteLength(claudeMd)} bytes`,
		);
		expect(r.stdout).toContain("core.hooksPath is now .husky (was unset)");
		expect(r.stdout).toContain("registry OK: stub registry");
		expect(f.git("config", "cut.regenerated").trim()).toBe(f.plugin);

		const hooks = JSON.parse(f.read(".claude/settings.json")).hooks;
		expect(hooks.PreToolUse[0].hooks).toEqual([
			{ type: "command", command: "node scripts/native.js" },
		]);
		const pkg = JSON.parse(f.read("package.json"));
		expect(pkg.scripts).toEqual({ test: "vitest run" });
		expect(pkg.comments).toEqual({});
		const classes = JSON.parse(f.read("docs/doc-map-classes.json"));
		expect(Object.keys(classes)).toEqual(["CLAUDE.md", "docs/other.md"]);
		expect(classes["CLAUDE.md"].role).toBe("The fixture's instructions");
	});

	it("drops consumes references resolving in neither the host nor the plugin (#423)", () => {
		const f = fixture();
		const r = f.cut();
		expect(r.status).toBe(0);
		const classes = JSON.parse(f.read("docs/doc-map-classes.json"));
		/* One the plugin ships, a survivor and an unresolved kind stay. */
		expect(classes["CLAUDE.md"].consumes).toEqual([
			{ kind: "path", ref: "scripts/keep.sh" },
			{ kind: "path", ref: "init-adopter.js" },
			{ kind: "note", ref: "scripts/nowhere.js" },
		]);
		expect(classes["docs/other.md"].consumes).toBeNull();
		expect(r.stdout).toContain(
			"3 `consumes` references resolving nowhere dropped",
		);
		expect(r.stdout).toContain("  CLAUDE.md → gone/*");
	});

	it("refuses while a process works inside the adopter, naming its pid and the way out, writing nothing", async () => {
		const f = fixture();
		const child = spawn("sleep", ["30"], { cwd: f.dir, stdio: "ignore" });
		try {
			await new Promise((resolve) => child.once("spawn", resolve));
			const r = f.cut();
			expect(r.status).toBe(1);
			expect(r.stderr).toContain("a process is working inside");
			expect(r.stderr).toContain(`pid ${child.pid}`);
			expect(r.stderr).toContain("end every mantahostels session first");
			expect(r.stderr).toContain("Nothing was written.");
			expect(r.stdout).not.toContain("ROLLBACK");
			expect(f.tagged()).toBe(false);
		} finally {
			child.kill();
		}
	});

	it("reads the processes inside the adopter from a WFC_PROC root (#3538)", () => {
		const f = fixture();
		const fake = makeProcRoot();
		try {
			fake.proc(4242, { argv: "claude --resume" });
			writeCwd(fake.root, "4242", f.dir);
			const r = f.cut({ WFC_PROC: fake.root });
			expect(r.status).toBe(1);
			expect(r.stderr).toContain(`pid 4242 (claude) in ${f.dir}`);
			expect(f.tagged()).toBe(false);
		} finally {
			fake.remove();
		}
	});

	it("refuses while a process works inside a worktree of the adopter, naming its pid and the worktree, and tags nothing", async () => {
		const f = fixture();
		const wt = path.join(path.dirname(f.dir), "wt");
		f.git("worktree", "add", "-q", "--detach", wt);
		const child = spawn("sleep", ["30"], { cwd: wt, stdio: "ignore" });
		try {
			await new Promise((resolve) => child.once("spawn", resolve));
			const r = f.cut();
			expect(r.status).toBe(1);
			expect(r.stderr).toContain(`pid ${child.pid}`);
			expect(r.stderr).toContain(`in ${wt}`);
			expect(f.tagged()).toBe(false);
			expect(f.git("status", "--porcelain")).toBe("");
		} finally {
			child.kill();
		}
	});

	it("refuses where a kept file spawns or sources a deleted one, naming each edge and offering MANTA.keep as the way out, tagging nothing", () => {
		const f = fixture();
		put(
			f.dir,
			"scripts/runner.js",
			'spawnSync(process.execPath, [path.join(__dirname, "old.js")]);\n',
		);
		put(f.dir, "scripts/lib.sh", 'source "$here/old.js"\n');
		f.git("add", "-A");
		f.git("commit", "-q", "-m", "reach the deleted script");
		const r = f.cut();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("scripts/runner.js → old.js");
		expect(r.stderr).toContain("scripts/lib.sh → old.js");
		expect(r.stderr).toContain("keep the target in MANTA.keep");
		expect(f.tagged()).toBe(false);
	});

	it("refuses a dirty tree before the recipe, naming the stray files and the way out, writing nothing", () => {
		const f = fixture();
		put(f.dir, "stray.txt", "x\n");
		const r = f.cut();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("the tree is not clean");
		expect(r.stderr).toContain("stray.txt");
		expect(r.stderr).toContain("commit or remove these first");
		expect(r.stdout).toBe("");
		expect(f.tagged()).toBe(false);
	});

	it("refuses a kept native hook that races a plugin hook on updatedInput, naming the hook and offering to narrow its matcher (#400)", () => {
		const f = fixture({
			PreToolUse: [{ matcher: "Bash|Write", hooks: [] }],
		});
		const r = f.cut();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("returns updatedInput");
		expect(r.stderr).toContain("PreToolUse Bash: node scripts/native.js");
		expect(r.stderr).toContain("narrow its matcher off the plugin's");
		expect(f.tagged()).toBe(false);
	});

	it("cuts where the plugin's hooks match other tools than the native rewriter's", () => {
		const f = fixture({ PreToolUse: [{ matcher: "Write", hooks: [] }] });
		const r = f.cut();
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
	});

	it("stops after the tag with the way back where a later step fails", () => {
		const f = fixture();
		const head = f.git("rev-parse", "HEAD").trim();
		const r = f.cut({ FAKE_INIT_EXIT: "1" });
		expect(r.status).toBe(1);
		expect(r.stdout).toContain("ROLLBACK");
		expect(r.stderr).toContain("init-adopter.js exited 1");
		expect(r.stderr).toContain("reset --hard pre-wfc-cut");
		expect(f.tagged()).toBe(true);
		expect(f.git("rev-parse", "HEAD").trim()).toBe(head);
	});
});
