// @vitest-environment node
/*
 * Tests for scripts/check-guard-registry.js carrying a row across a merge
 * (#4514): stale on the merged index, fresh on both parents, and no file of
 * its closure changed on both sides since the merge base.
 *
 * Loosen it and a merge whose sides changed one library each is refused for a
 * re-anchor nobody owes, or a row whose library both sides changed, or that
 * one parent left stale, lands fresh with no reader having seen it.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ANCHORS,
	committedRepo,
	hooksWiring,
	ownClaims,
	readAnchors,
	region,
	removeTemps,
	reviewIn,
	run,
	SELF_PLUGIN_HOOKS,
	templateOf,
} from "./lib/guard-registry-testkit";

afterEach(removeTemps);

const GUARD = "scripts/guard-pair.sh";
const LIB_A = "scripts/lib/a.sh";
const LIB_B = "scripts/lib/b.sh";
const lines = (...ls: string[]) => `${ls.join("\n")}\n`;
const LIB_A_BODY = ["a1() { :; }", "", "", "", "", "", "a2() { :; }"];

const env = (root: string) => ({
	...process.env,
	CLAUDE_PROJECT_DIR: root,
	WFC_RULES_DIR: "",
	WFC_RULES_FALLBACK_DIR: "",
	CLAUDE_CODE_SESSION_ID: "self-session",
	WFC_ANCHOR_LOCKS: "[]",
});

const copy = templateOf(() =>
	committedRepo(
		{
			claude: region(
				"- Pairs hold. **Enforced** (#4514): `scripts/guard-pair.sh` denies it.",
			),
			files: {
				[GUARD]: lines(
					"#!/bin/sh",
					'source "$(dirname "$0")/lib/a.sh"',
					'source "$(dirname "$0")/lib/b.sh"',
					"exit 2",
				),
				[LIB_A]: lines(...LIB_A_BODY),
				[LIB_B]: lines("b() { :; }"),
				[SELF_PLUGIN_HOOKS]: hooksWiring(GUARD),
			},
		},
		(r) =>
			reviewIn(r, [], {
				CLAUDE_CODE_SESSION_ID: "self-session",
				WFC_ANCHOR_LOCKS: "[]",
			}),
	),
);

/** A fixture with `side` branched off its base, and git hooks off until hooks() turns them on. */
function mergeRepo() {
	const root = copy();
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: root, encoding: "utf8", env: env(root) });
	const tryGit = (...args: string[]) =>
		spawnSync("git", args, { cwd: root, encoding: "utf8", env: env(root) });
	git("branch", "-M", "main");
	git("branch", "side");
	/* The anchors file's merge driver, as .gitattributes wires it (#4171). */
	fs.writeFileSync(
		path.join(root, ".git", "info", "attributes"),
		`${ANCHORS} merge=registry-anchors\n`,
	);
	git(
		"config",
		"merge.registry-anchors.driver",
		`node ${JSON.stringify(path.join(__dirname, "merge-registry-anchors.js"))} %O %A %B`,
	);
	/** A commit on `branch` writing `files`, re-anchoring the guard unless `stale`. */
	const change = (
		branch: string,
		files: Record<string, string>,
		{ stale = false } = {},
	) => {
		git("checkout", "-q", branch);
		for (const [rel, body] of Object.entries(files))
			fs.writeFileSync(path.join(root, rel), body);
		if (!stale) reviewIn(root, [GUARD], ownClaims(root));
		git("add", "-A");
		git("commit", "-qm", `${branch} change`);
		git("checkout", "-q", "main");
	};
	/** The gate wired as .husky wires it, pre-commit and pre-merge-commit both. */
	const hooks = () => {
		const dir = path.join(root, ".git", "hooks");
		const gate =
			"#!/bin/sh\nexec node scripts/check-guard-registry.js --against HEAD\n";
		for (const h of ["pre-commit", "pre-merge-commit"])
			fs.writeFileSync(path.join(dir, h), gate, { mode: 0o755 });
	};
	const fresh = () =>
		!run(root).json.warnings.some(
			(w) => w.guard === GUARD && w.kind === "STALE-PROSE",
		);
	return { root, git, tryGit, change, hooks, fresh };
}

