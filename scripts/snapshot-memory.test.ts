// @vitest-environment node
/*
 * snapshot-memory.sh writes its tarball into the session's own tree, where it
 * is committed: from a linked worktree, never the main checkout (#5287).
 * The store is passed as the first argument, so no case reads the machine's
 * real memory store.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import {
	cutWorktree,
	defineTemplate,
	initGitRepo,
	mkDirOutsideRepo,
} from "./lib/git-fixture";

const SCRIPT = path.resolve(__dirname, "snapshot-memory.sh");

const template = defineTemplate((dir) => {
	const hooks = path.join(dir, ".no-hooks");
	fs.mkdirSync(hooks);
	initGitRepo(dir, hooks);
});

it("writes the snapshot into a linked worktree and leaves the main checkout clean (#5287)", () => {
	const scratch = mkDirOutsideRepo("snapshot-memory-");
	try {
		const main = path.join(scratch, "main");
		template.instantiate(main);
		const tree = cutWorktree(main);
		const store = path.join(scratch, "memory");
		fs.mkdirSync(store);
		fs.writeFileSync(path.join(store, "note.md"), "x\n");
		/* The harness names the main checkout as the project even for a
		 * session in a linked worktree. */
		const r = spawnSync("bash", [SCRIPT, store], {
			cwd: tree,
			encoding: "utf8",
			env: { ...process.env, CLAUDE_PROJECT_DIR: main },
		});
		expect(r.status, r.stderr).toBe(0);
		expect(fs.readdirSync(path.join(tree, "snapshots"))).toHaveLength(1);
		expect(
			execFileSync("git", ["-C", main, "status", "--porcelain"], {
				encoding: "utf8",
			}),
		).toBe("");
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
	}
});
