// @vitest-environment node
/*
 * guard-hook-escape.js refuses an agent's own spelling of a git-hook escape
 * (#916). These are its boundary cases (§X11), run as the harness runs it:
 * the payload on stdin, the real rule store and the fail-open log, end to
 * end. Which command earns which verdict is lib/hook-escape.test.ts's; the
 * throw policy is lib/refuse-on-throw.test.ts's (#2801).
 *
 * The command judged is never run: the guard is handed a payload against a
 * throwaway repo, and the deny is checked against the rule fragment it
 * splices rather than a second copy of its text. Loosen it and an agent can
 * stand a `.husky/pre-commit` gate down for itself on its own say-so.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failOpenLogPath, readFailOpenLog } from "./guard-log-fixture";
import { mkScratchDir } from "./lib/git-fixture";
import {
	buildBashPayload,
	nodeGuardOutput,
	runNodeGuard,
} from "./lib/pretool-guard-testkit";

const GUARD = path.resolve(__dirname, "guard-hook-escape.js");

const { readRuleText } = require("./lib/rule-text") as {
	readRuleText: (id: string) => string;
};

let dir: string;
let config: string;

/** The hook output for `command`, or null; exit 0 and a quiet stderr
 * asserted on every call. */
const emission = (command: string, env: NodeJS.ProcessEnv = {}) =>
	nodeGuardOutput(GUARD, buildBashPayload(command, "test"), {
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

describe("the guard, end to end", () => {
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
		// WFC_SCRIPT_ROOT stands in for an install: a core root with no
		// package.json.
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

describe("the fail-open record", () => {
	const run = (stdin: string) =>
		runNodeGuard(GUARD, null, { project: dir, config, cwd: dir, stdin });

	it("treats an empty payload as nothing to check, not a fault", () => {
		const r = run("");
		expect([r.status, r.stdout, r.stderr]).toEqual([0, "", ""]);
		expect(fs.existsSync(failOpenLogPath(config, dir))).toBe(false);
	});

	it.each([
		[
			"a payload that is not JSON",
			"{not json",
			/payload did not parse as JSON/,
		],
		[
			"a payload carrying no command",
			JSON.stringify({ session_id: "t", tool_name: "Bash", tool_input: {} }),
			/no command in payload/,
		],
	])("records %s, allowing", (_l, stdin, match) => {
		const r = run(stdin);
		expect([r.status, r.stdout, r.stderr]).toEqual([0, "", ""]);
		const [line] = readFailOpenLog(config, dir).trim().split("\n");
		expect(line?.split("\t")).toEqual([
			expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
			"guard-hook-escape.js",
			expect.stringMatching(match),
		]);
	});

	it("refuses, logged, where its core throws", () => {
		// A copy of the entry beside a core that throws; every other lib is the
		// real one, linked.
		const at = path.join(dir, "broken");
		const lib = path.join(at, "scripts", "lib");
		fs.mkdirSync(lib, { recursive: true });
		fs.copyFileSync(GUARD, path.join(at, "scripts", "guard-hook-escape.js"));
		for (const f of fs.readdirSync(path.join(__dirname, "lib")))
			if (f !== "hook-escape.js")
				fs.symlinkSync(path.join(__dirname, "lib", f), path.join(lib, f));
		fs.writeFileSync(
			path.join(lib, "hook-escape.js"),
			'module.exports = { decide() { throw new Error("broke"); } };\n',
		);
		const out = nodeGuardOutput(
			path.join(at, "scripts", "guard-hook-escape.js"),
			buildBashPayload("WFC_ALLOW_BRANCH=1 git commit -m x -- a", "test"),
			{ project: dir, config, cwd: dir },
		);
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toBe(
			"guard-hook-escape.js could not judge this command, so it refuses it: broke",
		);
		expect(readFailOpenLog(config, dir)).toMatch(
			/core threw — the command was refused\tbroke/,
		);
	});
});
