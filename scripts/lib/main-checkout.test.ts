// @vitest-environment node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineTemplate, mkDirOutsideRepo } from "./git-fixture";

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

function seed(at: string, ...initArgs: string[]) {
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
}

const seeded = defineTemplate((dir) => seed(dir));

describe("mainCheckout (#2563)", () => {
	it("names the main checkout from itself and from a linked worktree", () => {
		const main = seeded.instantiate(path.join(base, "main"));
		const wt = path.join(main, ".claude", "worktrees", "wt");
		git(main, "worktree", "add", "-q", wt);
		expect(mainCheckout(main)).toBe(main);
		expect(mainCheckout(wt)).toBe(main);
	});

	it("names no checkout where the common dir is a --separate-git-dir one", () => {
		const at = path.join(base, "separate");
		fs.mkdirSync(at);
		seed(at, "--separate-git-dir", path.join(base, "store"));
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
