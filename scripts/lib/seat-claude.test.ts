// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runClaude, seatEnv } from "./seat-claude.js";

let tmp: string;
let saved: string | undefined;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "seat-claude-"));
	const bin = path.join(tmp, "claude");
	fs.writeFileSync(
		bin,
		`#!/usr/bin/env node
process.stdout.write("\\u001b[32m" + JSON.stringify({
	args: process.argv.slice(2),
	seat: process.env.CLAUDE_CONFIG_DIR ?? null,
	session: process.env.CLAUDE_CODE_SESSION_ID ?? null,
	jobDir: process.env.CLAUDE_JOB_DIR ?? null,
	provider: process.env.PROVIDER ?? null,
}) + "\\u001b[0m\\n");
if (process.argv[2] === "fail") { process.stderr.write("\\u001b[31mno job\\u001b[0m"); process.exit(1); }
`,
	);
	fs.chmodSync(bin, 0o755);
	saved = process.env.WFC_CLAUDE_BIN;
	process.env.WFC_CLAUDE_BIN = bin;
});

afterEach(() => {
	if (saved === undefined) delete process.env.WFC_CLAUDE_BIN;
	else process.env.WFC_CLAUDE_BIN = saved;
	fs.rmSync(tmp, { recursive: true, force: true });
});

const caller = {
	PATH: String(process.env.PATH),
	CLAUDE_CODE_SESSION_ID: "s-caller",
	CLAUDE_JOB_DIR: "/seat/jobs/caller",
	CLAUDE_CONFIG_DIR: "/other-seat",
};

it("runs claude on the seat, with the provider laid on and the caller's session forgotten", () => {
	const r = runClaude(["rm", "1a2b3c4d"], {
		cwd: tmp,
		env: seatEnv(caller, "/seat", { PROVIDER: "p" }),
	});
	expect(r.failed).toBeNull();
	expect(JSON.parse(r.out)).toEqual({
		args: ["rm", "1a2b3c4d"],
		seat: "/seat",
		session: null,
		jobDir: null,
		provider: "p",
	});
});

it("strips the VT codes from what a failed call printed", () => {
	const r = runClaude(["fail"], { cwd: tmp, env: seatEnv(caller, "/seat") });
	expect(r.failed).toBe("exit 1");
	expect(r.stderr).toBe("no job");
	expect(r.out).not.toContain("\u001b");
});
