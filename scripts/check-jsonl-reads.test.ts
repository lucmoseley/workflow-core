// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineTemplate } from "./lib/git-fixture";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "check-jsonl-reads.js");

let root: string;

const program = (rel: string, body: string) => {
	const at = path.join(root, "scripts", rel);
	fs.mkdirSync(path.dirname(at), { recursive: true });
	fs.writeFileSync(at, body);
};

const run = (...args: string[]) => {
	const r = runInProcess(SCRIPT, args, {
		cwd: root,
		env: { ...process.env, GITHUB_ACTIONS: "", CLAUDE_PROJECT_DIR: root },
	});
	return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
};

const LOOP =
	'for (const line of text.split("\\n")) {\n\tif (!line) continue;\n\trows.push(JSON.parse(line));\n}\n';
const CHAINED =
	"const rows = raw.split(/\\r?\\n/).filter(Boolean).map((l) => JSON.parse(l));\n";
const HELPER =
	'function readAll(text) {\n\treturn text\n\t\t.split("\\n")\n\t\t.map(parseRow)\n\t\t.filter((r) => r !== null);\n}\nfunction parseRow(line) {\n\ttry {\n\t\treturn JSON.parse(line);\n\t} catch {\n\t\treturn null;\n\t}\n}\n';
const ARROW_HELPER =
	'const parseRow = (l) =>\n\tJSON.parse(l);\nconst rows = raw.split("\\n").flatMap((l) => parseRow(l));\n';
const DOLLAR_HELPER =
	'const $p = (l, i) => JSON.parse(l);\nconst rows = raw.split("\\n").map((l, i) => $p(l, i));\n';
const PLAIN_HELPER =
	'const open = (l) => l.startsWith("{");\nconst flags = raw.split("\\n").map(open);\n';
const IDENTITY_MAP = 'const lines = raw.split("\\n").map((l) => l);\n';
const ROWS_MODULE =
	"function parseRow(line) {\n\treturn safe(line);\n}\nfunction safe(line) {\n\ttry {\n\t\treturn JSON.parse(line);\n\t} catch {\n\t\treturn null;\n\t}\n}\nmodule.exports = { parseRow, safe };\n";
const IMPORTED =
	'const { safe } = require("./lib/rows.js");\nconst rows = text.split("\\n").map(safe);\n';
const RENAMED =
	'import { safe as tryRow } from "./lib/rows.js";\nconst rows = text.split("\\n").map(tryRow);\n';
const NAMESPACE =
	'const h = require("./lib/rows");\nconst rows = text.split("\\n").map(h.safe);\n';
const EXPORTS_MEMBER =
	'exports.parseRow = (l) => JSON.parse(l);\nconst rows = text.split("\\n").map(exports.parseRow);\n';
const ONE_HOP =
	'const { parseRow } = require("./lib/rows.js");\nconst rows = text.split("\\n").map((l) => parseRow(l));\n';
const TWO_HOPS =
	'const { parseRow } = require("./lib/rows.js");\nconst a = (l) => parseRow(l);\nconst rows = text.split("\\n").map(a);\n';
const PLAIN_MODULE =
	'const open = (l) => l.startsWith("{");\nconst cfg = JSON.parse("{}");\nmodule.exports = { open, cfg };\n';
const IMPORTED_PLAIN =
	'const { open } = require("./lib/plain.js");\nconst flags = raw.split("\\n").map(open);\n';
const SHAPES_MODULE =
	"exports.viaExports = (l) => JSON.parse(l);\nfunction safe(l) {\n\treturn JSON.parse(l);\n}\nmodule.exports.safe = safe;\n";
