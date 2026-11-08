// @vitest-environment node
/*
 * init's skeleton, and an upgraded adopter's change set, committed through the
 * full hook stack init installed: that commit IS the test (#5). Kept apart from
 * init-adopter.test.ts: together they would hold one worker past the per-file
 * limit (#4296). Over the 10 s run-cost budget (base §X8 (5)) by nature: each
 * case runs every gate the hooks arm, and a cheaper commit would test less.
 * The file's cost grows with its cases: the landing-on skeleton's own commit
 * (#2412) is one more.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { failOpenLogPath } from "./guard-log-fixture";
import {
	CORE,
	commitThroughHooks,
	init,
	initialised,
	made,
	repo,
	SKELETON_PATHS,
	upgradeAfterInit,
} from "./init-adopter-fixture";
import { isCutOver } from "./lib/cutover.js";
import { allRegistrations, buildCommandLine } from "./lib/registrations.js";
import { runInProcess } from "./lib/run-in-process.js";
import { shellQuote } from "./lib/sh-quote.js";

/*
 * Skipped where gitleaks is absent, since
 * `.husky/pre-commit` refuses every commit without it; CI installs it (#55). The
 * probe resolves the binary as the hooks' `"${WFC_GITLEAKS:-gitleaks}"` does
 * (#224) — `||`, not `??`, so an empty value falls back rather than skipping
 * both cases.
 */

const HAS_GITLEAKS = (() => {
	try {
		execFileSync(process.env.WFC_GITLEAKS || "gitleaks", ["version"], {
			stdio: "ignore",
		});
		return true;
	} catch {
		return false;
	}
})();

/* Untraced: a case's budget, an init and a commit through every gate. */
const COMMIT_BUDGET_MS = 180_000;

describe("the skeleton's first commit", () => {
	it.skipIf(!HAS_GITLEAKS)(
		"lands green through the full husky stack with no modules",
		() => {
			const { dir } = initialised();
			/* A session's leaked CLAUDE_PROJECT_DIR, so CI too checks the
			 * helper's override (#3296). */
			const r = commitThroughHooks(
				dir,
				"Start the repo: the workflow-core skeleton",
				SKELETON_PATHS,
				{ ...process.env, CLAUDE_PROJECT_DIR: CORE },
			);
			expect(`${r.stdout}\n${r.stderr}`).not.toMatch(/^(FAIL|BROKEN):/m);
			expect(r.status).toBe(0);
			expect(
				execFileSync("git", ["ls-files", ".gitignore"], {
					cwd: dir,
					encoding: "utf8",
				}),
			).toBe(".gitignore\n");
		},
		COMMIT_BUDGET_MS,
	);

	it.skipIf(!HAS_GITLEAKS)(
		"lands green with the roadmap module on",
		() => {
			const { dir } = repo();
			expect(
				init(
					dir,
					"--founder",
					"A Founder",
					"--modules",
					"roadmap",
					"--category",
					"core=Core",
					"--no-tracker",
				).status,
			).toBe(0);
			const r = commitThroughHooks(
				dir,
				"Start the repo: skeleton with the roadmap",
			);
			expect(`${r.stdout}\n${r.stderr}`).not.toMatch(/^(FAIL|BROKEN):/m);
			expect(r.status).toBe(0);
		},
		COMMIT_BUDGET_MS,
	);
});

describe("a new repo created with the landing module on (#2412)", () => {
	it.skipIf(!HAS_GITLEAKS)(
		"is cut over from the start, hands its sessions the queue rule, and lands its skeleton commit green",
		() => {
			const { dir, git } = repo();
			expect(
				init(
					dir,
					"--founder",
					"A Founder",
					"--modules",
					"landing",
					"--no-tracker",
				).status,
			).toBe(0);
			expect(
				JSON.parse(
					fs.readFileSync(path.join(dir, ".claude/workflow-core.json"), "utf8"),
				).modules,
			).toEqual(["landing"]);
			expect(
				fs.readFileSync(path.join(dir, ".claude/workflow-core.md"), "utf8"),
			).toContain("A push to your session's queue ref is your own act");
			expect(isCutOver(dir)).toBe(true);
			/* The suite's WFC_MODULES holds every module but `landing`, and would
			 * replace the declared list in the hooks. */
			const { WFC_MODULES: _suite, ...env } = process.env;
			const r = commitThroughHooks(
				dir,
				"Start the repo: the workflow-core skeleton",
				SKELETON_PATHS,
				env,
			);
			expect(`${r.stdout}\n${r.stderr}`).not.toMatch(/^(FAIL|BROKEN):/m);
			expect(r.status, r.stderr).toBe(0);
			expect(git("status", "--porcelain", "--", ...SKELETON_PATHS)).toBe("");
		},
		COMMIT_BUDGET_MS,
	);
});

/*
 * An adopter from before the host registries, with gaps of its own, commits
 * everything upgrade changed: the registry guard and the husky stack must both
 * let it through (#1671).
 */
