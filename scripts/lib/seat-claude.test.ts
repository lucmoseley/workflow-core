// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { writeClaudeStub } from "./claude-stub";
import { buildSeatEnv, runClaude } from "./seat-claude.js";

let tmp: string;
let caller: NodeJS.ProcessEnv;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "seat-claude-"));
	const bin = writeClaudeStub(path.join(tmp, "claude"), [
		`printf '\\033[32m%s|%s|%s|%s|%s\\033[0m\\n' "$*" "$CLAUDE_CONFIG_DIR" "\${CLAUDE_CODE_SESSION_ID-unset}" "\${CLAUDE_JOB_DIR-unset}" "$PROVIDER"`,
		`[ "$1" = fail ] && { printf '\\033[31mno job\\033[0m' >&2; exit 1; }`,
		"exit 0",
	]);
	vi.stubEnv("WFC_CLAUDE_BIN", path.join(tmp, "absent"));
	caller = {
		PATH: String(process.env.PATH),
		WFC_CLAUDE_BIN: bin,
		WFC_REPO_ROOT: "/caller-root",
		CLAUDE_PROJECT_DIR: "/caller-root",
		WFC_DISPATCH_ROOT: "/caller-root",
		CLAUDE_CODE_SESSION_ID: "s-caller",
		CLAUDE_JOB_DIR: "/seat/jobs/caller",
		CLAUDE_CONFIG_DIR: "/other-seat",
	};
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

it("runs claude on the seat, with the provider laid on and the caller's session forgotten", () => {
	const r = runClaude(["rm", "1a2b3c4d"], {
		cwd: tmp,
		env: buildSeatEnv(caller, "/seat", { PROVIDER: "p" }),
	});
	expect(r.failed).toBeNull();
	expect(r.out).toBe("rm 1a2b3c4d|/seat|unset|unset|p");
});

it("strips the VT codes from what a failed call printed", () => {
	const r = runClaude(["fail"], {
		cwd: tmp,
		env: buildSeatEnv(caller, "/seat"),
	});
	expect(r.failed).toBe("exit 1");
	expect(r.stderr).toBe("no job");
	expect(r.out).not.toContain("\u001b");
});

it("forgets the caller's root, which a daemon the call starts would hand every later job (#4595)", () => {
	const env = buildSeatEnv(caller, "/seat");
	expect(env.WFC_REPO_ROOT).toBeUndefined();
	expect(env.CLAUDE_PROJECT_DIR).toBeUndefined();
	expect(env.WFC_DISPATCH_ROOT).toBeUndefined();
	expect(env.PATH).toBe(caller.PATH);
});
