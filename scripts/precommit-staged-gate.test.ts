// @vitest-environment node
/*
 * The pre-commit Biome gate, exercised end to end: `npm run check:staged`.
 *
 * Biome exits 1 when every staged path is one its config ignores — and `docs/`
 * and `public/` are ignored deliberately, so `--no-errors-on-unmatched` keeps a
 * documentation-only commit passing (mantahostels#298).
 *
 * So the cases below run the REAL command string out of package.json, against
 * the REAL biome.json, in a throwaway git repo — the shared tree's index is
 * repo-global (mantahostels#63) and must never be staged into by a test.
 *
 * It is a hard gate in `.husky/pre-commit`: loosen a case and a documentation-
 * only commit is refused, or a staged file Biome covers lands unchecked.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inferCommands } from "./lib/infer-commands.js";
import { coreCall, writeCheckerDelegates } from "./lib/precommit-gate-testkit";

const ROOT = path.join(__dirname, "..");
const CHECK_STAGED: string = JSON.parse(
	fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
).scripts["check:staged"];

const temps: string[] = [];

afterEach(() => {
	for (const t of temps.splice(0))
		fs.rmSync(t, { recursive: true, force: true });
});

/**
 * A git repo of its own, carrying this repo's Biome config verbatim,
 * committed: the command reads the index's copy, and a staged one would be a
 * path Biome checks.
 */
function fixture(files: Record<string, string>): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "staged-gate-"));
	temps.push(root);
	execFileSync("git", ["init", "-q", "."], { cwd: root });
	execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
	execFileSync("git", ["config", "user.name", "t"], { cwd: root });
	writeCheckerDelegates(root, ["biome-staged.js"]);
	// biome.json sets vcs.useIgnoreFile, which wants the file to exist.
	fs.writeFileSync(path.join(root, ".gitignore"), "");
	fs.copyFileSync(path.join(ROOT, "biome.json"), path.join(root, "biome.json"));
	execFileSync("git", ["add", "--", ".gitignore", "biome.json"], { cwd: root });
	execFileSync("git", ["commit", "-qm", "config"], { cwd: root });
	stage(root, files);
	return root;
}

function stage(root: string, files: Record<string, string>): void {
	for (const [rel, body] of Object.entries(files)) {
		const abs = path.join(root, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, body);
		execFileSync("git", ["add", "--", rel], { cwd: root });
	}
}

/** Runs the command as .husky/pre-commit does: PATH-prefixed, via the shell. */
function run(
	cwd: string,
	command: string,
	env: Record<string, string> = {},
): { code: number; output: string } {
	try {
		const stdout = execFileSync("sh", ["-c", command], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				PATH: `${path.join(ROOT, "node_modules", ".bin")}:${process.env.PATH}`,
				...env,
			},
		});
		return { code: 0, output: stdout };
	} catch (e) {
		const err = e as { status?: number; stdout?: string; stderr?: string };
		return {
			code: err.status ?? 1,
			output: `${err.stdout ?? ""}${err.stderr ?? ""}`,
		};
	}
}

// A formatting diagnostic, so no lint rule has to stay enabled for it.
const BADLY_FORMATTED = "export function f() {\n  return 'x';\n}\n";
const WELL_FORMATTED = 'export function f() {\n\treturn "x";\n}\n';

/*
 * One file per ignored path, and every extension one Biome HANDLES.
 *
 * A `.md` here would prove nothing: Biome has no markdown support, so a staged
 * `docs/note.md` matches nothing whatever the config says, and the case passes
 * just as well with `!docs` deleted.
 *
 * The content is badly formatted for the same reason: if one of these paths
 * stopped being ignored, Biome would have a real diagnostic to report and the
 * cases below would fail rather than quietly keep passing.
 */
const IGNORED_PATHS: Record<string, string> = {
	"docs/gen.js": BADLY_FORMATTED,
	"public/app.js": BADLY_FORMATTED,
	".claude/worktrees/agent-abc123/gen.js": BADLY_FORMATTED,
	// Claude Code rewrites `settings.json` two-space on any settings change, so
	// pinning its format would fail the gate for whoever next commits one.
	".claude/settings.json": '{\n  "a": 1\n}\n',
	"skills-lock.json": '{\n  "a": 1\n}\n',
};

