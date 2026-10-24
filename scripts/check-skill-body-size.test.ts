// @vitest-environment node
/*
 * Pins that check-skill-body-size.js warns on an own skill body over its cap —
 * under --touching, only where the commit grew it — and never FAILs on size,
 * and that it FAILs on an unescaped `$<digit>` in a skill or command body
 * (#1490).
 *
 * check-skill-body-size.js is exercised against a fabricated skills tree in a
 * throwaway git repo, never this one: the live bodies change with every
 * commit, so a test reading them would pass or fail by what someone else
 * pushed.
 *
 * The size guarantee worth breaking to prove: a body over the cap is WARN and
 * exit 0, never FAIL — the checker is report-only by ruling (mantahostels#3136), and a
 * test that let FAIL through would let it become a gate unnoticed.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "check-skill-body-size.js");

let root: string;
let hooks: string;

const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: root, stdio: "pipe" });

const skill = (name: string, bytes: number) => {
	const dir = path.join(root, ".claude", "skills", name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "SKILL.md"), "x".repeat(bytes));
};

const body = (rel: string, text: string) => {
	const file = path.join(root, rel);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
};

const run = (...args: string[]) => {
	const r = runInProcess(SCRIPT, ["--root", root, "--cap", "100", ...args], {
		cwd: root,
		env: { ...process.env, GITHUB_ACTIONS: "" },
	});
	return {
		status: r.status ?? -1,
		out: `${r.stdout}${r.stderr}`,
		json: () => JSON.parse(r.stdout),
	};
};

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-body-size-"));
	/* An empty hooks dir, so the scratch repo never runs this checkout's
	 * Husky gates through its absolute core.hooksPath. */
	hooks = fs.mkdtempSync(path.join(os.tmpdir(), "skill-body-hooks-"));
	git("init", "-q", "-b", "main");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "test");
	git("config", "core.hooksPath", hooks);
});
afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
	fs.rmSync(hooks, { recursive: true, force: true });
});

