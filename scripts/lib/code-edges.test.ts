// @vitest-environment node
/*
 * What one file reaches (file-reach.js) and what its run does (code-edges.js,
 * #4864): the files an import loads, the paths it tried first, and the
 * imports it cannot place. Loosen a case and the pass store caches a test
 * whose spawned script's module changed. Each case builds a real temporary
 * tree, since the walk resolves a module by reading the disk. Both modules'
 * cases share this file: the #4870 cases hold a module read alone against
 * the run importing it.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { readRunReach } = require("./code-edges.js");
const { fileReach } = require("./file-reach.js");

let root = "";
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** The reach of `file` under `root`, reading `text`, as a script run on
 * its own. */
function walk(file: string, text: string) {
	const faults: string[] = [];
	const rel = (ps: string[]) => ps.map((p) => path.relative(root, p));
	const found = fileReach(
		path.join(root, file),
		text,
		(m: string) => faults.push(m),
		null,
	);
	return { edges: rel(found.edges), shadows: rel(found.shadows), faults };
}

/** A tree holding `files`, and the importer `tool/t.py` reading `code`. */
function tree(code: string, files: string[]) {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ce-")));
	for (const rel of [...files, "tool/t.py"]) {
		fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
		fs.writeFileSync(path.join(root, rel), rel === "tool/t.py" ? code : "");
	}
	const { edges, shadows, faults } = walk("tool/t.py", code);
	return { edges, shadows, faults };
}

/** Python for a file directly under tool/ or lib/, putting the tree's `dir`
 * first on sys.path. */
