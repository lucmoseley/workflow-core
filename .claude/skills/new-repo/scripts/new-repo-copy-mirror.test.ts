// @vitest-environment node

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isCutOver } from "../../../../scripts/lib/cutover.js";
import {
	cleanRun,
	HAS_GITLEAKS,
	IGNORE_BLOCK,
	KEEP_BLOCK,
	newRepoSuite,
	RUN_TIMEOUT_MS,
	readEndState,
	readIgnoredScratch,
	readScratchLeft,
	reported,
	SET_ASIDE_HOOK,
	SOURCE,
	SOURCE_AGENTS,
	SOURCE_IGNORE,
	sandbox,
	statusOf,
} from "./new-repo-testkit";

newRepoSuite();

describe("new-repo.js copying a source repo", () => {
	it.skipIf(!HAS_GITLEAKS)(
		"mirrors the default branch as main with its tags, keeps the source as a fetch-only upstream, keeps init's files trackable, starts with no module and landing, and a second run finds every step done",
		() => {
			const s = sandbox({ source: SOURCE_IGNORE });
			const r = s.run();
			expect(r.status, r.stdout).toBe(0);
			expect(readEndState(s)).toEqual(
				cleanRun(true, { hooks: false }).goldenEnd,
			);
			for (const step of reported(true))
				expect(statusOf(r.stdout, step), step).toBe("done");
			expect(r.stdout).toContain(
				"source repo    done — octo/surf-lib's trunk is main, 2 tags pushed, upstream fetch-only\n  licence: MIT License\n  workflows: .github/workflows/ci.yml",
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
			expect(r.stdout).toMatch(/^init-adopter {3}done — .*, modules none$/m);

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
			expect(
				s.git("worktree", "list", "--porcelain").match(/^worktree /gm),
			).toHaveLength(1);
			expect(s.git("config", "--get", "remote.upstream.url")).toBe(
				`https://github.com/${SOURCE}.git`,
			);
			expect(s.git("config", "--get", "remote.upstream.pushurl")).toBe(
				"no-push",
			);

			expect(fs.readFileSync(path.join(s.clone, ".gitignore"), "utf8")).toBe(
				`${SOURCE_IGNORE}${IGNORE_BLOCK}${KEEP_BLOCK}`,
			);
			expect(readIgnoredScratch(s)).toBe(
				"private/x\n.claude/tmp/x\n.claude/worktrees/x\n",
			);
			expect(s.git("ls-files", "CLAUDE.md", "AGENTS.md", ".gitignore")).toBe(
				".gitignore\nAGENTS.md\nCLAUDE.md",
			);
			expect(s.git("status", "--porcelain")).toBe(
				"?? .claude/settings.local.json",
			);

			const config = JSON.parse(
				fs.readFileSync(
					path.join(s.clone, ".claude/workflow-core.json"),
					"utf8",
				),
			);
			expect(config.modules).toEqual([]);
			expect(isCutOver(s.clone)).toBe(true);
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
				"origin:wayfinder",
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
		3 * RUN_TIMEOUT_MS,
	);
});
