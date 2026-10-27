// @vitest-environment node
/*
 * The §G5 reader lister (#2750): a noun-named function whose own body reads,
 * or returns what a `readX` call gave it (#2858), is listed; a verb-named one, a command-named wrapper, one reading only
 * inside a nested function and one doing no I/O are not. A miss here hands
 * the rename tickets under #2750 a short candidate list, and the breaches it
 * drops never get renamed.
 *
 * The lister reads what git tracks, so each case stages its sample in a
 * fresh repo built with the real git, beside an untracked file it must not
 * read. It runs in process (§X3).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process";

const CLI = path.resolve(__dirname, "list-noun-readers.js");

let tmp: string;
beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "list-noun-readers-"));
});
afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

const list = (source: string) => {
	fs.writeFileSync(path.join(tmp, "sample.js"), source);
	fs.writeFileSync(
		path.join(tmp, "untracked.js"),
		"function stray() { return fs.readFileSync(f); }\n",
	);
	for (const args of [
		["init", "-q"],
		["add", "sample.js"],
	])
		expect(spawnSync("git", args, { cwd: tmp }).status).toBe(0);
	const r = runInProcess(CLI, [], { cwd: tmp });
	expect(r.status).toBe(0);
	return r.stdout;
};

it("lists a noun-named function or arrow whose own body reads", () => {
	const out = list(
		[
			"function trackedFiles() {",
			'\treturn execGit(["ls-files"]);',
			"}",
			"const lockedSources = (f) => JSON.parse(fs.readFileSync(f));",
			"",
		].join("\n"),
	);
	expect(out).toContain("sample.js:1\ttrackedFiles\n");
	expect(out).toContain("sample.js:4\tlockedSources\n");
	expect(out).toMatch(/^2 candidate\(s\)$/m);
});

it("passes a verb-named reader, a command-named wrapper and a non-reader", () => {
	const out = list(
		[
			"function loadManifest() { return fs.readFileSync(f); }",
			"function gitLines(args) { return execGit(args).split('\\n'); }",
			"function seedOf(buf) { return buf.readUInt32LE(0); }",
			"function main() { return fs.readFileSync(f); }",
			"",
		].join("\n"),
	);
	expect(out).toBe("0 candidate(s)\n");
});

it("lists a noun-named function that returns what a readX call gave it", () => {
	const out = list(
		[
			"function settingsAt(root, rev) {",
			"\tconst text = readTextAt(root, rel, rev);",
			"\tif (text === null) return null;",
			"\treturn { hooks: parseHooks(text) };",
			"}",
			"function hooksAt(root, rel, rev) {",
			"\tconst text = readTextAt(root, rel, rev);",
			"\treturn parseHooks(text);",
			"}",
			"function ownHookSources(root, opts) {",
			"\tif (opts.core) return readHostHookSources(root, opts);",
			"\treturn [settingsAt(root)];",
			"}",
			"function sourceCount(root) {",
			"\treadHostHookSources(root);",
			"\treturn 0;",
			"}",
			"",
		].join("\n"),
	);
	expect(out).toContain("sample.js:1\tsettingsAt\n");
	expect(out).toContain("sample.js:6\thooksAt\n");
	expect(out).toContain("sample.js:10\townHookSources\n");
	expect(out).not.toContain("sourceCount");
	expect(out).toMatch(/^3 candidate\(s\)$/m);
});

it("follows a readX value through every way a variable carries it", () => {
	const out = list(
		[
			"const ruleText = (id) => readRuleText(id);",
			"function headSha() {",
			"\tconst { sha } = readHead();",
			"\treturn sha;",
			"}",
			"function ruleIds() {",
			"\tconst ids = [];",
			"\tfor (const f of readRuleFiles()) ids.push(f.id);",
			"\treturn ids;",
			"}",
			"function lastLine() {",
			"\tlet line = null;",
			"\tline = readLog();",
			"\treturn line;",
			"}",
			"function textLength(file) {",
			"\tconst text = readText(file);",
			"\treturn file.text.length + text.length;",
			"}",
			"function fieldOnly(file) {",
			"\tconst text = readText(file);",
			"\treturn file.text;",
			"}",
			"",
		].join("\n"),
	);
	for (const name of [
		"ruleText",
		"headSha",
		"ruleIds",
		"lastLine",
		"textLength",
	])
		expect(out).toMatch(new RegExp(`\\t${name}\\n`));
	expect(out).not.toContain("fieldOnly");
	expect(out).toMatch(/^5 candidate\(s\)$/m);
});

it("charges a nested function's read to the nested function alone", () => {
	const out = list(
		[
			"function poolState() {",
			"\tconst onePool = () => fs.readdirSync(d);",
			"\treturn onePool;",
			"}",
			"",
		].join("\n"),
	);
	expect(out).toContain("sample.js:2\tonePool\n");
	expect(out).not.toContain("poolState");
});

it("exits 1 and says why where git cannot list the files", () => {
	const r = runInProcess(CLI, [], { cwd: tmp });
	expect(r.status).toBe(1);
	expect(r.stderr).toMatch(/^git ls-files failed: /);
});
