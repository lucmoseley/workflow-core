// @vitest-environment node

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failOpenLogPath, readFailOpenLog } from "./guard-log-fixture";
import { coreFile, seenFrom } from "./lib/core-path-testkit";
import {
	buildBashPayload,
	dispatchCoreOutput,
	guardDirs,
} from "./lib/pretool-guard-testkit";
import { readRuleText } from "./lib/rule-text.js";
import { runInProcess } from "./lib/run-in-process.js";

const CORE = "guard-vitest-wrapper";

const FRAGMENT = fs
	.readFileSync(
		path.resolve(
			__dirname,
			"..",
			"docs",
			"agents",
			"rules",
			"vitest-wrapper.txt",
		),
		"utf8",
	)
	.trim();

let dir: string;
let config: string;

const fragment = () => seenFrom(dir, () => readRuleText("vitest-wrapper"));

beforeEach(() => {
	({ dir, config } = guardDirs("guard-vitest-wrapper-"));
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const output = (
	payload: Record<string, unknown>,
	env: NodeJS.ProcessEnv = {},
) => dispatchCoreOutput(CORE, payload, { project: dir, config, cwd: dir, env });

const message = (
	command: string,
	session: string | null = "test",
	env: NodeJS.ProcessEnv = {},
) => {
	const out = output(buildBashPayload(command, session), env);
	expect(out).not.toBeNull();
	expect(out.permissionDecision).toBeUndefined();
	expect(out.hookEventName).toBe("PreToolUse");
	return out.additionalContext as string;
};

const readLatches = () => {
	const markers = path.join(dir, ".claude", "tmp", "markers");
	return fs.existsSync(markers)
		? fs.readdirSync(markers).filter((f) => f.startsWith(".rule-injected-"))
		: [];
};

describe("each exit path", () => {
	it("says nothing on a command it allows, and latches nothing", () => {
		expect(output(buildBashPayload("npm run test", "test"))).toBeNull();
		expect(readLatches()).toEqual([]);
		expect(fs.existsSync(failOpenLogPath(config, dir))).toBe(false);
	});

	it("carries the whole fragment and the wrapped command on the first run", () => {
		const text = message("node_modules/.bin/vitest run scripts/foo.test.ts");
		expect(text).toContain(fragment());
		expect(text).toContain(
			"This command: node_modules/.bin/vitest run scripts/foo.test.ts",
		);
		expect(text).toContain(
			`node ${coreFile("scripts/run-vitest.js")} scripts/foo.test.ts`,
		);
	});

	it("keeps the latch marker where a compaction clear will find it", () => {
		message("vitest run x.test.ts");
		expect(readLatches()).toEqual([
			".rule-injected-warn.vitest-wrapper-main-test",
		]);
	});

	it("drops to the standing line once latched, still warning", () => {
		message("vitest run x.test.ts");
		const second = message("vitest run y.test.ts");
		expect(second).not.toContain(fragment());
		expect(second).toContain("rule:vitest-wrapper");
		expect(second).toContain(
			`node ${coreFile("scripts/run-vitest.js")} y.test.ts`,
		);
	});

	it("repeats the fragment's own first sentence, not a paraphrase of it", () => {
		const first = (FRAGMENT.split("\n")[0] ?? "").replace(/\.$/, "");
		message("vitest run x.test.ts");
		expect(message("vitest run y.test.ts")).toContain(first);
	});
});

describe("each input channel", () => {
	it("keys the latch on the session: a second session is told afresh", () => {
		message("vitest run x.test.ts");
		expect(message("vitest run x.test.ts", "other")).toContain(fragment());
	});

	it("keys the latch on the agent: a subagent is told afresh", () => {
		message("vitest run x.test.ts");
		const out = output({
			...buildBashPayload("vitest run x.test.ts", "test"),
			agent_id: "sub1",
		});
		expect(out.additionalContext).toContain(fragment());
		expect(readLatches()).toContain(
			".rule-injected-warn.vitest-wrapper-asub1-test",
		);
	});

	it("warns without a session id, every time, latching nothing, logged", () => {
		expect(message("vitest run x.test.ts", null)).toContain(fragment());
		expect(message("vitest run x.test.ts", null)).toContain(fragment());
		expect(readLatches()).toEqual([]);
		expect(readFailOpenLog(config, dir)).toMatch(
			/no session key — rule vitest-wrapper unlatchable, delivered again/,
		);
	});
});

describe("each production adapter, crossed once", () => {
	it("sends the fallback naming the file where the store is empty, logged", () => {
		const empty = fs.mkdtempSync(path.join(dir, "store-"));
		const text = message("vitest run x.test.ts", "test", {
			WFC_RULES_DIR: empty,
		});
		expect(text).toContain("docs/agents/rules/vitest-wrapper.txt");
		expect(text).not.toContain(fragment());
		expect(readLatches()).toEqual([
			".rule-injected-warn.vitest-wrapper-main-test",
		]);
		expect(readFailOpenLog(config, dir)).toMatch(
			/rule vitest-wrapper unreadable — its fallback sent instead/,
		);
	});

	it("spells the wrapper at the plugin root in an install", () => {
		const install = path.join(dir, "install");
		fs.mkdirSync(path.join(install, "scripts"), { recursive: true });
		fs.writeFileSync(path.join(install, "scripts", "run-vitest.js"), "");
		const text = message("vitest run x.test.ts", "test", {
			WFC_SCRIPT_ROOT: install,
		});
		expect(text).toContain(
			`node ${path.join(install, "scripts", "run-vitest.js")} x.test.ts`,
		);
	});
});

describe("the context-budget scan against this guard as it stands", () => {
	it("reads its bound as bounded, from its core", () => {
		const root = path.resolve(__dirname, "..");
		const r = runInProcess(
			path.join(root, "scripts", "check-context-budget.js"),
			["--root", root, "--json"],
			{ cwd: root, env: { ...process.env, CLAUDE_PROJECT_DIR: root } },
		);
		const fragments = JSON.parse(r.stdout).session.direct.fragments as {
			id: string;
			guards: string[];
			latched: string;
		}[];
		expect(fragments.find((f) => f.id === "vitest-wrapper")).toMatchObject({
			guards: ["scripts/lib/vitest-wrapper.js"],
			latched: "bounded",
		});
	});
});
