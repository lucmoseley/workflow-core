// @vitest-environment node
// full-sweep-only: #5551

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { unresolvedCitations } from "./doc-map-assertions.js";

const ROOT = path.resolve(__dirname, "../..");
const PLANTED_FIXTURES = "scripts/lib/doc-map-assertions.test.ts";

function filesCitingTheChecker(): Record<string, string> {
	const tracked = execFileSync("git", ["ls-files", "-z"], {
		cwd: ROOT,
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
	})
		.split("\0")
		.filter((f) => /\.(md|js|ts|json|html|ya?ml)$/.test(f));
	const files: Record<string, string> = {};
	for (const f of tracked) {
		if (f.startsWith("scripts/fixtures/") || f === PLANTED_FIXTURES) continue;
		const text = readFileSync(path.join(ROOT, f), "utf8");
		if (text.includes("check-doc-map")) files[f] = text;
	}
	return files;
}

describe("doc-map assertion citations across the repo", () => {
	it("resolves every citation in a file naming check-doc-map", () => {
		expect(unresolvedCitations(filesCitingTheChecker())).toEqual([]);
	});
});
