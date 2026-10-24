// @vitest-environment node
/*
 * husky-script-refs.test.ts — every script a husky hook runs exists on disk
 * (#426). A hook calling a script that was never committed stays hidden until
 * its arming path is staged, then refuses every such commit with a bare
 * MODULE_NOT_FOUND.
 *
 * DEPARTS FROM §X3, DELIBERATELY (§G4): the subject is the hook TEXT, not a
 * script's behaviour, so nothing is run end to end.
 *
 * Reads each hook's non-comment lines for a `scripts/…` or `.claude/…` path
 * ending in a script extension. A grep pattern spells its dots `\.`, so the
 * paths a gate merely arms on never match. Unseen: an `npm run <x>` whose
 * script is missing, and a command resolved at runtime (the declared
 * `commands.*` in .claude/workflow-core.json).
 */

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

/* The template literal is what lets docs/test-read-edges.json attribute every
 * hook to this file, so an edit to any hook selects it; a plain `hook`
 * argument drops that attribution silently (#426). */
const readHook = (hook: string) =>
	fs.readFileSync(path.join(ROOT, ".husky", `${hook}`), "utf8");

describe("husky hook script references", () => {
	it("names the #426 shape: a gate calling an uncommitted script", () => {
		const hook = [
			"# node scripts/commented-out.js",
			"if git diff --cached --name-only | grep -q '^scripts/x\\.js$'; then",
			"\tnode scripts/check-compliance-version-dupes.js || exit 1",
			"\tnode scripts/check-citation-tracker.js || exit 1",
			"fi",
		].join("\n");
		expect(missing(hook)).toEqual([
			"scripts/check-compliance-version-dupes.js",
		]);
	});

	it.each(HOOKS)("%s calls only scripts that exist", (hook) => {
		const text = readHook(hook);
		if (hook === "pre-commit")
			expect(scriptRefs(text)).toContain("scripts/check-citation-tracker.js");
		expect(missing(text)).toEqual([]);
	});
});
