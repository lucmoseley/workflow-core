// @vitest-environment node
/*
 * The dispatcher cores that run a shell guard (#5389): each starts its script
 * only where its trigger admits the call, relays the script's answer as a
 * decision, and admits every call the script itself acts on.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import browser from "./browser-profile.js";
import practice from "./practice-note.js";
import { payloadFor, relay } from "./shell-guard.js";
import { buildHostPorts } from "./shell-guard-host.js";

/** A kit context carrying a spy for the port, over `input`. */
const ctxFor = (input: Record<string, unknown>, tool: string, out = "") => {
	const runShellGuard = vi.fn(() => out);
	return {
		ctx: {
			input,
			tool,
			key: { agent: "main", sid: "s1" },
			agent: "",
			cwd: "/w",
			runShellGuard,
		} as never,
		runShellGuard,
	};
};

const denyOut = (r: string) =>
	JSON.stringify({
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
			permissionDecisionReason: r,
		},
	});

describe("relay", () => {
	it("reads a deny, a context and silence", () => {
		expect(relay(denyOut("no"))).toEqual({ deny: "no" });
		expect(
			relay(JSON.stringify({ hookSpecificOutput: { additionalContext: "c" } })),
		).toEqual({ context: "c" });
		expect(relay("\n")).toBeNull();
	});

	it("throws on output that is not the hook JSON, for the row's failure policy", () => {
		expect(() => relay("practice-guard: oops")).toThrow();
	});
});

describe("payloadFor", () => {
	it("rebuilds the fields the scripts read", () => {
		const { ctx } = ctxFor({ command: "ls" }, "Bash");
		expect(payloadFor(ctx)).toEqual({
			hook_event_name: "PreToolUse",
			session_id: "s1",
			tool_name: "Bash",
			tool_input: { command: "ls" },
			cwd: "/w",
		});
	});
});

describe("the browser-profile core", () => {
	it("tests the same trigger as the script's own first gate", () => {
		const script = fs.readFileSync(
			path.join(__dirname, "../browser-profile-guard.sh"),
			"utf8",
		);
		const gate = script.match(/grep -qiE '([^']+)' <<<"\$cmd" \|\| exit 0/);
		expect(gate?.[1]).toBe(browser.TRIGGER.source);
		expect(browser.TRIGGER.flags).toBe("i");
	});

	it("starts no script on a command naming no trigger word", () => {
		const { ctx, runShellGuard } = ctxFor({ command: "git status" }, "Bash");
		expect(browser.decide("git status", ctx)).toBeNull();
		expect(runShellGuard).not.toHaveBeenCalled();
	});

	it("relays the script's refusal on a trigger word", () => {
		const cmd = "Chrome.EXE https://example.com";
		const { ctx, runShellGuard } = ctxFor(
			{ command: cmd },
			"Bash",
			denyOut("r"),
		);
		expect(browser.decide(cmd, ctx)).toEqual({ deny: "r" });
		expect(runShellGuard).toHaveBeenCalledWith(
			"browser-profile-guard.sh",
			expect.objectContaining({ tool_input: { command: cmd } }),
		);
	});
});

describe("the practice-note core", () => {
	it.each([
		[{ file_path: "/r/docs/practice/x.md" }, "Write"],
		[{ command: "cat docs/practice/x.md" }, "Bash"],
		[{ path: "/r/docs", pattern: "practice/*.md" }, "Glob"],
	])(
		"starts the script where the input names docs/practice: %j",
		(input, tool) => {
			const { ctx, runShellGuard } = ctxFor(input, tool);
			practice.decide("", ctx);
			expect(runShellGuard).toHaveBeenCalledOnce();
		},
	);

	it("starts nothing on a call that names no docs/practice", () => {
		const { ctx, runShellGuard } = ctxFor(
			{ file_path: "/r/docs/x.md" },
			"Read",
		);
		expect(practice.decide("", ctx)).toBeNull();
		expect(runShellGuard).not.toHaveBeenCalled();
	});
});

describe("the host port", () => {
	let home: string;
	beforeEach(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), "shell-guard-"));
		vi.stubEnv("HOME", home);
	});
	afterEach(() => {
		fs.rmSync(home, { recursive: true, force: true });
	});

	it("runs the real script, whose bare chrome.exe refusal reaches the core", () => {
		const cmd = "chrome.exe https://example.com";
		const { ctx } = ctxFor({ command: cmd }, "Bash");
		const out = buildHostPorts().runShellGuard(
			"browser-profile-guard.sh",
			payloadFor(ctx),
		);
		expect(relay(out)).toEqual({
			deny: expect.stringContaining(
				"chrome.exe without --profile-directory opens whichever profile",
			),
		});
	});

	it("throws where the script cannot run", () => {
		expect(() => buildHostPorts().runShellGuard("no-such.sh", {})).toThrow(
			/no-such\.sh: exit/,
		);
	});
});
