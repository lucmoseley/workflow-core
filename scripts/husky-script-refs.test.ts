// @vitest-environment node

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const SCRIPT_PATH = /(?:\.claude\/|scripts\/)[\w./-]+\.(?:c?js|mjs|sh|py)\b/g;

const HOOKS = fs
	.readdirSync(path.join(ROOT, ".husky"), { withFileTypes: true })
	.filter((e) => e.isFile())
	.map((e) => e.name);

function scriptRefs(text: string): string[] {
	const refs = new Set<string>();
	for (const line of text.split("\n")) {
		if (line.trimStart().startsWith("#")) continue;
		for (const m of line.matchAll(SCRIPT_PATH)) refs.add(m[0]);
	}
	return [...refs];
}

const missing = (text: string) =>
	scriptRefs(text).filter((p) => !fs.existsSync(path.join(ROOT, p)));

// #426
const readHook = (hook: string) =>
	fs.readFileSync(path.join(ROOT, ".husky", `${hook}`), "utf8");

describe("husky hook script references", () => {
	it("names the #426 shape: a gate calling an uncommitted script", () => {
		const hook = [
			"# node scripts/commented-out.js",
			"if git diff --cached --name-only | grep -q '^scripts/x\\.js$'; then",
			'\tnode scripts/check-compliance-version-dupes.js || exit "$?"',
			'\tnode scripts/check-citation-tracker.js || exit "$?"',
			"fi",
		].join("\n");
		expect(missing(hook)).toEqual([
			"scripts/check-compliance-version-dupes.js",
		]);
	});

	it.each(HOOKS)("%s calls only scripts that exist", (hook) => {
		const text = readHook(hook);
		if (hook === "pre-commit")
			expect(scriptRefs(text)).toContain("scripts/precommit-dispatch.js");
		expect(missing(text)).toEqual([]);
	});
});
