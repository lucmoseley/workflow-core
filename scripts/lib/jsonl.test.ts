// @vitest-environment node

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const load = createRequire(__filename);
const { parseJsonlRow, parseJsonl, readJsonl, readLastJsonlRow } =
	load("./jsonl.js");

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "jsonl-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const write = (text: string) => {
	const file = path.join(dir, "log.jsonl");
	fs.writeFileSync(file, text);
	return file;
};

describe("readJsonl", () => {
	it("lists a torn last line as bad and torn, keeping the rows before it", () => {
		expect(readJsonl(write('{"a":1}\n{"a":2}\n{"a":'))).toEqual({
			rows: [{ a: 1 }, { a: 2 }],
			entries: [
				{ row: { a: 1 }, line: 1 },
				{ row: { a: 2 }, line: 2 },
			],
			bad: [3],
			torn: true,
		});
	});

	it("reads an unterminated last line that parses as a whole row", () => {
		expect(readJsonl(write('{"a":1}\n{"a":2}'))).toEqual({
			rows: [{ a: 1 }, { a: 2 }],
			entries: [
				{ row: { a: 1 }, line: 1 },
				{ row: { a: 2 }, line: 2 },
			],
			bad: [],
			torn: false,
		});
	});

	it("lists and skips an unparsable row, and a row that is no object", () => {
		expect(
			readJsonl(write('{"a":1}\nnot json\n[1]\nnull\n3\n{"a":2}\n')),
		).toEqual({
			rows: [{ a: 1 }, { a: 2 }],
			entries: [
				{ row: { a: 1 }, line: 1 },
				{ row: { a: 2 }, line: 6 },
			],
			bad: [2, 3, 4, 5],
			torn: false,
		});
	});

	it("lists a bad newline-terminated last line as bad, never torn", () => {
		expect(readJsonl(write('{"a":1}\n{"a":\n'))).toEqual({
			rows: [{ a: 1 }],
			entries: [{ row: { a: 1 }, line: 1 }],
			bad: [2],
			torn: false,
		});
	});

	it("skips blank lines and CRLF endings", () => {
		expect(readJsonl(write('\n{"a":1}\r\n  \n{"a":2}\r\n'))).toEqual({
			rows: [{ a: 1 }, { a: 2 }],
			entries: [
				{ row: { a: 1 }, line: 2 },
				{ row: { a: 2 }, line: 4 },
			],
			bad: [],
			torn: false,
		});
	});

	it("reads an empty file as no rows", () => {
		expect(readJsonl(write(""))).toEqual({
			rows: [],
			entries: [],
			bad: [],
			torn: false,
		});
	});

	it("returns null for a missing file", () => {
		expect(readJsonl(path.join(dir, "absent.jsonl"))).toBeNull();
	});

	it("throws on a read error other than a missing file", () => {
		expect(() => readJsonl(dir)).toThrow(/EISDIR/);
	});
});

describe("parseJsonl", () => {
	it("gives text the same answers as a file", () => {
		expect(parseJsonl('{"a":1}\nbad\n{"a":')).toEqual({
			rows: [{ a: 1 }],
			entries: [{ row: { a: 1 }, line: 1 }],
			bad: [2, 3],
			torn: true,
		});
	});

	it("never parses a line keep refuses, nor counts it", () => {
		const seen: string[] = [];
		const keep = (line: string) => {
			seen.push(line);
			return line.includes('"k"');
		};
		expect(parseJsonl('{"k":1}\nbad\n{"a":2}\n{"k":', keep)).toEqual({
			rows: [{ k: 1 }],
			entries: [{ row: { k: 1 }, line: 1 }],
			bad: [4],
			torn: true,
		});
		expect(seen).toEqual(['{"k":1}', "bad", '{"a":2}', '{"k":']);
	});

	it("lists an unterminated last line that parses to no object as bad, never torn", () => {
		expect(parseJsonl('{"a":1}\n[1]')).toEqual({
			rows: [{ a: 1 }],
			entries: [{ row: { a: 1 }, line: 1 }],
			bad: [2],
			torn: false,
		});
	});
});

describe("parseJsonlRow", () => {
	it("gives one line's row, null for a blank line, undefined for no object", () => {
		expect(parseJsonlRow('{"a":1}\r')).toEqual({ a: 1 });
		expect(parseJsonlRow("  ")).toBeNull();
		expect(parseJsonlRow("bad")).toBeUndefined();
		expect(parseJsonlRow("[1]")).toBeUndefined();
		expect(parseJsonlRow("null")).toBeUndefined();
	});
});

describe("readLastJsonlRow", () => {
	const texts = {
		"a terminated last row": '{"a":1}\n{"a":2}\n',
		"an unterminated last row": '{"a":1}\n{"a":2}',
		"a torn last line": '{"a":1}\n{"a":2}\n{"a":',
		"bad and blank lines after the last row": '{"a":1}\n[1]\nnot json\n\n\n',
		"CRLF endings": '{"a":1}\r\n{"a":2}\r\n',
		"one row": '{"a":1}',
		"no row": "not json\n\n",
		"an empty file": "",
		"a last row longer than one read, split inside a multi-byte character": `{"a":1}\n{"a":"${"é".repeat(70_000)}"}\n`,
		"a last row with more than one read of bad lines after it": `{"a":1}\n${"not json\n".repeat(8000)}`,
	};

	it.each(Object.entries(texts))(
		"gives the row readJsonl ends on: %s",
		(_name, text) => {
			const file = write(text);
			expect(readLastJsonlRow(file)).toEqual(readJsonl(file).rows.at(-1));
		},
	);

	it.each(Object.entries(texts))(
		"gives the last row a test passes, as readJsonl's rows filtered: %s",
		(_name, text) => {
			const file = write(text);
			const odd = (row: Record<string, unknown>) => row.a === 1;
			expect(readLastJsonlRow(file, odd)).toEqual(
				readJsonl(file).rows.filter(odd).at(-1),
			);
		},
	);

	it("reads past one read of the file's end for a row the test passes", () => {
		const after = '{"a":2}\n'.repeat(20_000);
		expect(after.length).toBeGreaterThan(128 * 1024);
		const file = write(`{"a":1}\n${after}`);
		expect(
			readLastJsonlRow(file, (row: Record<string, unknown>) => row.a === 1),
		).toEqual({ a: 1 });
	});

	it("gives undefined for a file with no row, null for a missing one", () => {
		expect(readLastJsonlRow(write("\n"))).toBeUndefined();
		expect(readLastJsonlRow(path.join(dir, "absent.jsonl"))).toBeNull();
	});

	it("throws on a read error other than a missing file", () => {
		expect(() => readLastJsonlRow(dir)).toThrow();
	});
});
