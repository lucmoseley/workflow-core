// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHookShim } from "./lib/adopter-skeleton.js";
import { CODE_FILE } from "./lib/comment-policy.js";
import { coreOwnedPaths } from "./lib/core-owned-files.js";
import { defineTemplate, identityRepoTemplate } from "./lib/git-fixture";
import { dispatch } from "./lib/precommit-dispatch.js";
import { factsAt } from "./lib/precommit-dispatch-ports.js";
import { GATES } from "./lib/precommit-gates.js";
import { runInProcess } from "./lib/run-in-process.js";
import { NOTICES } from "./lib/shared-fault-notices.js";

const SCRIPT = path.resolve(__dirname, "check-comment-policy.js");
const PLUGIN_ROOT = path.resolve(__dirname, "..");
const COPIES = [
	"scripts/browse.py",
	"scripts/lib/resolve-core.js",
	"scripts/lib/resolve_core.py",
];
const SHIMS = coreOwnedPaths().filter((rel) => rel.startsWith(".husky/"));

let root: string;
let hooks: string;

const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: root, stdio: "pipe" });

const mainRepo = defineTemplate(identityRepoTemplate);

const write = (rel: string, text: string) => {
	fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
	fs.writeFileSync(path.join(root, rel), text);
};

const commit = (message: string) => {
	git("add", "-A");
	git("commit", "-qm", message);
};

const runWith = (env: NodeJS.ProcessEnv, ...args: string[]) => {
	const r = runInProcess(SCRIPT, args, {
		cwd: root,
		env: {
			...process.env,
			GITHUB_ACTIONS: "",
			CLAUDE_PROJECT_DIR: root,
			...env,
		},
	});
	return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
};
const run = (...args: string[]) => runWith({}, ...args);

beforeEach(() => {
	root = mainRepo.instantiate(
		fs.mkdtempSync(path.join(os.tmpdir(), "comment-policy-")),
	);
	hooks = fs.mkdtempSync(path.join(os.tmpdir(), "comment-policy-hooks-"));
	git("config", "core.hooksPath", hooks);
});
afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
	fs.rmSync(hooks, { recursive: true, force: true });
});

