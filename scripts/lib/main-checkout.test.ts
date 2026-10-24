// @vitest-environment node
/*
 * mainCheckout is the one home of the rule turning git's common dir into the
 * main checkout (#2563): a `.git` common dir names its parent, any other names
 * none.
 *
 * The mainCheckout cases build real throwaway repositories outside this one,
 * a linked worktree and a `--separate-git-dir` repo among them, because it
 * reads what `git rev-parse --git-common-dir` prints and only real git prints
 * it. checkoutOfCommonDir takes that output as a string, so its case does not.
 *
 * mainCheckout places the commit ledgers (arbiter-ledger.js), the seat-key
 * `.env` (headless-sessions.js) and the self-plugin setup path
 * (core-hooks.js); checkoutOfCommonDir picks repo-checks.js's reading root. A
 * loosened case lets a worktree session keep its ledgers or read its keys in
 * its own worktree, or print a setup path that is not the main checkout's.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkDirOutsideRepo } from "./git-fixture";

const { checkoutOfCommonDir, mainCheckout } = require("./main-checkout.js");

function git(root: string, ...args: string[]) {
	execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
}

let base: string;
beforeEach(() => {
	base = mkDirOutsideRepo("main-checkout-");
});
afterEach(() => {
	fs.rmSync(base, { recursive: true, force: true });
});

function checkout(name: string, ...initArgs: string[]) {
	const at = path.join(base, name);
	fs.mkdirSync(at);
	git(at, "init", "-q", ...initArgs);
	git(
		at,
		"-c",
		"user.email=test@example.com",
		"-c",
		"user.name=test",
		"commit",
		"-q",
		"--allow-empty",
		"--no-verify",
		"-m",
		"init",
	);
	return at;
}

describe("mainCheckout (#2563)", () => {
	it("names the main checkout from itself and from a linked worktree", () => {
		const main = checkout("main");
		const wt = path.join(main, ".claude", "worktrees", "wt");
		git(main, "worktree", "add", "-q", wt);
		expect(mainCheckout(main)).toBe(main);
		expect(mainCheckout(wt)).toBe(main);
	});

	it("names no checkout where the common dir is a --separate-git-dir one", () => {
		const at = checkout(
			"separate",
			"--separate-git-dir",
			path.join(base, "store"),
		);
		expect(mainCheckout(at)).toBeNull();
	});

	it("names no checkout outside any repository", () => {
		expect(mainCheckout(base)).toBeNull();
	});
});

describe("checkoutOfCommonDir (#2563)", () => {
	it("names the parent of a .git common dir and nothing for any other", () => {
		expect(checkoutOfCommonDir("/x/.git")).toBe("/x");
		expect(checkoutOfCommonDir("/x/store")).toBeNull();
		expect(checkoutOfCommonDir("/x/.git/modules/sub")).toBeNull();
	});
});
