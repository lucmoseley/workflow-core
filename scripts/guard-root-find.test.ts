// @vitest-environment node

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failOpenLogPath } from "./guard-log-fixture";
import {
	buildBashPayload,
	dispatchCoreOutput,
	guardDirs,
} from "./lib/pretool-guard-testkit";

const CORE = "guard-root-find";
const PLUGIN_ROOT = fs.realpathSync(path.resolve(__dirname, ".."));

let dir: string;
let config: string;
let project: string;

const emission = (
	command: string,
	{
		cwd,
		hookCwd = project,
		env = {},
	}: { cwd?: string; hookCwd?: string; env?: NodeJS.ProcessEnv } = {},
) =>
	dispatchCoreOutput(
		CORE,
		{ ...buildBashPayload(command, null), ...(cwd ? { cwd } : {}) },
		{ project, config, cwd: hookCwd, env },
	);

beforeEach(() => {
	({ dir, config } = guardDirs("guard-root-find-"));
	project = path.join(dir, "project");
	fs.mkdirSync(project);
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("the guard, end to end", () => {
	it("refuses a find at / as JSON on exit 0, handing over the real plugin root (#1006)", () => {
		const out = emission("find / -name x", { cwd: project });
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toMatch(
			/^Refused: `find \/ -name x` starts at `\/`\./,
		);
		expect(out.permissionDecisionReason).toContain(
			`This plugin's own files: ${PLUGIN_ROOT} — its scripts/ and docs/agents/ are there.`,
		);
		expect(fs.existsSync(failOpenLogPath(config, project))).toBe(false);
	});

	it("resolves a relative start against the payload's cwd", () => {
		expect(emission("find . -name x", { cwd: "/" }).permissionDecision).toBe(
			"deny",
		);
		expect(emission("find . -name x", { cwd: project })).toBeNull();
	});

	it("falls back to the hook's own directory where the payload has none", () => {
		expect(emission("find -name x", { hookCwd: "/" }).permissionDecision).toBe(
			"deny",
		);
		expect(emission("find -name x")).toBeNull();
	});

	it("reads a cd target's variable from the environment", () => {
		expect(
			emission("cd $X && find . -x", { cwd: project, env: { X: "/" } })
				.permissionDecision,
		).toBe("deny");
	});

	it("names the plugin's directories relative to an install's root (#5641)", () => {
		const install = path.join(dir, "install");
		fs.mkdirSync(path.join(install, "docs", "agents"), { recursive: true });
		const out = emission("find / -x", {
			cwd: project,
			env: { WFC_SCRIPT_ROOT: install },
		});
		expect(out.permissionDecisionReason).toContain(
			`This plugin's own files: ${install} — its scripts/ and docs/agents/ are there.`,
		);
	});

	it("is silent on a find it passes", () => {
		expect(emission("find /usr -name x", { cwd: project })).toBeNull();
		expect(fs.existsSync(failOpenLogPath(config, project))).toBe(false);
	});
});
