// @vitest-environment node
/*
 * .husky/post-commit's release-on-commit step (mantahostels#2336, #2058):
 * lib/post-commit-steps.js's releaseClaimsRow, and its claim-release row in
 * lib/post-commit-rows.js run through dispatch() on the real route (#5208).
 *
 * What is under test is the STEP'S GUARDING: which commits it stands down
 * on, how it spells the paths, what environment it hands the arbiter, and
 * that a fault in it never stops the steps after it. The arbiter stands in
 * through its PROGRAM export (lib/post-commit-testkit.ts) wherever its own
 * answer is not the point; its narrowing is session-arbiter.test.ts's.
 *
 * The step runs after every commit in the shared tree: loosen a case and a
 * committed file's claim is never given back, so neighbours stay denied on it
 * until this session's process ends, or the arbiter judges cleanliness against
 * the wrong tree.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	arbiterCli,
	commitAll,
	freshSandbox,
	gitRepo,
	live,
} from "./lib/arbiter-testkit";
import { scrubbedGitEnv } from "./lib/hook-entry.js";
import { releaseClaimsRow } from "./lib/post-commit-steps.js";
import {
	echoArgv,
	hookEnv,
	linkedCommit,
	plantSentinel,
	programs,
	quietPrograms,
	REPLAY_SENTINELS,
	rowOf,
	runPostCommit,
	SILENT,
	STEPS,
	stubProgram,
} from "./lib/post-commit-testkit";
import { newRepo, registerTempCleanup } from "./lib/precommit-gate-harness";
import { commitOverSequencer } from "./lib/precommit-gate-testkit";

const temps = registerTempCleanup();

/** A throwaway repo whose HEAD commit touches `files`. */
function hookRepo(prefix: string, files: string[]) {
	const repo = newRepo(prefix, temps);
	for (const f of files) {
		fs.mkdirSync(path.join(repo.root, path.dirname(f)), { recursive: true });
		fs.writeFileSync(path.join(repo.root, f), "x");
	}
	repo.git("add", "-A");
	repo.git("commit", "-q", "--allow-empty", "-m", "one");
	return repo;
}

const headOf = (repo: { git: (...a: string[]) => Buffer }) =>
	repo.git("rev-parse", "HEAD").toString().trim();

/** The step on `cwd`, the arbiter echoing the argv it was handed. */
function runStep(cwd: string, env: NodeJS.ProcessEnv = {}) {
	const arbiter = stubProgram("session-arbiter.js", echoArgv);
	const r = releaseClaimsRow({ cwd, env: hookEnv(env) }, programs);
	expect(r.exit).toBe(0);
	return { ...r, arbiter, argv: r.stdout.split("\n").filter(Boolean) };
}

/** The whole registry on `cwd`, every program quiet but an echoing arbiter. */
async function runRegistry(cwd: string) {
	quietPrograms();
	const arbiter = stubProgram("session-arbiter.js", echoArgv);
	const r = await runPostCommit({ cwd, env: hookEnv() });
	expect(r.exit).toBe(0);
	return { ...r, arbiter };
}

