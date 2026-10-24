// @vitest-environment node
/*
 * guard-citation-tracker.sh names a `Write` or `Edit` adding a citation of the
 * inherited tracker for a number it never used, and hands the session the rule
 * (#2015). The rule left the always-loaded pool for this hook, so a silent
 * hook means a session never meets it before the commit gate refuses.
 *
 * Each case runs the real hook against a throwaway repo whose seed commit
 * stands in for `ec8654cd` through `WFC_CITATION_BASELINE`. The citations are
 * built at run time so the commit gate never reads this file's own lines as
 * mis-copies.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkScratchDir } from "./lib/git-fixture";
import { guardOutput } from "./lib/pretool-guard-testkit";

const HOOK = path.resolve(__dirname, "guard-citation-tracker.sh");
const RULE = fs
	.readFileSync(
		path.resolve(
			__dirname,
			"..",
			"docs",
			"agents",
			"rules",
			"citation-tracker.txt",
		),
		"utf8",
	)
	.trim();

const cite = (n: number) => `${"mantahostels"}#${n}`;

let dir: string;
let repo: string;
let baseline: string;

beforeEach(() => {
	dir = mkScratchDir("citation-guard-");
	repo = path.join(dir, "repo");
	fs.mkdirSync(repo);
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: repo, encoding: "utf8" });
	git("init", "-q", ".");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");
	fs.writeFileSync(
		path.join(repo, "history.md"),
		`Cites ${cite(900)} and ${cite(63)}.\n`,
	);
	git("add", "--", ".");
	git("commit", "-qm", "seed");
	baseline = git("rev-parse", "HEAD").trim();
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const context = (
	tool: "Write" | "Edit",
	file: string,
	input: Record<string, string>,
	{ extra = {} as Record<string, string>, base = repo, project = repo } = {},
): string | null => {
	const parsed = guardOutput(
		HOOK,
		{
			tool_name: tool,
			tool_input: { file_path: `${base}/${file}`, ...input },
			session_id: "abcdef12-3456",
		},
		{
			project,
			config: dir,
			env: { WFC_CITATION_BASELINE: baseline, ...extra },
		},
	);
	if (!parsed) return null;
	expect(parsed.permissionDecision).toBeUndefined();
	return parsed.additionalContext;
};

describe("a write adding a citation the inherited tracker never used", () => {
	it("names it with its bare form and hands over the whole rule, once a session", () => {
		expect(
			context("Write", "notes.md", { content: `See ${cite(2015)}.\n` }),
		).toBe(
			`notes.md adds ${cite(2015)} (write #2015) — the inherited tracker never used that number, so the citation means this repo's own issue.\n\n${RULE}`,
		);
		const again = context("Edit", "history.md", {
			old_string: `Cites ${cite(900)}`,
			new_string: `Cites ${cite(900)} and ${cite(44)}`,
		});
		expect(again).toContain(`${cite(44)} (write #44)`);
		expect(again).not.toContain(RULE);
	});

	// The harness sends CLAUDE_PROJECT_DIR physical and the path as the model
	// spelled it, measured on Claude Code 2.1.308 (#2553); a symlinked project
	// dir is gr_root's to resolve.
	it.each([
		["physical", false],
		["the symlink", true],
	])(
		"names it on a write spelled through a symlink to the checkout, project dir %s (#2553)",
		(_, viaLink) => {
			const link = path.join(dir, "link");
			fs.symlinkSync(repo, link);
			const project = viaLink ? link : repo;
			expect(
				context(
					"Write",
					"notes.md",
					{ content: `See ${cite(2015)}.\n` },
					{ base: link, project },
				),
			).toContain(`${cite(2015)} (write #2015)`);
		},
	);
});

describe("any other write", () => {
	it("stays silent on a number the inherited tracker used, an exempt line and no citation", () => {
		expect(
			context("Write", "a.md", { content: `See ${cite(900)}.\n` }),
		).toBeNull();
		expect(
			context("Write", "b.md", {
				content: `See ${cite(2015)}. citation-exempt: the inherited one\n`,
			}),
		).toBeNull();
		expect(context("Write", "c.md", { content: "See #2015.\n" })).toBeNull();
	});

	it("stays silent where the line was already there before the write", () => {
		const line = `Old ${cite(2015)} line.`;
		fs.writeFileSync(path.join(repo, "old.md"), `${line}\n`);
		expect(
			context("Write", "old.md", { content: `${line}\nA new line.\n` }),
		).toBeNull();
		expect(
			context("Edit", "old.md", {
				old_string: `${line}\n`,
				new_string: `${line}\nA new line.\n`,
			}),
		).toBeNull();
	});

	it.each(["../d.md", "sub/../../d.md"])(
		"stays silent on %s, a write outside the checkout (#2546)",
		(file) => {
			expect(
				context("Write", file, { content: `See ${cite(2015)}.\n` }),
			).toBeNull();
		},
	);

	it("stays silent in an adopter, where the baseline commit does not resolve", () => {
		expect(
			context(
				"Write",
				"d.md",
				{ content: `See ${cite(2015)}.\n` },
				{ extra: { WFC_CITATION_BASELINE: "0".repeat(40) } },
			),
		).toBeNull();
	});
});
