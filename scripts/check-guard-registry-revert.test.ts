// @vitest-environment node
/*
 * Tests for scripts/check-guard-registry.js: the lander's revert and the rows it leaves stale (#3127).
 *
 * The checker is a hard gate in .husky/pre-commit and roadmap-digest.yml:
 * loosen a case and a rule can claim **Enforced** while its guard is missing
 * or unwired.
 *
 * Over the run-cost budget (base §X8 (5)) by inheritance: its cases moved
 * unchanged from check-guard-registry.test.ts, whose cost was pre-existing (#4294).
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ticketFiler } from "./lib/fix-ticket.js";
import {
	landerRevertKit,
	region,
	removeTemps,
} from "./lib/guard-registry-testkit";
import { remoteGit } from "./lib/lander.js";

afterEach(removeTemps);

describe("a lander revert lands with the rows it leaves stale (#3127)", () => {
	const { repo, preCommit, push, review, landerCheckout } = landerRevertKit();

	it("passes the clean revert at commit, naming the stale row and its --review line", () => {
		const { root, git, culprit } = repo();
		git("revert", "--no-commit", culprit);
		const r = preCommit(root, culprit);
		expect(r.code, r.report).toBe(0);
		expect((r.json as unknown as { exempted: unknown[] }).exempted).toEqual([
			{ row: "STALE-PROSE scripts/guard-branch.sh", forward: review },
		]);
		expect(r.report).toContain("lander's clean revert of");
	});

	it("passes the clean revert at push to landing", () => {
		const { root, git, culprit, tip } = repo();
		git("revert", "--no-edit", culprit);
		const r = push(root, git("rev-parse", "HEAD"), tip, culprit);
		expect(r.status, r.stderr).toBe(0);
	});

	it("still refuses the same revert from an ordinary session, at commit and at push", () => {
		const { root, git, culprit, tip } = repo();
		git("revert", "--no-commit", culprit);
		const atCommit = preCommit(root);
		expect(atCommit.code).toBe(1);
		expect(atCommit.report).toContain("STALE-PROSE  scripts/guard-branch.sh");
		git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "Revert it");
		expect(push(root, git("rev-parse", "HEAD"), tip).status).toBe(2);
	});

	it("gives a commit claiming the revert but carrying an extra hunk no exemption, at commit and at push", () => {
		const { root, git, culprit, tip } = repo();
		git("revert", "--no-commit", culprit);
		fs.writeFileSync(
			path.join(root, "scripts/guard-amend.sh"),
			"#!/bin/sh\nexit 0\n",
		);
		git("add", "-A");
		const atCommit = preCommit(root, culprit);
		expect(atCommit.code).toBe(1);
		expect(atCommit.report).toContain("no staleness exemption");
		git(
			"-c",
			"core.hooksPath=/dev/null",
			"commit",
			"-qm",
			`Revert "Add extra (#12)"\n\nThis reverts commit ${culprit}.`,
		);
		const atPush = push(root, git("rev-parse", "HEAD"), tip, culprit);
		expect(atPush.status, atPush.stderr).toBe(2);
		expect(atPush.stderr).toContain("no staleness exemption");
	});

	it("lands the lander's revert on landing past both gates, and its fix ticket names the stale row and its --review line", () => {
		const { root, git, culprit, tip } = repo();
		const onRemote = landerCheckout(root, tip);

		const made = remoteGit(root).revertOnLanding(
			culprit,
			git("rev-parse", `${culprit}^`),
			"why",
		);

		const stale = [
			{ row: "STALE-PROSE scripts/guard-branch.sh", forward: review },
		];
		expect(made).toMatchObject({ onto: tip, stale });
		if (!("sha" in made)) throw new Error("no revert");
		expect(onRemote("landing")).toBe(made.sha);
		const bodies: string[] = [];
		ticketFiler({
			messageOf: () => "Add extra (#12)",
			similar: () => [],
			fileIssue: (_args, body) => {
				bodies.push(body);
				return { status: 0, stdout: "Filed #9\n", stderr: "" };
			},
			stateOf: () => "open",
			reopen: () => undefined,
		}).fileFixTicket({
			culprit,
			parent: null,
			revert: made.sha,
			files: [],
			jobs: [],
			stale: made.stale ?? [],
		});
		expect(bodies[0]).toContain(
			`- \`STALE-PROSE scripts/guard-branch.sh\`: \`${review}\``,
		);
	});

	it("holds on a revert that adds a fault other than staleness, naming the row, and pushes nothing", () => {
		const { root, git, commit } = repo();
		/* C drops the amend rule; D deletes its guard. Reverting C restores
		 * a rule naming a guard that no longer exists. */
		const culprit = commit(
			{
				"CLAUDE.md": region(
					"- Stay on `main`. **Enforced** (#110): `scripts/guard-branch.sh` denies the checkout.",
				),
			},
			"Drop the amend rule",
		);
		fs.rmSync(path.join(root, "scripts/guard-amend.sh"));
		const tip = commit({}, "Delete the amend guard");
		const onRemote = landerCheckout(root, tip);

		const made = remoteGit(root).revertOnLanding(
			culprit,
			git("rev-parse", `${culprit}^`),
			"why",
		);

		expect(made).toEqual({
			failed: expect.stringMatching(
				/^its commit was refused: .*scripts\/guard-amend\.sh.*\(fix forward: /,
			),
		});
		expect(onRemote("landing")).toBe(tip);
	});

	it("gives a clean revert whose message lacks the revert line no exemption at push", () => {
		const { root, git, culprit, tip } = repo();
		git("revert", "--no-commit", culprit);
		git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "Drop extra");
		const r = push(root, git("rev-parse", "HEAD"), tip, culprit);
		expect(r.status, r.stderr).toBe(2);
		expect(r.stderr).toContain("does not carry");
	});
});
