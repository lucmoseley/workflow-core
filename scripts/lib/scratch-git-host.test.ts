/*
 * Tests for lib/scratch-git-host.js's isTracked: git's exit 128 reads as
 * "untracked" only where git says there is no repository (#3396). Break it
 * and lib/scratch-git.js either refuses a tracked script on a git fault, or
 * lets an unguarded script outside any repository write git state, the
 * #3162 incident. The fatal that is not that is driven through
 * git-fault-fake.ts at WFC_GIT (base §N7); the rest cross the real git in a
 * temp directory.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFaultyGit } from "./git-fault-fake";

// biome-ignore lint/suspicious/noExplicitAny: a CJS module has no types to import
const lib: any = createRequire(__filename)("./scratch-git-host.js");

describe("isTracked", () => {
	let dir: string;
	const saved = process.env.WFC_GIT;
	const isTracked = (abs: string) => lib.buildHostPorts().isTracked(abs);

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "scratch-git-host-"));
	});
	afterEach(() => {
		if (saved === undefined) delete process.env.WFC_GIT;
		else process.env.WFC_GIT = saved;
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("answers true for a tracked script and false for an untracked one", () => {
		execFileSync("git", ["init", "-q"], { cwd: dir });
		fs.writeFileSync(path.join(dir, "a.sh"), "x\n");
		fs.writeFileSync(path.join(dir, "b.sh"), "x\n");
		execFileSync("git", ["add", "a.sh"], { cwd: dir });
		expect(isTracked(path.join(dir, "a.sh"))).toBe(true);
		expect(isTracked(path.join(dir, "b.sh"))).toBe(false);
	});

	it("answers false where git says there is no repository", () => {
		fs.writeFileSync(path.join(dir, "a.sh"), "x\n");
		process.env.GIT_CEILING_DIRECTORIES = dir;
		try {
			expect(isTracked(path.join(dir, "a.sh"))).toBe(false);
		} finally {
			delete process.env.GIT_CEILING_DIRECTORIES;
		}
	});

	it("cannot say on any other exit 128", () => {
		process.env.WFC_GIT = writeFaultyGit(
			{ all: true },
			{ script: "echo 'fatal: unable to read index' >&2\nexit 128" },
			{ under: dir },
		).git;
		expect(isTracked(path.join(dir, "a.sh"))).toBeNull();
	});
});
