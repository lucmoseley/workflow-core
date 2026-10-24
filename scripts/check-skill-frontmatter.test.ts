// @vitest-environment node
/*
 * Pins that check-skill-frontmatter.js FAILs an own skill whose frontmatter a
 * strict YAML parser rejects, naming file, line:column and the quoting fix,
 * and skips a vendored one (#887).
 *
 * check-skill-frontmatter.js against a fabricated skills tree in a throwaway
 * git repo, never this one: the live bodies change with every commit.
 *
 * .husky/pre-commit refuses on this checker, so loosening a case here loosens
 * that gate.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import { buildTree } from "./lib/plugin-tree.js";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "check-skill-frontmatter.js");

let root: string;
let hooks: string;

const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: root, stdio: "pipe" });

/* No description writes no `description:` line at all, a name-only skill's shape (#2036). */
const skill = (name: string, description?: string) => {
	const dir = path.join(root, ".claude", "skills", name);
	fs.mkdirSync(dir, { recursive: true });
	const line = description === undefined ? "" : `description: ${description}\n`;
	fs.writeFileSync(
		path.join(dir, "SKILL.md"),
		`---\nname: ${name}\n${line}---\n\nBody.\n`,
	);
};

const run = (...args: string[]) => {
	const r = runInProcess(SCRIPT, args, {
		cwd: root,
		env: { ...process.env, GITHUB_ACTIONS: "", CLAUDE_PROJECT_DIR: root },
	});
	return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
};

const UNQUOTED = "Turn it on or off: Sonnet up to Opus.";
const QUOTED = `"${UNQUOTED}"`;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-frontmatter-"));
	/* An empty hooks dir, so the scratch repo never runs this checkout's
	 * Husky gates through its absolute core.hooksPath. */
	hooks = fs.mkdtempSync(path.join(os.tmpdir(), "skill-frontmatter-hooks-"));
	git("init", "-q", "-b", "main");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "test");
	git("config", "core.hooksPath", hooks);
});
afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
	fs.rmSync(hooks, { recursive: true, force: true });
});

