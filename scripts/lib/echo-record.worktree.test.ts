// @vitest-environment node

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { freshSandbox } from "./arbiter-testkit";
import { runCore, splitCheckout, toolCall } from "./guard-core-testkit";

let at: { main: string; worktree: string };
let tmp: string;

freshSandbox((sb) => {
	at = splitCheckout(path.join(sb.dir, "split"));
	tmp = path.join(sb.dir, "tmp");
	fs.mkdirSync(tmp);
	vi.stubEnv("TMPDIR", tmp);
});

const record = (worktree?: string) =>
	runCore(
		"record-tool-echo",
		toolCall(
			"Bash",
			{ command: "ls" },
			{ tool_response: { stdout: "a.md", stderr: "", interrupted: false } },
		),
		{ root: at.main, worktree, event: "PostToolUse" },
	);

describe("the recorder in a session's own worktree (#4242)", () => {
	it("extends the one chain the main checkout's calls extend, under TMPDIR", () => {
		expect(record(at.worktree).output).toBeNull();
		expect(record().output).toBeNull();
		const chain = fs.readFileSync(
			path.join(tmp, "wfc-echo-chain", "s1.main"),
			"utf8",
		);
		expect(chain).toMatch(/\t2\t/);
		for (const root of [at.main, at.worktree])
			expect(fs.readdirSync(root)).not.toContain("wfc-echo-chain");
	});
});
