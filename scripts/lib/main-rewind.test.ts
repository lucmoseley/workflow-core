// @vitest-environment node
/*
 * lib/main-rewind.sh is the one rewind refusal both guards source (#1777);
 * these cases pin each guard's stub for when it fails to load. The cases with
 * the lib present are each guard's own tests.
 *
 * Break them and a checkout whose lib did not load lets a force-push or a
 * direct write of `main` through, since a guard fails open.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failOpenLogPath } from "../guard-log-fixture";
import { copyLibs, sourcedLibs } from "../guard-parse-fixture";
import { mkScratchDir } from "./git-fixture";

// biome-ignore lint/suspicious/noExplicitAny: untyped CommonJS helpers
const { ruleText } = require("./rule-text") as any;

let dir: string;
let repo: string;
let config: string;

beforeEach(() => {
	dir = mkScratchDir("main-rewind-");
	repo = path.join(dir, "repo");
	config = path.join(dir, "config");
	fs.mkdirSync(path.join(repo, "scripts", "lib"), { recursive: true });
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
	execFileSync(
		"git",
		[
			"-c",
			"user.name=t",
			"-c",
			"user.email=t@t",
			"commit",
			"-q",
			"--allow-empty",
			"-m",
			"a",
		],
		{ cwd: repo },
	);
	for (const guard of ["guard-branch-publish.sh", "guard-pull-form.sh"]) {
		const from = path.join(__dirname, "..", guard);
		fs.copyFileSync(from, path.join(repo, "scripts", guard));
		copyLibs(path.join(repo, "scripts", "lib"), sourcedLibs(from), [
			"main-rewind.sh",
		]);
	}
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("with lib/main-rewind.sh missing", () => {
	it.each([
		[
			"guard-branch-publish.sh",
			"git push --force origin main",
			"force-pushes `main`",
		],
		[
			"guard-pull-form.sh",
			"git update-ref refs/heads/main HEAD",
			"writes `main` directly",
		],
	])("%s still refuses %s, and records why", (guard, command, what) => {
		const r = spawnSync(path.join(repo, "scripts", guard), [], {
			cwd: repo,
			encoding: "utf8",
			input: JSON.stringify({
				session_id: "test",
				tool_name: "Bash",
				tool_input: { command },
			}),
			env: {
				...process.env,
				CLAUDE_PROJECT_DIR: repo,
				CLAUDE_CONFIG_DIR: config,
			},
		});
		expect(r.status).toBe(0);
		const out = JSON.parse(r.stdout).hookSpecificOutput;
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toContain(`This ${what}`);
		expect(out.permissionDecisionReason).not.toContain(ruleText("main-rewind"));
		expect(fs.readFileSync(failOpenLogPath(config, repo), "utf8")).toContain(
			"lib/main-rewind.sh did not load",
		);
	});
});