const SPLIT = 'text.split("\\n")';
const SHAPES: Record<string, string> = {
	"renamed.js": `const { viaExports: ve } = require("./lib/shapes.js");\n${SPLIT}.map(ve);\n`,
	"namespace.js": `const ns = require("./lib/shapes");\n${SPLIT}.map(ns.viaExports);\n`,
	"member-of.js": `const one = require("./lib/shapes.js").safe;\n${SPLIT}.map(one);\n`,
	"star.mjs": `import * as star from "./lib/pkg";\n${SPLIT}.map(star.safe);\n`,
	"method.js": `class Reader {\n\tparseOne(line) {\n\t\treturn JSON.parse(line);\n\t}\n\tall(text) {\n\t\treturn ${SPLIT}.map((l) => this.parseOne(l));\n\t}\n}\n`,
	"prop.js": `const rows = {\n\tparseOne: (l) => JSON.parse(l),\n};\n${SPLIT}.map(rows.parseOne);\n`,
	"shadowed.js": `const opts = {\n\tsafe: (l) => l,\n};\nfunction safe(l) {\n\treturn JSON.parse(l);\n}\n${SPLIT}.map(safe);\n`,
};
const CLEAN_SHAPES: Record<string, string> = {
	"param-owner.js": `function trim(cfg) {\n\treturn JSON.parse(cfg);\n}\n${SPLIT}.map((l) => l.trim());\n`,
	"package-owner.js": `const path = require("node:path");\nfunction basename(cfg) {\n\treturn JSON.parse(cfg);\n}\n${SPLIT}.map((l) => path.basename(l));\n`,
	"off-row.js": `function loadCfg() {\n\treturn JSON.parse(fs.readFileSync("c.json", "utf8"));\n}\nconst tidy = (l) => l.trim() + loadCfg().suffix;\n${SPLIT}.map(tidy);\n`,
	"keyword.js": `if (ready) {\n\tJSON.parse(cfg);\n}\n${SPLIT}.map(if);\n`,
};
const ON_READER =
	'const { readJsonl } = require("./lib/jsonl.js");\nconst rows = readJsonl(file)?.rows ?? [];\n';

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "jsonl-reads-"));
});
afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("check-jsonl-reads", () => {
	it("FAILs a loop and a chained hand-parse, naming file, line, the reader and its exemplar", () => {
		program("loop.js", `const text = "";\n${LOOP}`);
		program("lib/chained.js", CHAINED);
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain("FAIL: 2 hand-parsed JSONL read(s)");
		expect(r.out).toContain(
			"2 site(s) hand-parse JSONL: scripts/lib/chained.js:1, scripts/loop.js:2.",
		);
		expect(r.out).toContain(
			"Fix: read it through readJsonl (a file), parseJsonl (text) or parseJsonlRow (one streamed line) in scripts/lib/jsonl.js, as scripts/lib/dispatch-ledger.js's readCountedRows does",
		);
	});

	it.each([
		["single-quoted", "'\\n'"],
		["template", "`\\n`"],
		["regex", "/\\n/"],
	])("FAILs a split on a %s newline", (_, newline) => {
		program(
			"split.js",
			`const rows = raw.split(${newline}).map(JSON.parse);\n`,
		);
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain("1 site(s) hand-parse JSONL: scripts/split.js:1.");
	});

	it("FAILs a split mapped through a named helper that parses JSON, bare or arrow-wrapped (#5869)", () => {
		program("helper.js", HELPER);
		program("arrow.js", ARROW_HELPER);
		program("dollar.js", DOLLAR_HELPER);
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			"3 site(s) hand-parse JSONL: scripts/arrow.js:3, scripts/dollar.js:2, scripts/helper.js:3.",
		);
	});

	it("FAILs a split mapped through a helper it imports, renames, reaches as a member or calls one hop on (#5888)", () => {
		program("lib/rows.js", ROWS_MODULE);
		program("imported.js", IMPORTED);
		program("renamed.mjs", RENAMED);
		program("namespace.js", NAMESPACE);
		program("member.js", EXPORTS_MEMBER);
		program("hop.js", ONE_HOP);
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			"5 site(s) hand-parse JSONL: scripts/hop.js:2, scripts/imported.js:2, scripts/member.js:2, scripts/namespace.js:2, scripts/renamed.mjs:2.",
		);
	});

	it("passes a split mapped through an imported helper that parses no JSON, one whose parse sits two hops off, and a readJsonl caller (#5888)", () => {
		program("lib/rows.js", ROWS_MODULE);
		program("lib/plain.js", PLAIN_MODULE);
		program("imported-plain.js", IMPORTED_PLAIN);
		program("far-hop.js", TWO_HOPS);
		program("on.js", ON_READER);
		const r = run();
		expect(r.status).toBe(0);
	});

	it.each(Object.entries(SHAPES))(
		"FAILs a helper reached as %s (#5888)",
		(name, body) => {
			program("lib/shapes.js", SHAPES_MODULE);
			program("lib/pkg/index.js", SHAPES_MODULE);
			program(name, body);
			const r = run();
			expect(r.status).toBe(1);
			expect(r.out).toContain(`1 site(s) hand-parse JSONL: scripts/${name}:`);
		},
	);

	it.each(Object.entries(CLEAN_SHAPES))(
		"passes %s: a parameter or package method sharing a parsing function's name, a hop off the row, a keyword callee (#5888)",
		(name, body) => {
			program(name, body);
			expect(run().status).toBe(0);
		},
	);

	it("passes a helper whose module resolves outside the root (#5888)", () => {
		const outside = `${root}-outside.js`;
		fs.writeFileSync(outside, "exports.safe = (l) => JSON.parse(l);\n");
		program(
			"outside.js",
			`const { safe } = require("../../${path.basename(outside)}");\n${SPLIT}.map(safe);\n`,
		);
		const r = run();
		fs.rmSync(outside);
		expect(r.status).toBe(0);
	});

	it("passes a split mapped through a helper that parses no JSON, its body holding a brace in a string, with a parse past its end, and an identity map beside an unrelated parse (#5869)", () => {
		const far = `${"f();\n".repeat(13)}const l = JSON.parse(cfg);\n`;
		program("plain.js", `${PLAIN_HELPER}${far}`);
		program("identity.js", `${IDENTITY_MAP}${far}`);
		program("on.js", ON_READER);
		const r = run();
		expect(r.status).toBe(0);
	});

	it("passes a program on the reader, a split with no parse near it, one in a comment, a test or spec of any extension and the reader itself (#3484)", () => {
		program("on.js", ON_READER);
		program(
			"far.js",
			`const lines = text.split("\\n");\n${"f();\n".repeat(13)}JSON.parse(x);\n`,
		);
		program("cites.js", '/* text.split("\\n").map(JSON.parse) */\n');
		program("loop.test.js", LOOP);
		program("loop.spec.cjs", LOOP);
		program("lib/jsonl.js", LOOP);
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK: 4 program(s), no hand-parsed JSONL.");
	});

	it("honours the opt-out marker only where it names an issue", () => {
		program("pointer.js", `// jsonl-read-exempt: #3452\n${LOOP}`);
		program(
			"why.js",
			`// jsonl-read-exempt: git log lines, not JSONL\n${LOOP}`,
		);
		program("bare.js", `// jsonl-read-exempt:\n${LOOP}`);
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			"2 site(s) hand-parse JSONL: scripts/bare.js:2, scripts/why.js:2.",
		);
	});
});

