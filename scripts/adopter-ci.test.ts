// @vitest-environment node
/*
 * Pins adopter-ci.js, the one job of an adopter's core-owned CI workflow
 * (#5347), by running it over fixture adopters.
 *
 * Breaking it lets a red command or check pass the adopter's CI, or lets one
 * failure hide the steps after it.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CI_WORKFLOW, renderCiWorkflow } from "./lib/adopter-ci.js";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "adopter-ci.js");

let root: string;

const write = (rel: string, body: string) => {
	const at = path.join(root, rel);
	fs.mkdirSync(path.dirname(at), { recursive: true });
	fs.writeFileSync(at, body);
};
const config = (extra: object) =>
	write(
		".claude/workflow-core.json",
		JSON.stringify({
			contract: 1,
			founder: "A Founder",
			modules: [],
			...extra,
		}),
	);
const run = () => {
	execFileSync("git", ["add", "-A"], { cwd: root });
	/* The suite injects WFC_MODULES, which replaces the declared list the
	 * gates read. */
	const { WFC_MODULES: _, ...env } = process.env;
	return runInProcess(SCRIPT, [], {
		cwd: root,
		env: { ...env, CLAUDE_PROJECT_DIR: root },
	});
};

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "adopter-ci-test-"));
	execFileSync("git", ["init", "-q"], { cwd: root });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("the declared commands", () => {
	it("runs every one after a failure and fails naming the red one", () => {
		config({
			commands: {
				lint: "touch lint.ran; exit 3",
				test: "touch test.ran",
			},
		});
		const r = run();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("commands.lint");
		expect(r.stderr).not.toContain("commands.test");
		expect(fs.existsSync(path.join(root, "test.ran"))).toBe(true);
	});

	it("passes where every declared command does", () => {
		config({ commands: { check: "true", test: "true" } });
		const r = run();
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("every step passed");
	});
});

describe("the shipped tree checks", () => {
	it("runs a check whose gate holds and fails on its FAIL", () => {
		config({});
		write(
			".github/workflows/x.yml",
			"name: x\non: push\npermissions: write-all\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n",
		);
		const r = run();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("check workflow-permissions");
	});

	it("passes the core's own rendered workflow, and skips a check whose gate fails, naming why", () => {
		config({ ci: { runner: "ubuntu-slim" } });
		write(CI_WORKFLOW, renderCiWorkflow({ runner: "ubuntu-slim" }));
		const r = run();
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(
			'skipped digest-version: module "roadmap" is off',
		);
	});
});