describe("the pre-commit Biome gate", () => {
	it("passes a commit whose every path Biome ignores", () => {
		const repo = fixture(IGNORED_PATHS);

		expect(run(repo, CHECK_STAGED).code).toBe(0);
	});

	it("fails that same commit without --no-errors-on-unmatched, saying no files were processed", () => {
		const repo = fixture(IGNORED_PATHS);

		const stripped = CHECK_STAGED.replace(" --no-errors-on-unmatched", "");
		expect(stripped, "the flag is gone from check:staged").not.toBe(
			CHECK_STAGED,
		);

		const { code, output } = run(repo, stripped);
		expect(code).not.toBe(0);
		expect(output).toContain("No files were processed");
	});

	// The control for the two above: the same bytes at a path Biome covers do
	// fail.
	it("still reports a staged file Biome does cover", () => {
		const repo = fixture({
			...IGNORED_PATHS,
			"scripts/bad.ts": BADLY_FORMATTED,
		});

		const { code, output } = run(repo, CHECK_STAGED);
		expect(code).not.toBe(0);
		expect(output).toContain("scripts/bad.ts");
	});

	// mantahostels#1138: Biome re-includes only at the breadth of the exclusion it follows.
	// `!.claude/**` then `.claude/**` works; `!.claude/**` then
	// `.claude/skills/*/scripts/**` is silently ignored, as is any re-include
	// under the directory-form `!.claude`. So covering the skill scripts meant
	// widening to everything under `.claude/` bar the exclusions above.
	it("covers a skill's own scripts under .claude", () => {
		const repo = fixture({
			".claude/skills/roadmap-edit/scripts/gen.js": BADLY_FORMATTED,
		});

		const { code, output } = run(repo, CHECK_STAGED);
		expect(code).not.toBe(0);
		expect(output).toContain(".claude/skills/roadmap-edit/scripts/gen.js");
	});

	it("passes a staged blob whose worktree copy a neighbour has since broken (#2429)", () => {
		const repo = fixture({ "scripts/mine.ts": WELL_FORMATTED });
		fs.writeFileSync(path.join(repo, "scripts/mine.ts"), BADLY_FORMATTED);

		const { code, output } = run(repo, CHECK_STAGED);
		expect(output).not.toContain("scripts/mine.ts");
		expect(code).toBe(0);
	});

	// An adopter's `biome check --staged` script is inferred as the plugin's
	// biome-staged.js, which its hook shim reaches through WFC_PLUGIN_ROOT.
	function runAdopted(repo: string): { code: number; output: string } {
		fs.writeFileSync(
			path.join(repo, "package.json"),
			JSON.stringify({
				scripts: {
					"check:staged": "biome check --staged --no-errors-on-unmatched",
				},
				devDependencies: { "@biomejs/biome": "2.0.0" },
			}),
		);
		const command = inferCommands(repo).check_staged?.command ?? "";
		expect(command).toContain("biome-staged.js");
		return run(repo, command, { WFC_PLUGIN_ROOT: ROOT });
	}

	it("passes that blob through an adopter's inferred check_staged (#2540)", () => {
		const repo = fixture({ "scripts/mine.ts": WELL_FORMATTED });
		fs.writeFileSync(path.join(repo, "scripts/mine.ts"), BADLY_FORMATTED);

		const { code, output } = runAdopted(repo);
		expect(output).not.toContain("scripts/mine.ts");
		expect(code).toBe(0);
	});

	it("refuses a broken staged blob through an adopter's inferred check_staged, naming it", () => {
		const repo = fixture({ "scripts/mine.ts": BADLY_FORMATTED });
		fs.writeFileSync(path.join(repo, "scripts/mine.ts"), WELL_FORMATTED);

		const { code, output } = runAdopted(repo);
		expect(code).not.toBe(0);
		expect(output).toContain("scripts/mine.ts");
	});

	it("refuses a staged blob whose worktree copy is clean, naming it", () => {
		const repo = fixture({ "scripts/mine.ts": BADLY_FORMATTED });
		fs.writeFileSync(path.join(repo, "scripts/mine.ts"), WELL_FORMATTED);

		const { code, output } = run(repo, CHECK_STAGED);
		expect(code).not.toBe(0);
		expect(output).toContain("scripts/mine.ts");
	});

	// Biome's project rules read the files a staged one imports, so the whole
	// index is extracted, not the staged paths alone.
	it("reads an unstaged tracked file a staged one imports", () => {
		const repo = fixture({
			"scripts/b.ts": 'import { a } from "./a.ts";\n\nexport const b = a;\n',
		});
		execFileSync("git", ["commit", "-qm", "b"], { cwd: repo });
		stage(repo, {
			"scripts/a.ts":
				'import { b } from "./b.ts";\n\nexport const a = 1;\nexport const c = b;\n',
		});

		const { code, output } = run(repo, CHECK_STAGED);
		expect(code).not.toBe(0);
		expect(output).toContain("noImportCycles");
	});

	it("passes an intent-to-add path, which the commit does not carry", () => {
		const repo = fixture({});
		fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
		fs.writeFileSync(path.join(repo, "scripts/later.ts"), BADLY_FORMATTED);
		execFileSync("git", ["add", "-N", "--", "scripts/later.ts"], { cwd: repo });

		expect(run(repo, CHECK_STAGED).code).toBe(0);
	});

	it("is what .husky/pre-commit runs", () => {
		const hook = fs.readFileSync(
			path.join(ROOT, ".husky", "pre-commit"),
			"utf8",
		);

		// The adopter's declared command since #2; this repo declares check:staged.
		expect(hook).toContain(
			`${coreCall("node", "scripts/lib/workflow-core-config.js")} command check_staged`,
		);
		expect(
			JSON.parse(
				fs.readFileSync(path.join(ROOT, ".claude/workflow-core.json"), "utf8"),
			).commands.check_staged,
		).toBe("npm run check:staged");
	});
});
