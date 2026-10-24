// @vitest-environment node
/*
 * .husky/post-commit's release-on-commit block (mantahostels#2336, #2058), cut from the hook's own
 * text and run — the parity discipline report-new-shared-faults.test.ts states
 * for the block above it.
 *
 * What is under test is the HOOK'S GUARDING: which commits it stands down on,
 * how it spells the paths, what environment it hands the arbiter, and that it
 * can never take the shell down. The arbiter is a stub throughout; its own
 * narrowing is session-arbiter.test.ts's.
 *
 * The block runs after every commit in the shared tree: loosen a case and a
 * committed file's claim is never given back, so neighbours stay denied on it
 * until this session's process ends, or the arbiter judges cleanliness against
 * the wrong tree.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { newRepo, registerTempCleanup } from "./lib/precommit-gate-harness";
import {
	cutInReplay,
	cutShellFunction,
	POST_COMMIT,
} from "./lib/precommit-gate-testkit";

const temps = registerTempCleanup();

/** The block under test, plus the shared replay test it calls. */
const cutBlock = () =>
	`${cutInReplay()}\n${cutShellFunction("release_committed_claims")}`;

/**
 * A throwaway repo whose HEAD commit touches `files`, with a stub arbiter at the
 * path the hook looks for.
 */
function hookRepo(prefix: string, files: string[], stub?: string) {
	const repo = newRepo(prefix, temps);
	for (const f of files) {
		fs.mkdirSync(path.join(repo.root, path.dirname(f)), { recursive: true });
		fs.writeFileSync(path.join(repo.root, f), "x");
	}
	repo.git("add", "-A");
	repo.git("commit", "-q", "--allow-empty", "-m", "one");
	if (stub !== undefined) {
		fs.mkdirSync(path.join(repo.root, "scripts"), { recursive: true });
		fs.writeFileSync(
			path.join(repo.root, "scripts", "session-arbiter.js"),
			stub,
		);
	}
	return repo;
}

/**
 * `sh -e`, never a plain `sh`: .husky/_/h runs every hook that way, and a block
 * green under `sh` can still abort the whole hook in production.
 */
function runBlock(cwd: string, env: Record<string, string> = {}) {
	const r = spawnSync(
		"sh",
		[
			"-e",
			"-c",
			`${cutBlock()}\nrelease_committed_claims\nprintf "reached-end\\n"`,
		],
		{
			cwd,
			encoding: "utf8",
			// The relative index path git exports into every hook.
			env: { ...process.env, GIT_INDEX_FILE: ".git/index", ...env },
		},
	);
	return {
		code: r.status ?? -1,
		// The trailing marker proves the block RETURNED rather than taking the
		// shell down with it.
		reachedEnd: r.stdout.includes("reached-end"),
		out: r.stdout.replace("reached-end\n", ""),
		err: r.stderr,
	};
}

function expectSurvived(r: { code: number; reachedEnd: boolean }) {
	expect(r.reachedEnd).toBe(true);
	expect(r.code).toBe(0);
}

/** A stub arbiter writing its own argv, one per line, to stdout. */
const ECHO_ARGV = `for (const a of process.argv.slice(2)) process.stdout.write(a + "\\n");\n`;

describe(".husky/post-commit's release-on-commit block", () => {
	it("calls session-arbiter.js release-committed, and CALLS the function it defines", () => {
		const uncommented = POST_COMMIT.split("\n").filter(
			(l) => !l.trimStart().startsWith("#"),
		);

		expect(uncommented.join("\n")).toContain("release-committed");
		// The INVOCATION at column zero, not the line that defines it.
		expect(uncommented).toContain("release_committed_claims");
	});

	it("hands the arbiter the subcommand and every path the commit touched", () => {
		const repo = hookRepo(
			"post-commit-release-paths-",
			["docs/doc-map.md", "app/page.tsx"],
			ECHO_ARGV,
		);

		const r = runBlock(repo.root);

		expect(r.out.split("\n").filter(Boolean)).toEqual([
			"release-committed",
			"app/page.tsx",
			"docs/doc-map.md",
		]);
		expectSurvived(r);
	});

	it("keeps a path containing a space as ONE argument", () => {
		const repo = hookRepo(
			"post-commit-release-space-",
			["docs/a file.md"],
			ECHO_ARGV,
		);

		const r = runBlock(repo.root);

		expect(r.out.split("\n").filter(Boolean)).toEqual([
			"release-committed",
			"docs/a file.md",
		]);
		expectSurvived(r);
	});

	// All six, not a representative one: the states are a hand-written list, and
	// a name dropped from it is exactly the regression this catches. Two are
	// directories in production (`rebase-merge`, `rebase-apply`) — the block
	// tests `-e`, so a file stands in.
	it.each([
		"rebase-merge",
		"rebase-apply",
		"CHERRY_PICK_HEAD",
		"REVERT_HEAD",
		"sequencer",
		"BISECT_LOG",
	])(
		"stands down mid-replay under %s, where the paths are somebody else's",
		(state) => {
			const repo = hookRepo(
				`post-commit-release-replay-${state}-`,
				["docs/doc-map.md"],
				ECHO_ARGV,
			);
			fs.writeFileSync(path.join(repo.root, ".git", state), "x");

			const r = runBlock(repo.root);

			expect(r.out).toBe("");
			expectSurvived(r);
		},
	);

	it("says nothing where the arbiter is missing altogether", () => {
		const repo = hookRepo("post-commit-release-missing-", ["docs/doc-map.md"]);

		const r = runBlock(repo.root);

		expect(r.out).toBe("");
		expectSurvived(r);
	});

	it("survives an arbiter that exits non-zero, and one that throws", () => {
		for (const [prefix, stub] of [
			["post-commit-release-nonzero-", "process.exit(3);\n"],
			["post-commit-release-throw-", "throw new Error('boom');\n"],
		] as const) {
			const repo = hookRepo(prefix, ["docs/doc-map.md"], stub);
			expectSurvived(runBlock(repo.root));
		}
	});

	it("passes the arbiter's stderr through — a clobber notice is said once", () => {
		const repo = hookRepo(
			"post-commit-release-stderr-",
			["docs/doc-map.md"],
			`process.stderr.write("session-arbiter: clobbered\\n");\n`,
		);

		const r = runBlock(repo.root);

		expect(r.err).toContain("session-arbiter: clobbered");
		expectSurvived(r);
	});

	it("unsets the three git redirects, so the arbiter's cleanliness check reads the real tree", () => {
		const repo = hookRepo(
			"post-commit-release-env-",
			["docs/doc-map.md"],
			`for (const k of ["GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE"])
				if (process.env[k] !== undefined) process.stdout.write(k + " leaked\\n");\n`,
		);

		const r = runBlock(repo.root, {
			GIT_DIR: ".git",
			GIT_WORK_TREE: ".",
		});

		expect(r.out).toBe("");
		expectSurvived(r);
	});

	it("says nothing on a commit that touched nothing", () => {
		const repo = hookRepo("post-commit-release-empty-", [], ECHO_ARGV);

		const r = runBlock(repo.root);

		expect(r.out).toBe("");
		expectSurvived(r);
	});
});
