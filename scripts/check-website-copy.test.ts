// @vitest-environment node
/*
 * Pins that a banned brand-sheet tell in `app/` copy gates with its file, line
 * and fix, that under `--against` only a tell the commit adds refuses it, and
 * which scopes are BROKEN rather than clean (mantahostels#858, #452).
 *
 * check-website-copy.js reads scope from git, so it runs inside a throwaway
 * repository rather than against this one — the tree here is shared, and a test
 * that staged files in it would fight a parallel session.
 *
 * It is a hard gate in `.husky/pre-commit` and a step in
 * `.github/workflows/ci.yml`: a false pass ships AI-flavoured filler to the
 * live site, where Vercel deploys every push to `main`.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(__dirname, "check-website-copy.js");

let repo: string;

const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: repo, encoding: "utf8" });

const write = (file: string, body: string) => {
	fs.mkdirSync(path.join(repo, path.dirname(file)), { recursive: true });
	fs.writeFileSync(path.join(repo, file), body);
};

const commit = (file: string, body: string) => {
	write(file, body);
	git("add", file);
	git("commit", "-qm", "x");
};

const check = (...args: string[]) => {
	const r = spawnSync("node", [SCRIPT, ...args], {
		cwd: repo,
		encoding: "utf8",
		/* The config is read at CLAUDE_PROJECT_DIR, which a session exports —
		 * inherited, it points the checker at the live repo's config (#452). */
		env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
	});
	return {
		status: r.status ?? -1,
		stdout: r.stdout ?? "",
		stderr: r.stderr ?? "",
	};
};

beforeEach(() => {
	repo = fs.mkdtempSync(path.join(os.tmpdir(), "website-copy-test-"));
	git("init", "-q", ".");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "test");
	commit("app/clean.tsx", 'export const c = "Surf, sleep, repeat.";\n');
});
afterEach(() => {
	fs.rmSync(repo, { recursive: true, force: true });
});

/*
 * The direction gate reads this checker's envelope through
 * checker-new-faults.js's `website-copy` profile, whose identity names the
 * finding's fields as string literals of its own (mantahostels#1938). Rename one in the
 * `ctx.fail` payload and two different tells in a file collapse to a single
 * identity, so adding a tell to a file that already carries one reads as
 * inherited and passes. Only the REAL envelope can see that; a hand-built
 * fixture carries the profile's own spelling.
 */
describe("the profile the direction gate reads this envelope through", () => {
	const newFaults = path.resolve(__dirname, "checker-new-faults.js");
	/* Two tells sharing a TAG, so `match` is the only field that tells them
	 * apart. */
	const crucial = 'export const a = "This is a crucial step.";\n';
	const pivotal = 'export const b = "A pivotal moment.";\n';

	const direction = (staged: string, baseline: string) => {
		const at = fs.mkdtempSync(
			path.join(os.tmpdir(), "website-copy-direction-"),
		);
		const put = (name: string, body: string) => {
			const abs = path.join(at, name);
			fs.writeFileSync(abs, body);
			return abs;
		};
		const r = spawnSync(
			"node",
			[
				newFaults,
				"website-copy",
				put("staged.json", staged),
				put("baseline.json", baseline),
			],
			{ encoding: "utf8" },
		);
		fs.rmSync(at, { recursive: true, force: true });
		return { code: r.status ?? -1, out: r.stdout ?? "" };
	};

	/** The live `--json` envelope over an app/copy.tsx holding `body`. */
	const envelope = (body: string) => {
		commit("app/copy.tsx", body);
		return check("--json").stdout;
	};

	it("refuses a second, different tell in a file that already carried one, naming only the new tell", () => {
		const one = envelope(crucial);
		const two = envelope(crucial + pivotal);

		const { code, out } = direction(two, one);

		expect(code).toBe(1);
		expect(out).toContain("pivotal");
		expect(out).not.toContain("crucial");
	});

	it("reads the tell it already carried as inherited", () => {
		const one = envelope(crucial);

		expect(direction(one, one).code).toBe(0);
	});
});

