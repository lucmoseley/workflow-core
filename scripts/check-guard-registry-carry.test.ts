// @vitest-environment node
/*
 * Tests for scripts/check-guard-registry.js carrying a row across a merge
 * (#4514): stale on the merged index, fresh on both parents, and no file of
 * its closure changed on both sides since the merge base. A row only the
 * merged-in side holds is carried on that side's freshness (#4801).
 *
 * spawn-kept: the merge cases commit through real git hooks, since only git
 * shows which index reaches a merge commit's tree.
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
const ADDED = "scripts/guard-solo.sh";
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

	it("stages nothing under a hook whose index git has already read, as prepare-commit-msg's under --no-verify, and still refuses", () => {
		const { root, git, change } = mergeRepo();
		change("main", { [LIB_A]: lines("a() { exit 1; }") });
		change("side", { [LIB_B]: lines("b() { exit 1; }") });
		git("merge", "--no-ff", "--no-commit", "side");
		const staged = git("show", `:${ANCHORS}`);

		const r = run(root, ["--against", "HEAD"], {
			env: { ...env(root), WFC_INDEX_FROZEN: "1" },
		});

		expect(r.code).toBe(1);
		expect(r.report).toContain(`carries ${GUARD} across the merge`);
		expect(r.report).toContain("git commit --no-edit");
		expect(git("show", `:${ANCHORS}`)).toBe(staged);
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

	it("never carries a row whose library the merge commit itself changes, matching neither parent", () => {
		const { root, git, tryGit, change, hooks } = mergeRepo();
		change("main", { [LIB_A]: lines("a() { exit 1; }") });
		change("side", { [LIB_B]: lines("b() { exit 1; }") });
		hooks();

		git("merge", "--no-ff", "--no-commit", "side");
		fs.writeFileSync(path.join(root, LIB_B), lines("b() { exit 3; }"));
		git("add", LIB_B);
		const r = tryGit("commit", "--no-edit");

		expect(r.status).not.toBe(0);
		expect(r.stderr).toContain(
			`not carried ${GUARD} — the merge itself changed ${LIB_B}`,
		);
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

	it("passes a merge of main into a branch, carrying nothing, where main already holds the row stale (#4582)", () => {
		const { git, tryGit, change, hooks } = mergeRepo();
		change("main", { [LIB_B]: lines("b() { exit 1; }") }, { stale: true });
		change("side", { [LIB_A]: lines("a() { exit 1; }") });
		hooks();
		git("checkout", "-q", "side");

		git("merge", "--no-ff", "--no-commit", "main");
		const merged = JSON.parse(git("show", `:${ANCHORS}`))[GUARD];
		const r = tryGit("commit", "--no-edit");

		expect(r.status, r.stderr).toBe(0);
		expect(r.stderr).toMatch(/already in HEAD or [0-9a-f]{40}/);
		expect(r.stderr).not.toContain(`carried ${GUARD}`);
		expect(JSON.parse(git("show", `HEAD:${ANCHORS}`))[GUARD]).toBe(merged);
	});

	it("passes a plain `git merge` of main at pre-merge-commit where main already holds the row stale (#4582)", () => {
		const { git, tryGit, change, hooks } = mergeRepo();
		change("main", { [LIB_B]: lines("b() { exit 1; }") }, { stale: true });
		change("side", { [LIB_A]: lines("a() { exit 1; }") });
		hooks();
		git("checkout", "-q", "side");

		const r = tryGit("merge", "--no-ff", "--no-edit", "main");

		expect(r.status, r.stderr).toBe(0);
		expect(git("log", "-1", "--format=%P").trim().split(" ")).toHaveLength(2);
	});

	it("never carries a row HEAD left stale", () => {
		const { root, git, change } = mergeRepo();
		change("main", { [LIB_A]: lines("a() { exit 1; }") }, { stale: true });
		change("side", { [LIB_B]: lines("b() { exit 1; }") });
		const theirs = JSON.parse(git("show", `side:${ANCHORS}`))[GUARD];

		git("merge", "--no-ff", "--no-commit", "side");
		const r = run(root, ["--against", "HEAD"], { env: env(root) });

		expect(r.code).toBe(0);
		expect(r.json).toHaveProperty("carried", []);
		expect(r.report).not.toContain(`carried ${GUARD}`);
		expect(JSON.parse(git("show", `:${ANCHORS}`))[GUARD]).toBe(theirs);
	});

	/** `side` adds a guard of its own over lib/a.sh, anchored fresh there, as #4696's member did. */
	const sideAddsGuard = (
		{ root, git }: ReturnType<typeof mergeRepo>,
		libA?: string,
	) => {
		git("checkout", "-q", "side");
		fs.writeFileSync(
			path.join(root, ADDED),
			lines("#!/bin/sh", 'source "$(dirname "$0")/lib/a.sh"', "exit 2"),
		);
		if (libA !== undefined) fs.writeFileSync(path.join(root, LIB_A), libA);
		fs.appendFileSync(
			path.join(root, "CLAUDE.md"),
			region(
				"- Solos hold. **Enforced** (#4514): `scripts/guard-solo.sh` denies it.",
			),
		);
		fs.writeFileSync(
			path.join(root, SELF_PLUGIN_HOOKS),
			hooksWiring(GUARD, ADDED),
		);
		/* --review skips a guard git's index does not hold. */
		git("add", "-A");
		reviewIn(root, [GUARD, ADDED], ownClaims(root));
		git("add", "-A");
		git("commit", "-qm", "side adds a guard");
		git("checkout", "-q", "main");
	};

	it("carries a row HEAD holds none of, a guard the merged-in side added, where only HEAD changed its library (#4801)", () => {
		const repo = mergeRepo();
		const { root, git, change } = repo;
		const [, ...rest] = LIB_A_BODY;
		change("main", { [LIB_A]: lines("a1() { exit 1; }", ...rest) });
		sideAddsGuard(repo);

		git("merge", "--no-ff", "--no-commit", "side");
		const r = run(root, ["--against", "HEAD"], { env: env(root) });

		expect(r.code, r.report).toBe(0);
		expect(r.json).toHaveProperty("carried", [ADDED]);
		expect(run(root).json.warnings.map((w) => w.guard)).not.toContain(ADDED);
	});

	it("never carries a row the merged-in side added where both sides changed its library, naming the file (#4801)", () => {
		const repo = mergeRepo();
		const { root, git, change } = repo;
		const [first, ...rest] = LIB_A_BODY;
		change("main", { [LIB_A]: lines("a1() { exit 1; }", ...rest) });
		sideAddsGuard(
			repo,
			lines(first ?? "", ...rest.slice(0, -1), "a2() { exit 1; }"),
		);

		git("merge", "--no-ff", "--no-commit", "side");
		const r = run(root, ["--against", "HEAD"], { env: env(root) });

		expect(r.code).toBe(1);
		expect(r.report).toContain(
			`not carried ${ADDED} — both sides changed ${LIB_A}`,
		);
		expect(r.json).toHaveProperty("carried", []);
	});
});
