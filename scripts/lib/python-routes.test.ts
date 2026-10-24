// @vitest-environment node
/*
 * Pins which local route rows python-routes.js holds `pythonRoutes` to, and
 * that each disagreement is named (#1863). Pure text in, findings out, so no
 * repository is needed; check-code-standards.test.ts pins the wiring.
 *
 * Loosen a case and `pythonRoutes` can drift from the table unreported, so
 * the swallowed-error gate judges a test file as a program, or a program as
 * nothing.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pythonRouteDrift } from "./python-routes.js";
import type { PythonKind } from "./workflow-core-config.js";

const table = (...rows: string[]) =>
	[
		"# Local",
		"",
		"## Route rows",
		"",
		"| Path | Code kind |",
		"|---|---|",
		...rows,
		"",
		"---",
		"",
	].join("\n");

const CORE = table(
	"| `scripts/**/test_*.py`, `scripts/conftest.py` | test: pytest's cases (#1262) |",
	"| `scripts/**/*.py`, shebang or not | program, the `scripts/lib/` modules included (#1262) |",
);

const details = (text: string, declared?: Record<string, PythonKind>) =>
	pythonRouteDrift(text, declared).drift.map(
		(d) => `${d.line} ${d.glob}: ${d.detail}`,
	);

describe("pythonRouteDrift", () => {
	it("passes copies that agree, row for row and in order", () => {
		const r = pythonRouteDrift(CORE, {
			"scripts/**/test_*.py": "test",
			"scripts/conftest.py": "test",
			"scripts/**/*.py": "program",
		});
		expect(r.drift).toEqual([]);
		expect(r.rows).toBe(3);
	});

	it("names a local row pythonRoutes lacks, with its table line and the entry to add", () => {
		const out = details(CORE, {
			"scripts/**/test_*.py": "test",
			"scripts/**/*.py": "program",
		});
		expect(out).toEqual([
			'7 scripts/conftest.py: the local route table routes it to test, and pythonRoutes has no such row: add "scripts/conftest.py": "test"',
		]);
	});

	it("names a kind that differs", () => {
		const out = details(CORE, {
			"scripts/**/test_*.py": "test",
			"scripts/conftest.py": "program",
			"scripts/**/*.py": "program",
		});
		expect(out).toEqual([
			'7 scripts/conftest.py: the local route table routes it to test, pythonRoutes to program: make it "test"',
		]);
	});

	it("names a pythonRoutes row no local row holds, on no table line", () => {
		const out = details(CORE, {
			"scripts/**/test_*.py": "test",
			"scripts/conftest.py": "test",
			"scripts/evidence_test_support.py": "test",
			"scripts/**/*.py": "program",
		});
		expect(out).toHaveLength(1);
		expect(out[0]).toMatch(
			/^0 scripts\/evidence_test_support\.py: pythonRoutes routes it to test, and no local route row/,
		);
	});

	it("names shared rows standing in another order, since the first match wins", () => {
		const out = details(CORE, {
			"scripts/**/*.py": "program",
			"scripts/**/test_*.py": "test",
			"scripts/conftest.py": "test",
		});
		expect(out).toHaveLength(1);
		expect(out[0]).toContain("7 scripts/**/test_*.py: pythonRoutes holds");
		expect(out[0]).toContain(
			"pythonRoutes scripts/**/*.py, scripts/**/test_*.py, scripts/conftest.py",
		);
	});

	it("holds every row of an absent table to be one no local row holds", () => {
		const out = details("# Local\n", { "scripts/**/*.py": "program" });
		expect(out).toHaveLength(1);
		expect(out[0]).toMatch(/^0 scripts\/\*\*\/\*\.py: /);
	});

	it("reads the heading with a suffix, the kind cell's leading kind, and a repeated glob as its first row", () => {
		const text = table(
			"| `server.py` | program: the read-only local server |",
			"| `probe.py` | library: a static table |",
			"| `docs/design-system/**` | none: a reference export (#2997) |",
			"| `server.py` | test |",
		).replace("## Route rows", "## Route rows and risk paths");
		expect(
			details(text, {
				"server.py": "program",
				"probe.py": "library",
				"docs/design-system/**": "none",
			}),
		).toEqual([]);
	});

	it("leaves out a row whose glob cannot reach a .py path", () => {
		const text = table(
			"| `next.config.ts`, `vitest.setup.ts` | tool configuration: §G alone |",
			"| `*.test-support.ts` | test: a helper only tests import |",
			"| `scripts/hooks/pre-commit` | shell |",
		);
		expect(pythonRouteDrift(text, {})).toEqual({ rows: 0, drift: [] });
	});

	it("expects a kind pythonRoutes cannot carry as none", () => {
		const text = table(
			"| `scripts/hooks/*` | shell |",
			"| `tools/` | tool configuration: §G alone |",
		);
		expect(details(text, {})).toEqual([
			'7 scripts/hooks/*: the local route table routes it to shell, which pythonRoutes carries as none, and pythonRoutes has no such row: add "scripts/hooks/*": "none"',
			'8 tools/: the local route table routes it to tool configuration, which pythonRoutes carries as none, and pythonRoutes has no such row: add "tools/": "none"',
		]);
	});

	it("says so of a row with no backticked glob, rather than skipping it unseen", () => {
		const out = details(table("| scripts/x.py | program |"), {});
		expect(out).toEqual([
			"7 (no glob): this route row has no backticked glob or no kind cell, so whether it routes Python went unchecked",
		]);
	});

	it("judges a bare-directory glob pythonRoutes names, as the gate matches one", () => {
		const text = table("| `scripts/legacy` | test |");
		expect(details(text, { "scripts/legacy": "test" })).toEqual([]);
		expect(details(text, { "scripts/legacy": "program" })).toHaveLength(1);
	});

	it("finds the core's own two copies in step", () => {
		const root = path.resolve(__dirname, "../..");
		const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
		const { pythonRoutes } = JSON.parse(read(".claude/workflow-core.json"));
		expect(
			pythonRouteDrift(read("docs/code-standards.md"), pythonRoutes).drift,
		).toEqual([]);
	});
});
