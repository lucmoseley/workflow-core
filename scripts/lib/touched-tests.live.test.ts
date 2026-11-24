// @vitest-environment node
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { selectTouched } = require("./touched-tests.js");

const ROOT = path.resolve(__dirname, "../..");

function selectedBy(file: string): string[] {
	execFileSync("git", ["ls-files", "--error-unmatch", file], {
		cwd: ROOT,
		stdio: "ignore",
	});
	return selectTouched(ROOT, {
		ownWork: { paths: [file], dropped: [], carriesUntracked: true },
		renderEdges: () => ({}),
	}).files;
}

it("the guard-registry anchors select the check-guard-registry family and the anchors-merge test", () => {
	const files = selectedBy(".claude/guard-registry-anchors.json");
	const family = execFileSync(
		"git",
		["ls-files", "scripts/check-guard-registry*.test.ts"],
		{ cwd: ROOT, encoding: "utf8" },
	)
		.split("\n")
		.filter((f) =>
			/^scripts\/check-guard-registry(-[\w-]+)?\.test\.ts$/.test(f),
		);
	expect(family).toContain("scripts/check-guard-registry.test.ts");
	expect(files).toEqual(
		[...family, "scripts/lib/registry-anchors-merge.test.ts"].sort(),
	);
});

it("the read-edge manifest selects the generated-rule-copies test", () => {
	expect(selectedBy("docs/test-read-edges.json")).toEqual([
		"scripts/lib/generated-rule-copies.test.ts",
	]);
});

it("the instruction-surface anchors select their checker test and the generated-rule-copies test", () => {
	expect(selectedBy("scripts/instruction-surface-anchors.json")).toEqual([
		"scripts/check-instruction-surface.test.ts",
		"scripts/lib/generated-rule-copies.test.ts",
	]);
});
