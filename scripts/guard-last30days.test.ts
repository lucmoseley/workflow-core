// @vitest-environment node
/*
 * guard-last30days.sh keeps the last30days skill out of the main session, where
 * one invocation leaves ~87k tokens in its context.
 *
 * It sources scripts/lib/guard-parse.sh for the verdict envelope (mantahostels#138), so it
 * has a load path that can fail.
 *
 * It judges a Skill payload rather than a shell command, so it cannot use
 * guard-parse-fixture.ts — that fixture drives every case through a `command`.
 *
 * It runs on every Skill call as a `PreToolUse` hook
 * (`self-plugin/hooks/hooks.json`, `hooks/hooks.json`): loosen it and one
 * inline call leaves ~87k tokens in a main session's context; make it deny
 * inside a subagent and the skill cannot run at all.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeFailOpenLog } from "./guard-log-fixture";

const GUARD = path.resolve(__dirname, "guard-last30days.sh");
const LIB = path.resolve(__dirname, "lib/guard-parse.sh");

let dir: string;
let config: string;
let project: string;

const run = (guard: string, payload: Record<string, unknown>) => {
	const r = spawnSync(guard, [], {
		encoding: "utf8",
		input: JSON.stringify(payload),
		// Since mantahostels#147 the guard records its fail-opens under CLAUDE_CONFIG_DIR.
		// Left unset, a test run appends to the founder's own log and manufactures
		// the very records check-guard-errors.js exists to report.
		env: {
			...process.env,
			CLAUDE_CONFIG_DIR: config,
			CLAUDE_PROJECT_DIR: project,
		},
	});
	if (r.status === null) throw new Error(`guard did not run: ${r.error}`);
	return r;
};

/** A copy of the guard whose lib/ can be tampered with. */
const detach = () => {
	const at = path.join(dir, "detached");
	fs.mkdirSync(path.join(at, "lib"), { recursive: true });
	const guard = path.join(at, path.basename(GUARD));
	fs.copyFileSync(GUARD, guard);
	fs.chmodSync(guard, 0o755);
	fs.copyFileSync(LIB, path.join(at, "lib", "guard-parse.sh"));
	return { at, guard };
};

/*
 * A guard that CRASHES also emits no verdict, so an allow alone would pass
 * whether the source line failed open or the script died on a missing function.
 */
const expectSilentAllow = (r: ReturnType<typeof run>) => {
	expect(r.status).toBe(0);
	expect(r.stdout ?? "").toBe("");
	expect(r.stderr ?? "").toBe("");
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-last30days-"));
	config = path.join(dir, "claude-config");
	project = path.join(dir, "project");
	fs.mkdirSync(project);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("the main session is denied", () => {
	it.each([
		["last30days", "the bare skill name"],
		["last30days:last30days", "the plugin-namespaced form"],
		["plugin:last30days", "namespaced the other way"],
	])("%s — %s", (skill) => {
		const out = JSON.parse(run(GUARD, { tool_input: { skill } }).stdout);
		expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
		expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
		// The deny has to say what to do instead, or it just blocks the work.
		expect(out.hookSpecificOutput.permissionDecisionReason).toContain(
			"subagent",
		);
	});

	it("an absent agent_id is the main session, same as an empty one", () => {
		const out = JSON.parse(
			run(GUARD, { tool_input: { skill: "last30days" } }).stdout,
		);
		expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
	});
});

describe("the sanctioned and unrelated paths pass", () => {
	it("allows the call inside a subagent — agent_id is the whole signal", () => {
		expectSilentAllow(
			run(GUARD, { tool_input: { skill: "last30days" }, agent_id: "abc" }),
		);
	});

	it("stays out of the way of every other skill", () => {
		expectSilentAllow(run(GUARD, { tool_input: { skill: "research" } }));
	});

	it("does not match a skill that merely mentions it", () => {
		expectSilentAllow(
			run(GUARD, { tool_input: { skill: "last30days-notes" } }),
		);
	});
});

describe("the shared library (mantahostels#138)", () => {
	it("the detached copy still denies — the control for the cases below", () => {
		const { guard } = detach();
		const out = JSON.parse(
			run(guard, { tool_input: { skill: "last30days" } }).stdout,
		);
		expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
	});

	it("allows everything through when the library is missing", () => {
		const { at, guard } = detach();
		fs.rmSync(path.join(at, "lib"), { recursive: true, force: true });
		// Fail open (mantahostels#103 §6): a guard that cannot load its library must not wedge
		// every Skill call in the session.
		expectSilentAllow(run(guard, { tool_input: { skill: "last30days" } }));
	});

	it("allows everything through when the library is unreadable", () => {
		const { at, guard } = detach();
		fs.chmodSync(path.join(at, "lib", "guard-parse.sh"), 0o000);
		expectSilentAllow(run(guard, { tool_input: { skill: "last30days" } }));
	});

	it("stays armed when the library's last statement returns non-zero", () => {
		// `source` reports the status of the library's LAST STATEMENT, so gating on
		// it would disarm the guard over a top-level probe that merely answered no.
		// The gate is `declare -F`.
		const { at, guard } = detach();
		fs.appendFileSync(path.join(at, "lib", "guard-parse.sh"), "\nfalse\n");
		const out = JSON.parse(
			run(guard, { tool_input: { skill: "last30days" } }).stdout,
		);
		expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
	});

	it("disarms when the library is truncated before gp_deny", () => {
		const { at, guard } = detach();
		const lib = path.join(at, "lib", "guard-parse.sh");
		const head = fs.readFileSync(lib, "utf8").split("gp_deny()")[0];
		fs.writeFileSync(lib, head);
		expectSilentAllow(run(guard, { tool_input: { skill: "last30days" } }));
	});

	it("resolves the library from the guard's own path, not the cwd", () => {
		// A hook runs with whatever cwd the session is in.
		const { guard } = detach();
		const r = spawnSync(guard, [], {
			cwd: os.tmpdir(),
			encoding: "utf8",
			input: JSON.stringify({ tool_input: { skill: "last30days" } }),
		});
		expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe(
			"deny",
		);
	});
});

/*
 * This guard hid its fail-opens worst of any of them (mantahostels#147): a jq that is missing or
 * that chokes left the skill name empty, the `case` read that as "not our skill",
 * and the ~87k-token inline call the guard exists to stop went through with
 * nothing said anywhere.
 */
describeFailOpenLog({
	guard: GUARD,
	denied: { tool_input: { skill: "last30days" } },
	fieldless: { tool_input: {} },
	// gp_begin names the missing field from the jq path it was given (mantahostels#157), so
	// this reads "no skill", not the hand-written "no skill name" it replaced.
	fieldlessMatch: /no skill in payload/,
	// Another skill entirely: the guard reads it, recognises it is not its
	// business, and must say nothing anywhere.
	benign: { tool_input: { skill: "roadmap-edit" } },
	ctx: () => ({ dir, config, project }),
});
