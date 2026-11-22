// @vitest-environment node
/*
 * check-scripts-typecheck.js reports every `scripts/` JS file that has opted
 * OUT of type checking (mantahostels#1464). It is exercised inside a throwaway git
 * repository rather than against this one, because it enumerates the tracked
 * set and this repo's is shared by every parallel session.
 *
 * WHAT BREAKING A TEST HERE COSTS. `checkJs` is repo-wide since
 * mantahostels#1464, so silencing a whole file is a one-line edit and this
 * script, run in `npm run status` and document-guards.yml, is the only thing
 * that reports one. Loosening the census block makes that edit invisible.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "check-scripts-typecheck.js");

let dir: string;

/** Run a git command inside the throwaway repo. */
const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: dir, encoding: "utf8" });

/** Write a file under the throwaway repo, creating its parent directories. */
const write = (rel: string, body: string) => {
	const abs = path.join(dir, rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, body);
};

/** A script the checker reads, carrying no `@ts-nocheck`. */
const checked = (name: string) =>
	`#!/usr/bin/env node\n/*\n * ${name} — a fixture.\n */\n\nmodule.exports = {};\n`;

const buildSilenced = (name: string) =>
	`#!/usr/bin/env node\n// @ts-nocheck\n/*\n * ${name} — a fixture.\n */\n\nmodule.exports = {};\n`;

/** Track and commit everything written so far. */
const commitAll = () => {
	git("add", "-A");
	git("commit", "-q", "-m", "fixtures");
};

