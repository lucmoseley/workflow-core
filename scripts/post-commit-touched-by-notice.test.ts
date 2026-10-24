// @vitest-environment node
/*
 * .husky/post-commit's `--touched-by` notices — the census's (#1810) and the
 * guard registry's (#2375) — cut from the hook's own text and run, as
 * post-commit-release-claims.test.ts runs the block beside them.
 *
 * What is under test is the HOOK'S half: the argv it hands each checker, that
 * it prints the checker's report only where the commit expired something, and
 * that it can never take the shell down. What a commit expires is each
 * checker's own test's. Loosen a case and a commit that expires a census row
 * or a registry anchor lands with no notice, or the hook takes the committing
 * shell down.
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

const WARN_REPORT = `process.stderr.write("This commit changed a guard\\n" + process.argv.slice(2).join(" ") + "\\nWARN: 1 finding this commit expired\\n");\n`;

const CHECKERS = ["check-instruction-surface.js", "check-guard-registry.js"];

describe.each(CHECKERS)(
	".husky/post-commit's --touched-by notice from %s",
	(checker) => {
		/** A throwaway repo with one commit, and a stub checker where the hook looks. */
		function hookRepo(prefix: string, stub?: string) {
			const repo = newRepo(prefix, temps);
			fs.writeFileSync(path.join(repo.root, "a.txt"), "x");
			repo.git("add", "-A");
			repo.git("commit", "-q", "-m", "one");
			if (stub !== undefined) {
				fs.mkdirSync(path.join(repo.root, "scripts"), { recursive: true });
				fs.writeFileSync(path.join(repo.root, "scripts", checker), stub);
			}
			return repo;
		}

		/** `sh -e`, as .husky/_/h runs every hook; the marker proves the block returned. */
		function runBlock(cwd: string) {
			const head = spawnSync("git", ["rev-parse", "HEAD"], {
				cwd,
				encoding: "utf8",
			}).stdout.trim();
			const r = spawnSync(
				"sh",
				[
					"-e",
					"-c",
					`${cutInReplay()}\n${cutShellFunction("report_touched_by")}\ncommitted=${head}\nreport_touched_by ${checker}\nprintf "reached-end\\n"`,
				],
				{
					cwd,
					encoding: "utf8",
					// The relative index path git exports into every hook.
					env: { ...process.env, GIT_INDEX_FILE: ".git/index" },
				},
			);
			expect(r.stdout).toContain("reached-end");
			expect(r.status).toBe(0);
			return { out: r.stdout.replace("reached-end\n", ""), head };
		}

		it("is invoked at column zero, not only defined", () => {
			const uncommented = POST_COMMIT.split("\n").filter(
				(l) => !l.trimStart().startsWith("#"),
			);
			expect(uncommented).toContain(`report_touched_by ${checker}`);
		});

		it("prints the checker's report, run on this commit alone", () => {
			const repo = hookRepo("post-commit-touched-by-warn-", WARN_REPORT);
			const { out, head } = runBlock(repo.root);
			expect(out).toContain("This commit changed a guard");
			expect(out).toContain(`--root ${repo.root} --touched-by ${head}`);
			expect(out).toContain("WARN: 1 finding this commit expired");
		});

		it("unsets the three git redirects, so the checker's git reads resolve from its own root", () => {
			const repo = hookRepo(
				"post-commit-touched-by-env-",
				`process.stderr.write("env: " + ["GIT_INDEX_FILE", "GIT_DIR", "GIT_WORK_TREE"].map((k) => process.env[k] ?? "-").join(",") + "\\n");\n`,
			);
			expect(runBlock(repo.root).out).toContain("env: -,-,-");
		});

		it("prints nothing on an OK run, the commit having expired nothing", () => {
			const repo = hookRepo(
				"post-commit-touched-by-ok-",
				`process.stderr.write("OK: HEAD expired nothing.\\n");\n`,
			);
			expect(runBlock(repo.root).out).toBe("");
		});

		it("prints nothing where the checker is BROKEN or throws, as an adopter with no anchors file is", () => {
			for (const [prefix, stub] of [
				[
					"post-commit-touched-by-broken-",
					`process.stderr.write("BROKEN: no baseline\\n"); process.exit(2);\n`,
				],
				["post-commit-touched-by-throw-", "throw new Error('boom');\n"],
			] as const)
				expect(runBlock(hookRepo(prefix, stub).root).out).toBe("");
		});

		it("prints the BROKEN line of a run its git ceiling stopped, so a stalled commit says why (#2210)", () => {
			const line =
				"BROKEN: --touched-by passed its 30s ceiling waiting on git diff-tree HEAD, and killed it; nothing it found is reported.";
			const repo = hookRepo(
				"post-commit-touched-by-ceiling-",
				`process.stderr.write(${JSON.stringify(`${line}\n`)}); process.exit(2);\n`,
			);
			expect(runBlock(repo.root).out).toBe(`${line}\n`);
		});

		it("prints nothing where the checker is missing", () => {
			expect(
				runBlock(hookRepo("post-commit-touched-by-missing-").root).out,
			).toBe("");
		});

		it("stands down mid-replay, where the commit may be a neighbour's", () => {
			const repo = hookRepo("post-commit-touched-by-replay-", WARN_REPORT);
			fs.writeFileSync(path.join(repo.root, ".git", "CHERRY_PICK_HEAD"), "x");
			expect(runBlock(repo.root).out).toBe("");
		});
	},
);