describe("check-comment-policy", () => {
	it("lists each breach by file and line, and passes the permitted kinds", () => {
		write("package.json", JSON.stringify({ devDependencies: { vitest: "1" } }));
		write("docs/adr/0003-a-choice.md", "# A choice\n");
		write(
			"scripts/lib/helper-surface.json",
			JSON.stringify({ entryPoints: { "scripts/lib/api.js": ["runIt"] } }),
		);
		write(
			"scripts/lib/api.js",
			"const a = 1;\n/** Runs it. */\nfunction runIt() {}\n// ADR-0003\nconst b = 1;\n// `vitest` needs it\nconst c = 1;\n",
		);
		write("scripts/b.py", "x = 1\n# a stray note\ny = 2\n");
		write("scripts/c.js", "const a = 1;\n// one\nconst b = 1;\n// two\n");
		write("docs/notes.md", "// not code\n");
		git("add", "-A");
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			"scripts/b.py:2  a stray note — fits no permitted comment kind",
		);
		expect(r.out).toContain("scripts/c.js:2  one");
		expect(r.out).toContain("scripts/c.js:4  two");
		expect(r.out).not.toContain("api.js");
		expect(r.out).toContain("3 comment breach(es) in 2 of 3 code file(s)");
	});

	it("reads a line opening on a commentMarkers entry in the judged tree's config as code (#5709)", () => {
		const stamped =
			"/*\n * @encodes docs/a.md § B :: 7c89\n */\nconst a = 1;\n";
		write("scripts/c.js", stamped);
		git("add", "-A");
		expect(run().status).toBe(1);
		write(
			".claude/workflow-core.json",
			JSON.stringify({ contract: 1, commentMarkers: ["@encodes"] }),
		);
		git("add", "-A");
		const r = run("--root", ".", "--all");
		expect(r.out).not.toContain("scripts/c.js");
		expect(r.status).toBe(0);
	});

	it("--all prints the count per file, most first, in place of each breach", () => {
		write("scripts/c.js", "const a = 1;\n// one\nconst b = 1;\n// two\n");
		write("scripts/b.py", "x = 1\n# a stray note\n");
		write("scripts/ok.js", "const a = 1;\n");
		git("add", "-A");
		const r = run("--all");
		expect(r.status).toBe(1);
		expect(r.out).toMatch(/ {5}2 {2}scripts\/c\.js\n {5}1 {2}scripts\/b\.py/);
		expect(r.out).not.toContain("a stray note");
		expect(r.out).not.toContain("ok.js");
	});

	it.each([
		["--root", ["--root", "."], ""],
		["a --root below the checkout's top", ["--root", "sub"], "sub/"],
	])("--all counts only tracked files, from %s (#5573)", (_, args, dir) => {
		write(`${dir}scripts/kept.js`, stray);
		git("add", "-A");
		write(`${dir}scripts/untracked.js`, stray);
		const r = run(...args, "--all");
		expect(r.status).toBe(1);
		expect(r.out).toContain("scripts/kept.js");
		expect(r.out).not.toContain("untracked.js");
		expect(r.out).toContain("1 comment breach(es) in 1 of 1 code file(s)");
	});

	it("reads past a tracked symlink to a directory (#5492)", () => {
		write("vendor/skill/run.js", "const a = 1;\n");
		fs.symlinkSync("vendor/skill", path.join(root, "linked"));
		git("add", "-A");
		const r = run("--all");
		expect(r.status).toBe(0);
		expect(r.out).toContain("1 code file(s), every comment a permitted kind.");
	});

	const marked = ["vendor/a.js", "gen/b.js", "vendor/keep/c.js"];
	const writeMarked = (text: string, dir = "") => {
		write(
			`${dir}.gitattributes`,
			"vendor/** linguist-vendored\ngen/** linguist-generated\nvendor/keep/** -linguist-vendored\n",
		);
		for (const rel of marked) write(`${dir}${rel}`, text);
	};
	const stray = "const a = 1;\n// a stray note\n";
	const expectOnlyUnmarked = (
		r: { status: number; out: string },
		kept = "vendor/keep/c.js:2",
	) => {
		expect(r.status).toBe(1);
		expect(r.out).toContain(kept);
		expect(r.out).not.toContain("vendor/a.js");
		expect(r.out).not.toContain("gen/b.js");
	};

	it.each([
		["the host root", [], ""],
		["--root", ["--root", "."], ""],
		["a --root below the checkout's top", ["--root", "sub"], "sub/"],
	])(
		"--all skips what .gitattributes marks vendored or generated, from %s",
		(_, args, dir) => {
			writeMarked(stray, dir);
			git("add", "-A");
			expectOnlyUnmarked(run(...args, "--all"), "vendor/keep/c.js");
		},
	);

	it("passes a tree whose every comment is a permitted kind", () => {
		write("scripts/ok.js", "// #12\nconst a = 1;\n");
		git("add", "-A");
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain("1 code file(s), every comment a permitted kind.");
	});

	it("passes the plugin's copies and hook shims in an adopter with no surface of its own, and charges the adopter's own top comment", () => {
		for (const rel of COPIES)
			write(rel, fs.readFileSync(path.join(PLUGIN_ROOT, rel), "utf8"));
		for (const rel of SHIMS) write(rel, renderHookShim(path.basename(rel)));
		write("scripts/own.js", "/*\n * A note.\n */\nconst a = 1;\n");
		git("add", "-A");
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain("scripts/own.js:1");
		expect(r.out).toContain(
			`1 comment breach(es) in 1 of ${COPIES.length + SHIMS.length + 1} code file(s)`,
		);
	});

	it("lists as copies every core-owned code file but the rendered hook shims, plus resolve_core.py, which an adopter copies once", () => {
		const surface = JSON.parse(
			fs.readFileSync(
				path.join(PLUGIN_ROOT, "scripts/lib/helper-surface.json"),
				"utf8",
			),
		);
		const owned = coreOwnedPaths().filter(
			(rel) => CODE_FILE.test(rel) && !SHIMS.includes(rel),
		);
		expect([...surface.copies].sort()).toEqual(
			[...owned, "scripts/lib/resolve_core.py"].sort(),
		);
		expect([...surface.copies].sort()).toEqual([...COPIES].sort());
	});

	it.each([
		["CLAUDE_PROJECT_DIR naming the main checkout", true],
		["no CLAUDE_PROJECT_DIR", false],
	])(
		"reads the linked worktree it runs in, not the main checkout, with %s (#5560)",
		(_, declared) => {
			write("scripts/a.js", "const a = 1;\n// one\nconst b = 1;\n// two\n");
			commit("seed");
			const linked = fs.mkdtempSync(
				path.join(os.tmpdir(), "comment-policy-wt-"),
			);
			fs.rmSync(linked, { recursive: true });
			try {
				git("worktree", "add", "-q", "--detach", linked);
				fs.writeFileSync(
					path.join(linked, "scripts/a.js"),
					"const a = 1;\nconst b = 1;\n// two\n",
				);
				const r = runInProcess(SCRIPT, ["--all", "--json"], {
					cwd: linked,
					env: {
						...process.env,
						GITHUB_ACTIONS: "",
						CLAUDE_PROJECT_DIR: declared ? root : "",
					},
				});
				expect(r.status).toBe(1);
				const out = JSON.parse(r.stdout);
				expect(out.perFile).toEqual({ "scripts/a.js": 1 });
				expect(out.keys).toEqual([
					"COMMENT\tscripts/a.js:3  two — fits no permitted comment kind",
				]);
			} finally {
				fs.rmSync(linked, { recursive: true, force: true });
				git("worktree", "prune");
			}
		},
	);

	describe("--against HEAD", () => {
		beforeEach(() => {
			write("scripts/a.js", "const a = 1;\n// inherited note\nconst b = 2;\n");
			commit("seed");
		});

		it("refuses a comment the staged blob adds, not the worktree's", () => {
			write(
				"scripts/a.js",
				"const a = 1;\n// inherited note\nconst b = 2;\n// added note\n",
			);
			git("add", "scripts/a.js");
			write("scripts/a.js", "const a = 1;\n// inherited note\nconst b = 2;\n");
			const r = run("--against", "HEAD");
			expect(r.status).toBe(1);
			expect(r.out).toContain("scripts/a.js:4  added note");
			expect(r.out).not.toContain("a.js:2  inherited note —");
			expect(r.out).toContain("Delete each comment, or reshape it");
		});

		it("passes a moved comment, and refuses an edited one", () => {
			write("scripts/a.js", "// inherited note\nconst a = 1;\nconst b = 2;\n");
			git("add", "scripts/a.js");
			expect(run("--against", "HEAD").status).toBe(0);
			write(
				"scripts/a.js",
				"const a = 1;\n// inherited, edited\nconst b = 2;\n",
			);
			git("add", "scripts/a.js");
			const r = run("--against", "HEAD");
			expect(r.status).toBe(1);
			expect(r.out).toContain("inherited, edited");
		});

		it("lets a renamed file keep its comments, charging only one it adds", () => {
			git("mv", "scripts/a.js", "scripts/moved.js");
			expect(run("--against", "HEAD").status).toBe(0);
			write(
				"scripts/moved.js",
				"const a = 1;\n// inherited note\nconst b = 2;\n// new here\n",
			);
			git("add", "scripts/moved.js");
			const r = run("--against", "HEAD");
			expect(r.status).toBe(1);
			expect(r.out).toContain("scripts/moved.js:4  new here");
			expect(r.out).not.toContain("moved.js:2  inherited note —");
		});

		it("refuses each refused shape a staged file holds, and passes each permitted one", () => {
			write("tsconfig.json", '{ "compilerOptions": { "checkJs": true } }');
			write("package.json", JSON.stringify({ dependencies: { ajv: "8" } }));
			write("docs/adr/0011-x.md", "# x\n");
			write(
				"scripts/lib/helper-surface.json",
				JSON.stringify({ entryPoints: { "scripts/s.js": ["run"] } }),
			);
			write(
				"scripts/s.js",
				[
					"// SPDX-License-Identifier: MIT",
					"const a = 1; // biome-ignore format: a table",
					"// ADR-0011",
					"const b = 1; // measured 3 s at p95 (#812)",
					"// #5455",
					"const c = 1; // `ajv` rejects a bare key",
					"/** Runs it. */",
					"function run() {}",
					"/** @type {number} */",
					"const d = 1; // a stray note",
					"// eslint-disable-next-line no-console",
					"const e = 1;",
					"// ADR-0999",
					"const f = 1;",
					"",
				].join("\n"),
			);
			write("scripts/t.ts", "/** @type {number} */\nconst a = 1;\n");
			git("add", "-A");
			const r = run("--against", "HEAD");
			expect(r.status).toBe(1);
			const lines = [
				...new Set(
					[...r.out.matchAll(/(scripts\/[\w.]+:\d+) {2}/g)].map((m) => m[1]),
				),
			];
			expect(lines).toEqual([
				"scripts/s.js:10",
				"scripts/s.js:11",
				"scripts/s.js:13",
				"scripts/t.ts:1",
			]);
		});

		it("reads the manifest and docs/adr/ the commit carries", () => {
			write("package.json", JSON.stringify({ dependencies: { ajv: "8" } }));
			write("docs/adr/0011-x.md", "# x\n");
			write(
				"scripts/b.js",
				"// `ajv` rejects a bare key\nconst a = 1;\n// ADR-0011\nconst b = 1;\n",
			);
			git("add", "-A");
			expect(run("--against", "HEAD").status).toBe(0);
		});

		it("charges no comment added to a vendored or generated file", () => {
			writeMarked("const a = 1;\n");
			commit("attributes");
			writeMarked(stray);
			git("add", "-A");
			expectOnlyUnmarked(run("--against", "HEAD"));
		});

		it("reads --head's own attributes, not the index's or the worktree's", () => {
			writeMarked("const a = 1;\n");
			commit("attributes");
			writeMarked(stray);
			commit("comments");
			git("rm", "-q", ".gitattributes");
			expectOnlyUnmarked(run("--against", "HEAD~1", "--head", "HEAD"));
		});

		it("judges a side by its own tree under a hook's exported GIT_DIR", () => {
			writeMarked("const a = 1;\n");
			commit("attributes");
			writeMarked(stray);
			commit("comments");
			write(
				".gitattributes",
				"vendor/** linguist-vendored\ngen/** linguist-generated\n",
			);
			git("add", ".gitattributes");
			expectOnlyUnmarked(
				runWith(
					{ GIT_DIR: path.join(root, ".git") },
					"--against",
					"HEAD~1",
					"--head",
					"HEAD",
				),
			);
		});
	});
});

