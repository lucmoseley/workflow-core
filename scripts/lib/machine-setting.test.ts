// @vitest-environment node
/*
 * lib/machine-setting.js's contract (#3228): the variable where set, else
 * `$HOME/.claude/<name>`, and only ENOENT reads as no file. A break here
 * reaches the load ceiling and the session floor at once, both read through it.
 *
 * One temp HOME is built at module scope, since every case only reads it.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { readMachineSetting } from "./machine-setting.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "machine-setting-"));
fs.mkdirSync(path.join(home, ".claude"));
const file = path.join(home, ".claude", "a-setting");
fs.writeFileSync(file, "7\n");
fs.mkdirSync(path.join(home, ".claude", "a-dir"));
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

describe("readMachineSetting", () => {
	it("reads the variable over the file, naming it as the source", () => {
		expect(
			readMachineSetting("a-setting", "WFC_X", { WFC_X: "3", HOME: home }),
		).toEqual({ text: "3", source: "WFC_X" });
	});

	it("reads an empty variable as no setting, skipping the file", () => {
		expect(
			readMachineSetting("a-setting", "WFC_X", { WFC_X: "", HOME: home }),
		).toEqual({});
	});

	it("reads the file where the variable is unset, naming its path", () => {
		expect(readMachineSetting("a-setting", "WFC_X", { HOME: home })).toEqual({
			text: "7\n",
			source: file,
		});
	});

	it("reads no file as no setting, and no problem", () => {
		expect(readMachineSetting("absent", "WFC_X", { HOME: home })).toEqual({});
	});

	it("names the problem where the file will not read", () => {
		const read = readMachineSetting("a-dir", "WFC_X", { HOME: home });
		expect(read.text).toBeUndefined();
		expect(read.problem).toMatch(/\.claude\/a-dir: EISDIR/);
	});

	it("reads no file from an injected environment with no HOME", () => {
		expect(readMachineSetting("a-setting", "WFC_X", {})).toEqual({});
	});

	it("reads no file where HOME is relative", () => {
		expect(
			readMachineSetting("a-setting", "WFC_X", { HOME: "relative" }),
		).toEqual({});
	});

	it("falls back to the account's home for the live environment", () => {
		vi.stubEnv("HOME", "");
		vi.stubEnv("WFC_X", undefined);
		const homedir = vi.spyOn(os, "homedir").mockReturnValue(home);
		try {
			expect(readMachineSetting("a-setting", "WFC_X")).toEqual({
				text: "7\n",
				source: file,
			});
		} finally {
			homedir.mockRestore();
		}
	});
});
