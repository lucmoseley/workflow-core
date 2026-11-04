// @vitest-environment node
/*
 * new-repo.js stopped by a hook refusing the skeleton commit, then --resume
 * once it is fixed, through the new repo's real hook stack (#4297).
 * new-repo.test.ts's header says how a run is driven and what a loosened case
 * costs.
 *
 * Over the run-cost budget (base §X8 (5)): its one case is a run §X8 (2) keeps
 * on the real hook stack, which is most of its time.
 */

import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	builtThrough,
	cleanRun,
	type Golden,
	HAS_GITLEAKS,
	newRepoSuite,
	RUN_TIMEOUT_MS,
	statusOf,
} from "./new-repo-testkit";

newRepoSuite();

describe.skipIf(!HAS_GITLEAKS)(
	"new-repo.js --resume after a part-way stop",
	() => {
		let golden: Golden;
		beforeAll(() => {
			golden = cleanRun(false, { hooks: false }).golden;
		}, RUN_TIMEOUT_MS);

		it("stops, exit 2, on a hook refusing the skeleton commit, printing its output word for word, and --resume finishes once it is fixed", () => {
			const s = builtThrough("plugin reads", false, undefined, golden);
			/* A copied repo's own gate (#694 item 6), which the core's wiring
			 * gate refuses until its header says what it does. */
			const gate = path.join(s.clone, ".husky/pre-commit.local");
			fs.writeFileSync(gate, ":\n");
			const r = s.resume();
			expect(r.status, r.stdout).toBe(2);
			expect(r.stdout).toMatch(
				/^commit {9}STOPPED — a hook refused the skeleton commit$/m,
			);
			expect(r.stdout).toContain(
				"UNANNOTATED  .husky/pre-commit.local:1\n  wiring:  wired at git\n",
			);
			expect(r.stdout).toContain("FAIL: 1 fault(s) this commit adds\n");
			expect(r.stdout).toContain(
				"Manual step: open a new tab, run `td1`, fix it in that session, then re-run from workflow-core: node .claude/skills/new-repo/scripts/new-repo.js --resume tides --no-plugin-install\nThen re-run: node .claude/skills/new-repo/scripts/new-repo.js --resume tides --no-plugin-install\n",
			);
			expect(() => s.git("rev-parse", "--verify", "-q", "HEAD")).toThrow();

			fs.writeFileSync(
				gate,
				"# shellcheck shell=sh\n# IMPLICIT: runs tides's own checks on every commit\n# JUSTIFIED: fail-safe — the source repo's checks keep running\n# DEFEAT: none\n:\n",
			);
			const again = s.resume();
			expect(again.status, again.stdout).toBe(0);
			expect(statusOf(again.stdout, "commit")).toBe("done");
			expect(statusOf(again.stdout, "push")).toBe("done");
			expect(s.git("ls-files", ".husky/pre-commit.local")).toBe(
				".husky/pre-commit.local",
			);
			expect(s.git("rev-parse", "origin/main")).toBe(
				s.git("rev-parse", "HEAD"),
			);
		}, 340_000);
	},
);