describe("check-website-copy", () => {
	it("passes clean copy, naming what it looked at", () => {
		const r = check();
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("OK:");
		expect(r.stderr).toContain("1 file(s) clean");
	});

	it("gates on a banned tell, with the file, the line and the fix", () => {
		commit("app/bad.tsx", 'export const c = "Busy — and cheap.";\n');
		const r = check();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("app/bad.tsx:1");
		expect(r.stderr).toContain("EM-DASH");
		expect(r.stderr).toContain("docs/brand-sheet.md §11");
		// A gate whose message points at --no-verify teaches the habit that defeats it.
		expect(r.stderr).not.toMatch(/reach for --no-verify\b(?!, which)/);
	});

	it("names the host's declared brandSheetPath in its message (#452)", () => {
		write(
			".claude/workflow-core.json",
			JSON.stringify({ brandSheetPath: "docs/brand/brand-sheet.md" }),
		);
		commit("app/bad.tsx", 'export const c = "Busy — and cheap.";\n');
		const r = check();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("docs/brand/brand-sheet.md §11");
	});

	// The whole scope rule: this gate is about what a visitor reads.
	it("ignores files outside the scanned directory", () => {
		commit(
			"docs/note.tsx",
			'export const c = "Repo prose — keeps its dash.";\n',
		);
		expect(check().status).toBe(0);
	});

	it("ignores an untracked file", () => {
		write("app/scratch.tsx", 'export const c = "Busy — and cheap.";\n');
		expect(check().status).toBe(0);
	});

	/*
	 * The whole root is scanned at both revisions and the SET DIFFERENCE is what
	 * refuses — so an inherited tell reports and passes, and one the commit adds
	 * refuses even in a file it did not itself stage.
	 */
	it("passes a tell HEAD already carries, saying so", () => {
		commit("app/bad.tsx", 'export const c = "Busy — and cheap.";\n');
		write("app/other.tsx", 'export const c = "Clean copy.";\n');
		git("add", "app/other.tsx");
		const r = check("--against", "HEAD");
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("already in HEAD");
	});

	it("refuses a tell the commit adds, naming it", () => {
		commit("app/ok.tsx", 'export const c = "Clean copy.";\n');
		write("app/bad.tsx", 'export const c = "Busy — and cheap.";\n');
		git("add", "app/bad.tsx");
		const r = check("--against", "HEAD");
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("app/bad.tsx");
	});

	it("names the host's brandSheetPath on the --against path too (#452)", () => {
		write(
			".claude/workflow-core.json",
			JSON.stringify({ brandSheetPath: "docs/brand/brand-sheet.md" }),
		);
		write("app/bad.tsx", 'export const c = "Busy — and cheap.";\n');
		git("add", "app/bad.tsx");
		const r = check("--against", "HEAD");
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("docs/brand/brand-sheet.md §11");
	});

	// A regression case: code review found the scanner reading the worktree
	// under `--staged` (mantahostels#858 review).
	it("judges the staged blob, not the worktree", () => {
		commit("app/bad.tsx", 'export const c = "Clean copy.";\n');
		write("app/bad.tsx", 'export const c = "Busy — and cheap.";\n');
		git("add", "app/bad.tsx");
		write("app/bad.tsx", 'export const c = "Clean copy.";\n');
		expect(check("--against", "HEAD").status).toBe(1);
	});

	it("passes a clean staged blob under a dirty worktree", () => {
		commit("app/bad.tsx", 'export const c = "Clean copy.";\n');
		write("app/bad.tsx", 'export const c = "Clean copy, edited.";\n');
		git("add", "app/bad.tsx");
		write("app/bad.tsx", 'export const c = "Busy — and cheap.";\n');
		expect(check("--against", "HEAD").status).toBe(0);
	});

	/* The materialisation is a blob fetch at a declared pathspec, not the whole
	 * tree — and a pathspec the caller gave must reach it, or both sides would
	 * scan the default root instead of the one asked about (mantahostels#1834). */
	it("carries a positional root through to both materialised sides", () => {
		commit("site/bad.tsx", 'export const c = "Clean copy.";\n');
		write("site/bad.tsx", 'export const c = "Busy — and cheap.";\n');
		git("add", "site/bad.tsx");
		const r = check("site", "--against", "HEAD");
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("site/bad.tsx");
	});

	it("is BROKEN, not OK, when the root matches nothing", () => {
		const r = check("nosuchdir");
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("nothing was scanned");
	});

	/* Under --root the same roots fed the materialisation, so an empty set means
	 * the REVISION carries no source under them — a fact, not a typo. OK rather
	 * than SKIP: a SKIP on the <rev> side is BROKEN under --against's fail-closed
	 * rule, which would refuse the very commit that creates app/. */
	it("is OK when a materialised revision carries nothing in scope", () => {
		commit("docs/note.md", "prose\n");
		const r = check("site", "--against", "HEAD");
		expect(r.status).toBe(0);
		expect(r.stderr).not.toContain("nothing was scanned");
	});

	it("is BROKEN when git will not enumerate the tracked set, naming git ls-files", () => {
		fs.rmSync(path.join(repo, ".git"), { recursive: true, force: true });
		const r = check();
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("git ls-files");
	});

	it("scans .ts as well as .tsx, and leaves other extensions alone", () => {
		commit("app/data.ts", 'export const c = "Busy — and cheap.";\n');
		expect(check().status).toBe(1);
		commit("app/notes.md", "Busy — and cheap.\n");
		expect(check().stderr).not.toContain("notes.md");
	});

	it("--warn reports without gating", () => {
		commit("app/bad.tsx", 'export const c = "Busy — and cheap.";\n');
		const r = check("--warn");
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("WARN:");
	});

	it("--json carries the findings for a machine reader", () => {
		commit("app/bad.tsx", 'export const c = "Busy — and cheap.";\n');
		const r = check("--json");
		const out = JSON.parse(r.stdout);
		expect(out.outcome).toBe("FAIL");
		expect(out.count).toBe(1);
		expect(out.findings[0]).toMatchObject({ tag: "EM-DASH", line: 1 });
	});

	it("is BROKEN, not clean, when handed a path it cannot scope, saying it is absolute", () => {
		const r = check("/etc");
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("BROKEN:");
		expect(r.stderr).toContain("is absolute");
	});

	/* The same refusal on the --against path, which is the one
	 * .husky/pre-commit takes (mantahostels#1940). */
	it("names the absolute root under --against, not git's failure", () => {
		const r = check("/etc", "--against", "HEAD");
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("is absolute");
		expect(r.stderr).not.toContain("git ls-tree");
	});

	/* refuse() runs after the rev is read, so a bare --against still reports the
	 * missing value rather than the checker's own complaint (mantahostels#1940). */
	it("names the missing rev before the absolute root", () => {
		const r = check("/etc", "--against");
		expect(r.stderr).toContain("--against needs a value");
		expect(r.stderr).not.toContain("is absolute");
	});

	/* A symlink dirent is not isDirectory(), so before mantahostels#1940 both sides read
	 * through one and scanned the link's target a second time. */
	it("counts a symlinked source file once, not twice, under --against", () => {
		write("app/bad.tsx", 'export const c = "Busy — and cheap.";\n');
		fs.symlinkSync("bad.tsx", path.join(repo, "app", "link.tsx"));
		git("add", "app");
		const r = check("--against", "HEAD", "--json");
		expect(r.status).toBe(1);
		const out = JSON.parse(r.stdout);
		expect(out.outcome).toBe("FAIL");
		expect(out.added).toHaveLength(1);
		expect(out.added[0]).toContain("app/bad.tsx");
	});

	/* The link is named `.tsx` deliberately: an extensionless one never passes
	 * SOURCE, so it is dropped before anything tries to read it and the fault
	 * cannot fire. A source-named link to a directory is the reachable case. */
	it("is not BROKEN by a symlink to a directory under --against", () => {
		commit(
			"app/nested/clean.tsx",
			'export const c = "Surf, sleep, repeat.";\n',
		);
		fs.symlinkSync("nested", path.join(repo, "app", "link.tsx"));
		git("add", "app");
		const r = check("--against", "HEAD", "--json");
		expect(JSON.parse(r.stdout).outcome).not.toBe("BROKEN");
		expect(r.status).not.toBe(2);
	});

	/* `--against` puts BOTH revisions through walk(), so only report mode
	 * reaches the ls-files branch (mantahostels#1940). */
	it("counts a symlinked source file once in report mode too", () => {
		commit("app/bad.tsx", 'export const c = "Busy — and cheap.";\n');
		fs.symlinkSync("bad.tsx", path.join(repo, "app", "link.tsx"));
		git("add", "app/link.tsx");
		git("commit", "-qm", "link");
		const r = check("--json");
		expect(r.status).toBe(1);
		expect(JSON.parse(r.stdout).count).toBe(1);
	});

	it("takes a scanned directory as an argument", () => {
		commit("site/bad.tsx", 'export const c = "Busy — and cheap.";\n');
		expect(check().status).toBe(0);
		expect(check("site").status).toBe(1);
	});
});
