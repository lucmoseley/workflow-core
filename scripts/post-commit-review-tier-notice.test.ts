// @vitest-environment node
/*
 * .husky/post-commit's notice after an amend that dropped the amended commit's
 * `Review-Tier:` line (#4051), its block cut from the hook's own text and run
 * as post-commit-touched-by-notice.test.ts runs the blocks beside it. Loosen a
 * case and a reviewed commit's record goes with no word, or an empty commit on
 * a reviewed HEAD is told it amended something.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { newRepo, registerTempCleanup } from "./lib/precommit-gate-harness";
import { cutShellFunction, POST_COMMIT } from "./lib/precommit-gate-testkit";

const temps = registerTempCleanup();

const NAME = "report_dropped_review_tier";
const Trailer =
	"Review-Tier: escalated; areas=secrets; base=b; tree=t; paths=s";

/** A repo whose HEAD carries a Review-Tier: line. */
function reviewed() {
	const repo = newRepo("post-commit-review-tier-", temps);
	fs.writeFileSync(path.join(repo.root, "a.txt"), "x");
	repo.git("add", "-A");
	repo.git("commit", "-q", "-m", `held\n\n${Trailer}`);
	return repo;
}

/** `sh -e`, as .husky/_/h runs every hook; the marker proves the block returned. */
function runBlock(cwd: string) {
	const r = spawnSync(
		"sh",
		["-e", "-c", `${cutShellFunction(NAME)}\n${NAME}\nprintf "reached-end\\n"`],
		{ cwd, encoding: "utf8" },
	);
	expect(r.stdout).toBe("reached-end\n");
	expect(r.status).toBe(0);
	return r.stderr;
}

describe(".husky/post-commit's dropped Review-Tier: notice (#4051)", () => {
	it("is invoked at column zero, not only defined", () => {
		expect(POST_COMMIT.split("\n")).toContain(NAME);
	});

	it.each([
		["a reword", []],
		["one that changes the tree", ["b.txt"]],
	])("speaks after %s whose message leaves the line out", (_, extra) => {
		const repo = reviewed();
		for (const f of extra) fs.writeFileSync(path.join(repo.root, f), "y");
		repo.git("add", "-A");
		repo.git("commit", "-q", "--amend", "-m", "reworded");
		expect(runBlock(repo.root)).toContain(
			"this amend dropped the Review-Tier: line",
		);
	});

	it("says nothing after an amend that keeps the line", () => {
		const repo = reviewed();
		repo.git("commit", "-q", "--amend", "--no-edit");
		expect(runBlock(repo.root)).toBe("");
	});

	it("says nothing after an empty commit on a reviewed HEAD", () => {
		const repo = reviewed();
		repo.git("commit", "-q", "--allow-empty", "-m", "empty");
		expect(runBlock(repo.root)).toBe("");
	});
});
