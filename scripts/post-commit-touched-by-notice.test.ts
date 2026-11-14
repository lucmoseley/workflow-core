// @vitest-environment node
/*
 * .husky/post-commit's `--touched-by` notices — the census's (#1810) and the
 * guard registry's (#2375) — as lib/post-commit-steps.js's touchedByRow and
 * their two rows in lib/post-commit-rows.js, run through dispatch() on the
 * real route where the gating is the point (#5208), beside
 * post-commit-release-claims.test.ts's release step.
 *
 * What is under test is the STEP'S half: the argv it hands each checker, that
 * it prints the checker's report only where the commit expired something, and
 * that a fault in it never stops the steps after it. The checker's run stands
 * in through lib/check.js's checkInProcess (lib/post-commit-testkit.ts); what
 * a commit expires is each checker's own test's. Loosen a case and a commit
 * that expires a census row or a registry anchor lands with no notice.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	hookEnv,
	quietPrograms,
	type Result,
	rowOf,
	runPostCommit,
	SCRIPTS,
	SILENT,
	STEPS,
	stubCheck,
} from "./lib/post-commit-testkit";
import { newRepo, registerTempCleanup } from "./lib/precommit-gate-harness";

const temps = registerTempCleanup();
const load = createRequire(__filename);

const CHECKERS = [
	["check-instruction-surface.js", "instruction-surface"],
	["check-guard-registry.js", "guard-registry"],
] as const;

const WARN = (argv: string[]): Result => ({
	exit: 0,
	stdout: "",
	stderr: `This commit changed a guard\n${argv.join(" ")}\nWARN: 1 finding this commit expired\n`,
});

describe.each(CHECKERS)(
	".husky/post-commit's --touched-by notice from %s",
	(checker, id) => {
		/** A throwaway repo with one commit. */
		function hookRepo(prefix: string) {
			const repo = newRepo(prefix, temps);
			fs.writeFileSync(path.join(repo.root, "a.txt"), "x");
			repo.git("add", "-A");
			repo.git("commit", "-q", "-m", "one");
			return {
				root: repo.root,
				head: repo.git("rev-parse", "HEAD").toString().trim(),
			};
		}

		/** The row's step on `cwd`, the checker's run answering `answer`. */
		async function runStep(
			cwd: string,
			answer: (argv: string[]) => Result,
			env: NodeJS.ProcessEnv = {},
		) {
			const check = stubCheck((_spec, argv) => answer(argv));
			const r = await STEPS.touchedByRow(checker)({ cwd, env: hookEnv(env) });
			expect(r.exit).toBe(0);
			expect(r.stderr).toBe("");
			return { out: r.stdout, check };
		}

		it("is wired: its registry row runs this checker's SPEC, standing down on the post-commit stand-down set", async () => {
			const row = rowOf(id);
			expect(row.when).toEqual({ unlessRoutes: ["post-commit-stand-down"] });
			const { root } = hookRepo("post-commit-touched-by-wired-");
			const check = stubCheck(() => SILENT);
			await row.run({ cwd: root, env: hookEnv() });
			const [spec, , opts] = check.mock.calls[0];
			expect(opts.script).toBe(path.join(SCRIPTS, checker));
			expect(spec).toBe(load(path.join(SCRIPTS, checker)).SPEC);
		});

		/* The real checker, once, through the real checkInProcess: a fixture
		 * repo with no census or registry of its own expires nothing, and its
		 * BROKEN run says nothing. */
		it("runs the real checker in-process, silent on a repo it cannot read", async () => {
			const { root } = hookRepo("post-commit-touched-by-real-");
			expect(
				await STEPS.touchedByRow(checker)({ cwd: root, env: hookEnv() }),
			).toEqual(SILENT);
		}, 60_000);

		it("prints the checker's report, run on this commit alone", async () => {
			const { root, head } = hookRepo("post-commit-touched-by-warn-");
			const { out } = await runStep(root, WARN);
			expect(out).toContain("This commit changed a guard");
			expect(out).toContain(`--root ${root} --touched-by ${head}`);
			expect(out).toContain("WARN: 1 finding this commit expired");
		});

		it("unsets the three git redirects, so the checker's git reads resolve from its own root", async () => {
			const { root } = hookRepo("post-commit-touched-by-env-");
			const { out } = await runStep(
				root,
				() => ({
					...SILENT,
					stderr: `env: ${["GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE"].map((k) => process.env[k] ?? "-").join(",")}\n`,
				}),
				{ GIT_DIR: ".git", GIT_WORK_TREE: "." },
			);
			expect(out).toBe("env: -,-,-\n");
		});

		it("prints nothing on an OK run, the commit having expired nothing", async () => {
			const { root } = hookRepo("post-commit-touched-by-ok-");
			const { out } = await runStep(root, () => ({
				...SILENT,
				stderr: "OK: HEAD expired nothing.\n",
			}));
			expect(out).toBe("");
		});

		it("prints nothing where the checker is BROKEN or throws, as an adopter with no anchors file is", async () => {
			const { root } = hookRepo("post-commit-touched-by-broken-");
			for (const stderr of [
				"BROKEN: no baseline\n",
				"BROKEN: the check threw: Error: boom\n",
			])
				expect(
					(await runStep(root, () => ({ exit: 2, stdout: "", stderr }))).out,
				).toBe("");
		});

		it("prints the BROKEN line of a run its git ceiling stopped, so a stalled commit says why (#2210)", async () => {
			const line =
				"BROKEN: --touched-by passed its 30s ceiling waiting on git diff-tree HEAD, and killed it; nothing it found is reported.";
			const { root } = hookRepo("post-commit-touched-by-ceiling-");
			const { out } = await runStep(root, () => ({
				exit: 2,
				stdout: "",
				stderr: `${line}\n`,
			}));
			expect(out).toBe(`${line}\n`);
		});

		it("names a checker run that rejects in one line, and the steps after it still run", async () => {
			const { root } = hookRepo("post-commit-touched-by-reject-");
			const quiet = quietPrograms();
			stubCheck((_spec, _argv, { script }) => {
				if (script.endsWith(checker)) throw new Error("boom");
				return SILENT;
			});
			const r = await runPostCommit({ cwd: root, env: hookEnv() });
			expect(r.exit).toBe(0);
			expect(r.stderr).toBe(`post-commit: the ${id} step threw: boom\n`);
			expect(quiet["keep-hook-shims.js"]).toHaveBeenCalledOnce();
		});

		it.each([
			["stands down mid-replay, where the commit may be a neighbour's", true],
			["prints where no replay is in progress", false],
		])("%s", async (_name, replaying) => {
			const { root } = hookRepo("post-commit-touched-by-replay-");
			if (replaying)
				fs.writeFileSync(path.join(root, ".git", "CHERRY_PICK_HEAD"), "x");
			quietPrograms();
			stubCheck((_spec, argv, { script }) =>
				script.endsWith(checker) ? WARN(argv) : SILENT,
			);
			const r = await runPostCommit({ cwd: root, env: hookEnv() });
			if (replaying)
				expect(r.stdout).not.toContain("This commit changed a guard");
			else expect(r.stdout).toContain("This commit changed a guard");
		});
	},
);
