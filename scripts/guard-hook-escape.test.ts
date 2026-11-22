// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failOpenLogPath } from "./guard-log-fixture";
import { mkScratchDir } from "./lib/git-fixture";
import {
	buildBashPayload,
	dispatchCoreOutput,
} from "./lib/pretool-guard-testkit";

const CORE = "guard-hook-escape";

const { readRuleText } = require("./lib/rule-text") as {
	readRuleText: (id: string) => string;
};

let dir: string;
let config: string;

const emission = (command: string, env: NodeJS.ProcessEnv = {}) =>
	dispatchCoreOutput(CORE, buildBashPayload(command, "test"), {
		project: dir,
		config,
		cwd: dir,
		env,
	});

beforeEach(() => {
	dir = mkScratchDir("guard-hook-escape-");
	config = path.join(dir, "claude-config");
	execFileSync("git", ["init", "-q", "-b", "main", "."], { cwd: dir });
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("the core, end to end", () => {
	it("refuses an escape as JSON on exit 0, naming the command and carrying the whole rule", () => {
		const out = emission('WFC_ALLOW_BRANCH="1" git commit -m x -- a');
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toBe(
			`This command sets a git-hook escape: WFC_ALLOW_BRANCH="…" git commit -m x -- a\n\n${readRuleText("hook-escape")}`,
		);
		expect(fs.existsSync(failOpenLogPath(config, dir))).toBe(false);
	});

	it("passes a mention in silence, logging nothing", () => {
		expect(emission("grep -n WFC_ALLOW_BRANCH scripts/")).toBeNull();
		expect(fs.existsSync(failOpenLogPath(config, dir))).toBe(false);
	});

	it("reads the whole multi-line subject quote-aware: a hand-over passes, a later assignment is refused", () => {
		expect(
			emission(
				"gh issue comment 1 --body 'Run this:\nWFC_ALLOW_BRANCH=1 git commit -m x -- a'",
			),
		).toBeNull();
		expect(
			emission("echo 'a\nb'; WFC_ALLOW_BRANCH=1 git commit -m x -- a")
				.permissionDecision,
		).toBe("deny");
	});
});

describe("a refusal whose rule it cannot read still refuses", () => {
	it("refuses with an empty store, names the fragment's file, and records no fail-open", () => {
		const store = fs.mkdtempSync(path.join(dir, "store-"));
		const out = emission("export WFC_ALLOW_BRANCH=1", {
			WFC_RULES_DIR: store,
		});
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toContain(
			"docs/agents/rules/hook-escape.txt",
		);
		expect(fs.existsSync(failOpenLogPath(config, dir))).toBe(false);
	});

	it("spells the fragment's file at the plugin root in an install", () => {
		const install = path.join(dir, "install");
		const rules = path.join(install, "docs", "agents", "rules");
		fs.mkdirSync(rules, { recursive: true });
		fs.writeFileSync(path.join(rules, "hook-escape.txt"), "x\n");
		const out = emission("export WFC_ALLOW_BRANCH=1", {
			WFC_RULES_DIR: fs.mkdtempSync(path.join(dir, "store-")),
			WFC_SCRIPT_ROOT: install,
		});
		expect(out.permissionDecisionReason).toContain(
			`read from ${rules}/hook-escape.txt.`,
		);
	});
});