describe("the pre-commit row", () => {
	const row = GATES.find((g) => g.id === "comment-policy");

	const armed = async (modules: string[]) => {
		write(".claude/workflow-core.json", JSON.stringify({ modules }));
		vi.stubEnv("WFC_MODULES", undefined);
		const ran: string[] = [];
		const code = await dispatch({
			rows: row ? [row] : [],
			gates: "all",
			ports: {
				staged: () => [{ status: "A", path: "scripts/a.js" }],
				computed: () => [],
				exists: () => true,
				load: (r) => () => {
					ran.push(r.id);
					return { exit: 1, stdout: "", stderr: "" };
				},
				write: () => undefined,
				interrupted: async () => null,
				fact: factsAt(root, () => undefined),
			},
		});
		vi.unstubAllEnvs();
		return { code, ran };
	};

	it("runs the checker under --against HEAD only while the module is on", async () => {
		expect(row?.args).toEqual(["--against", "HEAD"]);
		expect(row?.when).toEqual({ facts: ["module:comments"] });
		expect(NOTICES["comment-policy"]?.facts).toEqual(["module:comments"]);
		expect(await armed([])).toEqual({ code: 0, ran: [] });
		expect(await armed(["comments"])).toEqual({
			code: 1,
			ran: ["comment-policy"],
		});
	});

	it("throws on a fact naming no module", () => {
		expect(() => factsAt(root, () => undefined)("module:nope")).toThrow(
			"no fact is named 'module:nope'",
		);
	});
});
