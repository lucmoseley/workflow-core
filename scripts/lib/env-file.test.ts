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
const { readEnvFileValue, readStoredSecrets } = require("./env-file.js");

const LONG_RUN = 500_000;

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
		[
			"an expanded newline",
			"K=abcd\\nefgh",
			["abcd\\nefgh", "abcd\nefgh", "abcd\r\nefgh", "abcd", "efgh"],
		],
		[
			"a # in a word, then a comment",
			"K=abcd#efgh # prod",
			["abcd#efgh # prod", "abcd", "abcd#efgh"],
		],
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

	it.each([
		["a hyphened name", "my-key=abcdefghij", ["abcdefghij"]],
		["a dotted name", "my.key=abcdefghij", ["abcdefghij"]],
		["a colon and space", "K: abcdefghij", ["abcdefghij"]],
		["a comment", "# K=abcdefghij", ["abcdefghij"]],
		["a comment on export", "## export K = abcdefghij", ["abcdefghij"]],
	])("reads a value, and no name, off %s (#3917)", (_name, line, values) => {
		fs.writeFileSync(file, line);
		expect(readStoredSecrets()).toEqual({ names: [], values });
	});

	it.each([
		["prose around a colon", "# rotate this: every month"],
		["a label in a comment", "# Updated: 2026-11-02"],
		["a URL in a comment", "# see https://example.test/a"],
		["a colon and no space", "K:abcdefghij"],
		["a lower-case name in a comment (#4048)", "# scope=repository"],
	])("reads nothing off %s (#3917)", (_name, line) => {
		fs.writeFileSync(file, line);
		expect(readStoredSecrets()).toEqual({ names: [], values: [] });
	});

	it.each([
		["a line break", "\n"],
		["a U+2028", " "],
		["a U+2029", " "],
		["a CR", "\r"],
	])(
		"reads a quoted value across %s, whole and piece by piece (#3917)",
		(_name, br) => {
			fs.writeFileSync(
				file,
				`K="abcdefgh${br}middle part${br}ijklmnopq" # note`,
			);
			const { names, values } = readStoredSecrets();
			expect(names).toEqual(["K"]);
			expect(values).toEqual(
				expect.arrayContaining([
					"abcdefgh",
					"middle part",
					"ijklmnopq",
					`abcdefgh${br}middle part${br}ijklmnopq`,
				]),
			);
		},
	);

	it("reads a quote no later line closes as that one line alone (#3917)", () => {
		fs.writeFileSync(file, 'K="abcdefgh\nijklmnopq\nL=second\n');
		expect(readStoredSecrets()).toEqual({
			names: ["K", "L"],
			values: ["abcdefgh", "second"],
		});
	});

	it("takes no escaped quote for the one closing a split value (#3917)", () => {
		fs.writeFileSync(file, 'K="abcd\\"efgh\nijkl\\"mnop\nqrstuvwx"\n');
		expect(readStoredSecrets().values).toContain(
			'abcd\\"efgh\nijkl\\"mnop\nqrstuvwx',
		);
	});

	it("reads across a quote after an escaped backslash, as dotenv does (#4048)", () => {
		fs.writeFileSync(file, 'K="abcdefghij\\\\"\nklmnopqrst"\n');
		const { values } = readStoredSecrets();
		expect(values).toContain('abcdefghij\\\\"\nklmnopqrst');
		expect(values).toContain("klmnopqrst");
	});

	it("reads each line of a value its escapes break, and its CRLF print (#4048)", () => {
		fs.writeFileSync(file, 'K="abcdefgh\\nijklmnop"\n');
		expect(readStoredSecrets().values).toEqual(
			expect.arrayContaining([
				"abcdefgh",
				"ijklmnop",
				"abcdefgh\nijklmnop",
				"abcdefgh\r\nijklmnop",
			]),
		);
	});

	it("reads an unquoted value across a U+2028 less its comment (#4048)", () => {
		fs.writeFileSync(file, "K=abcdefghij\u2028klmnopqrst # note\n");
		expect(readStoredSecrets().values).toEqual(
			expect.arrayContaining(["klmnopqrst", "abcdefghij\u2028klmnopqrst"]),
		);
	});

	it("closes a split value at its quote after an escaped backslash, as no later line does (#3917)", () => {
		fs.writeFileSync(file, 'K="abcdefgh\nijklmnop\\\\"\n');
		const { values } = readStoredSecrets();
		expect(values).toContain("abcdefgh\nijklmnop\\\\");
		expect(values).toContain("ijklmnop\\");
	});

	it("closes a split value at its last escaped quote where nothing else does (#3917)", () => {
		fs.writeFileSync(file, 'K="abcdefgh\nijkl\\"mnop\nqrst\\"uvwx\nlater\n');
		const { values } = readStoredSecrets();
		expect(values).toContain('abcdefgh\nijkl\\"mnop\nqrst\\');
		expect(values).toContain('ijkl\\"mnop');
		expect(values).not.toContain("later");
	});

	it.each([
		["a U+2028", "\u2028"],
		["a U+2029", "\u2029"],
	])(
		"reads an unquoted value across %s, whole and piece by piece (#3917)",
		(_name, br) => {
			fs.writeFileSync(file, `K=abcdefgh${br}ijklmnop\nL=second\n`);
			const { names, values } = readStoredSecrets();
			expect(names).toEqual(["K", "L"]);
			expect(values).toEqual(
				expect.arrayContaining([
					"abcdefgh",
					"ijklmnop",
					`abcdefgh${br}ijklmnop`,
				]),
			);
		},
	);

	it("still reads the line a split value's opener runs over (#3917)", () => {
		fs.writeFileSync(file, 'K="abcdefgh\nL=second\nijklmnopq"\n');
		const { names, values } = readStoredSecrets();
		expect(names).toEqual(["K", "L"]);
		expect(values).toEqual(expect.arrayContaining(["second", "L=second"]));
	});

	/* These cross the real clock, as the walks expose no count: vitest's timeout
	 * is what a superlinear walk trips. LONG_RUN squared, some 2.5e11 steps, is
	 * far past what that timeout allows. */
	it.each([
		["openers", 'K="abcdefgh\n'.repeat(LONG_RUN), ["K"], "abcdefgh"],
		[
			"an unclosed opener's lines",
			`K="abcdefgh\n${"ijklmnop\n".repeat(LONG_RUN)}`,
			["K"],
			"abcdefgh",
		],
		[
			"lines inside a value that closes",
			`K="abcdefgh\n${"ijklmnop\n".repeat(LONG_RUN)}"`,
			["K"],
			"ijklmnop",
		],
		[
			"escaped quotes on their own lines",
			`K="abcdefgh\n${'\\"\n'.repeat(LONG_RUN)}`,
			["K"],
			"abcdefgh",
		],
		["separators", `K=abcdefgh${"\u2028".repeat(LONG_RUN)}`, ["K"], "abcdefgh"],
	])(
		"reads a long run of %s within the test's timeout (#3917)",
		(_name, text, names, value) => {
			fs.writeFileSync(file, text);
			const read = readStoredSecrets();
			expect(read.names).toEqual(names);
			expect(read.values).toContain(value);
		},
	);

	it.each([
		["name characters", "a".repeat(LONG_RUN)],
		["comment marks", "#".repeat(LONG_RUN)],
	])(
		"reads nothing off a long run of %s within the test's timeout (#3917)",
		(_name, text) => {
			fs.writeFileSync(file, text);
			expect(readStoredSecrets()).toEqual({ names: [], values: [] });
		},
	);

	it("leaves readEnvFileValue on the writer's grammar (#3917)", () => {
		fs.writeFileSync(
			file,
			'my-key=hyphened\nmy.key=dotted\nM: colon\n# C=commented\nK="abcdefgh\nijklmnopq"\n',
		);
		for (const name of ["my-key", "my.key", "M", "C"]) {
			expect(readEnvFileValue(file, name)).toBeNull();
		}
		expect(readEnvFileValue(file, "K")).toBe("abcdefgh");
	});

	it("reads an unclosed quote of 9M characters without overflowing the stack", () => {
		fs.writeFileSync(file, `K="${"a".repeat(9_000_000)}`);
		expect(readStoredSecrets().values).toHaveLength(1);
	});

	it("reads a long run of spaces inside a value in linear time", () => {
		fs.writeFileSync(file, `K=abcd${" ".repeat(2_000_000)}efgh`);
		/* Crosses the real clock, as no seam counts a regex's backtracking: linear
		 * here measured 11 ms (8 Nov 2026); quadratic over 2M spaces, unmeasured,
		 * is some 4e12 steps, so 2000 ms parts the two on any load. */
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
