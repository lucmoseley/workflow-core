// @vitest-environment node
/*
 * Tests for the second baseline a verified lander revert is judged against
 * (#4451): scripts/lander-revert-base.js, lib/clean-revert.js's
 * readRevertBase and lib/check.js's --against diff, driven through
 * check-guard-registry.js, a direction gate the lander's revert meets.
 *
 * Near the run-cost budget (base §X8 (5)): two cases cross the lander's real
 * revert, commit hooks and push, as check-guard-registry-revert.test.ts's do;
 * the fixture is built once and copied per case.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	landerRevertKit,
	region,
	removeTemps,
} from "./lib/guard-registry-testkit";
import { remoteGit } from "./lib/lander.js";
import { runInProcess } from "./lib/run-in-process";

afterEach(removeTemps);

const BRANCH =
	"- Stay on `main`. **Enforced** (#110): `scripts/guard-branch.sh` denies the checkout.";
const AMEND =
	"- Never amend. **Enforced** (#111): `scripts/guard-amend.sh` denies it.";
/* Names a guard no tree holds: a fault wherever the claim stands. */
const SQUASH =
	"- Never squash. **Enforced** (#113): `scripts/guard-squash.sh` denies it.";

describe("a verified lander revert is judged against its culprit's parent as well as HEAD (#4451)", () => {
	const { repo, preCommit, landerCheckout } = landerRevertKit();

	/** Parent claims the missing squash guard; the culprit drops `dropped`. */
	function culpritRemovingFault(dropped: string[]) {
		const r = repo();
		const parent = r.commit(
			{ "CLAUDE.md": region(BRANCH, AMEND, SQUASH) },
			"Claim a squash guard",
		);
		const kept = [BRANCH, AMEND, SQUASH].filter((l) => !dropped.includes(l));
		const culprit = r.commit(
			{ "CLAUDE.md": region(...kept) },
			"Drop claims (#12)",
		);
		return { ...r, parent, culprit };
	}

	it("lands a revert that re-adds a fault its culprit removed", () => {
		const { root, commit, culprit, parent } = culpritRemovingFault([SQUASH]);
		const tip = commit({ "notes.txt": "moved on\n" }, "Move the tip");
		const onRemote = landerCheckout(root, tip);

		const made = remoteGit(root).revertOnLanding(culprit, parent, "why");

		expect(made).toMatchObject({ onto: tip });
		if (!("sha" in made)) throw new Error(`no revert: ${made.failed}`);
		expect(onRemote("landing")).toBe(made.sha);
	});

	it("refuses the same revert carrying a fault in neither tree, naming that fault alone", () => {
		const { root, commit, culprit, parent } = culpritRemovingFault([
			SQUASH,
			AMEND,
		]);
		fs.rmSync(path.join(root, "scripts/guard-amend.sh"));
		const tip = commit({}, "Delete the amend guard");
		const onRemote = landerCheckout(root, tip);

		const made = remoteGit(root).revertOnLanding(culprit, parent, "why");

		expect(made).toEqual({
			failed: expect.stringMatching(/^its commit was refused: /),
		});
		if (!("failed" in made)) throw new Error("revert landed");
		expect(made.failed).toContain("scripts/guard-amend.sh");
		expect(made.failed).not.toContain("scripts/guard-squash.sh");
		expect(onRemote("landing")).toBe(tip);
	});

	it("keeps the HEAD baseline alone for a commit naming the culprit that is no clean revert", () => {
		const { root, git, commit, culprit } = culpritRemovingFault([SQUASH]);
		commit({ "notes.txt": "moved on\n" }, "Move the tip");
		git("revert", "--no-commit", culprit);
		fs.writeFileSync(path.join(root, "notes.txt"), "an extra hunk\n");
		git("add", "-A");

		const base = readBase(root, culprit);
		const r = preCommit(root, culprit, base);

		expect(base).toBe("");
		expect(r.code, r.report).toBe(1);
		expect(r.report).toContain("scripts/guard-squash.sh");
	});

	it("leaves the resolution to the hook: a gate given no base judges the clean revert against HEAD alone", () => {
		const { root, git, commit, culprit, parent } = culpritRemovingFault([
			SQUASH,
		]);
		commit({ "notes.txt": "moved on\n" }, "Move the tip");
		git("revert", "--no-commit", culprit);

		expect(readBase(root, culprit)).toBe(parent);
		expect(preCommit(root, culprit).code).toBe(1);
		expect(preCommit(root, culprit, parent).code).toBe(0);
	});

	it("resolves the base once in .husky/pre-commit, before its first direction gate", () => {
		const hook = fs.readFileSync(
			path.join(__dirname, "..", ".husky", "pre-commit"),
			"utf8",
		);
		const resolutions = hook.match(/scripts\/lander-revert-base\.js/g) ?? [];
		expect(resolutions).toHaveLength(1);
		expect(hook.indexOf("export WFC_LANDER_REVERT_BASE")).toBeLessThan(
			hook.indexOf("--against HEAD"),
		);
	});
});

/** What scripts/lander-revert-base.js prints in `root` for `culprit`. */
function readBase(root: string, culprit: string): string {
	const r = runInProcess(
		path.join(root, "scripts", "lander-revert-base.js"),
		[],
		{ cwd: root, env: { WFC_LANDER_REVERT: culprit } },
	);
	expect(r.status, r.stderr).toBe(0);
	return r.stdout.trim();
}
