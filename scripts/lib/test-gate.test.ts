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
import { pushGateState } from "./test-gate.js";

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

function declare(root: string, config: object) {
	fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(root, ".claude", "workflow-core.json"),
		JSON.stringify(config),
	);
}

/** Whether `command`, declared as `commands.test` with `suites` on, writes the
 *  marker: the push gate owns it where it does, so `pushGateState` — what
 *  pre-push and push:check read — answers owes; pre-commit owns it where not. */
function mintsMarker(command: string, root: string): boolean {
	declare(root, {
		contract: 1,
		modules: ["suites"],
		commands: { test: command },
	});
	const { state } = pushGateState({ root });
	expect(state).not.toBe("broken");
	return state === "owes";
}

describe("which declared command writes the marker, read through pushGateState", () => {
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

describe("pushGateState: whether a push owes a certificate (#2929, #3016)", () => {
	const stateFor = (modules: string[]) => {
		const root = host({ test: VITEST });
		declare(root, { contract: 1, modules });
		return pushGateState({ root });
	};

	it("skips with the lander's line where landing is on", () => {
		expect(stateFor(["suites", "landing"])).toEqual({
			state: "skip",
			line: expect.stringContaining("the lander runs the full suite"),
		});
	});

	it("owes one, with no line, where suites is on and landing off", () => {
		expect(stateFor(["suites"])).toEqual({ state: "owes", line: null });
	});

	it("skips as module-off where suites is off", () => {
		expect(stateFor([])).toEqual({
			state: "skip",
			line: expect.stringContaining('module "suites" is off'),
		});
	});

	/** A host declaring `npm test` with `suites` on, committed as it stands. */
	const committedHost = (
		scripts?: Record<string, string>,
		plant?: (root: string) => void,
	) => {
		const root = host(scripts);
		plant?.(root);
		declare(root, {
			contract: 1,
			modules: ["suites"],
			commands: { test: "npm test" },
		});
		const git = (...args: string[]) =>
			expect(spawnSync("git", ["-C", root, ...args]).status).toBe(0);
		git("init", "-q");
		git("add", ".");
		git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "c");
		return root;
	};

	it("reads package.json at the rev it is given, not the working copy's (#3135)", () => {
		const root = committedHost({ test: VITEST });
		fs.writeFileSync(
			path.join(root, "package.json"),
			JSON.stringify({ scripts: { test: "jest" } }),
		);
		expect(pushGateState({ root, rev: "HEAD" }).state).toBe("owes");
		fs.writeFileSync(path.join(root, "package.json"), "{");
		expect(pushGateState({ root, rev: "HEAD" }).state).toBe("owes");
		expect(pushGateState({ root }).state).toBe("skip");
	});

	it("reads no package.json at the rev as minting none, however the working copy reads", () => {
		const root = committedHost();
		fs.writeFileSync(
			path.join(root, "package.json"),
			JSON.stringify({ scripts: { test: VITEST } }),
		);
		expect(pushGateState({ root, rev: "HEAD" }).state).toBe("skip");
	});

	it("answers broken where the rev holds no file at package.json", () => {
		const root = committedHost(undefined, (dir) => {
			fs.mkdirSync(path.join(dir, "package.json"));
			fs.writeFileSync(path.join(dir, "package.json", "x"), "");
		});
		expect(pushGateState({ root, rev: "HEAD" })).toEqual({
			state: "broken",
			line: expect.stringContaining("package.json at HEAD is not a file"),
		});
	});

	it("answers broken, with the reader's reason, on a config it cannot read", () => {
		const root = host({ test: VITEST });
		declare(root, { contract: 99 });
		expect(pushGateState({ root })).toEqual({
			state: "broken",
			line: expect.stringMatching(/\S/),
		});
	});
});

describe("node test-gate.js <verb>", () => {
	const run = (verb: string, root: string, config: object) => {
		declare(root, config);
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
