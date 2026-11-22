// @vitest-environment node

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hookEnv, rowOf, STEPS } from "./lib/post-commit-testkit";
import { newRepo, registerTempCleanup } from "./lib/precommit-gate-harness";

const temps = registerTempCleanup();

const Trailer =
	"Review-Tier: escalated; areas=secrets; base=b; tree=t; paths=s";

function reviewed() {
	const repo = newRepo("post-commit-review-tier-", temps);
	fs.writeFileSync(path.join(repo.root, "a.txt"), "x");
	repo.git("add", "-A");
	repo.git("commit", "-q", "-m", `held\n\n${Trailer}`);
	return repo;
}

function runStep(cwd: string) {
	const r = STEPS.droppedReviewTier(STEPS.buildRunIo({ cwd, env: hookEnv() }));
	expect(r.exit).toBe(0);
	expect(r.stdout).toBe("");
	return r.stderr;
}

describe(".husky/post-commit's dropped Review-Tier: notice (#4051)", () => {
	it("is wired: its registry row runs it on every route, a replay included", () => {
		const row = rowOf("dropped-review-tier");
		expect(row.run).toBe(STEPS.droppedReviewTier);
		expect(row.when).toBeUndefined();
	});

	it.each([
		["a reword", []],
		["one that changes the tree", ["b.txt"]],
	])("speaks after %s whose message leaves the line out", (_, extra) => {
		const repo = reviewed();
		for (const f of extra) fs.writeFileSync(path.join(repo.root, f), "y");
		repo.git("add", "-A");
		repo.git("commit", "-q", "--amend", "-m", "reworded");
		expect(runStep(repo.root)).toBe(
			"post-commit: this amend dropped the Review-Tier: line the amended commit carried, so the review it recorded is now unrecorded. On an unchanged tree, amend again with that line in the message to keep it.\n",
		);
	});

	it("reads the line in any case, with blanks before its colon, on both sides of the amend", () => {
		const repo = newRepo("post-commit-review-tier-spelt-", temps);
		fs.writeFileSync(path.join(repo.root, "a.txt"), "a\n");
		repo.git("add", "-A");
		repo.git("commit", "-q", "-m", "a\n\nreview-tier  : light");
		repo.git("commit", "-q", "--amend", "-m", "a again\n\nReview-Tier: light");
		expect(runStep(repo.root)).toBe("");
		repo.git("commit", "-q", "--amend", "-m", "a, its tier dropped");
		expect(runStep(repo.root)).toContain(
			"this amend dropped the Review-Tier: line",
		);
	});

	it("says nothing after an amend that keeps the line", () => {
		const repo = reviewed();
		repo.git("commit", "-q", "--amend", "--no-edit");
		expect(runStep(repo.root)).toBe("");
	});

	it("says nothing after an empty commit on a reviewed HEAD", () => {
		const repo = reviewed();
		repo.git("commit", "-q", "--allow-empty", "-m", "empty");
		expect(runStep(repo.root)).toBe("");
	});
});
