// @vitest-environment node
/*
 * Pins which sites check-jsonl-reads.js finds hand-parsing JSONL rather than
 * reading through lib/jsonl.js, over the whole tree, and that its refusal
 * names the reader and its exemplar (#3452, #3453).
 *
 * Fabricated programs in a throwaway directory, never this checkout, so a
 * case's sites are only its own.
 *
 * .husky/pre-commit refuses on this checker, so loosening a case here lets the
 * next hand-rolled reader, with its own answer for a torn last line, land.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
			"Fix: read it through readJsonl (a file), parseJsonl (text) or parseJsonlRow (one streamed line) in scripts/lib/jsonl.js, as scripts/lib/dispatch-ledger.js's readWindowRows does",
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

	it("honours the opt-out marker only where it gives a reason", () => {
		program(
			"why.js",
			`// jsonl-read-exempt: git log lines, not JSONL\n${LOOP}`,
		);
		program("bare.js", `// jsonl-read-exempt:\n${LOOP}`);
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain("1 site(s) hand-parse JSONL: scripts/bare.js:2.");
	});
});

describe("--index (#3687)", () => {
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: root, stdio: "pipe" });

	beforeEach(() => {
		git("init", "-q", "-b", "main", ".");
		git("config", "user.email", "test@example.com");
		git("config", "user.name", "test");
		program("on.js", ON_READER);
		git("add", ".");
		git("commit", "-qm", "seed");
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
