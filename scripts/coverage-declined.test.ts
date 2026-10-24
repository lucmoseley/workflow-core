// @vitest-environment node

/*
 * Pins that no config, dependency, npm script, gate or workflow measures test
 * coverage, on the JavaScript or the Python side.
 *
 * Test coverage measurement was declined, not forgotten (mantahostels#1136).
 *
 * mantahostels#1132 measured a baseline: `app/`+`lib/` at 94.0% of statements, `scripts/`
 * at 39.5%, `.claude/` at 37.1%. mantahostels#1136 found that spread is an artefact of test
 * style, not a measure of what is untested: 72 of the 81 tracked
 * `scripts/**\/*.js` files carry a sibling test file, but 87 of the 113 test
 * files under `scripts/` run the code by spawning it, and vitest's v8 provider
 * instruments only its own workers. A `scripts/` floor would therefore make
 * "convert a subprocess test into an in-process import" the cheapest way to
 * raise the number — which stops testing the shebang, argv and exit-code seam
 * that git and the husky hooks depend on.
 *
 * `AGENTS.md` carries the instruments this repo uses instead, and both are
 * targeting rules rather than volume ones: concentrate test effort on "auth/RLS
 * boundaries, the availability fan-out, money paths, and reward-code
 * generation/redemption", and "Mutation-test every new guarantee".
 *
 * Each case reads the live repo files rather than a fixture, since this repo's
 * own wiring is the subject.
 *
 * These cases exist so a later ticket wanting coverage has to delete them and
 * say why, rather than reintroducing it from first principles.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "..");
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

describe("coverage measurement is declined repo-wide (mantahostels#1136)", () => {
	it("vitest.config.ts declares no coverage block", () => {
		// A `coverage:` key inside `test:` is all it takes to turn instrumentation
		// on, and `thresholds` inside it is what would make it a gate.
		const config = read("vitest.config.ts");
		expect(config).not.toMatch(/\bcoverage\s*:/);
		expect(config).not.toMatch(/\bthresholds\s*:/);
	});

	it("no @vitest/coverage-* provider is a dependency", () => {
		// mantahostels#1132 installed `@vitest/coverage-v8` with --no-save to take the
		// baseline and removed it again; 57 packages is the standing cost of
		// keeping it, paid on every CI `npm ci`.
		const pkg = JSON.parse(read("package.json"));
		const deps = Object.keys({
			...(pkg.dependencies ?? {}),
			...(pkg.devDependencies ?? {}),
		});
		expect(deps.filter((d) => d.startsWith("@vitest/coverage-"))).toEqual([]);
	});

	it("the Python side declines the same way", () => {
		// §5 of mantahostels#1136: pytest-cov takes the same answer as vitest coverage, for
		// the same reason — the same targeting rule, over 7 pipeline files.
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
		// The two enforcement moments a coverage step could be added to: the
		// pre-commit hook, and CI's existing `Lint and tests` job.
		expect(read(".husky/pre-commit")).not.toMatch(/--coverage|--cov\b/);
		expect(read(".github/workflows/ci.yml")).not.toMatch(/--coverage|--cov\b/);
	});
});
