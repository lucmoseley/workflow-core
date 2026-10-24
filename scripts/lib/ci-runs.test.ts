// @vitest-environment node

/*
 * scripts/lib/ci-runs.js as tool_gate reads it (#1629): the `ci:` line naming
 * the workflows that run a tool. The format and lint gates' reading of the
 * same function is pinned through formatters.js in formatters.test.ts.
 *
 * Each case reads a throwaway host's workflows, never this checkout's, which
 * change under the suite. Loosen one and a skipped gate names a workflow that
 * does not run the tool, or says none does where one does.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { newRepo, registerTempCleanup } from "./precommit-gate-harness";
import { ROOT } from "./precommit-gate-testkit";
import { runInProcess } from "./run-in-process.js";

const temps = registerTempCleanup();
const PROGRAM = path.join(ROOT, "scripts", "lib", "ci-runs.js");

const host = (
	workflows: Record<string, string>,
	scripts?: Record<string, string>,
) => {
	const { root } = newRepo("ci-runs-host-", temps);
	const dir = path.join(root, ".github", "workflows");
	fs.mkdirSync(dir, { recursive: true });
	for (const [name, body] of Object.entries(workflows))
		fs.writeFileSync(path.join(dir, name), body);
	if (scripts)
		fs.writeFileSync(
			path.join(root, "package.json"),
			JSON.stringify({ scripts }),
		);
	return root;
};

const run = (root: string, args: string[]) => {
	const r = runInProcess(PROGRAM, args, { cwd: root, env: process.env });
	return { code: r.status, stdout: r.stdout, stderr: r.stderr };
};

describe("ci-runs.js as a program — tool_gate's reading (#1629)", () => {
	it("names every workflow running the tool, through npm scripts too", () => {
		const root = host(
			{
				"a.yml": "      - run: actionlint\n",
				"b.yml": "      - run: npm run lint:actions\n",
				"c.yml": "      - run: npm test\n",
			},
			{ "lint:actions": "actionlint -color" },
		);
		expect(run(root, ["actionlint"])).toEqual({
			code: 0,
			stdout: "ci:.github/workflows/a.yml, .github/workflows/b.yml\n",
			stderr: "",
		});
	});

	it("prints a bare `ci:` where no workflow runs it, a comment line not counting", () => {
		const root = host({ "a.yml": "      # shellcheck runs elsewhere\n" });
		const { code, stdout } = run(root, ["shellcheck"]);
		expect(stdout).toBe("ci:\n");
		expect(code).toBe(0);
	});

	it("refuses a tool it does not know with its usage, exiting 2 and printing no `ci:` line", () => {
		const { code, stdout, stderr } = run(host({}), ["no-such-linter"]);
		expect(stdout).toBe("");
		expect(stderr).toMatch(/usage: node ci-runs\.js <shfmt\|.*\|actionlint>/);
		expect(code).toBe(2);
	});
});
