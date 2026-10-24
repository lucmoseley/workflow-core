// @vitest-environment node
/*
 * test-gate.test.ts — which declared test commands write the test-pass marker
 * (#740), driven against a throwaway package.json, because the verdict turns
 * on the text of the declared script and each case must set it — a runner
 * that mints the marker or one that does not — which this repo's own
 * package.json cannot vary. That verdict is the line
 * between pre-push's warning owning a suite and pre-commit running it: read
 * wrongly one way, workflow-core runs its whole suite on every commit; the
 * other, an adopter's red suite commits clean again.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pushGateSkip } from "./test-gate.js";

const dirs: string[] = [];
/* WFC_MODULES replaces the declared module list, so a value inherited from
 * the shell would decide `suites` instead of each case's own config. */
const priorModules = process.env.WFC_MODULES;
beforeEach(() => {
	delete process.env.WFC_MODULES;
});
afterEach(() => {
	if (priorModules === undefined) delete process.env.WFC_MODULES;
	else process.env.WFC_MODULES = priorModules;
	while (dirs.length > 0)
		fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function host(scripts?: Record<string, string>) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "test-gate-"));
	dirs.push(dir);
	if (scripts)
		fs.writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({ scripts }),
		);
	return dir;
}

const VITEST = "node scripts/run-vitest.js";

/** Whether `command`, declared as `commands.test` with `suites` on, writes the
 *  marker: the push gate owns it where it does, so `pushGateSkip` — what
 *  pre-push and push:check read — skips nothing; pre-commit owns it where not. */
function mintsMarker(command: string, root: string): boolean {
	fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(root, ".claude", "workflow-core.json"),
		JSON.stringify({
			contract: 1,
			modules: ["suites"],
			commands: { test: command },
		}),
	);
	const skip = pushGateSkip({ root });
	expect(skip === null || "skip" in skip).toBe(true);
	return skip === null;
}

describe("which declared command writes the marker, read through pushGateSkip", () => {
	it.each([
		"npm test",
		"npm t",
		"npm run test",
		"npm run-script test",
		"npm test -- --changed",
	])("reads %s as the package.json test script", (command) => {
		expect(mintsMarker(command, host({ test: VITEST }))).toBe(true);
		expect(mintsMarker(command, host({ test: "jest" }))).toBe(false);
	});

	it("reads `npm run <name>` as that script, not the test script", () => {
		const root = host({ test: "jest", "test:v": VITEST });
		expect(mintsMarker("npm run test:v", root)).toBe(true);
	});

	it("reads a command naming the runner itself, with no package.json", () => {
		expect(mintsMarker(VITEST, host())).toBe(true);
		expect(mintsMarker("node --test", host())).toBe(false);
	});

	it("reads an npm command with no package.json, or one that will not parse, as writing none", () => {
		expect(mintsMarker("npm test", host())).toBe(false);
		const root = host();
		fs.writeFileSync(path.join(root, "package.json"), "{");
		expect(mintsMarker("npm test", root)).toBe(false);
	});
});

describe("node test-gate.js <verb>", () => {
	const run = (verb: string, root: string, config: object) => {
		fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
		fs.writeFileSync(
			path.join(root, ".claude", "workflow-core.json"),
			JSON.stringify(config),
		);
		const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: root };
		delete env.WFC_MODULES;
		return spawnSync(
			process.execPath,
			[path.join(__dirname, "test-gate.js"), verb],
			{ encoding: "utf8", env },
		);
	};

	it.each([
		["push", { modules: ["suites"] }, 0, ""],
		["push", { modules: ["suites"], commands: { test: "npm test" } }, 1, ""],
		[
			"commit",
			{ modules: ["suites"], commands: { test: "npm test" } },
			0,
			"npm test\n",
		],
		["push", { modules: [] }, 1, ""],
		["push", { contract: 99 }, 2, ""],
	])("%s over %j exits %i", (verb, cfg, status, stdout) => {
		const r = run(verb, host({ test: "jest" }), { contract: 1, ...cfg });
		expect([r.status, r.stdout]).toEqual([status, stdout]);
	});

	it("refuses a verb it does not know", () => {
		expect(run("pull", host(), { contract: 1 }).status).toBe(2);
	});
});