const putFirst = (dir: string) =>
	`sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "${dir}"))`;

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

	/* #4790 pass 2 review, finding 6: a from-imported name's package form
	 * went unwatched once its module was found. */
	it("names what a from-imported name tried before its module as a shadow", () => {
		expect(
			tree("from pkg import sub\n", ["tool/pkg/__init__.py", "tool/pkg/sub.py"])
				.shadows,
		).toContain("tool/pkg/sub/__init__.py");
	});

	it("names a relative import's from-imported names' shadows", () => {
		const found = tree("from . import sub\n", ["tool/sub.py"]);
		expect(found.edges).toEqual(["tool/sub.py"]);
		expect(found.shadows).toEqual(["tool/sub/__init__.py"]);
	});

	it("faults a from-imported name a namespace package does not hold", () => {
		expect(tree("from ns import gone\n", ["tool/ns/other.py"]).faults).toEqual([
			"imports gone from ns, a namespace package that holds no gone",
		]);
	});

	it("reaches a submodule in whichever of a namespace package's directories holds it (#4870)", () => {
		const code = [
			putFirst("a"),
			putFirst("b"),
			"import ns.sub",
			"from ns import other, gone",
		].join("\n");
		expect(tree(code, ["a/ns/sub.py", "b/ns/other.py"])).toMatchObject({
			edges: ["a/ns/sub.py", "b/ns/other.py"],
			faults: ["imports gone from ns, a namespace package that holds no gone"],
		});
	});

	it.each([
		["a regular package", "b/ns/sub/__init__.py"],
		["a plain module", "b/ns/sub.py"],
	])(
		"faults a part %s in one namespace directory lacks, though another directory holds it (#4870)",
		(_what, regular) => {
			const code = [putFirst("a"), putFirst("b"), "import ns.sub.leaf"].join(
				"\n",
			);
			expect(tree(code, ["a/ns/sub/leaf.py", regular]).faults).toEqual([
				"imports ns.sub.leaf, whose leaf the walk cannot place",
			]);
		},
	);

	it("keeps to a regular package's own directory below it, whatever a sibling namespace directory holds (#4870)", () => {
		const code = [
			putFirst("a"),
			putFirst("b"),
			"import ns.reg.inner.x",
			"import ns.reg.inner.gone",
		].join("\n");
		const files = [
			"a/ns/reg/inner/gone.py",
			"b/ns/reg/__init__.py",
			"b/ns/reg/inner/x.py",
		];
		expect(tree(code, files)).toMatchObject({
			edges: ["b/ns/reg/__init__.py", "b/ns/reg/inner/x.py"],
			faults: ["imports ns.reg.inner.gone, whose gone the walk cannot place"],
		});
	});

	it.each([
		[
			"import pkg.ns.gone",
			"imports pkg.ns.gone, whose gone the walk cannot place",
		],
		[
			"from pkg.ns import gone",
			"imports gone from pkg.ns, a namespace package that holds no gone",
		],
		[
			"import pkg.ns.sub.gone",
			"imports pkg.ns.sub.gone, whose sub the walk cannot place",
		],
	])(
		"faults `%s`, missing from a namespace directory inside a regular package (#4870)",
		(code, fault) => {
			const found = tree(`import pkg.ns.x\n${code}\n`, [
				"tool/pkg/__init__.py",
				"tool/pkg/ns/x.py",
			]);
			expect(found.faults).toEqual([fault]);
			expect(found.edges).toContain("tool/pkg/ns/x.py");
		},
	);

	it("reaches only the first of a namespace package's directories to hold a submodule (#4870)", () => {
		const code = [putFirst("a"), putFirst("b"), "import ns.mod"].join("\n");
		expect(tree(code, ["a/ns/mod.py", "b/ns/mod.py"]).edges).toEqual([
			"b/ns/mod.py",
		]);
	});

	it("names a submodule's place under an earlier entry holding no directory of its namespace package as a shadow (#4870)", () => {
		const code = [putFirst("b"), putFirst("a"), "import ns.sub"].join("\n");
		const found = tree(code, ["a/other.py", "b/ns/sub.py"]);
		expect(found.edges).toEqual(["b/ns/sub.py"]);
		expect(found.shadows).toEqual(
			expect.arrayContaining(["a/ns/sub/__init__.py", "a/ns/sub.py"]),
		);
	});

	it("takes a from-imported name that is a directory of a namespace package for a package (#4870)", () => {
		const code = [putFirst("a"), putFirst("b"), "from ns import sub"].join(
			"\n",
		);
		expect(tree(code, ["a/ns/x.py", "b/ns/sub/y.py"]).faults).toEqual([]);
	});

	it("counts a submodule in each namespace directory an indented insert may or may not have put first (#4870)", () => {
		const code = [
			putFirst("d"),
			"if CHECK:",
			`    ${putFirst("m")}`,
			"import ns.sub",
		].join("\n");
		expect(tree(code, ["d/ns/sub.py", "m/ns/sub.py"]).edges).toEqual([
			"m/ns/sub.py",
			"d/ns/sub.py",
		]);
	});

	it.each([
		["the regular package", "m/pkg/sub.py"],
		["the namespace package", "d/pkg/sub.py"],
	])(
		"faults a submodule only %s holds, where an indented insert decides which package Python takes (#4870)",
		(_what, sub) => {
			const code = [
				putFirst("d"),
				"if CHECK:",
				`    ${putFirst("m")}`,
				"import pkg.sub",
			].join("\n");
			const files = ["m/pkg/__init__.py", "d/pkg/other.py", sub];
			expect(tree(code, files).faults).toEqual([
				"imports pkg.sub, whose sub the walk cannot place",
			]);
		},
	);

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
		const code = [putFirst("b"), putFirst("a"), "import helper"].join("\n");
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
	])("faults every later import but a builtin module's after %s", (edit) => {
		const { faults } = tree(
			`${edit}\nimport sys\nimport json\nimport helper\n`,
			["tool/helper.py"],
		);
		expect(faults).toEqual([
			"imports json after a sys.path edit the walk cannot read",
			"imports helper after a sys.path edit the walk cannot read",
		]);
	});

	/* #4790 pass 2 review, finding 5: the unreadable front entry may hold a
	 * json.py, so a stdlib name cached past it. */
	it("places a stdlib import past an unreadable entry appended after the stdlib's", () => {
		const { faults } = tree(
			"sys.path.append(sys.argv[1])\nimport json\nimport helper\n",
			[],
		);
		expect(faults).toEqual([
			"imports helper after a sys.path edit the walk cannot read",
		]);
	});

	it("counts every file an indented insert may or may not have put first", () => {
		const code = ["if CHECK:", `    ${putFirst("lib")}`, "import helper"].join(
			"\n",
		);
		expect(tree(code, ["lib/helper.py", "tool/helper.py"]).edges).toEqual([
			"lib/helper.py",
			"tool/helper.py",
		]);
	});

	it("places a function's import on the search path as the file leaves it too", () => {
		const code = ["def run():", "    import helper", putFirst("lib")].join(
			"\n",
		);
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

/** The run of `start` under `root`, read off the disk (`readRunReach`):
 * every file it reaches bar `start`, sorted, its shadows and its faults. */
function runOf(start: string) {
	const faults: string[] = [];
	const found = readRunReach(root)(start, (_file: string, m: string) =>
		faults.push(m),
	);
	return {
		edges: found.files.filter((f: string) => f !== start).sort(),
		shadows: found.shadows,
		unread: found.unread,
		faults,
	};
}

/** A tree under a fresh `root` holding each of `files`, path to text. */
function writeTree(files: Record<string, string>) {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ce-")));
	for (const [rel, text] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
		fs.writeFileSync(path.join(root, rel), text);
	}
}

describe("a module walked on its importer's sys.path (#4870)", () => {
	/** `lib/m.py`'s own reach, reading `code`, and the run of the script
	 * `tool/t.py`, reading `script`, that imports it; `files` stand beside
	 * them, empty. */
	function moduleTree(script: string, code: string, files: string[]) {
		writeTree({
			...Object.fromEntries(files.map((f) => [f, ""])),
			"lib/m.py": code,
			"tool/t.py": script,
		});
		return { alone: walk("lib/m.py", code), imported: runOf("tool/t.py") };
	}
	/* list_shape.py's shape: `lib`, then its own directory ahead of it. */
	const listShape = [
		"HERE = os.path.dirname(os.path.abspath(__file__))",
		'sys.path.insert(0, os.path.join(HERE, "..", "lib"))',
		"sys.path.insert(0, HERE)",
		"import m",
	].join("\n");

	it("names what the importer's earlier entry tried before the module's import as a shadow", () => {
		const { alone, imported } = moduleTree(listShape, "import helper\n", [
			"lib/helper.py",
		]);
		expect(alone.shadows).toEqual(["lib/helper/__init__.py"]);
		expect(imported.shadows).toEqual(
			expect.arrayContaining(["tool/helper/__init__.py", "tool/helper.py"]),
		);
		expect(imported.edges).toContain("lib/helper.py");
		expect(imported.faults).toEqual([]);
	});

	it("reaches the file on the importer's earlier entry that shadows the module's import", () => {
		const { alone, imported } = moduleTree(listShape, "import helper\n", [
			"lib/helper.py",
			"tool/helper.py",
		]);
		expect(alone.edges).toEqual(["lib/helper.py"]);
		expect(imported.edges).toEqual([
			"lib/helper.py",
			"lib/m.py",
			"tool/helper.py",
		]);
	});

	it("reaches the file the module's import found before the importer's later entry shadowed it", () => {
		const script = [
			"HERE = os.path.dirname(os.path.abspath(__file__))",
			'sys.path.insert(0, os.path.join(HERE, "..", "lib"))',
			"import m",
			'sys.path.insert(0, os.path.join(HERE, "..", "late"))',
		].join("\n");
		const { imported } = moduleTree(script, "import helper\n", [
			"tool/helper.py",
			"late/helper.py",
		]);
		expect(imported).toMatchObject({
			edges: ["late/helper.py", "lib/m.py", "tool/helper.py"],
			faults: [],
		});
	});

	it("names a stdlib import's shadow on the importer's entries", () => {
		const { alone, imported } = moduleTree(listShape, "import json\n", []);
		expect(alone.shadows).not.toContain("tool/json.py");
		expect(imported.shadows).toContain("tool/json.py");
	});

	it("places an import only the importer's sys.path holds, which faults walked alone", () => {
		const { alone, imported } = moduleTree(listShape, "import beside\n", [
			"tool/beside.py",
		]);
		expect(alone.faults).toEqual([
			"imports beside, which is neither stdlib nor found beside it or on a sys.path entry it adds",
		]);
		expect(imported).toMatchObject({
			edges: ["lib/m.py", "tool/beside.py"],
			faults: [],
		});
	});

	/* A package may rewrite its own __path__, so one lacking the submodule
	 * may still be the one Python takes, and loads what the walk cannot see. */
	it("faults a submodule one package of its name on the handed path lacks, though another holds it", () => {
		const { imported } = moduleTree(listShape, "import pkg.sub\n", [
			"lib/pkg/__init__.py",
			"tool/pkg/__init__.py",
			"tool/pkg/sub.py",
		]);
		expect(imported.faults).toEqual([
			"imports pkg.sub, whose sub the walk cannot place",
		]);
		expect(imported.edges).toContain("tool/pkg/sub.py");
	});

	it("faults the module's relative import from a namespace package, which walked alone or from a regular package is none", () => {
		const { alone, imported } = moduleTree(listShape, "from . import sub\n", [
			"lib/sub.py",
		]);
		expect(alone).toMatchObject({ edges: ["lib/sub.py"], faults: [] });
		expect(imported.faults).toEqual([
			"imports . relative to a namespace package, whose other directories the walk cannot tell",
		]);
		const regular = moduleTree(listShape, "from . import sub\n", [
			"lib/sub.py",
			"lib/__init__.py",
		]);
		expect(regular.imported).toMatchObject({
			edges: ["lib/__init__.py", "lib/m.py", "lib/sub.py"],
			faults: [],
		});
	});

	it("faults an import neither path holds", () => {
		const { imported } = moduleTree(listShape, "import playwright\n", []);
		expect(imported.faults).toEqual([
			"imports playwright, which is neither stdlib nor found beside it or on a sys.path entry it adds",
		]);
	});

	it("faults the module's import where the importer's sys.path holds an entry the walk cannot read", () => {
		const { alone, imported } = moduleTree(
			`import os, sys\n${putFirst("lib")}\nimport m\nsys.path.insert(0, sys.argv[1])\n`,
			"import sys\nimport helper\n",
			["lib/helper.py"],
		);
		expect(alone.faults).toEqual([]);
		/* The script's own imports too: the settled pass walks it on the path
		 * it left, the unread entry first. */
		expect(imported.faults).toEqual([
			"imports os after a sys.path edit the walk cannot read",
			"imports m after a sys.path edit the walk cannot read",
			"imports helper after a sys.path edit the walk cannot read",
		]);
	});

	it("hands the module's own edits on, atop its importer's, to what it imports", () => {
		writeTree({
			"tool/t.py": listShape,
			"lib/m.py": `${putFirst("deep")}\nimport n\n`,
			"deep/n.py": "import x\nimport y\n",
			"deep/x.py": "",
			"tool/y.py": "",
		});
		expect(runOf("tool/t.py")).toMatchObject({
			edges: ["deep/n.py", "deep/x.py", "lib/m.py", "tool/y.py"],
			faults: [],
		});
	});

	it("reaches a module found only on the entry another module of the run adds", () => {
		writeTree({
			"tool/t.py": `${putFirst("lib")}\nimport a\nimport b\n`,
			"lib/a.py": putFirst("extra"),
			"lib/b.py": "import x\n",
			"extra/x.py": "",
		});
		expect(runOf("tool/t.py")).toMatchObject({
			edges: ["extra/x.py", "lib/a.py", "lib/b.py"],
			faults: [],
			unread: [],
		});
	});

	/* Walked first, `b` meets `x` before `a` has added its entry: only the
	 * settled pass judges it. */
	it("reaches a module found only on the entry a module imported after it adds, faulting nothing (#5071)", () => {
		writeTree({
			"tool/t.py": `${putFirst("lib")}\nimport b\nimport a\n`,
			"lib/a.py": putFirst("extra"),
			"lib/b.py": "def run():\n    import x\n",
			"extra/x.py": "",
		});
		expect(runOf("tool/t.py")).toMatchObject({
			edges: ["extra/x.py", "lib/a.py", "lib/b.py"],
			faults: [],
			unread: [],
		});
	});

	it("settles on a path that walking its modules on it again leaves as it was", () => {
		writeTree({ "tool/t.py": listShape, "lib/m.py": `${putFirst("deep")}\n` });
		expect(runOf("tool/t.py")).toMatchObject({ unread: [], faults: [] });
	});
});

/* #4864, #4870: what a spawned Python script's run reaches, each a change
 * the pass store must see. */
describe("a Python script's run", () => {
	/** Python putting `name`, beside the file that reads it, first on sys.path. */
	const insert = (name: string) =>
		`import os, sys\nsys.path.insert(0, os.path.join(os.path.dirname(__file__), "${name}"))\n`;
	/** `tool.py` putting `lib` and then its own directory first on sys.path,
	 * as list_shape.py does, and importing `lib/mod.py`. */
	const listShaped = [
		"import os, sys",
		"HERE = os.path.dirname(os.path.abspath(__file__))",
		'sys.path.insert(0, os.path.join(HERE, "lib"))',
		"sys.path.insert(0, HERE)",
		"import mod  # noqa: E402",
	].join("\n");

	it("names a module's place on an earlier sys.path entry a shadow", () => {
		writeTree({
			"s/tool.py": [
				"import sys",
				"from pathlib import Path",
				'sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))',
				"import helper",
			].join("\n"),
			"s/helper.py": "",
		});
		expect(runOf("s/tool.py")).toMatchObject({
			edges: ["s/helper.py"],
			faults: [],
		});
		expect(runOf("s/tool.py").shadows).toContain("s/lib/helper.py");
	});

	it("names where the script's sys.path shadows its module's import a shadow", () => {
		writeTree({
			"s/tool.py": listShaped,
			"s/lib/mod.py": "import helper\n",
			"s/lib/helper.py": "",
		});
		expect(runOf("s/tool.py").shadows).toContain("s/helper.py");
	});

	it("reaches a module's import found only on the script's sys.path", () => {
		writeTree({
			"s/tool.py": listShaped,
			"s/lib/mod.py": "import beside\n",
			"s/beside.py": "",
		});
		expect(runOf("s/tool.py")).toMatchObject({
			edges: ["s/beside.py", "s/lib/mod.py"],
			faults: [],
		});
	});

	it("names the entry one module adds ahead of another module's import a shadow", () => {
		writeTree({
			"s/tool.py": listShaped,
			"s/lib/mod.py": `${insert("../x")}import other\n`,
			"s/lib/other.py": "import helper\n",
			"s/lib/helper.py": "",
		});
		expect(runOf("s/tool.py").shadows).toContain("s/x/helper.py");
	});

	it("names the entry a module adds ahead of its importer's later import a shadow", () => {
		writeTree({
			"s/tool.py": "import mod\nimport helper\n",
			"s/mod.py": insert("x"),
			"s/helper.py": "",
		});
		expect(runOf("s/tool.py").shadows).toContain("s/x/helper.py");
	});

	it("names the entry an imported module adds ahead of its importer's own a shadow", () => {
		writeTree({
			"s/tool.py": `${insert("x")}import mod\nimport helper\n`,
			"s/mod.py": insert("y"),
			"s/x/helper.py": "",
		});
		expect(runOf("s/tool.py").shadows).toContain("s/y/helper.py");
	});

	/* The second pair differs by a soft hyphen, which a locale's collation
	 * ignores. */
	it.each([
		["x", "y"],
		["x", "x\u00ad"],
	])(
		"settles where the entries two same-named modules add, %j and %j, decide which of them loads",
		(one, other) => {
			writeTree({
				"s/tool.py": "import setup\nimport mod\n",
				"s/setup.py": `${insert(one)}${insert(other)}`,
				"s/mod.py": "",
				[`s/${one}/mod.py`]: insert("."),
				[`s/${other}/mod.py`]: insert("."),
			});
			expect(runOf("s/tool.py")).toMatchObject({ unread: [], faults: [] });
		},
	);

	it("reaches a namespace package's module on the entry a module added last", () => {
		writeTree({
			"s/tool.py": "import setup\nimport ns.sub\n",
			"s/setup.py": `${insert("a")}${insert("b")}`,
			"s/ns/sub.py": "",
			"s/a/ns/sub.py": "",
			"s/b/ns/sub.py": "",
		});
		expect(runOf("s/tool.py").edges).toContain("s/b/ns/sub.py");
	});

	it("settles where two modules import each other, each adding to sys.path", () => {
		writeTree({
			"s/tool.py": listShaped,
			"s/lib/mod.py": `${insert("a")}import other\n`,
			"s/lib/other.py": `${insert("b")}import mod\n`,
		});
		expect(runOf("s/tool.py")).toMatchObject({ unread: [], faults: [] });
	});

	it("faults an import that follows a sys.path edit the walk cannot read", () => {
		writeTree({
			"s/tool.py":
				"import sys\nsys.path.insert(0, sys.argv[1])\nimport placed\n",
			"s/placed.py": "",
		});
		expect(runOf("s/tool.py").faults).toEqual([
			"imports placed after a sys.path edit the walk cannot read",
		]);
	});
});

/* #4790 pass 2 review, finding 4: each of these dropped its import with no
 * fault, so the pass store cached a test past a change to helper.py. */
describe("a statement the parse may miss", () => {
	it.each([
		[
			"a one-line compound statement's body",
			"try: import helper\nexcept ImportError: pass\n",
		],
		[
			"an import after a comment holding a triple quote",
			'# a """ in prose\nimport helper\n',
		],
	])("places %s", (_shape, code) => {
		const { edges, faults } = tree(code, ["tool/helper.py"]);
		expect({ edges: [...new Set(edges)], faults }).toEqual({
			edges: ["tool/helper.py"],
			faults: [],
		});
	});

	it("faults a file ending inside an open bracket", () => {
		expect(tree("import helper\nx = (\n", ["tool/helper.py"]).faults).toEqual([
			"ends inside an open bracket, so its last statement goes unread",
		]);
	});

	it("faults an import it cannot parse", () => {
		expect(
			tree("if f(lambda: 1): import helper\n", ["tool/helper.py"]).faults,
		).toEqual([
			"imports through 1): import helper, which the walk cannot parse",
		]);
	});

	/* #4790 pass 3 review, finding 3: a load with no import keyword raised
	 * no fault. */
	it.each([
		['spec = importlib.util.spec_from_file_location("m", P)'],
		["spec.loader.exec_module(m)"],
		["runpy.run_path(P)"],
		["exec(open(P).read())"],
		['__import__("helper")'],
	])("faults %s, a load that names no import", (load) => {
		expect(tree(`${load}\n`, ["tool/helper.py"]).faults).toHaveLength(1);
	});
});

describe("a file the walk cannot read", () => {
	it("faults JSX or TSX code rather than answering no edges", () => {
		const faults: string[] = [];
		fileReach(
			"/x/a.tsx",
			'import "./b.js";\n',
			(m: string) => faults.push(m),
			null,
		);
		expect(faults).toEqual(["is .tsx code, whose loads the walk cannot read"]);
	});

	it("answers a data file no edges and no fault", () => {
		const faults: string[] = [];
		expect(
			fileReach("/x/a.json", "{}", (m: string) => faults.push(m), null),
		).toEqual({
			edges: [],
			shadows: [],
			reads: [],
			unread: [],
			unknown: [],
			python: false,
			pySearch: null,
		});
		expect(faults).toEqual([]);
	});
});

/* #4790 pass 2 review, finding 1: scripts/host-root-byte-identity.test.ts
 * imported host_root inside `python3 -c`, so editing host_root.py left it
 * cached. */
describe("an interpreter handed its program inline", () => {
	const unseen = (code: string, file = "/x/a.test.ts") =>
		fileReach(file, code, () => undefined, null).unread;

	it.each([
		[
			'spawnSync("python3", ["-c", "import sys; sys.path.insert(0, sys.argv[1]); from host_root import host_root", LIB]);',
		],
		['spawnSync("python3", ["-I", "-c", CODE]);'],
		[
			`spawnSync(process.execPath, [\n\t"-e",\n\t\`require(\${JSON.stringify(p)})\`,\n]);`,
		],
		['spawnSync("node", ["--eval", "require(process.argv[1])", p]);'],
		['spawnSync("python3", ["-"], { input: code });'],
		['spawnSync("python3", ["-", "import sys"], { input: code });'],
		["execSync(`python3 -c 'import helper'`);"],
		/* #4790 pass 3 review, finding 2: an escape hid the load's line
		 * start, and one the reader does not undo hides the text. */
		['spawnSync("python3", ["-c", "import sys\\nimport host_root"]);'],
		[
			"spawnSync(process.execPath, [\"-e\", \"require('node:fs')\\nrequire('./x')\"]);",
		],
		['spawnSync("python3", ["-c", "import sys\\x0aimport host_root"]);'],
	])("names %s", (code) => {
		expect(unseen(code)).toHaveLength(1);
	});

	it.each([
		['spawnSync("git", ["-c", "user.name=t", "commit"]);'],
		['spawnSync("grep", ["-e", "x", file]);'],
		['spawnSync(process.execPath, ["-e", "setInterval(() => {}, 1000)", s]);'],
		[
			"spawnSync(process.execPath, [\"-e\", \"require('node:fs').writeFileSync(1, 'x')\"]);",
		],
		['spawnSync("python3", ["-c", "import sys; print(sys.argv[1])", x]);'],
		['spawnSync("python3", ["-c", "import sys\\nprint(1)"]);'],
		['spawnSync("python3", [script, "-c", "x"]);'],
		['// spawnSync("python3", ["-c", "import helper"]);'],
	])("lets pass %s, which loads no file", (code) => {
		expect(unseen(code)).toEqual([]);
	});

	/* #4790 pass 3 review, finding 4: the row of a builtin-only inline
	 * python must still rest on python3. */
	it("marks the reach of a Python spawn it lets pass as running python3", () => {
		expect(
			fileReach(
				"/x/a.test.ts",
				'spawnSync("python3", ["-c", "import sys"]);',
				() => undefined,
				null,
			).python,
		).toBe(true);
	});

	it("reads a Python list's spawn too", () => {
		expect(
			unseen(
				'subprocess.run([sys.executable, "-c", "import helper"])\n',
				"/x/t.py",
			),
		).toHaveLength(1);
	});
});

/* #4790 pass 3 review, finding 1: park-blocked.sh's `node -e` required
 * issue-hold.js off its argument, which no walk read, so
 * park-blocked.test.ts stayed cached after issue-hold.js changed. */
describe("a shell script's inline program", () => {
	const SelfDirLines = [
		`SELF_DIR="\${BASH_SOURCE[0]%/*}"`,
		`[[ "$SELF_DIR" == "\${BASH_SOURCE[0]}" ]] && SELF_DIR=.`,
		'SELF_DIR="$(cd "$SELF_DIR" && pwd)"',
	].join("\n");
	const sh = (code: string) =>
		fileReach("/x/s/park.sh", code, () => undefined, null);

	it("reaches the file a node program requires off an argument read as a path, as park-blocked.sh's", () => {
		const { unread, edges } = sh(
			[
				SelfDirLines,
				"printf '%s' \"$body\" | node -e '",
				"  const { readOwnHold } = require(process.argv[1]);",
				'\' "$SELF_DIR/lib/issue-hold.js" "$issue" 2>/dev/null',
			].join("\n"),
		);
		expect(unread).toEqual([]);
		expect(edges).toEqual(["/x/s/lib/issue-hold.js"]);
	});

	it.each([
		[
			`$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)/lib/c.js`,
			"/x/lib/c.js",
		],
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell text
		["${BASH_SOURCE[0]%/*}/c.js", "/x/s/c.js"],
	])("reads %s as a path", (arg, want) => {
		expect(sh(`node -p 'require(process.argv[1]).X' "${arg}"\n`).edges).toEqual(
			[want],
		);
	});

	it.each([
		[
			"an argument it cannot read as a path",
			`node -e 'require(process.argv[1])' "$UNSET/x.js"\n`,
		],
		[
			"a caller's $0",
			`node -e 'require(process.argv[1])' "$(dirname "$0")/x.js"\n`,
		],
		[
			"a variable set to two paths",
			`D="\${BASH_SOURCE[0]%/*}"\nD="/tmp"\nnode -e 'require(process.argv[1])' "$D/x.js"\n`,
		],
		["a double-quoted program", `node -e "require('./x')"\n`],
		["a relative load", `node -e 'require("./x")'\n`],
		["a Python program loading a module", `python3 -c 'import helper'\n`],
	])("names a spawn through %s unread", (_what, code) => {
		expect(sh(code).unread).toHaveLength(1);
	});

	/* The same review's sweep: 162 tests reached a script sourcing or
	 * running a sibling through `"$here/…"`, which no walk read. */
	it("reaches a code path spelled off a variable naming the file's directory", () => {
		expect(
			sh(
				[
					SelfDirLines,
					'source "$SELF_DIR/lib/guard-root.sh"',
					'lines="$(node "$SELF_DIR/lib/msg.js" "$f")"',
					'cfg="$(cd "$SELF_DIR/.." && pwd)/c.js"',
					'node "$cfg"',
				].join("\n"),
			).edges.sort(),
		).toEqual(["/x/c.js", "/x/s/lib/guard-root.sh", "/x/s/lib/msg.js"]);
	});

	it("skips a comment line", () => {
		expect(sh("# node -e 'require(x)'\n").unread).toEqual([]);
	});
});

/* #4790 pass 3 review round 3, finding 1: a load spelled off a variable the
 * walk dropped without a word. concision-backstop-sensitive.test.ts runs
 * code-signal.sh's `node "$CS_MATCHER"`, sensitive-paths.js, which no row
 * held; the rule since: a load word the walk cannot read is unread. */
describe("a shell script's loads", () => {
	const dirOf = (v: string) =>
		`${v}="\${BASH_SOURCE[0]%/*}"\n[[ "$${v}" == "\${BASH_SOURCE[0]}" ]] && ${v}=.`;
	const sh = (code: string, file = "/x/s/a.sh") =>
		fileReach(file, code, () => undefined, null);

	it.each([
		[
			"code-signal.sh's matcher, through `cd … 2>/dev/null && pwd` and an unset after",
			`${dirOf("_cs_dir")}\n_cs_dir="$(cd "$_cs_dir" 2>/dev/null && pwd)"\nCS_MATCHER="$_cs_dir/sensitive-paths.js"\nCS_ARBITER="\${_cs_dir%/*}/session-arbiter.js"\nunset _cs_dir\nf() {\n  node "$CS_MATCHER" --stdin 2>"$err"\n  node "$CS_ARBITER" own-paths\n}\n`,
			["/x/s/sensitive-paths.js", "/x/session-arbiter.js"],
		],
		[
			"review-agent-type.sh's guard root, sourced before its unset",
			`${dirOf("_rat_here")}\nif ! declare -F gr_root >/dev/null 2>&1; then\n  source "$_rat_here/guard-root.sh"\nfi\nunset _rat_here\n`,
			["/x/s/guard-root.sh"],
		],
		[
			"dispatch-sessions.sh's `here`, made absolute off $PWD",
			`${dirOf("here")}\n[[ "$here" == /* ]] || here="$PWD/$here"\nsource "$here/lib/interop-probe.sh" 2>/dev/null\n`,
			["/x/s/lib/interop-probe.sh"],
		],
		[
			"bg-run.sh's directory, through `cd … >/dev/null 2>&1 && pwd`",
			`${dirOf("SCRIPT_DIR")}\nSCRIPT_DIR="$(cd "$SCRIPT_DIR" >/dev/null 2>&1 && pwd)"\nsource "$SCRIPT_DIR/lib/guard-root.sh"\n`,
			["/x/s/lib/guard-root.sh"],
		],
		[
			"an inherited variable's default",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: shell text
			'hook="${WFC_TIER_HOOK:-${BASH_SOURCE[0]%/*}/d.js}"\nnode "$hook" --only x\n',
			["/x/s/d.js"],
		],
		[
			"a function running its arguments",
			`${dirOf("here")}\noutlive_live node "$here/sweep.js"\n`,
			["/x/s/sweep.js"],
		],
	])("reads %s", (_what, code, want) => {
		const reach = sh(code);
		expect(reach.unread).toEqual([]);
		expect([...reach.edges, ...reach.shadows]).toEqual(
			expect.arrayContaining(want),
		);
	});

	it.each([
		[
			"a variable unset before the load",
			`${dirOf("_h")}\nunset _h\nsource "$_h/g.sh"\n`,
		],
		[
			"a path off a command's output",
			'source "$(git rev-parse --show-toplevel)/a.sh"\n',
		],
		["a variable the walk cannot read", 'node "$UNSET/x.js"\n'],
		["a path built off an argument", 'node "$1/x.js"\n'],
		["a path relative to the working directory", "node scripts/x.js\n"],
		["a program on stdin", "printf x | node\n"],
		["a heredoc program", "python3 <<'EOF'\nimport helper\nEOF\n"],
		["a shell's command string", "bash -c 'source ./a.sh'\n"],
		["a module off python3's search path", "python3 -m helper\n"],
		["a function running an unread load", 'hb node "$UNSET/x.js"\n'],
		/* Finding 2: hook-bound.sh, precommit-gate.sh and relink-store.sh. A
		 * default naming the caller's $0, the working directory or an
		 * argument is no path the walk can read; the gate suites run the
		 * hooks in a throwaway repository. */
		[
			"hook-bound.sh's runner, off the caller's $0",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: shell text
			'hb_runner="$(cd "${WFC_PLUGIN_ROOT:-$(dirname "$0")/..}" 2>/dev/null && pwd)/scripts/lib/run-budgeted.js" || hb_runner=""\nhook_bound() { command node "$hb_runner" --hook "$@"; }\n',
		],
		[
			"precommit-gate.sh's formatters, off the working directory",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: shell text
			'node "${WFC_PLUGIN_ROOT:-.}/scripts/lib/formatters.js" shell-files\n',
		],
		[
			"relink-store.sh's script, off an argument",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: shell text
			'rs_script="${WFC_PLUGIN_ROOT:-$1}/scripts/session-checkout.js"\nnode "$rs_script" relink\n',
		],
	])("names %s unread", (_what, code) => {
		expect(sh(code).unread).toHaveLength(1);
	});

	it.each([
		["a load the caller hands in whole", 'node "$1"\n"$@"\n'],
		[
			"a command an inherited variable names",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: shell text
			'gh="${WFC_GH:-gh}"\n"$gh" api x\n',
		],
		[
			"a variable holding a command's name",
			'found=false\nfound=true\nif "$found"; then :; fi\n',
		],
		["a `case` pattern", 'case "$x" in\n  /*|"$y") echo hi ;;\nesac\n'],
		["a `[[` test", '[[ "$x" == /* &&\n  "$y" != "$z" ]] && echo hi\n'],
		["a heredoc's body", 'cat <<EOF\nsource "$X/a.sh"\nEOF\n'],
		["an array of data", "PROSE=(\n  . ':(exclude)*.js'\n)\n"],
		["arithmetic", "if (( $# > 0 )); then :; fi\n"],
		/* #4790: a definition's brackets may hold any run of blanks. */
		["a function defined with spaced brackets", "./x.sh (        ) { :; }\n"],
		/* #4790: the git shim's real git, found off PATH, is the caller's. */
		[
			"a program a `code-edges caller:` line declares found off PATH",
			'# code-edges caller: real\nfor d in $PATH; do real="$d/git"; done\n"$real" status\n',
		],
	])("reads %s as no load", (_what, code) => {
		expect(sh(code).unread).toEqual([]);
	});

	it("reads the real git off PATH as unread where no line declares it the caller's", () => {
		expect(
			sh('for d in $PATH; do real="$d/git"; done\n"$real" status\n').unread,
		).toHaveLength(1);
	});

	/* Found in round 4: an assignment after `then` or `do` bound nothing, so
	 * its variable read as inherited, the caller's, and its load dropped. */
	it("binds an assignment after `then` or `do`, so a load off it is read", () => {
		expect(
			sh('if c; then X="$PWD/a.sh"; fi\nsource "$X"\n').unread,
		).toHaveLength(1);
		const read = sh(`${dirOf("D")}\nif c; then X="$D/b.sh"; fi\nsource "$X"\n`);
		expect(read.unread).toEqual([]);
		expect(read.shadows).toEqual(["/x/s/b.sh"]);
	});

	/* #4790: a code path inside a message word is an edge, as
	 * park-blocked.sh's `refuse "… node $SELF_DIR/issue-body.js …"`. */
	it("reaches a code path a message spells inside a quoted word", () => {
		expect(
			sh(
				`${dirOf("D")}\nrefuse "run node $D/issue-body.js append, or \${BASH_SOURCE[0]%/*}/x.sh."\n`,
			).edges,
		).toEqual(["/x/s/issue-body.js", "/x/s/x.sh"]);
	});

	/* #4790: one interpreter table, so a versioned python3 is Python. */
	it("walks a script whose #! line names a versioned python3 as Python", () => {
		const faults: string[] = [];
		fileReach(
			"/x/hooks/run",
			"#!/usr/bin/env python3.12\nimport nosuchmod\n",
			(m: string) => faults.push(m),
			null,
		);
		expect(faults).toHaveLength(1);
	});

	it("walks a script with no extension by its #! line, as a git hook", () => {
		expect(
			sh('#!/usr/bin/env sh\nnode "$UNSET/x.js"\n', "/x/.husky/pre-commit")
				.unread,
		).toHaveLength(1);
	});

	/* #4790: a git hook is executed, never sourced, so its `$0` is itself. */
	it("reads `$0` as the file itself in a script with no extension alone", () => {
		const code =
			// biome-ignore lint/suspicious/noTemplateCurlyInString: shell text
			'#!/usr/bin/env sh\nnode "${WFC_ROOT:-$(dirname "$0")/..}/s/x.js"\n';
		const hook = sh(code, "/x/.husky/pre-commit");
		expect(hook.unread).toEqual([]);
		expect(hook.shadows).toEqual(["/x/s/x.js"]);
		expect(sh(code, "/x/.husky/pre-commit.sh").unread).toHaveLength(1);
	});

	it("names a `source` of a script with no extension unread", () => {
		expect(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: shell text
			sh('. "${BASH_SOURCE[0]%/*}/pre-commit"\n', "/x/.husky/lib.sh").unread,
		).toHaveLength(1);
	});

	/* #4790: a walk for edges alone must not need python3 to read a
	 * shell script's inline Python program. */
	it("reads a shell script's edges where no python3 is on PATH", () => {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ce-")));
		const probe = path.join(root, "probe.js");
		fs.writeFileSync(
			probe,
			`const { fileReach } = require(${JSON.stringify(require.resolve("./file-reach.js"))});\nprocess.stdout.write(JSON.stringify(fileReach("/x/s/a.sh", "python3 -c 'import sys'\\n", () => {}, null).edges));\n`,
		);
		/* spawn-kept: python3's version is read once per process, so a walk
		 * with no python3 on PATH needs a process that never read it. */
		const r = spawnSync(process.execPath, [probe], {
			encoding: "utf8",
			env: { PATH: root },
		});
		expect(r.stderr).toBe("");
		expect(JSON.parse(r.stdout)).toEqual([]);
	});
});

describe("a JS file's loads and reads (#4790 round 4)", () => {
	/** A tree holding `files` (path to text), and the reach of `lib/l.js` reading `code`. */
	function js(code: string, files: Record<string, string> = {}) {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ce-")));
		for (const [rel, text] of Object.entries({ ...files, "lib/l.js": code })) {
			fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
			fs.writeFileSync(path.join(root, rel), text);
		}
		const rel = (ps: string[]) => ps.map((p) => path.relative(root, p));
		const r = fileReach(
			path.join(root, "lib/l.js"),
			code,
			() => undefined,
			null,
		);
		return {
			edges: rel(r.edges),
			reads: rel(r.reads),
			unread: r.unread,
			unknown: r.unknown,
		};
	}

	/* #4790: a non-literal load is unread, never dropped. */
	it.each([
		[
			"a name bound to nothing it reads",
			"module.exports = (file) => require(file);\n",
		],
		["a call", 'require(path.join(dir, "x.js"));\n'],
		["a template", ["require(`./lib/$", "{name}`);\n"].join("")],
		["a spread", "const c = { ...require(file) };\n"],
		["a dynamic import", "await import(pathToFileURL(file).href);\n"],
		[
			"a template's interpolation, which is code",
			["const s = `$", "{require(file)}`;\n"].join(""),
		],
	])("names a load of %s unread", (_what, code) => {
		expect(js(code).unread).toHaveLength(1);
	});

	it.each([
		["a literal", 'require("./x.js");\n'],
		[
			"a const bound to a __dirname join",
			'const LIB = path.resolve(__dirname, "x.js");\nrequire(LIB);\n',
		],
		[
			"a const the caller names",
			"const MOD = process.env.WFC_MOD;\nrequire(MOD);\n",
		],
		["a const bound to a package name", 'const SDK = "ai";\nrequire(SDK);\n'],
		["a load inside a string", 'const RECORD = "require(process.argv[1])";\n'],
		["require.resolve", "require.resolve(name, { paths });\n"],
	])("reads a load of %s", (_what, code) => {
		expect(js(code).unread).toEqual([]);
	});

	/* #4790: a data file joined off __dirname is a read, any path binding. */
	it("reads a data file joined off __dirname, through any binding of path", () => {
		const r = js(
			'const M = nodePath.join(__dirname, "m.json");\nconst C = path.join(__dirname, "c.js");\nconst G = path.join(__dirname, "gone.json");\n',
			{ "lib/m.json": "{}", "lib/c.js": "" },
		);
		expect(r.reads).toEqual(["lib/m.json"]);
		expect(r.edges).toEqual(["lib/c.js"]);
	});

	/* #4790: guard-core-load.js's cores, off guard-cores.json. */
	it("reaches each script a declared manifest's key names, and reads the manifest", () => {
		const r = js(
			"// code-edges loads: m.json core\nconst load = (row) => require(corePath(row.core));\n",
			{
				"lib/m.json":
					'{"Pre": [{"core": "a.js"}, {"core": "b.js", "host": "h.js"}]}',
				"lib/a.js": "",
				"lib/b.js": "",
			},
		);
		expect(r).toEqual({
			edges: ["lib/a.js", "lib/b.js"],
			reads: ["lib/m.json"],
			unread: [],
			unknown: [],
		});
	});

	it("names a declared manifest that is no file, or will not parse, unread", () => {
		expect(js("// code-edges loads: m.json core\n").unread).toHaveLength(1);
		expect(
			js("// code-edges loads: m.json core\n", { "lib/m.json": "{" }).unread,
		).toHaveLength(1);
	});

	/* #4790: a declared value naming no file is unread, never dropped. */
	it("names a declared manifest value that is no file unread", () => {
		const r = js(
			"// code-edges loads: m.json core\nconst load = (row) => require(corePath(row.core));\n",
			{
				"lib/m.json": '[{"core": "a.js"}, {"core": "gone.js"}]',
				"lib/a.js": "",
			},
		);
		expect(r.unread).toEqual([
			"declares // code-edges loads: m.json core, whose gone.js is no file",
		]);
	});

	/* #4790: a declaration explains only the loads reading its key. */
	it("leaves a load its declaration does not explain unread", () => {
		const files = { "lib/m.json": '[{"core": "a.js"}]', "lib/a.js": "" };
		const declared = "// code-edges loads: m.json core\n";
		expect(
			js(`${declared}const file = corePath(row.core);\nrequire(file);\n`, files)
				.unread,
		).toEqual([]);
		expect(
			js(
				`${declared}require(corePath(row.core));\nconst extra = require(process.argv[9]);\n`,
				files,
			).unread,
		).toEqual(["loads require(process.argv[9])"]);
	});

	/* #4790: a path two joins off __dirname, as pretool-guard-testkit's
	 * DISPATCH off CHECKOUT, is an edge; a part bound to a literal is read. */
	it("reaches a file joined off a const bound to a __dirname join", () => {
		const r = js(
			'const ROOT = path.resolve(__dirname, "..");\nconst NAME = "d.js";\nconst D = path.join(ROOT, "s", NAME);\nconst J = path.join(\n\tROOT,\n\t"s",\n\t"j.json",\n);\n',
			{ "s/d.js": "", "s/j.json": "{}" },
		);
		expect(r.edges).toEqual(["s/d.js"]);
		expect(r.reads).toEqual(["s/j.json"]);
		expect(r.unknown).toEqual([]);
	});

	/* headless-run-fake.ts writes a script requiring such a join. */
	it("reaches a join inside a template's interpolation, which is code", () => {
		const r = js(
			[
				"const SRC = `require($",
				'{JSON.stringify(path.join(__dirname, "s.js"))})`;\n',
			].join(""),
			{ "lib/s.js": "" },
		);
		expect(r.edges).toEqual(["lib/s.js"]);
	});

	it.each([
		[
			"a parameter",
			'const ROOT = path.resolve(__dirname, "..");\nconst read = (f) => path.join(ROOT, f);\n',
		],
		[
			"a property",
			'spawn("node", [path.join(__dirname, "..", row.script)]);\n',
		],
		[
			"a template",
			["const at = path.join(__dirname, `$", "{name}.txt`);\n"].join(""),
		],
	])("names a join off __dirname holding %s unknown", (_what, code) => {
		expect(js(code).unknown).toHaveLength(1);
	});

	it.each([
		["a temporary directory", "const at = path.join(tmp, name);\n"],
		["a string", 'const SRC = "path.join(__dirname, name)";\n'],
		["an array's join", 'const s = parts.join(", ");\n'],
	])("reads a join off %s as none of the tree's", (_what, code) => {
		expect(js(code).unknown).toEqual([]);
	});

	/* claimed-bash-write-host.js's ledger writer. */
	it("reaches the file a listed node program requires off a __dirname-joined argument", () => {
		const r = js(
			'const STORE = path.join(__dirname, "s.js");\nconst RECORD = "require(process.argv[1]).f()";\nspawnSync(process.execPath, ["-e", RECORD, STORE, rel]);\n',
			{ "lib/s.js": "" },
		);
		expect(r.unread).toEqual([]);
		expect([...new Set(r.edges)]).toEqual(["lib/s.js"]);
	});
});
