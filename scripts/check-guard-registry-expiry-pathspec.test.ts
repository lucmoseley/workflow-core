// @vitest-environment node
/*
 * Tests for scripts/check-guard-registry.js: #2617's refusal met by a pathspec commit, and `--taking`.
 *
 * The checker is a hard gate in .husky/pre-commit and roadmap-digest.yml:
 * loosen a case and a rule can claim **Enforced** while its guard is missing
 * or unwired.
 *
 * Over the run-cost budget (base §X8 (5)) by inheritance: its cases moved
 * unchanged from check-guard-registry.test.ts, whose cost was pre-existing (#4294).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ANCHORS,
	anchorExpiryKit,
	lock,
	readAnchors,
	removeTemps,
	reviewEnv,
	reviewIn,
} from "./lib/guard-registry-testkit";

afterEach(removeTemps);

describe("--against HEAD refuses the commit that expires an anchor (#2617)", () => {
	const { stagingRepo, claims, gate, review, readHookLine } = anchorExpiryKit();

	/* A `git commit -- <paths>` through .husky/pre-commit's own line: the hook
	 * reads a private index holding just those paths' working-tree bytes. */
	function hookCommitter(root: string, locks: unknown[] = []) {
		const hook = path.join(root, ".git", "hooks", "pre-commit");
		fs.writeFileSync(hook, `#!/bin/sh\n${readHookLine()}\n`, { mode: 0o755 });
		const env = {
			...reviewEnv(root, claims(locks)),
			WFC_RULES_DIR: "",
			WFC_RULES_FALLBACK_DIR: "",
		};
		return (...paths: string[]) =>
			spawnSync("git", ["commit", "-qm", "x", "--", ...paths], {
				cwd: root,
				encoding: "utf8",
				env,
			});
	}

	it("is the refusal a pathspec commit meets through the hook's own line", () => {
		const { root, git } = stagingRepo();
		const hookCommit = hookCommitter(root);
		fs.writeFileSync(
			path.join(root, "scripts", "guard-amend.sh"),
			"#!/bin/sh\nexit 1\n",
		);
		const refused = hookCommit("scripts/guard-amend.sh");
		expect(refused.status).not.toBe(0);
		expect(refused.stderr).toContain("--review scripts/guard-amend.sh");
		review(root, ["scripts/guard-amend.sh"]);
		expect(hookCommit("scripts/guard-amend.sh", ANCHORS).status).toBe(0);
		expect(git("status", "--porcelain")).toBe("");
	});

	it("refuses a stale row held only through a file the pathspec commit takes whole, and its --taking re-anchor clears it (#3255)", () => {
		const { root, git } = stagingRepo();
		const locks = [lock("scripts/lib/deny.sh", { alive: false })];
		const hookCommit = hookCommitter(root, locks);
		fs.writeFileSync(
			path.join(root, "scripts", "lib", "deny.sh"),
			"deny() { exit 0; }\n",
		);
		const refused = hookCommit("scripts/lib/deny.sh");
		expect(refused.status).not.toBe(0);
		expect(refused.stderr).not.toContain("not refusing");
		expect(refused.stderr).toContain(
			"--review scripts/guard-branch.sh --taking scripts/lib/deny.sh",
		);
		const out = reviewIn(
			root,
			["scripts/guard-branch.sh", "--taking", "scripts/lib/deny.sh"],
			claims(locks),
		);
		expect(out).toContain(
			"taking scripts/lib/deny.sh from neighbour-session (GONE)'s claim",
		);
		expect(out).toMatch(/^\s*anchored scripts\/guard-branch\.sh/m);
		expect(hookCommit("scripts/lib/deny.sh", ANCHORS).status).toBe(0);
		expect(git("status", "--porcelain")).toBe("");
	});

	/* The way out --review prints where it keeps a --taking path's claim. */
	const keptClaim = (out: string, why: string) => {
		expect(out).toContain(
			`not taking scripts/lib/deny.sh — ${why}, so any claim on it stands; commit it by pathspec and re-run the --review line that commit's refusal prints`,
		);
		expect(out).not.toContain("taking scripts/lib/deny.sh from");
		expect(out).toContain(
			"not anchored scripts/guard-branch.sh — scripts/lib/deny.sh is dirty and claimed by neighbour-session (GONE)",
		);
	};
	const takeDeny = (root: string, locks: unknown[]) =>
		reviewIn(
			root,
			["scripts/guard-branch.sh", "--taking", "scripts/lib/deny.sh"],
			claims(locks),
		);

	it("--taking a path no refusal of this session's commit staged keeps its holder's claim, and says so (#3288)", () => {
		const { root } = stagingRepo();
		const locks = [lock("scripts/lib/deny.sh", { alive: false })];
		fs.writeFileSync(
			path.join(root, "scripts", "lib", "deny.sh"),
			"deny() { exit 0; }\n",
		);
		const before = readAnchors(root);
		keptClaim(
			takeDeny(root, locks),
			"no refusal of this session's commit names it staged",
		);
		expect(readAnchors(root)).toEqual(before);
	});

	it("--taking a path whose working tree moved since the refusal keeps its holder's claim, and says so (#3288)", () => {
		const { root } = stagingRepo();
		const locks = [lock("scripts/lib/deny.sh", { alive: false })];
		const hookCommit = hookCommitter(root, locks);
		const deny = path.join(root, "scripts", "lib", "deny.sh");
		fs.writeFileSync(deny, "deny() { exit 0; }\n");
		expect(hookCommit("scripts/lib/deny.sh").stderr).toContain(
			"--taking scripts/lib/deny.sh",
		);
		fs.appendFileSync(deny, "# more\n");
		const before = readAnchors(root);
		keptClaim(
			takeDeny(root, locks),
			"its working tree is not the copy the commit staged",
		);
		expect(readAnchors(root)).toEqual(before);
	});

	it("--taking a claimed file the commit stages as a removal takes the claim (#3288)", () => {
		const { root, git } = stagingRepo();
		const locks = [lock("scripts/lib/deny.sh", { alive: false })];
		const hookCommit = hookCommitter(root, locks);
		fs.rmSync(path.join(root, "scripts", "lib", "deny.sh"));
		expect(hookCommit("scripts/lib/deny.sh").stderr).toContain(
			"--taking scripts/lib/deny.sh",
		);
		expect(takeDeny(root, locks)).toContain(
			"taking scripts/lib/deny.sh from neighbour-session (GONE)'s claim",
		);
		expect(hookCommit("scripts/lib/deny.sh", ANCHORS).status).toBe(0);
		expect(git("status", "--porcelain")).toBe("");
	});

	/* A committed, anchored .husky/ hook: the arbiter watches no such path, so
	 * no session's claim ever covers it. */
	const hookRel = ".husky/prepare-commit-msg";
	function hookedRepo() {
		const repo = stagingRepo();
		const hook = path.join(repo.root, hookRel);
		fs.mkdirSync(path.dirname(hook), { recursive: true });
		fs.writeFileSync(
			hook,
			"#!/bin/sh\n# IMPLICIT:  a thing.\n# JUSTIFIED: fail-safe.\n# DEFEAT:    none\nexit 0\n",
		);
		/* Staged before its review: a guard outside the index has no digest (#4517). */
		repo.git("add", "--", hookRel);
		review(repo.root, [hookRel]);
		repo.git("add", "--", ANCHORS);
		repo.git("commit", "-qm", "hook");
		return { ...repo, hook };
	}
	const printedReview = (stderr: string) => {
		const line = /^ +node \S+ --review ([^<\n]+)$/m.exec(stderr)?.[1];
		if (!line) throw new Error(`no --review line in\n${stderr}`);
		return line.split(" ");
	};

	it("anchors an unwatched hook this commit stages whole, through the line its refusal prints (#3738)", () => {
		const { root, git, hook } = hookedRepo();
		const hookCommit = hookCommitter(root);
		fs.appendFileSync(hook, "# more\n");
		expect(reviewIn(root, [hookRel], claims())).toContain(
			"commit it by pathspec and re-run the --review line that commit's refusal prints",
		);
		const refused = hookCommit(hookRel);
		expect(refused.status).not.toBe(0);
		const printed = printedReview(refused.stderr);
		expect(printed).toEqual([hookRel, "--taking", hookRel]);
		expect(reviewIn(root, printed, claims())).toMatch(
			/^\s*anchored \.husky\/prepare-commit-msg/m,
		);
		expect(hookCommit(hookRel, ANCHORS).status).toBe(0);
		expect(git("status", "--porcelain")).toBe("");
	});

	it("refuses an unwatched hook whose working tree moved since the refusal, as bytes no commit stages (#3738)", () => {
		const { root, hook } = hookedRepo();
		const hookCommit = hookCommitter(root);
		fs.appendFileSync(hook, "# more\n");
		const printed = printedReview(hookCommit(hookRel).stderr);
		fs.appendFileSync(hook, "# and more\n");
		const before = readAnchors(root);
		const out = reviewIn(root, printed, claims());
		expect(out).toContain(
			`not taking ${hookRel} — its working tree is not the copy the commit staged`,
		);
		expect(out).toContain(
			`not anchored ${hookRel} — ${hookRel} is dirty and not claimed by this session`,
		);
		expect(readAnchors(root)).toEqual(before);
	});

	it("prints no --taking for a hook staged in part, whose pathspec commit then does (#3738)", () => {
		const { root, git, hook } = hookedRepo();
		fs.appendFileSync(hook, "# staged\n");
		git("add", "--", hookRel);
		fs.appendFileSync(hook, "# unstaged\n");
		const refused = gate(root);
		expect(refused.code).toBe(1);
		const printed = printedReview(refused.report);
		expect(printed).toEqual([hookRel]);
		expect(reviewIn(root, printed, claims())).toContain(
			"commit it by pathspec and re-run the --review line that commit's refusal prints",
		);
		expect(printedReview(hookCommitter(root)(hookRel).stderr)).toEqual([
			hookRel,
			"--taking",
			hookRel,
		]);
	});

	it("prints no --taking for a file this session's own claim already covers (#3738)", () => {
		const { root } = stagingRepo();
		const rel = "scripts/guard-amend.sh";
		fs.writeFileSync(path.join(root, rel), "#!/bin/sh\nexit 1\n");
		const own = [{ ...lock(rel), sessionId: "self-session" }];
		const refused = hookCommitter(root, own)(rel);
		expect(refused.status).not.toBe(0);
		expect(printedReview(refused.stderr)).toEqual([rel]);
	});

	it("--review without --taking still skips a claimed file the shared index stages whole, as the neighbour's own (#3255)", () => {
		const { root, stage } = stagingRepo();
		stage({ "scripts/lib/deny.sh": "deny() { exit 0; }\n" });
		const before = readAnchors(root);
		const out = reviewIn(
			root,
			["scripts/guard-branch.sh"],
			claims([lock("scripts/lib/deny.sh")]),
		);
		expect(out).toContain(
			"not anchored scripts/guard-branch.sh — scripts/lib/deny.sh is dirty and claimed by neighbour-session",
		);
		expect(readAnchors(root)).toEqual(before);
	});

	it("still stands a row down, naming the holder, where the claimed file's working tree carries bytes the commit does not (#3255)", () => {
		const { root, stage } = stagingRepo();
		stage({ "scripts/lib/deny.sh": "deny() { exit 0; }\n" });
		fs.appendFileSync(path.join(root, "scripts", "lib", "deny.sh"), "# more\n");
		const r = gate(root, [lock("scripts/lib/deny.sh", { alive: false })]);
		expect(r.code).toBe(0);
		expect(r.report).toContain(
			"not refusing scripts/guard-branch.sh — scripts/lib/deny.sh is dirty and claimed by neighbour-session (GONE)",
		);
	});
});
