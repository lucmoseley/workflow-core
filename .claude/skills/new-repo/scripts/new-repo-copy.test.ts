// @vitest-environment node
/*
 * new-repo.js --source: copying a source repo into the new one. Split from
 * new-repo.test.ts, whose header says how a run is driven and what a loosened
 * case costs (#3258).
 *
 * Over the run-cost budget (base §X8 (5)) by inheritance: its cases moved
 * unchanged from new-repo.test.ts, whose cost was pre-existing (#3258).
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initPaths } from "../../../../scripts/init-adopter.js";
import { HOOKS } from "../../../../scripts/lib/adopter-skeleton.js";
import { runInProcess } from "../../../../scripts/lib/run-in-process.js";
import {
	builtThrough,
	HAS_GITLEAKS,
	IGNORE_BLOCK,
	newRepoSuite,
	readEndState,
	readIgnoredScratch,
	reported,
	type Sandbox,
	SET_ASIDE_HOOK,
	SOURCE,
	SOURCE_AGENTS,
	SOURCE_HOOK,
	SOURCE_IGNORE,
	sandbox,
	statusOf,
} from "./new-repo-testkit";

newRepoSuite();

/** Scratch clones of the source repo left in TMPDIR, where the hook stack keeps files of its own. */
const readScratchLeft = (s: Sandbox) =>
	fs
		.readdirSync(path.join(s.sb, "tmp"))
		.filter((f) => f.startsWith("new-repo-source-"));

const KEEP_BLOCK =
	"# --- workflow-core: keep the core's files trackable (new-repo.js) ---\n!/CLAUDE.md\n# --- end workflow-core block ---\n";