describe("--index (#3687)", () => {
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: root, stdio: "pipe" });

	const seededRepo = defineTemplate((at) => {
		const gitAt = (...args: string[]) =>
			execFileSync("git", args, { cwd: at, stdio: "pipe" });
		gitAt("init", "-q", "-b", "main", ".");
		gitAt("config", "user.email", "test@example.com");
		gitAt("config", "user.name", "test");
		fs.mkdirSync(path.join(at, "scripts"), { recursive: true });
		fs.writeFileSync(path.join(at, "scripts", "on.js"), ON_READER);
		gitAt("add", ".");
		gitAt("commit", "-qm", "seed");
	});

	beforeEach(() => {
		seededRepo.instantiate(root);
	});

	it("passes a hand-parse in an untracked program and in an unstaged edit", () => {
		program("loose.js", CHAINED);
		program("on.js", `${ON_READER}${CHAINED}`);
		expect(run().status).toBe(1);
		const r = run("--index");
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK: 1 program(s), no hand-parsed JSONL.");
	});

	it("refuses the same hand-parse once staged, naming its file and line", () => {
		program("loose.js", CHAINED);
		git("add", "scripts/loose.js");
		const r = run("--index", "--json");
		expect(r.status).toBe(1);
		expect(JSON.parse(r.out).findings).toMatchObject([
			{ file: "scripts/loose.js", line: 1 },
		]);
		expect(JSON.parse(r.out).findings[0].message).toContain(
			"Fix: read it through readJsonl",
		);
	});
});