describe("an unseeded adopter's first commit after upgrade (#1671)", () => {
	const ownGuard = "scripts/guard-own.sh";
	const ownChecker = "scripts/check-own.js";

	/** init's tree, put back to a pre-v1.3.14 adopter's and committed. */
	function unseededAdopter() {
		const { dir, git } = initialised("A");
		for (const rel of [
			".claude/registrations.json",
			".claude/guard-fire-needles.json",
		])
			fs.rmSync(path.join(dir, rel));
		/* A hook from before #1839, which upgrade turns into its shim. */
		fs.writeFileSync(
			path.join(dir, ".husky/pre-commit"),
			`#!/usr/bin/env sh\nWFC_PLUGIN_ROOT=${shellQuote(CORE)}\nexport WFC_PLUGIN_ROOT\n`,
		);
		/* Settings with a core key missing, so the merge rewrites the file, and a
		 * hook of the adopter's own that no registry pins or counts. */
		const at = path.join(dir, ".claude/settings.json");
		const settings = JSON.parse(fs.readFileSync(at, "utf8"));
		delete settings.env.CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP;
		settings.hooks = {
			PreToolUse: [
				{
					matcher: "Bash",
					hooks: [
						{
							type: "command",
							command: `bash "$CLAUDE_PROJECT_DIR"/${ownGuard}`,
						},
					],
				},
			],
		};
		fs.writeFileSync(at, `${JSON.stringify(settings, null, "\t")}\n`);
		fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
		fs.writeFileSync(path.join(dir, ownGuard), "#!/usr/bin/env bash\n", {
			mode: 0o755,
		});
		fs.writeFileSync(path.join(dir, ownChecker), "// nothing calls this\n");
		git("add", "-A");
		/* With no hooks, so the gaps land as HEAD's and read as inherited below. */
		git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "before upgrade");
		return { dir, git };
	}

	const readHookLines = (dir: string) =>
		allRegistrations(
			JSON.parse(
				fs.readFileSync(path.join(dir, ".claude/settings.json"), "utf8"),
			),
		).map(buildCommandLine);

	it.skipIf(!HAS_GITLEAKS)(
		"lands the whole change set through the registry guard and the husky stack",
		() => {
			const { dir, git } = unseededAdopter();
			const hooksBefore = readHookLines(dir);
			upgradeAfterInit(dir);
			/* Upgrade adds no hook to settings.json, so it owes no `hooks` row:
			 * a change here reopens #1671's second question. */
			expect(readHookLines(dir)).toEqual(hooksBefore);

			const changed = git("status", "--porcelain", "-uall")
				.split("\n")
				.filter(Boolean)
				.map((l) => l.slice(3));
			expect(changed).toEqual(
				expect.arrayContaining([
					".claude/settings.json",
					".claude/registrations.json",
					".claude/guard-fire-needles.json",
					".husky/pre-commit",
				]),
			);
			const message = "Upgrade workflow-core";
			const config = fs.mkdtempSync(path.join(os.tmpdir(), "adopter-config-"));
			made.push(config);
			const env = {
				...process.env,
				CLAUDE_PROJECT_DIR: dir,
				CLAUDE_CONFIG_DIR: config,
			};
			const guardOn = (paths: string[]) => {
				git("add", "-N", "--", ...paths);
				return runInProcess(
					path.join(__dirname, "guard-dispatch.js"),
					["--only", "guard-registry-atomicity"],
					{
						cwd: dir,
						env,
						stdin: JSON.stringify({
							hook_event_name: "PreToolUse",
							session_id: "upgrader",
							tool_name: "Bash",
							tool_input: {
								command: `git commit -m "${message}" -- ${paths.join(" ")}`,
							},
						}),
					},
				);
			};

			/* The upgrade moves no hook and adds no member, so the guard passes it
			 * on judging, not by failing open... */
			const allowed = guardOn(changed);
			expect(allowed.status).toBe(0);
			expect(allowed.stdout).not.toContain('"deny"');
			expect(fs.existsSync(failOpenLogPath(config, dir))).toBe(false);
			/* ...and the same tree refuses an unregistered guard riding along. */
			const extra = "scripts/guard-new.sh";
			fs.writeFileSync(path.join(dir, extra), "#!/usr/bin/env bash\n");
			const refused = guardOn([...changed, extra]);
			expect(refused.stdout).toContain('"deny"');
			expect(refused.stdout).toContain(extra);
			git("rm", "-q", "--cached", "--", extra);
			fs.rmSync(path.join(dir, extra));

			const commit = commitThroughHooks(dir, message, changed, env);
			const commitOutput = `${commit.stdout}\n${commit.stderr}`;
			expect(commitOutput).not.toMatch(/^(FAIL|BROKEN):/m);
			expect(commit.status).toBe(0);
			expect(commitOutput).toContain(`${ownGuard} has no sibling test`);
			expect(commitOutput).toContain(`${ownChecker} is run by no husky hook`);
			expect(commitOutput).toMatch(/inherited fault/);
		},
		COMMIT_BUDGET_MS,
	);
});
