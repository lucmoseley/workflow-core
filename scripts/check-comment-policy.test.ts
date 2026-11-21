// @vitest-environment node
/*
 * Pins check-comment-policy.js over a throwaway git repo: the bare listing,
 * `--all`'s per-file counts, `--against HEAD` charging only the comments a
 * commit adds, and the pre-commit row standing down while the module is off
 * (#5490). lib/comment-policy.test.ts pins each shape.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatch } from "./lib/precommit-dispatch.js";
import { factsAt } from "./lib/precommit-dispatch-ports.js";
import { GATES } from "./lib/precommit-gates.js";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "check-comment-policy.js");

let root: string;
let hooks: string;

const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: root, stdio: "pipe" });

const write = (rel: string, text: string) => {
	fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
	fs.writeFileSync(path.join(root, rel), text);
};

const commit = (message: string) => {
	git("add", "-A");
	git("commit", "-qm", message);
};

const run = (...args: string[]) => {
	const r = runInProcess(SCRIPT, args, {
		cwd: root,
		env: { ...process.env, GITHUB_ACTIONS: "", CLAUDE_PROJECT_DIR: root },
	});
	return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
};

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "comment-policy-"));
	hooks = fs.mkdtempSync(path.join(os.tmpdir(), "comment-policy-hooks-"));
	git("init", "-q", "-b", "main");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "test");
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
			"const a = 1;\n/** Runs it. */\nfunction runIt() {}\n// ADR-0003\nconst b = 1;\n// vitest needs it\nconst c = 1;\n",
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

	it("passes a tree whose every comment is a permitted kind", () => {
		write("scripts/ok.js", "// #12\nconst a = 1;\n");
		git("add", "-A");
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain("1 code file(s), every comment a permitted kind.");
	});

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

		it("reads the manifest and docs/adr/ the commit carries", () => {
			write("package.json", JSON.stringify({ dependencies: { ajv: "8" } }));
			write("docs/adr/0007-x.md", "# x\n");
			write(
				"scripts/b.js",
				"// ajv rejects a bare key\nconst a = 1;\n// ADR-0007\nconst b = 1;\n",
			);
			git("add", "-A");
			expect(run("--against", "HEAD").status).toBe(0);
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
		expect(row?.when).toEqual({ facts: ["module:comment-policy"] });
		expect(await armed([])).toEqual({ code: 0, ran: [] });
		expect(await armed(["comment-policy"])).toEqual({
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
