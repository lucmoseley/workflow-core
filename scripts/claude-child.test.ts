// @vitest-environment node
/*
 * claude-child.js, driven through its command line against a stub `claude`
 * that records its argv, its CLAUDE_CONFIG_DIR and its stdin (#2040).
 *
 * spawn-kept: a real fd (§X3) — the script hands the child real fds —
 * its own stdout and stderr, and the prompt file as stdin.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ADMITTED_AUTH,
	buildAuthStatusBranch,
	buildAuthStatusNodeBranch,
	REFUSED_AUTH,
	writeSeatHelper,
} from "./lib/auth-status-fake";

const SCRIPT = path.resolve(__dirname, "claude-child.js");

let dir = "";
let seat = "";

const STUB = `#!/usr/bin/env node
${buildAuthStatusNodeBranch()}
const fs = require("node:fs");
const out = process.env.STUB_OUT;
fs.writeFileSync(out, JSON.stringify({
	argv: process.argv.slice(2),
	configDir: process.env.CLAUDE_CONFIG_DIR,
	stdin: (() => { try { return fs.readFileSync(0, "utf8"); } catch { return null; } })(),
}));
process.stdout.write("child said hello\\n");
process.exit(Number(process.env.STUB_EXIT || 0));
`;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-child-"));
	seat = path.join(dir, ".claude");
	fs.mkdirSync(seat);
	fs.writeFileSync(path.join(dir, "claude"), STUB, { mode: 0o755 });
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const run = (args: string[], extra: Record<string, string> = {}) =>
	spawnSync(process.execPath, [SCRIPT, ...args], {
		encoding: "utf8",
		env: {
			...process.env,
			CLAUDE_CONFIG_DIR: seat,
			CLAUDE_PROJECT_DIR: dir,
			WFC_CLAUDE_CONFIG_A: path.join(dir, ".claude"),
			WFC_CLAUDE_CONFIG_B: path.join(dir, ".claude2"),
			WFC_CLAUDE_CONFIG_C: path.join(dir, ".claude3"),
			WFC_CLAUDE_BIN: path.join(dir, "claude"),
			STUB_OUT: path.join(dir, "seen.json"),
			...extra,
		},
	});

const readSeen = () =>
	JSON.parse(fs.readFileSync(path.join(dir, "seen.json"), "utf8"));
const launched = () => fs.existsSync(path.join(dir, "seen.json"));

describe("usage", () => {
	it("runs /usage on the named seat, approving no tool", () => {
		const r = run(["usage", "--config-dir", seat]);
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("child said hello\n");
		expect(readSeen().argv).toEqual([
			"-p",
			"/usage",
			"--permission-mode",
			"manual",
		]);
		expect(readSeen().configDir).toBe(seat);
	});

	it("passes on the child's exit status", () => {
		expect(
			run(["usage", "--config-dir", seat], { STUB_EXIT: "3" }).status,
		).toBe(3);
	});

	it("refuses a binary that cannot answer for its auth, naming the cached reading", () => {
		const r = run(["usage", "--config-dir", seat], {
			WFC_CLAUDE_BIN: path.join(dir, "missing"),
		});
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("auth status` failed");
		expect(r.stderr).toContain("allowance.js --config-dir");
	});

	it("names the cached reading where the child cannot start", () => {
		/* Answers `auth status`, then is gone before the launch. */
		const vanishing = path.join(dir, "vanishing");
		fs.writeFileSync(
			vanishing,
			`#!/bin/bash\nif [ "$1" = "auth" ]; then rm -- "$0"; fi\n${buildAuthStatusBranch()}\n`,
			{ mode: 0o755 },
		);
		const r = run(["usage", "--config-dir", seat], {
			WFC_CLAUDE_BIN: vanishing,
		});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("the child did not finish");
		expect(r.stderr).toContain("allowance.js --config-dir");
	});
});

describe("chrome", () => {
	const prompt = () => {
		const f = path.join(dir, "prompt.md");
		fs.writeFileSync(f, "Read example.com and report.\n");
		return f;
	};

	it("gives the child the Chrome tools only, file_upload barred, 10 turns a page plus 5, the prompt on stdin", () => {
		const r = run([
			"chrome",
			"--config-dir",
			seat,
			"--pages",
			"2",
			"--prompt-file",
			prompt(),
		]);
		expect(r.status).toBe(0);
		expect(readSeen().argv).toEqual([
			"-p",
			"--chrome",
			"--tools",
			"",
			"--allowedTools",
			"mcp__claude-in-chrome__*",
			"--disallowedTools",
			"mcp__claude-in-chrome__file_upload",
			"--max-turns",
			"25",
			"--output-format",
			"json",
		]);
		expect(readSeen().stdin).toBe("Read example.com and report.\n");
		expect(readSeen().configDir).toBe(seat);
	});

	it.each([
		["seven pages", ["--pages", "7"], "at most 6"],
		["no pages", ["--pages", "0"], "from 1 to 6"],
		["a page count that is not a number", ["--pages", "two"], "from 1 to 6"],
	])("refuses %s, launching nothing", (_, pages, says) => {
		const r = run([
			"chrome",
			"--config-dir",
			seat,
			...pages,
			"--prompt-file",
			prompt(),
		]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(says);
		expect(launched()).toBe(false);
	});

	it("refuses a missing prompt file, launching nothing", () => {
		const r = run([
			"chrome",
			"--config-dir",
			seat,
			"--pages",
			"1",
			"--prompt-file",
			path.join(dir, "nope.md"),
		]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("could not read the prompt file");
		expect(launched()).toBe(false);
	});
});

describe("refuses, launching nothing", () => {
	it.each([
		[
			"a config dir that is not a seat",
			["usage", "--config-dir", "/tmp/elsewhere"],
			"not one of this machine's seats",
		],
		["no config dir", ["usage"], "--config-dir is required"],
		[
			"a flag no mode takes",
			["usage", "--config-dir", "SEAT", "--dangerously-skip-permissions"],
			"unknown flag",
		],
		[
			"a chrome flag on usage",
			["usage", "--config-dir", "SEAT", "--pages", "1"],
			"unknown flag",
		],
		[
			"a free prompt",
			["usage", "--config-dir", "SEAT", "do anything"],
			"do anything",
		],
		["no mode", ["--config-dir", "SEAT"], "a command is required"],
		["an unknown mode", ["print", "--config-dir", "SEAT"], "unknown command"],
	])("%s", (_, args, says) => {
		const r = run(args.map((a) => (a === "SEAT" ? seat : a)));
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(says);
		expect(launched()).toBe(false);
	});
});

describe("the launch's auth (#2236)", () => {
	it.each(REFUSED_AUTH)("refuses under %s, launching nothing", (name, env) => {
		const r = run(["usage", "--config-dir", seat], env);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(`${name} is set`);
		expect(r.stderr).toContain("#2236");
		expect(launched()).toBe(false);
	});

	it("refuses an apiKeyHelper in the seat's settings", () => {
		writeSeatHelper(seat);
		const r = run(["usage", "--config-dir", seat]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("apiKeyHelper");
		expect(launched()).toBe(false);
	});

	it.each(ADMITTED_AUTH)("launches on %s", (_name, env) => {
		expect(run(["usage", "--config-dir", seat], env).status).toBe(0);
		expect(launched()).toBe(true);
	});
});
