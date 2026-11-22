// @vitest-environment node

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "..");
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

describe("coverage measurement is declined repo-wide (mantahostels#1136)", () => {
	it("vitest.config.ts declares no coverage block", () => {
		const config = read("vitest.config.ts");
		expect(config).not.toMatch(/\bcoverage\s*:/);
		expect(config).not.toMatch(/\bthresholds\s*:/);
	});

	it("no @vitest/coverage-* provider is a dependency", () => {
		const pkg = JSON.parse(read("package.json"));
		const deps = Object.keys({
			...(pkg.dependencies ?? {}),
			...(pkg.devDependencies ?? {}),
		});
		expect(deps.filter((d) => d.startsWith("@vitest/coverage-"))).toEqual([]);
	});

	it("the Python side declines the same way", () => {
		expect(read("requirements-dev.txt")).not.toMatch(/\bpytest-cov\b/);
		expect(read("pytest.ini")).not.toMatch(/--cov/);
	});

	it("no npm script, gate or workflow invokes a coverage run", () => {
		const pkg = JSON.parse(read("package.json"));
		for (const [name, cmd] of Object.entries(
			pkg.scripts as Record<string, string>,
		))
			expect(`${name} -> ${cmd}`).not.toMatch(
				/--coverage|\bpytest-cov\b|--cov/,
			);
		expect(read(".husky/pre-commit")).not.toMatch(/--coverage|--cov\b/);
		expect(read(".github/workflows/ci.yml")).not.toMatch(/--coverage|--cov\b/);
	});
});
