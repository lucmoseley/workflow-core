// @vitest-environment node
/*
 * lib/jsonl.js's answers (#3452): a torn last line, an unparsable row, an
 * empty file and a missing one.
 * In-process over real temp files: the reader's one port is the filesystem,
 * and its ENOENT-versus-other-error split is only real on a real one.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const load = createRequire(__filename);
const { parseJsonl, readJsonl } = load("./jsonl.js");

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
	it("reports a torn last line as torn, keeping the rows before it", () => {
		expect(readJsonl(write('{"a":1}\n{"a":2}\n{"a":'))).toEqual({
			rows: [{ a: 1 }, { a: 2 }],
			torn: true,
			unparsable: 0,
		});
	});

	it("reads an unterminated last line that parses as a whole row", () => {
		expect(readJsonl(write('{"a":1}\n{"a":2}'))).toEqual({
			rows: [{ a: 1 }, { a: 2 }],
			torn: false,
			unparsable: 0,
		});
	});

	it("counts and skips an unparsable row, and a row that is no object", () => {
		expect(
			readJsonl(write('{"a":1}\nnot json\n[1]\nnull\n3\n{"a":2}\n')),
		).toEqual({ rows: [{ a: 1 }, { a: 2 }], torn: false, unparsable: 4 });
	});

	it("counts a bad newline-terminated last line as unparsable, never torn", () => {
		expect(readJsonl(write('{"a":1}\n{"a":\n'))).toEqual({
			rows: [{ a: 1 }],
			torn: false,
			unparsable: 1,
		});
	});

	it("skips blank lines and CRLF endings", () => {
		expect(readJsonl(write('\n{"a":1}\r\n  \n{"a":2}\r\n'))).toEqual({
			rows: [{ a: 1 }, { a: 2 }],
			torn: false,
			unparsable: 0,
		});
	});

	it("reads an empty file as no rows", () => {
		expect(readJsonl(write(""))).toEqual({
			rows: [],
			torn: false,
			unparsable: 0,
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
			torn: true,
			unparsable: 1,
		});
	});
});
