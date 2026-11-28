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