describe("new-repo.js copying a source repo", () => {
	it("--dry-run names the source repo's licence and workflows, suites with the test command, and the negations, and writes nothing", () => {
		const s = sandbox({ source: SOURCE_IGNORE });
		const r = s.run("--dry-run");
		expect(r.status, r.stdout + r.stderr).toBe(0);
		expect(r.stdout).toContain(
			"source repo    would — push octo/surf-lib's trunk to lucmoseley/tides as main, with its tags; upstream fetch-only\n  licence: MIT License\n  workflows: .github/workflows/ci.yml — GitHub Actions runs them in lucmoseley/tides on their own triggers\n",
		);
		expect(r.stdout).toContain("--modules suites ");
		expect(r.stdout).toContain(
			"modules        suites\n  commands: test: npm run test (package.json)\n",
		);
		expect(r.stdout).toContain(
			"set aside      would — move AGENTS.md to docs/source/AGENTS.source.md, move .husky/pre-commit to .husky/pre-commit.local\n",
		);
		expect(r.stdout).toContain(
			"gitignore      would — append negations to .gitignore for CLAUDE.md\n",
		);
		expect(r.stdout).toContain(
			'source docs    would — register the source repo\'s docs in docs/doc-map.md §A under "Source repo docs (octo/surf-lib)", class source-of-truth\n',
		);
		expect(r.stdout).toContain(
			`reconcile      would — "Reconcile octo/surf-lib's agent instructions with the core's" under the first map, labelled wayfinder:grilling + takes:wayfinder, unassigned\n`,
		);
		expect(s.readState()).toBeNull();
		expect(fs.existsSync(s.clone)).toBe(false);
		expect(readScratchLeft(s)).toEqual([]);
		expect(
			s
				.readCalls()
				.some((c) => c.join(" ").startsWith(`repo clone ${SOURCE} `)),
		).toBe(true);
	});

	it("refuses, exit 2, a source repo whose .gitignore hides a parent directory of init's files, naming its line, and creates nothing", () => {
		const s = sandbox({ source: "node_modules/\n.claude/\n" });
		const r = s.run();
		expect(r.status, r.stdout).toBe(2);
		expect(r.stdout).toMatch(
			/^preflight {6}STOPPED — the source repo's \.gitignore:2 \("\.claude\/"\) hides \.claude\/workflow-core\.json, .*, and no negation can undo it$/m,
		);
		expect(r.stdout).toContain(
			"Manual step: pick another source repo: the core's files cannot be kept trackable past that line\nThen start again: /new-repo\n",
		);
		expect(s.readState()).toBeNull();
		expect(readScratchLeft(s)).toEqual([]);
	});

	it("refuses, exit 2, a source repo with a hook the core's would overwrite, other than pre-commit, and creates nothing", () => {
		const s = sandbox({
			source: SOURCE_IGNORE,
			sourceFiles: { ".husky/pre-push": "npm test\n" },
		});
		const r = s.run();
		expect(r.status, r.stdout).toBe(2);
		expect(r.stdout).toContain(
			"preflight      STOPPED — the source repo has .husky/pre-push, which the core's hook of the same name would overwrite\n\nManual step: pick another source repo: only a source pre-commit can be kept, as .husky/pre-commit.local\nThen start again: /new-repo\n",
		);
		expect(s.readState()).toBeNull();
		expect(readScratchLeft(s)).toEqual([]);
	});

	it("refuses, exit 2, a source repo gh cannot reach, naming it and how to start again, and records no state", () => {
		const s = sandbox();
		const r = s.run("--source", "octo/nowhere");
		expect(r.status, r.stdout).toBe(2);
		expect(r.stdout).toContain(
			"STOPPED — the source repo octo/nowhere is not reachable\n\nManual step: check its owner/name, and that gh's account can read it\nThen start again: /new-repo\n",
		);
		expect(s.readState()).toBeNull();
	});

	it("gives the same git check-ignore verdict on init's paths before init writes them as after, and init writes no path outside that list", () => {
		const s = sandbox();
		const repo = path.join(s.sb, "verdict");
		execFileSync("git", ["init", "-q", "-b", "main", repo], { env: s.env });
		fs.writeFileSync(
			path.join(repo, ".gitignore"),
			".husky/\ndocs/*.json\n/AGENTS.md\n*.md\n!README.md\n.claude/*.json\n!/.claude/settings.json\n",
		);
		const paths: string[] = initPaths(["roadmap"]);
		const readIgnoreVerdict = () =>
			spawnSync("git", ["check-ignore", "-v", "-n", "--stdin"], {
				cwd: repo,
				input: `${paths.join("\n")}\n`,
				encoding: "utf8",
				env: s.env,
			}).stdout;
		const before = readIgnoreVerdict();
		expect(before).toMatch(/\.husky\/\t\.husky\/pre-commit$/m);
		expect(before).toMatch(
			/:!\/\.claude\/settings\.json\t\.claude\/settings\.json$/m,
		);
		expect(before).toMatch(/^::\tscripts\/browse\.py$/m);
		const init = runInProcess(
			path.resolve(__dirname, "../../../../scripts/init-adopter.js"),
			[
				"--root",
				repo,
				"--founder",
				"Test Founder",
				"--modules",
				"roadmap",
				"--no-tracker",
				"--no-plugin-install",
			],
			{ cwd: repo, env: { ...s.env, CLAUDE_PROJECT_DIR: repo } },
		);
		expect(init.status, init.stdout + init.stderr).toBe(0);
		expect(readIgnoreVerdict()).toBe(before);
		const written = execFileSync(
			"git",
			["ls-files", "--others", "--exclude-standard", "--ignored", "-o"],
			{ cwd: repo, encoding: "utf8", env: s.env },
		);
		const untracked = execFileSync("git", ["ls-files", "--others"], {
			cwd: repo,
			encoding: "utf8",
			env: s.env,
		});
		const all = [...new Set(`${written}${untracked}`.split("\n"))].filter(
			Boolean,
		);
		expect(all.filter((f) => !paths.includes(f))).toEqual([]);
	}, 60_000);

	it.skipIf(!HAS_GITLEAKS)(
		"mirrors the default branch as main with its tags, keeps the source as a fetch-only upstream, keeps init's files trackable, starts with suites, and a second run finds every step done",
		() => {
			const s = sandbox({ source: SOURCE_IGNORE });
			const r = s.run();
			expect(r.status, r.stdout).toBe(0);
			for (const step of reported(true))
				expect(statusOf(r.stdout, step), step).toBe("done");
			expect(r.stdout).toContain(
				"source repo    done — octo/surf-lib's trunk pushed as main, 2 tags pushed, upstream fetch-only\n  licence: MIT License\n  workflows: .github/workflows/ci.yml",
			);
			expect(r.stdout).toContain(
				"gitignore      done — negations appended to .gitignore for CLAUDE.md\n",
			);
			expect(r.stdout).toContain(
				"set aside      done — AGENTS.md → docs/source/AGENTS.source.md, .husky/pre-commit → .husky/pre-commit.local, # shellcheck shell=sh added to .husky/pre-commit.local\n",
			);
			expect(r.stdout).toContain(
				'source docs    done — 2 registered in docs/doc-map.md §A under "Source repo docs (octo/surf-lib)"\n',
			);
			expect(r.stdout).toContain("reconcile      done — #2 under #1\n");
			expect(r.stdout).toMatch(/^init-adopter {3}done — .*, modules suites$/m);

			// The default branch and tags only: never the stale branch, never a fork.
			expect(readEndState(s).originRefs).toEqual([
				"refs/heads/main",
				"refs/tags/v1",
				"refs/tags/v2",
			]);
			expect(s.readCalls().some((c) => c.includes("fork"))).toBe(false);
			expect(s.git("rev-list", "--count", "HEAD")).toBe("3");
			expect(s.git("show", "HEAD:lib/tide.js")).toBe(
				"module.exports = () => 2;",
			);
			expect(s.git("rev-parse", "origin/main")).toBe(
				s.git("rev-parse", "HEAD"),
			);
			expect(s.git("config", "--get", "remote.upstream.url")).toBe(
				`https://github.com/${SOURCE}.git`,
			);
			expect(s.git("config", "--get", "remote.upstream.pushurl")).toBe(
				"no-push",
			);

			expect(fs.readFileSync(path.join(s.clone, ".gitignore"), "utf8")).toBe(
				`${SOURCE_IGNORE}${IGNORE_BLOCK}${KEEP_BLOCK}`,
			);
			// The negations follow the block and reach none of its paths.
			expect(readIgnoredScratch(s)).toBe(
				"private/x\n.claude/tmp/x\n.claude/worktrees/x\n",
			);
			expect(s.git("ls-files", "CLAUDE.md", "AGENTS.md", ".gitignore")).toBe(
				".gitignore\nAGENTS.md\nCLAUDE.md",
			);
			// settings.local.json is this machine's, left untracked as in the empty flow.
			expect(s.git("status", "--porcelain")).toBe(
				"?? .claude/settings.local.json",
			);

			const config = JSON.parse(
				fs.readFileSync(
					path.join(s.clone, ".claude/workflow-core.json"),
					"utf8",
				),
			);
			expect(config.modules).toEqual(["suites"]);
			expect(config.commands.test).toBe("npm run test");

			expect(s.git("show", "HEAD:docs/source/AGENTS.source.md")).toBe(
				SOURCE_AGENTS.trim(),
			);
			expect(s.git("show", "HEAD:.husky/pre-commit.local")).toBe(
				SET_ASIDE_HOOK.trim(),
			);
			expect(s.git("show", "HEAD:AGENTS.md")).not.toContain(
				"Open a pull request",
			);
			const classes = JSON.parse(
				fs.readFileSync(
					path.join(s.clone, "docs/doc-map-classes.json"),
					"utf8",
				),
			);
			const route = "Path-scoped cherry-pick from `upstream` only";
			expect(classes["docs/tides.md"]).toEqual({
				section: "Source repo docs (octo/surf-lib)",
				class: "source-of-truth",
				classQualifier: null,
				role: "From the source repo octo/surf-lib, kept as copied",
				route,
				consumes: null,
				reader: "both",
			});
			expect(classes["docs/source/AGENTS.source.md"]).toMatchObject({
				section: "Source repo docs (octo/surf-lib)",
				class: "source-of-truth",
				role: "The source repo's AGENTS.md, set aside where no session loads it",
				route,
				reader: "agent",
			});
			expect(
				fs.readFileSync(path.join(s.clone, "docs/doc-map.md"), "utf8"),
			).toContain("### Source repo docs (octo/surf-lib)\n");

			const [, ticket] = s.readState().issues;
			expect(ticket.title).toBe(
				"Reconcile octo/surf-lib's agent instructions with the core's",
			);
			expect(ticket.labels.sort()).toEqual([
				"takes:wayfinder",
				"wayfinder:grilling",
			]);
			expect(ticket.parent).toBe(1);
			expect(ticket.assignees).toEqual([]);
			expect(ticket.body).toContain(
				"- `docs/source/AGENTS.source.md` — the source repo's `AGENTS.md`",
			);
			expect(readScratchLeft(s)).toEqual([]);

			const again = s.resume();
			expect(again.status, again.stdout).toBe(0);
			for (const step of reported(true).filter((n) => n !== "init-adopter"))
				expect(statusOf(again.stdout, step), step).toBe("skipped");
			expect(again.stdout).toContain("  licence: MIT License\n");
			expect(s.readState().issues).toHaveLength(2);
			expect(readEndState(s).originRefs).toHaveLength(3);
		},
		340_000,
	);

	it("stops, exit 2, where origin's main is not an ancestor of the clone's main, offering a hand settle and a --resume re-run as the way out", () => {
		const s = builtThrough("source repo", true);
		s.git(
			"-c",
			"core.hooksPath=/dev/null",
			"commit",
			"-q",
			"--allow-empty",
			"-m",
			"pushed from elsewhere",
		);
		s.git("push", "-q", "origin", "main");
		s.git("reset", "-q", "--hard", "HEAD~1");
		const r = s.resume();
		expect(r.status, r.stdout).toBe(2);
		expect(r.stdout).toMatch(
			/^source repo {4}STOPPED — lucmoseley\/tides's main is not an ancestor of ~\/tides's main: the two have diverged$/m,
		);
		expect(r.stdout).toContain(
			"Manual step: settle ~/tides's main against origin/main by hand\nThen re-run: node .claude/skills/new-repo/scripts/new-repo.js --resume tides --no-plugin-install\n",
		);
		expect(fs.existsSync(path.join(s.clone, "CLAUDE.md"))).toBe(false);
	}, 60_000);

	it("leaves a tag the source repo moved after the copy at origin's sha, and a re-run carries on past it", () => {
		const s = builtThrough("source repo", true);
		const v1 = s.git("rev-parse", "refs/tags/v1");
		execFileSync("git", [
			"-C",
			path.join(s.sb, "github", `${SOURCE}.git`),
			"tag",
			"-f",
			"v1",
			"trunk",
		]);
		// Stop the run at the map, past the copy and short of the commit.
		fs.writeFileSync(path.join(s.sb, "fail/issue-create"), "");
		const r = s.resume();
		expect(r.status, r.stdout).toBe(1);
		expect(r.stdout).toMatch(/^source repo {4}skipped — already done — /m);
		expect(
			execFileSync("git", ["ls-remote", "--tags", "--refs", "origin", "v1"], {
				cwd: s.clone,
				encoding: "utf8",
				env: s.env,
			}).split("\t")[0],
		).toBe(v1);
	}, 60_000);

	it("stops, exit 2, where a line in the clone's .gitignore defeats the negations, naming it, and a re-run only re-checks the block", () => {
		const s = builtThrough("init-adopter", true);
		const ignore = path.join(s.clone, ".gitignore");
		fs.appendFileSync(ignore, ".husky/\n");
		const r = s.resume();
		expect(r.status, r.stdout).toBe(2);
		// The appended `.husky/` is the line after every line those two end.
		const line = `${SOURCE_IGNORE}${IGNORE_BLOCK}`.split("\n").length;
		expect(r.stdout).toMatch(
			new RegExp(
				`^gitignore {6}STOPPED — \\.gitignore:${line} \\("\\.husky/"\\) hides \\.husky/prepare-commit-msg, .*, and no negation can undo it$`,
				"m",
			),
		);
		expect(r.stdout).toContain(
			"Manual step: narrow or remove that line in ~/tides — a pattern hiding a parent directory, such as `.claude/`, defeats any negation\n",
		);
		const written = fs.readFileSync(ignore, "utf8");
		// Every hidden path is negated, the hooks too, though no negation reaches them;
		// the source repo's own pre-commit is tracked, so git hides it from nothing.
		expect(written).toBe(
			`${SOURCE_IGNORE}${IGNORE_BLOCK}.husky/\n${KEEP_BLOCK.replace(
				"# --- end",
				`${[...HOOKS.filter((h) => h !== "pre-commit"), "pre-commit.local"]
					.map((h) => `!/.husky/${h}\n`)
					.join("")}# --- end`,
			)}`,
		);

		const again = s.resume();
		expect(again.status, again.stdout).toBe(2);
		expect(statusOf(again.stdout, "gitignore")).toBe("STOPPED");
		expect(fs.readFileSync(ignore, "utf8")).toBe(written);
	}, 120_000);

	it("stops, exit 2, where the source repo's file and a different set-aside copy are both present, naming which to keep, and a re-run finishes the move once one is deleted", () => {
		const s = builtThrough("source repo", true);
		const copy = path.join(s.clone, "docs/source/AGENTS.source.md");
		fs.mkdirSync(path.dirname(copy), { recursive: true });
		fs.writeFileSync(copy, `${SOURCE_AGENTS}Kept: the tide notes.\n`);
		// Stop the run at the map, past the step and short of the commit.
		fs.writeFileSync(path.join(s.sb, "fail/issue-create"), "");
		const r = s.resume();
		expect(r.status, r.stdout).toBe(2);
		expect(r.stdout).toContain(
			"set aside      STOPPED — ~/tides holds both the source repo's AGENTS.md and a different docs/source/AGENTS.source.md\n\nManual step: keep the text you mean in ~/tides/docs/source/AGENTS.source.md, then delete ~/tides/AGENTS.md\n",
		);
		expect(fs.readFileSync(path.join(s.clone, "AGENTS.md"), "utf8")).toBe(
			SOURCE_AGENTS,
		);
		expect(fs.existsSync(path.join(s.clone, "CLAUDE.md"))).toBe(false);

		fs.rmSync(path.join(s.clone, "AGENTS.md"));
		const again = s.resume();
		expect(again.status, again.stdout).toBe(1);
		expect(again.stdout).toContain(
			"set aside      done — .husky/pre-commit → .husky/pre-commit.local, # shellcheck shell=sh added to .husky/pre-commit.local\n",
		);
		expect(statusOf(again.stdout, "first map")).toBe("STOPPED");
		expect(fs.readFileSync(copy, "utf8")).toBe(
			`${SOURCE_AGENTS}Kept: the tide notes.\n`,
		);
	}, 120_000);

	it("finishes a move whose copy was made but whose original was left, and removes a CLAUDE.md that only links to AGENTS.md", () => {
		const s = builtThrough("source repo", true, {
			source: "node_modules/\n",
			sourceFiles: { "CLAUDE.md": { link: "AGENTS.md" } },
		});
		fs.mkdirSync(path.join(s.clone, ".husky"), { recursive: true });
		// A copy already holding its shell directive (#1870).
		fs.writeFileSync(
			path.join(s.clone, ".husky/pre-commit.local"),
			SET_ASIDE_HOOK,
		);
		fs.writeFileSync(path.join(s.sb, "fail/issue-create"), "");
		const r = s.resume();
		expect(r.status, r.stdout).toBe(1);
		expect(r.stdout).toContain(
			"set aside      done — CLAUDE.md, a link to AGENTS.md, removed, AGENTS.md → docs/source/AGENTS.source.md\n",
		);
		expect(fs.lstatSync(path.join(s.clone, "CLAUDE.md")).isSymbolicLink()).toBe(
			false,
		);
		expect(
			fs.readFileSync(
				path.join(s.clone, "docs/source/AGENTS.source.md"),
				"utf8",
			),
		).toBe(SOURCE_AGENTS);
		expect(
			fs.existsSync(path.join(s.clone, "docs/source/CLAUDE.source.md")),
		).toBe(false);
		// The core's hook, init's own, where the source repo's was.
		expect(
			fs.readFileSync(path.join(s.clone, ".husky/pre-commit"), "utf8"),
		).not.toBe(SOURCE_HOOK);
		expect(
			fs.readFileSync(path.join(s.clone, ".husky/pre-commit.local"), "utf8"),
		).toBe(SET_ASIDE_HOOK);
	}, 120_000);

	it("finishes a move whose byte-for-byte copy was made but whose original was left, adding the shell directive the copy lacks (#1870)", () => {
		const s = builtThrough("source repo", true);
		fs.writeFileSync(
			path.join(s.clone, ".husky/pre-commit.local"),
			SOURCE_HOOK,
		);
		fs.writeFileSync(path.join(s.sb, "fail/issue-create"), "");
		const r = s.resume();
		expect(r.status, r.stdout).toBe(1);
		expect(
			fs.readFileSync(path.join(s.clone, ".husky/pre-commit.local"), "utf8"),
		).toBe(SET_ASIDE_HOOK);
		expect(
			fs.readFileSync(path.join(s.clone, ".husky/pre-commit"), "utf8"),
		).not.toBe(SOURCE_HOOK);
	}, 120_000);

	it("moves a source hook that names its shell byte for byte, adding nothing (#1870)", () => {
		const hook = `#!/bin/sh\n${SOURCE_HOOK}`;
		const s = builtThrough("source repo", true, {
			source: SOURCE_IGNORE,
			sourceFiles: { ".husky/pre-commit": hook },
		});
		fs.writeFileSync(path.join(s.sb, "fail/issue-create"), "");
		const r = s.resume();
		expect(r.status, r.stdout).toBe(1);
		expect(r.stdout).toContain(
			"set aside      done — AGENTS.md → docs/source/AGENTS.source.md, .husky/pre-commit → .husky/pre-commit.local\n",
		);
		expect(
			fs.readFileSync(path.join(s.clone, ".husky/pre-commit.local"), "utf8"),
		).toBe(hook);
	}, 120_000);

	it("warns where the source repo's AGENTS.md was edited before the move, and leaves it where it is", () => {
		const s = builtThrough("source repo", true);
		const agents = path.join(s.clone, "AGENTS.md");
		fs.writeFileSync(agents, `${SOURCE_AGENTS}Edited in the clone.\n`);
		fs.writeFileSync(path.join(s.sb, "fail/issue-create"), "");
		const r = s.resume();
		expect(r.status, r.stdout).toBe(1);
		expect(r.stdout).toContain(
			"set aside      done — .husky/pre-commit → .husky/pre-commit.local, # shellcheck shell=sh added to .husky/pre-commit.local\n  warning: AGENTS.md differs from the source repo's and was left where it is\n",
		);
		expect(fs.readFileSync(agents, "utf8")).toBe(
			`${SOURCE_AGENTS}Edited in the clone.\n`,
		);
		expect(
			fs.existsSync(path.join(s.clone, "docs/source/AGENTS.source.md")),
		).toBe(false);
	}, 120_000);
});
