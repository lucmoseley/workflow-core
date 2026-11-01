// @vitest-environment node
/*
 * lib/env-file.js's readers for a log masker (#3661, #3821): they read what
 * the secrets file assigns or throw, since a masker handed fewer secrets than
 * the file holds writes the rest bare. Break it and scripts/retro-transcript.js
 * leaks them. Each case writes a real file under a temp dir, at
 * WFC_SECRETS_FILE, as the readers take bytes from nowhere else.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { readStoredNames, readStoredValues } = require("./env-file.js");

describe("the secrets file's stored names and values (#3821)", () => {
	let dir: string;
	let file: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-file-"));
		file = path.join(dir, "secrets.env");
		vi.stubEnv("WFC_SECRETS_FILE", file);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("reads none where there is no file", () => {
		expect(readStoredNames()).toEqual([]);
		expect(readStoredValues()).toEqual([]);
	});

	it("reads each name and each non-empty value once, unquoted", () => {
		fs.writeFileSync(
			file,
			"\uFEFF# a comment\nA=one\nexport B = 'two#x'\r\nC=\nA=one\nA=three\rD=four\n",
		);
		expect(readStoredNames()).toEqual(["A", "B", "C", "D"]);
		expect(readStoredValues()).toEqual(["one", "two#x", "three", "four"]);
	});

	it.each([
		["an unquoted value", "K=abcdefgh # prod", ["abcdefgh # prod", "abcdefgh"]],
		["a quoted value", 'K="abcdefgh" # prod', ['abcdefgh" # prod', "abcdefgh"]],
		["a # inside a word", "K=abc#defgh", ["abc#defgh"]],
	])("reads %s both whole and before its comment", (_name, line, values) => {
		fs.writeFileSync(file, line);
		expect(readStoredValues()).toEqual(values);
	});

	it.each([
		[
			"a UTF-16 LE file with its mark",
			Buffer.from("\uFEFFA=one\r\n", "utf16le"),
			"utf16",
		],
		[
			"a UTF-16 BE file with its mark",
			Buffer.from([0xfe, 0xff, 0x00, 0x41]),
			"utf16",
		],
		["a UTF-16 LE file without it", Buffer.from("A=one\n", "utf16le"), "utf16"],
		["an invalid UTF-8 byte", Buffer.from([0x41, 0x3d, 0xe9]), "invalid"],
	])("throws on %s, naming the fault", (_name, bytes, fault) => {
		fs.writeFileSync(file, bytes);
		expect(readStoredNames).toThrow(`(${fault})`);
		expect(readStoredValues).toThrow(`(${fault})`);
	});
});
