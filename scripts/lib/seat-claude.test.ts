// @vitest-environment node
/*
 * lib/seat-claude.js (#4344): the seat env the relaunch guard and the refill
 * loop's resume hand `claude`, and runClaude's VT-stripped verdict. `claude`
 * is lib/claude-stub.ts's bash stub at the given env's WFC_CLAUDE_BIN in a temp
 * dir, echoing the env it was given in colour; process.env's points nowhere
 * (#3991). Broken, a relaunched or resumed job runs on the caller's seat or
 * under its session id, or runs a binary its env never named.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { writeClaudeStub } from "./claude-stub";
import { buildSeatEnv, runClaude } from "./seat-claude.js";

let tmp: string;
let saved: string | undefined;
let caller: NodeJS.ProcessEnv;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "seat-claude-"));
	const bin = writeClaudeStub(path.join(tmp, "claude"), [
		`printf '\\033[32m%s|%s|%s|%s|%s\\033[0m\\n' "$*" "$CLAUDE_CONFIG_DIR" "\${CLAUDE_CODE_SESSION_ID-unset}" "\${CLAUDE_JOB_DIR-unset}" "$PROVIDER"`,
		`[ "$1" = fail ] && { printf '\\033[31mno job\\033[0m' >&2; exit 1; }`,
		"exit 0",
	]);
	saved = process.env.WFC_CLAUDE_BIN;
	process.env.WFC_CLAUDE_BIN = path.join(tmp, "absent");
	caller = {
		PATH: String(process.env.PATH),
		WFC_CLAUDE_BIN: bin,
		CLAUDE_CODE_SESSION_ID: "s-caller",
		CLAUDE_JOB_DIR: "/seat/jobs/caller",
		CLAUDE_CONFIG_DIR: "/other-seat",
	};
});

afterEach(() => {
	if (saved === undefined) delete process.env.WFC_CLAUDE_BIN;
	else process.env.WFC_CLAUDE_BIN = saved;
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