describe("check-skill-body-size", () => {
	it("is OK when every own body is under the cap", () => {
		skill("small", 50);
		skill("edge", 100);
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK:");
		expect(r.out).toContain("2 own skill bodies");
	});

	it("WARNs, and never FAILs, on a body one byte over the cap, naming only that file and how far over it is", () => {
		skill("small", 50);
		skill("big", 101);
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain("WARN:");
		expect(r.out).toContain(".claude/skills/big/SKILL.md is 101 B, 1 B over");
		expect(r.out).not.toContain("small/SKILL.md is");
	});

	it("is BROKEN, not SKIP, where the root names no directory (#43)", () => {
		const missing = path.join(root, "no-such-project");
		const r = runInProcess(SCRIPT, ["--json"], {
			cwd: root,
			env: { ...process.env, GITHUB_ACTIONS: "", CLAUDE_PROJECT_DIR: missing },
		});
		expect(r.status).toBe(2);
		expect(JSON.parse(r.stdout).outcome).toBe("BROKEN");
		expect(r.stdout).toContain(missing);
	});

	it("skips a symlinked (vendored) skill however large it is", () => {
		skill("own", 50);
		const vendored = path.join(root, ".agents", "skills", "vend");
		fs.mkdirSync(vendored, { recursive: true });
		fs.writeFileSync(path.join(vendored, "SKILL.md"), "x".repeat(5000));
		fs.symlinkSync(vendored, path.join(root, ".claude", "skills", "vend"));
		const r = run("--json");
		expect(r.status).toBe(0);
		expect(r.json().bodies.map((b: { path: string }) => b.path)).toEqual([
			".claude/skills/own/SKILL.md",
		]);
	});

	describe("an unescaped $<digit>, which the harness rewrites (#1490)", () => {
		it.each([
			["code", "```\nawk '{print $4, $1}' f\n```\n", "$4"],
			["prose", "Close issue **#$1** now.\n", "$1"],
			["a price", "costs $0.0129 a read\n", "$0"],
		])(
			"FAILs on a body holding one in %s, naming file, line and token",
			(_, text, token) => {
				body(".claude/skills/s/SKILL.md", `---\nname: s\n---\n${text}`);
				const r = run();
				expect(r.status).toBe(1);
				expect(r.out).toContain(
					`.claude/skills/s/SKILL.md:${text.startsWith("```") ? 5 : 4} holds ${token}`,
				);
				expect(r.out).toContain("escape it as \\");
			},
		);

		it("FAILs on a command body under .claude/commands, naming file, line and the $ARGUMENTS fix", () => {
			body(".claude/commands/close.md", "gh issue view $1\n");
			const r = run();
			expect(r.status).toBe(1);
			expect(r.out).toContain(".claude/commands/close.md:1 holds $1");
			expect(r.out).toContain("write $ARGUMENTS for an intended placeholder");
		});

		it("FAILs on a namespaced command body in a subdirectory, naming the file, line and offending token", () => {
			body(".claude/commands/ns/x.md", "awk '{print $2}'\n");
			const r = run();
			expect(r.status).toBe(1);
			expect(r.out).toContain(".claude/commands/ns/x.md:1 holds $2");
		});

		it("SKIPs where the repo has neither a skills nor a commands directory", () => {
			const r = run("--json");
			expect(r.status).toBe(0);
			expect(r.json().outcome).toBe("SKIP");
		});

		it("passes an escaped \\$1 and a $ARGUMENTS placeholder", () => {
			body(".claude/skills/s/SKILL.md", "costs \\$17 a month\n");
			body(".claude/commands/close.md", "gh issue view $ARGUMENTS\n");
			const r = run();
			expect(r.status).toBe(0);
			expect(r.out).toContain("OK:");
			expect(r.out).toContain("1 own skill bodies and 1 command bodies");
		});

		it("ignores a vendored (symlinked) skill and a supporting file", () => {
			skill("own", 10);
			body(".claude/skills/own/references/notes.md", "awk '{print $1}'\n");
			const vendored = path.join(root, ".agents", "skills", "vend");
			fs.mkdirSync(vendored, { recursive: true });
			fs.writeFileSync(path.join(vendored, "SKILL.md"), "awk '{print $1}'\n");
			fs.symlinkSync(vendored, path.join(root, ".claude", "skills", "vend"));
			expect(run().status).toBe(0);
		});

		it("under --touching, refuses only a body the diff names, naming the fix", () => {
			body(".claude/skills/old/SKILL.md", "awk '{print $1}'\n");
			body(".claude/commands/c.md", "fine\n");
			git("add", ".");
			git("commit", "-qm", "seed");
			const quiet = run("--touching", "HEAD");
			expect(quiet.status).toBe(0);
			body(".claude/commands/c.md", "gh issue view $1\n");
			const r = run("--touching", "HEAD");
			expect(r.status).toBe(1);
			expect(r.out).toContain(".claude/commands/c.md:1 holds $1");
			expect(r.out).toContain("move code that needs it into a script");
			expect(r.out).not.toContain("old/SKILL.md");
		});
	});

	describe("--touching <rev>", () => {
		it("reports only the touched body, with its delta, and stays silent on an untouched over-cap one", () => {
			skill("grown", 80);
			skill("stale", 300);
			git("add", ".");
			git("commit", "-qm", "seed");
			skill("grown", 120);
			const r = run("--touching", "HEAD");
			expect(r.status).toBe(0);
			expect(r.out).toContain(
				"grown/SKILL.md is 120 B, 20 B over the 100 B cap, +40 B since HEAD",
			);
			expect(r.out).not.toContain("stale/SKILL.md");
			const j = run("--touching", "HEAD", "--json").json();
			expect(j.bodies.map((b: { path: string }) => b.path)).toEqual([
				".claude/skills/grown/SKILL.md",
			]);
		});

		it("prints a measured line, and no finding, for an over-cap body this commit shrank", () => {
			skill("shrunk", 300);
			git("add", ".");
			git("commit", "-qm", "seed");
			skill("shrunk", 250);
			const r = run("--touching", "HEAD");
			expect(r.status).toBe(0);
			expect(r.out).toContain("OK:");
			expect(r.out).toContain(
				"measured: .claude/skills/shrunk/SKILL.md 250 B, -50 B since HEAD, still 150 B over",
			);
		});

		it("prints a measured line, and no finding, for a touched body under the cap", () => {
			skill("ok", 60);
			git("add", ".");
			git("commit", "-qm", "seed");
			skill("ok", 70);
			const r = run("--touching", "HEAD");
			expect(r.status).toBe(0);
			expect(r.out).toContain("OK:");
			expect(r.out).toContain(
				"measured: .claude/skills/ok/SKILL.md 70 B, +10 B since HEAD, 30 B under",
			);
		});

		it("is BROKEN, exit 2, on a rev git cannot resolve, naming the rev", () => {
			skill("ok", 60);
			const r = run("--touching", "no-such-rev");
			expect(r.status).toBe(2);
			expect(r.out).toContain("BROKEN");
			expect(r.out).toContain("no-such-rev");
		});
	});

	it("is BROKEN on a --cap that is not a positive integer, naming the value it got", () => {
		skill("ok", 60);
		const r = runInProcess(SCRIPT, ["--root", root, "--cap", "lots"], {
			cwd: root,
			env: { ...process.env, GITHUB_ACTIONS: "" },
		});
		expect(r.status).toBe(2);
		expect(`${r.stdout}${r.stderr}`).toContain(
			"--cap needs a positive integer, got lots",
		);
	});
});
