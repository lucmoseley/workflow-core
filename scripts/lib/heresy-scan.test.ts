// @vitest-environment node
/*
 * Pins heresy-scan.js's shared tree walk and site summary (#4123). Each
 * check's own test holds its boundary cases.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listTreeFiles, saySites } from "./heresy-scan.js";

let root = "";
beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "heresy-scan-"));
});
afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

const write = (rel: string) => {
	fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
	fs.writeFileSync(path.join(root, rel), "");
};

describe("listTreeFiles", () => {
	it("lists each dir's files sorted, in the dirs' order, skipping node_modules, symlinks and a missing dir", () => {
		for (const rel of [
			"scripts/b.js",
			"scripts/lib/a.js",
			"scripts/node_modules/x/i.js",
			"hooks/z.sh",
			".claude/skills/s/k.md",
		])
			write(rel);
		fs.symlinkSync(
			path.join(root, "scripts/b.js"),
			path.join(root, "scripts/link.js"),
		);
		expect(
			listTreeFiles(root, ["scripts", "missing", ".claude/skills", "hooks"]),
		).toEqual([
			"scripts/b.js",
			"scripts/lib/a.js",
			".claude/skills/s/k.md",
			"hooks/z.sh",
		]);
	});
});

describe("saySites", () => {
	const ctx = (findings: { file: string; line: number }[]) => {
		const said: string[] = [];
		return { said, findings, say: (s: string) => said.push(s) };
	};

	it("says the count, phrase, each site and each fix line, indented", () => {
		const c = ctx([
			{ file: "a.js", line: 2 },
			{ file: "b.js", line: 7 },
		]);
		saySites(c as never, "site(s) off the route", ["Fix: one.", "Fix: two."]);
		expect(c.said).toEqual([
			"  2 site(s) off the route: a.js:2, b.js:7.\n  Fix: one.\n  Fix: two.",
		]);
	});

	it("says nothing where there are no findings", () => {
		const c = ctx([]);
		saySites(c as never, "site(s)", ["Fix: one."]);
		expect(c.said).toEqual([]);
	});
});
