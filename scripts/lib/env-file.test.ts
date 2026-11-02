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
const { readStoredSecrets } = require("./env-file.js");

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
		expect(readStoredSecrets()).toEqual({ names: [], values: [] });
	});

	it("reads each name and each non-empty value once, unquoted", () => {
		fs.writeFileSync(
			file,
			"\uFEFF# a comment\nA=one\nexport B = 'two#x'\r\nC=\nA=one\nA=three\rD=four\n",
		);
		expect(readStoredSecrets().names).toEqual(["A", "B", "C", "D"]);
		expect(readStoredSecrets().values).toEqual([
			"one",
			"two#x",
			"three",
			"four",
		]);
	});

	it.each([
		["an unquoted value", "K=abcdefgh # prod", ["abcdefgh # prod", "abcdefgh"]],
		["a quoted value", 'K="abcdefgh" # prod', ['abcdefgh" # prod', "abcdefgh"]],
		["a # inside a word", "K=abcd#efgh", ["abcd#efgh", "abcd"]],
		["backticks", "K=`abcdefgh`", ["`abcdefgh`", "abcdefgh"]],
		["spaces inside quotes", 'K=" abcdefgh "', [" abcdefgh ", "abcdefgh"]],
		[
			"a # inside quotes, then a comment",
			'K="abcd #efgh" # prod',
			['abcd #efgh" # prod', "abcd #efgh"],
		],
		[
			"an escaped quote",
			'K="abcd\\"efgh"',
			['abcd\\"efgh', 'abcd"efgh', "abcd\\"],
		],
		[
			"a # inside a quoted value holding its own quote, then a comment",
			"K='abcd'efgh #inner' # prod",
			["abcd'efgh #inner' # prod", "abcd", "abcd'efgh #inner"],
		],
		["an expanded newline", "K=abcd\\nefgh", ["abcd\\nefgh", "abcd\nefgh"]],
		[
			"text after the closing quote",
			'K="abcdefgh" junk',
			['abcdefgh" junk', "abcdefgh"],
		],
		["nested quotes", "K=\"'abcdefgh'\"", ["'abcdefgh'", "abcdefgh"]],
		["a quote the value never closes", 'K="abcd#efgh', ["abcd#efgh", "abcd"]],
		[
			"a quote inside a quoted value, then a comment",
			"K='abcd'efgh' # prod",
			["abcd'efgh' # prod", "abcd", "abcd'efgh"],
		],
		["a comment and no value", "K=#abcdefgh", ["#abcdefgh"]],
	])(
		"reads %s both whole and as a hand-writer means it",
		(_name, line, values) => {
			fs.writeFileSync(file, line);
			expect(readStoredSecrets().values).toEqual(values);
		},
	);

	it("reads an unclosed quote of 9M characters without overflowing the stack", () => {
		fs.writeFileSync(file, `K="${"a".repeat(9_000_000)}`);
		expect(readStoredSecrets().values).toHaveLength(1);
	});

	it("reads a long run of spaces inside a value in linear time", () => {
		fs.writeFileSync(file, `K=abcd${" ".repeat(2_000_000)}efgh`);
		const started = Date.now();
		expect(readStoredSecrets().names).toEqual(["K"]);
		expect(Date.now() - started).toBeLessThan(2000);
	});

	it("refuses a symlink whose target is gone, not reading it as no store", () => {
		fs.symlinkSync(path.join(dir, "gone"), file);
		expect(readStoredSecrets).toThrow("cannot be read (ENOENT)");
	});

	it("names the fault and the way out where the file cannot be read", () => {
		fs.mkdirSync(file);
		expect(readStoredSecrets).toThrow(
			"is no regular file (a FIFO, socket, device or directory), so its secrets cannot be masked. Make it a readable regular file, then re-run.",
		);
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
		expect(readStoredSecrets).toThrow(`(${fault})`);
	});
});
