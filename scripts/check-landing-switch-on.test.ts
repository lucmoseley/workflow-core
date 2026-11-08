// @vitest-environment node
/*
 * check-landing-switch-on.js (#4688) over a throwaway repo and core. Loosened,
 * a repo on v2.1.0 or later running `landing` off, or on but not cut over,
 * shares one unguarded tree with `npm run status` and SessionStart silent.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initGitRepo } from "./lib/git-fixture";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.join(__dirname, "check-landing-switch-on.js");

let dir: string;
let repo: string;
let core: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "landing-switch-on-"));
	repo = path.join(dir, "repo");
	core = path.join(dir, "core");
	initGitRepo(repo, "/dev/null");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const setUp = (
	version: string,
	modules: string[],
	upstream: "landing" | "main" | null,
) => {
	fs.mkdirSync(path.join(core, ".claude-plugin"), { recursive: true });
	fs.writeFileSync(
		path.join(core, ".claude-plugin", "plugin.json"),
		JSON.stringify({ name: "workflow-core", version }),
	);
	fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(repo, ".claude", "workflow-core.json"),
		JSON.stringify({ contract: 1, modules, tracker: "o/here" }),
	);
	if (upstream !== null)
		execFileSync(
			"git",
			["config", "branch.main.merge", `refs/heads/${upstream}`],
			{ cwd: repo },
		);
};

/* Without the suite's WFC_MODULES, which would replace the repo's own list. */
const check = (...args: string[]) => {
	const { WFC_MODULES: _, ...env } = process.env;
	return runInProcess(SCRIPT, args, {
		cwd: repo,
		env: { ...env, WFC_REPO_ROOT: repo, WFC_SCRIPT_ROOT: core },
	});
};

describe("check-landing-switch-on.js (#4688)", () => {
	it("fails a v2.1.0 repo running landing off, naming the note's switch-on steps", () => {
		setUp("2.1.0", [], "main");
		const r = check();
		expect(r.stderr).toContain("LANDING-OFF");
		expect(r.stderr).toContain("migrations/v2.1.0.md");
		expect(r.stderr).toContain("switch-on [act]s");
		expect(r.stderr).toContain("steps-owed.js");
		expect(r.status).toBe(1);
	});

	it("fails a later release running landing off too", () => {
		setUp("2.3.1", [], null);
		expect(check().stderr).toContain("LANDING-OFF");
	});

	it("fails landing on but not cut over, naming cutover-main-checkout.js", () => {
		setUp("2.1.0", ["landing"], "landing");
		const r = check();
		expect(r.stderr).toContain("NOT-CUT-OVER");
		expect(r.stderr).toContain("cutover-main-checkout.js");
		expect(r.status).toBe(1);
	});

	it("passes landing on and cut over", () => {
		setUp("2.1.0", ["landing"], "main");
		const r = check();
		expect(r.stderr).toContain("OK:");
		expect(r.status).toBe(0);
	});

	it("skips a core before v2.1.0, whose shared-tree guards still run", () => {
		setUp("2.0.1", [], "main");
		const r = check();
		expect(r.stderr).toContain("SKIP:");
		expect(r.status).toBe(0);
	});

	it("prints the FAIL at SessionStart and nothing once cut over", () => {
		setUp("2.1.0", [], "main");
		expect(check("--notify").stdout).toContain("LANDING-OFF");
		setUp("2.1.0", ["landing"], "main");
		expect(check("--notify").stdout).toBe("");
	});
});