/** Run the checker against the throwaway repo. */
const run = (args: string[] = [], env: Record<string, string> = {}) => {
	const r = runInProcess(SCRIPT, ["--root", dir, ...args], {
		env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ...env },
	});
	return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "scripts-typecheck-"));
	git("init", "-q");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "t");
	git("commit", "-q", "--allow-empty", "-m", "root");
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("the census — which tracked files have silenced the type checker", () => {
	it("reports OK on a corpus where nothing carries the pragma, saying so", () => {
		write("scripts/a.js", checked("a.js"));
		write("scripts/lib/b.js", checked("b.js"));
		commitAll();
		const { status, out } = run();
		expect(status).toBe(0);
		expect(out).toMatch(/^OK: all 2 in-scope \.js file\(s\) are type-checked/m);
		expect(out).toContain("none carries `// @ts-nocheck`");
	});

	it("names a silenced file and warns without gating", () => {
		write("scripts/a.js", checked("a.js"));
		write("scripts/off.js", buildSilenced("off.js"));
		commitAll();
		const { status, out } = run();
		// WARN, so exit 0: standing repo state, and the session reading it is
		// rarely the one that wrote the pragma.
		expect(status).toBe(0);
		expect(out).toMatch(/^WARN: 1 scripts\/ \.js file\(s\)/m);
		expect(out).toContain("scripts/off.js");
		expect(out).toContain("1 of 2 in-scope .js file(s) carry `// @ts-nocheck`");
	});

	it("counts every silenced file, not just the first", () => {
		write("scripts/one.js", buildSilenced("one.js"));
		write("scripts/two.js", buildSilenced("two.js"));
		commitAll();
		const { out } = run();
		expect(out).toMatch(/^WARN: 2 scripts\//m);
		expect(out).toContain("scripts/one.js");
		expect(out).toContain("scripts/two.js");
	});

	it("ignores an untracked file, so a scratch copy never reads as a silencing", () => {
		write("scripts/a.js", checked("a.js"));
		commitAll();
		write("scripts/scratch.js", buildSilenced("scratch.js"));
		const { status, out } = run();
		expect(status).toBe(0);
		expect(out).not.toContain("scratch.js");
	});
});

describe("the finding a silenced file raises", () => {
	it("raises one TYPECHECK-SILENCED finding whose way out is converting the file (#5492)", () => {
		write("scripts/plain.js", buildSilenced("plain.js"));
		commitAll();
		const envelope = JSON.parse(run(["--json"]).out);
		expect(envelope.findings).toHaveLength(1);
		expect(envelope.findings[0].tag).toBe("TYPECHECK-SILENCED");
		expect(envelope.findings[0].message).toContain("§N8: convert the file");
		expect(run(["--full"]).out).toMatch(/scripts\/plain\.js {2}\(\d+ lines\)/);
	});
});

describe("where the pragma counts, which is where TypeScript honours it", () => {
	it("does not count a pragma sitting below the header block (mantahostels#1395)", () => {
		// TypeScript honours `@ts-nocheck` only in the leading comment region, so
		// a line further down silences nothing and must not be reported as if it
		// had.
		write(
			"scripts/late.js",
			"#!/usr/bin/env node\n/*\n * late.js — a fixture.\n */\n\nconst x = 1;\n// @ts-nocheck\nmodule.exports = { x };\n",
		);
		commitAll();
		const { status, out } = run();
		expect(status).toBe(0);
		expect(out).toMatch(/^OK: all 1 in-scope/m);
	});

	it("counts a pragma in the leading region, which is the paired positive case", () => {
		write("scripts/early.js", buildSilenced("early.js"));
		commitAll();
		expect(run().out).toMatch(/^WARN: 1 scripts\//m);
	});

	it("reads a file merely quoting the pragma inside prose as checked, never as silenced (mantahostels#1395)", () => {
		// This script and §N8 both name the pragma in prose; a substring match
		// would report them as having used it.
		write(
			"scripts/prose.js",
			"#!/usr/bin/env node\n/*\n * prose.js — a fixture that mentions `// @ts-nocheck` in a sentence.\n */\n\nmodule.exports = {};\n",
		);
		commitAll();
		const { status, out } = run();
		expect(status).toBe(0);
		expect(out).toMatch(/^OK: all 1 in-scope/m);
	});
});

describe("scope — the two globs tsconfig.json lists in `include`", () => {
	it("ignores a silenced .js outside both globs", () => {
		write("lib/off.js", buildSilenced("off.js"));
		write("scripts/a.js", checked("a.js"));
		commitAll();
		const { status, out } = run();
		expect(status).toBe(0);
		expect(out).toMatch(/^OK: all 1 in-scope/m);
	});

	it("covers a skill script one directory below .claude/skills (mantahostels#1147)", () => {
		write(".claude/skills/demo/scripts/off.js", buildSilenced("off.js"));
		commitAll();
		const { out } = run();
		expect(out).toContain(".claude/skills/demo/scripts/off.js");
	});

	it("does not walk deeper than one directory level under a skill (mantahostels#1147)", () => {
		// The 25 vendored skills are symlinks, and a wider glob walks into
		// whatever they ship.
		write(".claude/skills/demo/scripts/nested/off.js", buildSilenced("off.js"));
		commitAll();
		const { status, out } = run();
		expect(status).toBe(0);
		expect(out).toMatch(/^OK: all 0 in-scope/m);
	});
});

describe("apparatus failures", () => {
	it("is BROKEN when git cannot enumerate the tracked set", () => {
		// git is the reading apparatus, so this is BROKEN and never SKIP
		// (check.js:16-26).
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "not-a-repo-"));
		const r = runInProcess(SCRIPT, ["--root", outside]);
		fs.rmSync(outside, { recursive: true, force: true });
		expect(r.status).toBe(2);
		expect(`${r.stdout}${r.stderr}`).toMatch(/^BROKEN: git ls-files failed/m);
	});

	it("is BROKEN when a tracked file cannot be read, naming the likely cause", () => {
		write("scripts/gone.js", checked("gone.js"));
		commitAll();
		fs.rmSync(path.join(dir, "scripts/gone.js"));
		const { status, out } = run();
		expect(status).toBe(2);
		expect(out).toMatch(/^BROKEN: cannot read tracked file scripts\/gone\.js/m);
		expect(out).toContain("often an unstaged delete");
	});
});