describe("check-skill-frontmatter", () => {
	it("passes a description quoted around its `: `", () => {
		skill("good", QUOTED);
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK: 1 own skill(s), every frontmatter parsing");
	});

	it("passes a frontmatter with no description key, a name-only skill's shape (#2036)", () => {
		skill("bare");
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK: 1 own skill(s), every frontmatter parsing");
	});

	it("FAILs #885's unquoted `: `, naming the file, js-yaml's line:column and the quoting fix", () => {
		skill("good", QUOTED);
		skill("bad", UNQUOTED);
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			".claude/skills/bad/SKILL.md:3:31 — js-yaml: bad indentation of a mapping entry. Fix: double-quote that value",
		);
		expect(r.out).not.toContain("good/SKILL.md:");
	});

	it("FAILs frontmatter that opens and never closes, naming the file and line and the fix", () => {
		const dir = path.join(root, ".claude", "skills", "open");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "SKILL.md"), "---\nname: open\n");
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			".claude/skills/open/SKILL.md:1:1 — the frontmatter opens with --- and never closes. Fix: close it with a --- line",
		);
	});

	it("reads past a BOM and trailing blanks on the fences", () => {
		const dir = path.join(root, ".claude", "skills", "bom");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "SKILL.md"),
			`\uFEFF--- \nname: bom\ndescription: ${UNQUOTED}\n---  \n`,
		);
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain(".claude/skills/bom/SKILL.md:3:31");
	});

	it("passes over a plain file beside the skill directories", () => {
		skill("good", QUOTED);
		fs.writeFileSync(path.join(root, ".claude", "skills", "README.md"), "x");
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK: 1 own skill(s)");
	});

	it("skips a symlinked (vendored) skill", () => {
		const vendored = path.join(root, ".agents", "skills", "vend");
		fs.mkdirSync(vendored, { recursive: true });
		fs.writeFileSync(
			path.join(vendored, "SKILL.md"),
			`---\nname: vend\ndescription: ${UNQUOTED}\n---\n`,
		);
		fs.mkdirSync(path.join(root, ".claude", "skills"), { recursive: true });
		fs.symlinkSync(vendored, path.join(root, ".claude", "skills", "vend"));
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK: 0 own skill(s)");
	});

	describe("--against HEAD", () => {
		it("refuses a commit that stages an unquoted `: `, naming the file and line and the fix, and judges the index, not the worktree", () => {
			skill("s", QUOTED);
			git("add", ".");
			git("commit", "-qm", "seed");
			skill("s", UNQUOTED);
			git("add", ".");
			const refused = run("--against", "HEAD");
			expect(refused.status).toBe(1);
			expect(refused.out).toContain(
				".claude/skills/s/SKILL.md:3:31 — js-yaml: bad indentation of a mapping entry. Fix: double-quote that value",
			);
			/* Repaired in the worktree but not staged: the commit still carries the fault. */
			skill("s", QUOTED);
			expect(run("--against", "HEAD").status).toBe(1);
		});

		it("refuses the first skill a repo ever adds, naming the file and line, rather than going BROKEN on the empty baseline", () => {
			fs.writeFileSync(path.join(root, "seed"), "x");
			git("add", ".");
			git("commit", "-qm", "seed");
			skill("s", UNQUOTED);
			git("add", ".");
			const r = run("--against", "HEAD");
			expect(r.status).toBe(1);
			expect(r.out).toContain(".claude/skills/s/SKILL.md:3:31");
		});

		it("passes a commit whose staged description is quoted", () => {
			skill("s", QUOTED);
			git("add", ".");
			git("commit", "-qm", "seed");
			skill("s", `"${UNQUOTED} Now longer."`);
			git("add", ".");
			expect(run("--against", "HEAD").status).toBe(0);
		});
	});
});

/*
 * The copy an adopter runs (#1380): rendered into a temp directory with no
 * node_modules above it, as the plugin cache is, so js-yaml can come only from
 * the host repo's own install.
 */
describe("the shipped copy, in an adopter", () => {
	let cache: string;
	let plugin: string;
	beforeAll(() => {
		cache = fs.mkdtempSync(path.join(os.tmpdir(), "skill-frontmatter-plugin-"));
		/* buildTree refuses an existing directory. */
		plugin = path.join(cache, "plugin");
		buildTree(path.resolve(__dirname, ".."), plugin);
	});
	afterAll(() => fs.rmSync(cache, { recursive: true, force: true }));

	const shipped = () => {
		const r = runInProcess(
			path.join(plugin, "scripts", "check-skill-frontmatter.js"),
			[],
			{ cwd: root, env: { ...process.env, CLAUDE_PROJECT_DIR: root } },
		);
		return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
	};

	it("parses with the js-yaml the adopter installed", () => {
		skill("bad", UNQUOTED);
		fs.mkdirSync(path.join(root, "node_modules"));
		fs.symlinkSync(
			path.resolve(__dirname, "..", "node_modules", "js-yaml"),
			path.join(root, "node_modules", "js-yaml"),
		);

		const r = shipped();

		expect(r.status).toBe(1);
		expect(r.out).toContain("js-yaml: bad indentation of a mapping entry");
	});

	it("is BROKEN, naming the install, where the adopter has no js-yaml", () => {
		skill("bad", UNQUOTED);

		const r = shipped();

		expect(r.status).toBe(2);
		expect(r.out).toContain(
			`js-yaml is not installed in ${root}, so this check cannot run. Install it there: npm install --ignore-scripts --save-dev --save-exact js-yaml`,
		);
	});

	it("needs no js-yaml where the adopter has no skills of its own", () => {
		expect(shipped().status).toBe(0);
	});
});
