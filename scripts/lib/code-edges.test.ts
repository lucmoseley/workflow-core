// @vitest-environment node
/*
 * code-edges.js's Python reach (#4864): the files an import loads, the paths
 * it tried first, and the imports it cannot place. Loosen a case and the pass
 * store caches a test whose spawned script's module changed. Each case builds
 * a real temporary tree, since the walk resolves a module by reading the
 * disk.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { reachOf } = require("./code-edges.js");

let root = "";
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** A tree holding `files`, and the importer `tool/t.py` reading `code`. */
function tree(code: string, files: string[]) {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ce-")));
	for (const rel of [...files, "tool/t.py"]) {
		fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
		fs.writeFileSync(path.join(root, rel), rel === "tool/t.py" ? code : "");
	}
	const file = path.join(root, "tool/t.py");
	const faults: string[] = [];
	const rel = (ps: string[]) => ps.map((p) => path.relative(root, p));
	const { edges, shadows } = reachOf(file, code, (m: string) => faults.push(m));
	return { edges: rel(edges), shadows: rel(shadows), faults };
}

describe("a dotted import", () => {
	it("reaches the package and each submodule it names", () => {
		expect(
			tree("import pkg.sub\n", ["tool/pkg/__init__.py", "tool/pkg/sub.py"])
				.edges,
		).toEqual(["tool/pkg/__init__.py", "tool/pkg/sub.py"]);
	});

	it("reaches a submodule package's __init__.py and one below a namespace directory", () => {
		expect(
			tree("import pkg.sub.deep.leaf\n", [
				"tool/pkg/__init__.py",
				"tool/pkg/sub/__init__.py",
				"tool/pkg/sub/deep/leaf.py",
			]).edges,
		).toEqual([
			"tool/pkg/__init__.py",
			"tool/pkg/sub/__init__.py",
			"tool/pkg/sub/deep/leaf.py",
		]);
	});

	it("reaches a from-imported name that is a submodule, and not one that is an attribute", () => {
		expect(
			tree("from pkg import sub, attr\n", [
				"tool/pkg/__init__.py",
				"tool/pkg/sub.py",
			]).edges,
		).toEqual(["tool/pkg/__init__.py", "tool/pkg/sub.py"]);
	});

	it("names a dotted part's package as a shadow of its module", () => {
		expect(
			tree("import pkg.sub\n", ["tool/pkg/__init__.py", "tool/pkg/sub.py"])
				.shadows,
		).toContain("tool/pkg/sub/__init__.py");
	});

	it("faults a from-imported name a namespace package does not hold", () => {
		expect(tree("from ns import gone\n", ["tool/ns/other.py"]).faults).toEqual([
			"imports gone from ns, a namespace package that holds no gone",
		]);
	});

	it("faults a submodule the walk cannot place", () => {
		const { faults } = tree("import pkg.gone\n", ["tool/pkg/__init__.py"]);
		expect(faults).toEqual([
			"imports pkg.gone, whose gone the walk cannot place",
		]);
	});
});

describe("a sys.path entry the file adds", () => {
	it.each([
		['os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib")'],
		['str(Path(__file__).resolve().parent.parent / "lib")'],
		['HERE / ".." / "lib"'],
	])("places a module found through sys.path.insert(0, %s)", (expr) => {
		const code = [
			"from pathlib import Path",
			"HERE = Path(__file__).parent",
			`sys.path.insert(\n    0, ${expr}\n)`,
			"import helper  # noqa: E402",
		].join("\n");
		const { edges, faults } = tree(code, ["lib/helper.py"]);
		expect({ edges, faults }).toEqual({
			edges: ["lib/helper.py"],
			faults: [],
		});
	});

	it("searches the newest insert first and names what it tried before the module", () => {
		const code = [
			'sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "b"))',
			'sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "a"))',
			"import helper",
		].join("\n");
		const found = tree(code, ["a/other.py", "b/helper.py", "tool/helper.py"]);
		expect(found.edges).toEqual(["b/helper.py"]);
		expect(found.shadows).toEqual([
			"a/helper/__init__.py",
			"a/helper.py",
			"b/helper/__init__.py",
		]);
	});

	it("searches an appended entry after the importer's own directory", () => {
		const code =
			'sys.path.append(os.path.join(os.path.dirname(__file__), "..", "lib"))\nimport helper\n';
		expect(tree(code, ["lib/helper.py", "tool/helper.py"]).edges).toEqual([
			"tool/helper.py",
		]);
	});

	it.each([
		["sys.path.insert(0, sys.argv[1])"],
		['sys.path.insert(0, "relative")'],
		["sys.path.insert(1, os.path.dirname(__file__))"],
		["sys.path[:0] = [LIB]"],
		["sys.path.pop(0)"],
		["del sys.path[0]"],
	])("faults a later non-stdlib import after %s", (edit) => {
		const { faults } = tree(`${edit}\nimport os\nimport helper\n`, [
			"tool/helper.py",
		]);
		expect(faults).toEqual([
			"imports helper after a sys.path edit the walk cannot read",
		]);
	});

	it("counts every file an indented insert may or may not have put first", () => {
		const code = [
			"if CHECK:",
			'    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))',
			"import helper",
		].join("\n");
		expect(tree(code, ["lib/helper.py", "tool/helper.py"]).edges).toEqual([
			"lib/helper.py",
			"tool/helper.py",
		]);
	});

	it("places a function's import on the search path as the file leaves it too", () => {
		const code = [
			"def run():",
			"    import helper",
			'sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))',
		].join("\n");
		expect(tree(code, ["lib/helper.py", "tool/helper.py"]).edges).toEqual([
			"tool/helper.py",
			"lib/helper.py",
		]);
	});

	it("faults a third-party package the tree does not hold", () => {
		expect(tree("import playwright\n", []).faults).toEqual([
			"imports playwright, which is neither stdlib nor found beside it or on a sys.path entry it adds",
		]);
	});
});
