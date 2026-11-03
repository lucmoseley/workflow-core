// @vitest-environment node
/*
 * lib/overflow-key.js through the command a launch hands `claude` as its
 * apiKeyHelper (#3699): it prints the seat's key from the secrets file, and a
 * missing file or variable fails naming the variable, never a value. Break it and an overflow session
 * runs on no key, or prints one into a log.
 *
 * spawn-kept: `claude` runs the helper as a shell command line, so each case
 * runs it through `sh -c` from a directory whose name needs quoting: the
 * quoting buildKeyHelper writes is under test.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildKeyHelper } from "./overflow-key.js";

const KEY = "sk-fake-overflow-key";
let dir = "";
let secrets = "";

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "overflow key '"));
	secrets = path.join(dir, "secrets.env");
	fs.writeFileSync(secrets, `OTHER=sk-fake-other\nWFC_K=${KEY}\n`);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const runHelper = (keyVar: string, file = secrets) =>
	spawnSync("sh", ["-c", buildKeyHelper(keyVar, file)], {
		encoding: "utf8",
		env: { PATH: process.env.PATH },
	});

describe("the key helper", () => {
	it("prints the key from the secrets file", () => {
		const r = runHelper("WFC_K");
		expect(r.status).toBe(0);
		expect(r.stdout).toBe(`${KEY}\n`);
	});

	it("reads the file at call time, not at launch", () => {
		const command = buildKeyHelper("WFC_K", secrets);
		fs.writeFileSync(secrets, "WFC_K=sk-fake-rotated\n");
		expect(spawnSync("sh", ["-c", command], { encoding: "utf8" }).stdout).toBe(
			"sk-fake-rotated\n",
		);
	});

	it("never reads the key from the caller's environment", () => {
		const r = spawnSync("sh", ["-c", buildKeyHelper("WFC_UNSET", secrets)], {
			encoding: "utf8",
			env: { PATH: process.env.PATH, WFC_UNSET: "sk-fake-from-env" },
		});
		expect(r.status).not.toBe(0);
		expect(r.stdout).toBe("");
	});

	it("fails on a missing variable, naming it and printing no value", () => {
		const r = runHelper("WFC_MISSING");
		expect(r.status).toBe(1);
		expect(r.stdout).toBe("");
		expect(r.stderr).toContain("WFC_MISSING is not set in");
		expect(r.stderr).toContain("write-secret.js WFC_MISSING");
		expect(r.stdout + r.stderr).not.toContain("sk-fake");
	});

	it("fails on a missing file, naming the variable and printing no value", () => {
		const r = runHelper("WFC_K", path.join(dir, "absent.env"));
		expect(r.status).toBe(1);
		expect(r.stdout).toBe("");
		expect(r.stderr).toContain("to read WFC_K from");
		expect(r.stdout + r.stderr).not.toContain("sk-fake");
	});
});
