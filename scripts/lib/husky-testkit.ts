/*
 * husky-testkit.ts — husky's `.husky/_` shim for a fixture repo, generated as
 * `npm run prepare` generates the checkout's: husky's own install, then
 * install-hooks.js's rewrite of `h` (#3138). The checkout's own `.husky/_` is
 * gitignored and exists only in the shared checkout, so a fixture copying it
 * fails in every linked worktree (#4360).
 *
 * Importing it unsets `HUSKY` for every case in the importing file, so build
 * the shim inside a case: from a `beforeAll` husky skips the install and
 * `shimDir` throws.
 *
 * FOR TESTS ONLY.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterAll, beforeEach, vi } from "vitest";
import { mkScratchDir } from "./git-fixture";

const require = createRequire(import.meta.url);

// Husky's `_/h` exits 0 before any hook runs under an inherited `HUSKY=0`,
// so every suite that installs the shim runs its `git` calls without it (#4715).
beforeEach(() => {
	vi.stubEnv("HUSKY", undefined);
});

let repo: string | null = null;
let generated: string | null = null;

afterAll(() => {
	if (repo) fs.rmSync(repo, { recursive: true, force: true });
	repo = null;
	generated = null;
});

function shimDir(): string {
	if (generated === null) {
		const at = mkScratchDir("husky-shim-");
		repo = at;
		const run = (args: string[]) =>
			execFileSync(process.execPath, args, {
				cwd: at,
				encoding: "utf8",
				stdio: "pipe",
			});
		execFileSync("git", ["init", "-q", "."], { cwd: at });
		// husky prints why it skipped and still exits 0.
		const said = run([
			path.join(path.dirname(require.resolve("husky")), "bin.js"),
		]);
		const dir = path.join(at, ".husky", "_");
		if (!fs.existsSync(path.join(dir, "h")))
			throw new Error(`husky wrote no ${dir}/h: ${said.trim()}`);
		run([path.join(__dirname, "..", "install-hooks.js")]);
		generated = dir;
	}
	return generated;
}

export function huskyHooks(): string[] {
	return fs
		.readdirSync(shimDir())
		.filter((f) => !/^(h|husky\.sh|\.gitignore)$/.test(f));
}

/**
 * Writes the shim into `root`'s `.husky/_` and points `root`'s core.hooksPath
 * at it, absolute as install-hooks.js pins it.
 */
export function installHuskyShim(root: string): void {
	const underscore = path.join(root, ".husky", "_");
	fs.cpSync(shimDir(), underscore, { recursive: true });
	execFileSync("git", ["config", "core.hooksPath", underscore], { cwd: root });
}