describe("a merge carries a row whose sides changed different files of its closure (#4514)", () => {
	it("commits the merge with the row fresh, no --review run, where each side changed a different library", () => {
		const { root, git, tryGit, change, hooks, fresh } = mergeRepo();
		change("main", { [LIB_A]: lines("a() { exit 1; }") });
		change("side", { [LIB_B]: lines("b() { exit 1; }") });
		const before = readAnchors(root)[GUARD];
		hooks();

		git("merge", "--no-ff", "--no-commit", "side");
		const r = tryGit("commit", "--no-edit");

		expect(r.status, r.stderr).toBe(0);
		expect(r.stderr).toContain(`carried ${GUARD} across the merge`);
		expect(git("log", "-1", "--format=%P").trim().split(" ")).toHaveLength(2);
		const committed = JSON.parse(git("show", `HEAD:${ANCHORS}`));
		expect(committed[GUARD]).not.toBe(before);
		expect(git("status", "--porcelain")).toBe("");
		expect(fresh()).toBe(true);
	});

	it("refuses a plain `git merge` at pre-merge-commit, whose tree is already written, and `git commit --no-edit` finishes it carried", () => {
		const { git, tryGit, change, hooks, fresh } = mergeRepo();
		change("main", { [LIB_A]: lines("a() { exit 1; }") });
		change("side", { [LIB_B]: lines("b() { exit 1; }") });
		hooks();

		const merged = tryGit("merge", "--no-ff", "--no-edit", "side");
		expect(merged.status).not.toBe(0);
		expect(merged.stderr).toContain(`carries ${GUARD} across the merge`);
		expect(merged.stderr).toContain("git commit --no-edit");

		const r = tryGit("commit", "--no-edit");
		expect(r.status, r.stderr).toBe(0);
		expect(git("log", "-1", "--format=%P").trim().split(" ")).toHaveLength(2);
		expect(fresh()).toBe(true);
	});

	it("refuses a merge where both sides changed the same library, though git merges it cleanly, naming the row and the file", () => {
		const { root, git, tryGit, change, hooks } = mergeRepo();
		const [first, ...rest] = LIB_A_BODY;
		change("main", {
			[LIB_A]: lines("a1() { exit 1; }", ...rest),
		});
		change("side", {
			[LIB_A]: lines(first ?? "", ...rest.slice(0, -1), "a2() { exit 1; }"),
		});
		const before = readAnchors(root)[GUARD];
		hooks();

		git("merge", "--no-ff", "--no-commit", "side");
		const r = tryGit("commit", "--no-edit");

		expect(r.status).not.toBe(0);
		expect(r.stderr).toContain(
			`not carried ${GUARD} — both sides changed ${LIB_A}`,
		);
		expect(r.stderr).toContain(`STALE-PROSE  ${GUARD}`);
		expect(JSON.parse(git("show", `:${ANCHORS}`))[GUARD]).toBe(before);
	});

	it("never carries a row the merged-in side left stale", () => {
		const { root, git, tryGit, change, hooks } = mergeRepo();
		change("main", { [LIB_A]: lines("a() { exit 1; }") });
		change("side", { [LIB_B]: lines("b() { exit 1; }") }, { stale: true });
		const before = readAnchors(root)[GUARD];
		hooks();

		git("merge", "--no-ff", "--no-commit", "side");
		const r = tryGit("commit", "--no-edit");

		expect(r.status).not.toBe(0);
		expect(r.stderr).toMatch(
			new RegExp(`not carried ${GUARD} — it is not fresh on [0-9a-f]{40}`),
		);
		expect(JSON.parse(git("show", `:${ANCHORS}`))[GUARD]).toBe(before);
	});

	it("never carries a row HEAD left stale", () => {
		const { root, git, change } = mergeRepo();
		change("main", { [LIB_A]: lines("a() { exit 1; }") }, { stale: true });
		change("side", { [LIB_B]: lines("b() { exit 1; }") });
		const theirs = JSON.parse(git("show", `side:${ANCHORS}`))[GUARD];

		git("merge", "--no-ff", "--no-commit", "side");
		const r = run(root, ["--against", "HEAD"], { env: env(root) });

		expect(r.json).toHaveProperty("carried", []);
		expect(JSON.parse(git("show", `:${ANCHORS}`))[GUARD]).toBe(theirs);
	});
});
