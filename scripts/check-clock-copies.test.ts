// @vitest-environment node
/*
 * Pins which sites check-clock-copies.js finds reading WFC_NOW outside
 * lib/check.js's now(), over the whole tree, and that its refusal names the
 * clock and its exemplar (#3457).
 *
 * Fabricated programs in a throwaway directory, never this checkout, so a
 * case's sites are only its own.
 *
 * .husky/pre-commit refuses on this checker, so loosening a case here lets the
 * next program's own clock, with its own answer for a malformed pin, land.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "check-clock-copies.js");

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

const COPY =
	"const raw = process.env.WFC_NOW;\nconst t = raw ? Date.parse(raw) : Date.now();\n";
const ON_CLOCK = 'const { now } = require("./lib/check");\nconst t = now();\n';

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "clock-copies-"));
});
afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("check-clock-copies", () => {
	it("FAILs a parser copy, naming file, line, now() and its exemplar", () => {
		program("copy.js", `"use strict";\n${COPY}`);
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain("FAIL: 1 WFC_NOW read(s) outside now()");
		expect(r.out).toContain(
			"1 site(s) read WFC_NOW outside now(): scripts/copy.js:2.",
		);
		expect(r.out).toContain(
			"Fix: call now() from scripts/lib/check.js, as scripts/check-history-trim.js does,",
		);
	});

	it.each([
		["an env port's member read", "const pin = env.WFC_NOW;\n"],
		["a bracket read", 'const pin = process.env["WFC_NOW"];\n'],
		["a template-key bracket read", "const pin = process.env[`WFC_NOW`];\n"],
		["a destructuring read", "const { WFC_NOW: pin } = process.env;\n"],
	])("FAILs %s, naming its file and line", (_, body) => {
		program("lib/read.mjs", body);
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			"1 site(s) read WFC_NOW outside now(): scripts/lib/read.mjs:1.",
		);
		expect(r.out).toContain(
			"in a guard core, pass its env as scripts/lib/sweep-fire-host.js's now(env) does",
		);
	});

	it("passes a program on now(), a pin set for a child, one in a comment, a test and lib/check.js itself", () => {
		program("on.js", ON_CLOCK);
		program("pins.js", 'spawn("x", { env: { WFC_NOW: "2026-01-01" } });\n');
		program("cites.js", "/* process.env.WFC_NOW */\n");
		program("copy.test.js", COPY);
		program("copy.spec.js", COPY); // #3618
		program("lib/check.js", COPY);
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK: 4 program(s), no WFC_NOW read outside now().");
	});

	it("passes a read the marker gives a reason for, and only that one", () => {
		program("kept.js", `// clock-kept: pinned by its own caller\n${COPY}`);
		program("bare.js", `// clock-kept:\n${COPY}`);
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			"1 site(s) read WFC_NOW outside now(): scripts/bare.js:2.",
		);
	});
});
