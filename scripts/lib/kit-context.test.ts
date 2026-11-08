// @vitest-environment node
/*
 * lib/kit-context.js's kitContext reads a rule from the store and spells a
 * core path as an install reaches it (#3018): a wrong spelling hands a core a
 * path that does not exist in an adopter's install. kit-context.contract.test.ts
 * holds the fake to the same builder.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { agentKey, kitContext, latchPath, sharedReaders } =
	require("./kit-context.js") as typeof import("./kit-context.js");

let dir: string;
let store: string;

beforeEach(() => {
	dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kit-context-")));
	store = path.join(dir, "rules");
	fs.mkdirSync(store);
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const fragment = (id: string) =>
	fs.writeFileSync(path.join(store, `${id}.txt`), `${id} `.padEnd(20, "x"));

describe("the rule store and the install spellings on the context (#3018)", () => {
	const log = () => undefined;
	const ctx = () =>
		kitContext({ root: dir, payload: {}, log }, sharedReaders(dir, log));

	it("reads a rule from the store, and throws where it has none", () => {
		fragment("alpha");
		vi.stubEnv("WFC_RULES_DIR", store);
		expect(ctx().ruleText("alpha")).toBe(
			fs.readFileSync(path.join(store, "alpha.txt"), "utf8"),
		);
		expect(() => ctx().ruleText("ghost")).toThrow();
	});

	it("spells a core path at the plugin root in an install", () => {
		const install = path.join(dir, "plugin");
		fs.mkdirSync(path.join(install, "scripts"), { recursive: true });
		fs.mkdirSync(path.join(install, "docs"));
		fs.writeFileSync(path.join(install, "scripts", "claim-issue.js"), "");
		vi.stubEnv("WFC_SCRIPT_ROOT", install);
		expect(ctx().corePaths("run scripts/claim-issue.js.")).toBe(
			`run ${install}/scripts/claim-issue.js.`,
		);
		expect(ctx().scriptPath("claim-issue.js")).toBe(
			`${install}/scripts/claim-issue.js`,
		);
		expect(ctx().docPath("agents/x.md")).toBe(`${install}/docs/agents/x.md`);
	});
});

describe("a latch's path (mantahostels#2411)", () => {
	it("keys it on the agent, so a subagent gets its own", () => {
		const key = agentKey({ session_id: "sid-1", agent_id: "sub" });
		expect(key).toEqual({ agent: "asub", sid: "sid-1" });
		expect(latchPath("/r", "led.x", key as NonNullable<typeof key>)).toBe(
			"/r/.claude/tmp/markers/.rule-injected-led.x-asub-sid-1",
		);
	});

	it("replaces anything in the id that would move the marker, keeping the dot", () => {
		expect(latchPath("/r", "../led.x", { agent: "main", sid: "sid-1" })).toBe(
			"/r/.claude/tmp/markers/.rule-injected-.._led.x-main-sid-1",
		);
	});

	it("has no key for a payload carrying no session", () => {
		expect(agentKey({ tool_name: "Bash" })).toBeNull();
	});
});
