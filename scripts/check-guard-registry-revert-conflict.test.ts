// @vitest-environment node
/*
 * Tests for scripts/check-guard-registry.js: #3127's revert whose only conflict is in the anchors file (#3935).
 *
 * The checker is a hard gate in .husky/pre-commit and roadmap-digest.yml:
 * loosen a case and a rule can claim **Enforced** while its guard is missing
 * or unwired.
 *
 * Over the run-cost budget (base §X8 (5)) by inheritance: its cases moved
 * unchanged from check-guard-registry.test.ts, whose cost was pre-existing (#4294).
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	landerRevertKit,
	ownClaims,
	removeTemps,
	reviewIn,
	templateOf,
} from "./lib/guard-registry-testkit";
import { remoteGit } from "./lib/lander.js";
import { shellQuote } from "./lib/sh-quote.js";

afterEach(removeTemps);

describe("a lander revert lands with the rows it leaves stale (#3127)", () => {
	const { repo, tools, preCommit, push, review, landerCheckout } =
		landerRevertKit();

	describe("a revert whose only conflict is in the anchors file (#3935)", () => {
		const Anchors = ".claude/guard-registry-anchors.json";
		const lines = (first: string, last: string) =>
			`extra() { :; }\n# ${first}\n# 2\n# 3\n# 4\n# 5\n# 6\n# ${last}\n`;

		/* A culprit and a later commit, each moving the guard's anchor row. */
		let movedCulprit = "";
		let movedTip = "";
		const copy = templateOf(() => {
			const { root, commit } = repo();
			const reanchored = (first: string, last: string, msg: string) => {
				fs.writeFileSync(
					path.join(root, "scripts/lib/extra.sh"),
					lines(first, last),
				);
				reviewIn(root, ["scripts/guard-branch.sh"], ownClaims(root));
				return commit({}, msg);
			};
			reanchored("a", "z", "Spread extra");
			movedCulprit = reanchored("b", "z", "Change its head");
			movedTip = reanchored("b", "y", "Change its tail");
			return root;
		});

		function conflicting() {
			const root = copy();
			return {
				root,
				git: tools(root).git,
				culprit: movedCulprit,
				tip: movedTip,
			};
		}

		/** That culprit's revert, staged with its conflict on the tip's side. */
		function conflicted() {
			const { root, git, culprit, tip } = conflicting();
			expect(
				spawnSync("git", ["revert", "--no-commit", culprit], { cwd: root })
					.status,
			).not.toBe(0);
			expect(git("diff", "--name-only", "--diff-filter=U")).toBe(Anchors);
			fs.writeFileSync(
				path.join(root, Anchors),
				execFileSync(
					"git",
					[
						"merge-file",
						"-p",
						"--ours",
						"--object-id",
						`${tip}:${Anchors}`,
						`${culprit}:${Anchors}`,
						`${culprit}^:${Anchors}`,
					],
					{ cwd: root, encoding: "utf8" },
				),
			);
			git("add", Anchors);
			return { root, git, culprit, tip };
		}

		it("passes where the conflict keeps the tip's side, at commit and at push, naming the stale row", () => {
			const { root, git, culprit, tip } = conflicted();
			const atCommit = preCommit(root, culprit);
			expect(atCommit.code, atCommit.report).toBe(0);
			expect(
				(atCommit.json as unknown as { exempted: unknown[] }).exempted,
			).toEqual([
				{ row: "STALE-PROSE scripts/guard-branch.sh", forward: review },
			]);
			git(
				"-c",
				"core.hooksPath=/dev/null",
				"commit",
				"-qm",
				`Revert it\n\nThis reverts commit ${culprit}.`,
			);
			const atPush = push(root, git("rev-parse", "HEAD"), tip, culprit);
			expect(atPush.status, atPush.stderr).toBe(0);
		});

		it("lands the lander's own revert on landing past both gates", () => {
			const { root, git, culprit, tip } = conflicting();
			const onRemote = landerCheckout(root, tip);

			const made = remoteGit(root).revertOnLanding(
				culprit,
				git("rev-parse", `${culprit}^`),
				"why",
			);

			expect(made).toMatchObject({
				onto: tip,
				stale: [
					{ row: "STALE-PROSE scripts/guard-branch.sh", forward: review },
				],
			});
			if (!("sha" in made)) throw new Error("no revert");
			expect(onRemote("landing")).toBe(made.sha);
		});

		it("lands the lander's revert past both gates where the anchors' merge driver is defined, so nothing conflicts (#4171)", () => {
			const { root, git, culprit, tip } = conflicting();
			fs.writeFileSync(
				path.join(root, ".git", "info", "attributes"),
				`${Anchors} merge=registry-anchors\n`,
			);
			git(
				"config",
				"merge.registry-anchors.driver",
				`node ${shellQuote(path.resolve(__dirname, "merge-registry-anchors.js"))} %O %A %B`,
			);
			const onRemote = landerCheckout(root, tip);

			const made = remoteGit(root).revertOnLanding(
				culprit,
				git("rev-parse", `${culprit}^`),
				"why",
			);

			expect(made).toMatchObject({
				onto: tip,
				stale: [
					{ row: "STALE-PROSE scripts/guard-branch.sh", forward: review },
				],
			});
			if (!("sha" in made)) throw new Error("no revert");
			expect(onRemote("landing")).toBe(made.sha);
			expect(git("log", "-1", "--format=%b", made.sha)).not.toContain(
				"Conflicts in",
			);
		});

		it("gives an anchors file holding anything else no exemption", () => {
			const { root, git, culprit } = conflicted();
			fs.appendFileSync(path.join(root, Anchors), "\n");
			git("add", Anchors);
			const r = preCommit(root, culprit);
			expect(r.code).toBe(1);
			expect(r.report).toContain("not the clean revert");
		});

		it("gives a change outside the anchors file no exemption", () => {
			const { root, git, culprit } = conflicted();
			fs.writeFileSync(
				path.join(root, "scripts/lib/deny.sh"),
				"deny() { :; }\n",
			);
			git("add", "-A");
			const r = preCommit(root, culprit);
			expect(r.code).toBe(1);
			expect(r.report).toContain("not the clean revert");
		});
	});
});