describe(".husky/post-commit's release-on-commit step", () => {
	it("is wired: the registry's claim-release row runs it, standing down on the post-commit stand-down set", () => {
		const row = rowOf("claim-release");
		expect(row.run).toBe(STEPS.releaseClaimsRow);
		expect(row.when).toEqual({ unlessRoutes: ["post-commit-stand-down"] });
	});

	it("hands the arbiter the subcommand and every path the commit touched", () => {
		const repo = hookRepo("post-commit-release-paths-", [
			"docs/doc-map.md",
			"app/page.tsx",
		]);

		expect(runStep(repo.root).argv).toEqual([
			"release-committed",
			"--commit",
			headOf(repo),
			"app/page.tsx",
			"docs/doc-map.md",
		]);
	});

	it("keeps a path containing a space as ONE argument", () => {
		const repo = hookRepo("post-commit-release-space-", ["docs/a file.md"]);

		expect(runStep(repo.root).argv).toEqual([
			"release-committed",
			"--commit",
			headOf(repo),
			"docs/a file.md",
		]);
	});

	// All five sentinels, not a representative one: the stand-down set is a
	// hand-written list, and a name dropped from it is exactly the regression
	// this catches. The sixth, `sequencer`, is below.
	it.each(REPLAY_SENTINELS)(
		"stands down mid-replay under %s, where the paths are somebody else's",
		async (sentinel, kind) => {
			const repo = hookRepo(`post-commit-release-replay-${sentinel}-`, [
				"docs/doc-map.md",
			]);
			plantSentinel(repo.root, sentinel, kind);

			const r = await runRegistry(repo.root);

			expect(r.arbiter).not.toHaveBeenCalled();
			expect(r.stdout).not.toContain("release-committed");
		},
	);

	/** A second commit on doc-map.md, by commitOverSequencer. */
	function sequencedRepo(prefix: string, liveSequence: boolean) {
		const repo = hookRepo(prefix, ["docs/doc-map.md"]);
		fs.writeFileSync(path.join(repo.root, "docs", "doc-map.md"), "y");
		commitOverSequencer(repo.root, liveSequence, ["-a"]);
		return repo;
	}

	it("stands down mid revert sequence, where the paths are somebody else's", async () => {
		const r = await runRegistry(
			sequencedRepo("post-commit-release-sequence-", true).root,
		);

		expect(r.arbiter).not.toHaveBeenCalled();
		expect(r.stdout).not.toContain("release-committed");
	});

	it("releases a commit made over a leftover sequencer (#3298)", async () => {
		const repo = sequencedRepo("post-commit-release-leftover-", false);

		const r = await runRegistry(repo.root);

		expect(r.stdout).toContain(
			`release-committed\n--commit\n${headOf(repo)}\ndocs/doc-map.md\n`,
		);
	});

	it("says nothing, exit 0, where the arbiter exits non-zero", () => {
		const repo = hookRepo("post-commit-release-nonzero-", ["docs/doc-map.md"]);
		stubProgram("session-arbiter.js", () => ({ ...SILENT, exit: 3 }));

		expect(
			releaseClaimsRow({ cwd: repo.root, env: hookEnv() }, programs),
		).toEqual(SILENT);
	});

	it("names an arbiter that throws in one line, and the steps after it still run", async () => {
		const repo = hookRepo("post-commit-release-throw-", ["docs/doc-map.md"]);
		const quiet = quietPrograms();
		stubProgram("session-arbiter.js", () => {
			throw new Error("boom");
		});

		const r = await runPostCommit({ cwd: repo.root, env: hookEnv() });

		expect(r.exit).toBe(0);
		expect(r.stderr).toBe("post-commit: the claim-release step threw: boom\n");
		expect(quiet["keep-hook-shims.js"]).toHaveBeenCalledOnce();
	});

	it("passes the arbiter's stderr through — a clobber notice is said once", () => {
		const repo = hookRepo("post-commit-release-stderr-", ["docs/doc-map.md"]);
		stubProgram("session-arbiter.js", () => ({
			...SILENT,
			stderr: "session-arbiter: clobbered\n",
		}));

		expect(
			releaseClaimsRow({ cwd: repo.root, env: hookEnv() }, programs).stderr,
		).toBe("session-arbiter: clobbered\n");
	});

	it("hands the arbiter none of the three git redirects, so its cleanliness check reads the real tree", () => {
		const repo = hookRepo("post-commit-release-env-", ["docs/doc-map.md"]);

		const { arbiter } = runStep(repo.root, {
			GIT_DIR: ".git",
			GIT_WORK_TREE: ".",
		});

		const handed = arbiter.mock.calls[0][0].env;
		for (const k of ["GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE"])
			expect(handed[k], k).toBeUndefined();
	});

	it("says nothing on a commit that touched nothing", () => {
		const repo = hookRepo("post-commit-release-empty-", []);

		const r = runStep(repo.root);

		expect(r.stdout).toBe("");
		expect(r.arbiter).not.toHaveBeenCalled();
	});
});

describe("the release and the record under a linked worktree's hook redirects", () => {
	const sb = freshSandbox();
	const { cli } = arbiterCli(sb);

	it("releases the worktree commit's paths and records it at the main tree", () => {
		gitRepo(sb);
		fs.writeFileSync(path.join(sb.repo, "docs", "notes.md"), "seed\n");
		commitAll(sb);
		const { wt, env } = linkedCommit(sb.repo, sb.dir);
		live(sb, "alice");
		const session = { ...env, CLAUDE_CODE_SESSION_ID: "alice" };

		const release = releaseClaimsRow({ cwd: wt, env: session }, programs);
		expect(release.exit).toBe(0);
		expect(release.stdout).toContain("docs/wt.md");

		const ledger = () =>
			cli(["writes", "--committed"], {
				...scrubbedGitEnv(session),
				CLAUDE_PROJECT_DIR: sb.repo,
			}).stdout.split("\n");
		expect(ledger()).not.toContain("docs/wt.md");
		/* The ledger the Stop hook reads, at the main tree, bills the
		 * worktree's commit. */
		const record = rowOf("commit-record").run(
			{ cwd: wt, env: session },
			programs,
		);
		expect(record).toEqual(SILENT);
		expect(ledger()).toContain("docs/wt.md");
		expect(
			execFileSync("git", ["status", "--porcelain"], {
				cwd: wt,
				encoding: "utf8",
				env: scrubbedGitEnv(process.env),
			}),
		).toBe("");
	});
});
