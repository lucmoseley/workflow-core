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

const TRIGGERED = "chrome.exe https://example.com";

/** The browser core run on a trigger command, its port answering `out`. */
const browserOn = (out: string) => {
	const { ctx, runShellGuard } = ctxFor({ command: TRIGGERED }, "Bash", out);
	return { decision: () => browser.decide(TRIGGERED, ctx), runShellGuard };
};

describe("a script's answer", () => {
	it("is relayed as a deny, a context or silence", () => {
		expect(browserOn(denyOut("no")).decision()).toEqual({ deny: "no" });
		expect(
			browserOn(
				JSON.stringify({ hookSpecificOutput: { additionalContext: "c" } }),
			).decision(),
		).toEqual({ context: "c" });
		expect(browserOn("\n").decision()).toBeNull();
	});

	it("throws where it is not the hook JSON, for the row's failure policy", () => {
		expect(() => browserOn("browser-profile-guard: oops").decision()).toThrow();
	});
});

describe("the payload a script is handed", () => {
	it("rebuilds the fields the scripts read", () => {
		const { decision, runShellGuard } = browserOn("");
		decision();
		expect(runShellGuard).toHaveBeenCalledWith("browser-profile-guard.sh", {
			hook_event_name: "PreToolUse",
			session_id: "s1",
			tool_name: "Bash",
			tool_input: { command: TRIGGERED },
			cwd: "/w",
		});
	});
});

describe("the browser-profile core", () => {
	it("admits every word of the script's own first gate", () => {
		const script = fs.readFileSync(
			path.join(__dirname, "../browser-profile-guard.sh"),
			"utf8",
		);
		const gate = script.match(/grep -qiE '([^']+)' <<<"\$cmd" \|\| exit 0/);
		const words = (gate?.[1] ?? "").split("|");
		expect(words.length).toBeGreaterThan(1);
		for (const word of words) {
			/* The word spelt as a command types it, upper-cased to hold the gate's -i. */
			const typed = word
				.replace(/\\\./g, ".")
				.replace(/ \+/g, " ")
				.toUpperCase();
			const { ctx, runShellGuard } = ctxFor({ command: typed }, "Bash");
			browser.decide(typed, ctx);
			expect(runShellGuard, typed).toHaveBeenCalledOnce();
		}
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
		const { ctx } = ctxFor({ command: TRIGGERED }, "Bash");
		const hosted = { ...(ctx as object), ...buildHostPorts() } as never;
		expect(browser.decide(TRIGGERED, hosted)).toEqual({
			deny: expect.stringContaining(
				"chrome.exe without --profile-directory opens whichever profile",
			),
		});
	});

	/* Four times Linux's 64 KiB default pipe buffer, so the child always
	 * exits before Node has written it all: the EPIPE spawnSync then reports
	 * beside the exit (#5416). */
	const big = { padding: "x".repeat(256 * 1024) };

	it("throws the exit where the script cannot run", () => {
		expect(() => buildHostPorts().runShellGuard("no-such.sh", big)).toThrow(
			/no-such\.sh: exit 127/,
		);
	});

	it("returns a script's answer where it exits 0 unread", () => {
		fs.writeFileSync(path.join(home, "unread.sh"), "echo said\n");
		expect(buildHostPorts(home).runShellGuard("unread.sh", big)).toBe("said\n");
	});
});
