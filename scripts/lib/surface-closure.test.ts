// @vitest-environment node
/*
 * surface-closure.test.ts — the render refuses a helper surface that does not
 * ship whole (#464): each edge kind lib/surface-closure.js follows, through
 * buildTree, so a refusal is the render's own. Each case renders a fixture
 * core under the system temp dir.
 *
 * `release-plugin.js` cuts every adopter's install from that render; loosen a
 * case and a release ships a helper surface missing a file it reaches, so an
 * adopter's checks that import through it fail on a missing module.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTree } from "./plugin-tree.js";

// Spelled in pieces: a `${…}` literal in a plain string trips Biome's template lint.
const DIRNAME = ['$(dirname "$', '{BASH_SOURCE[0]}")'].join("");
const STRIPPED = ["$", "{BASH_SOURCE[0]%/*}"].join("");

let tmp: string;
let root: string;
let out: string;
const write = (rel: string, body: string) => {
	fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
	fs.writeFileSync(path.join(root, rel), body);
};
const surface = (...entryPoints: string[]) =>
	write(
		"scripts/lib/helper-surface.json",
		JSON.stringify({
			entryPoints: Object.fromEntries(entryPoints.map((e) => [e, []])),
		}),
	);

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "surface-closure-"));
	root = path.join(tmp, "src");
	out = path.join(tmp, "out");
	write("self-plugin/hooks/hooks.json", JSON.stringify({ hooks: {} }));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("the render's helper-surface closure", () => {
	it("renders a surface whose every edge kind reaches a shipped file", () => {
		surface("scripts/lib/h.js", "scripts/lib/g.sh", "scripts/lib/p.py");
		write(
			"scripts/lib/h.js",
			[
				'const { dep } = require("./dep");',
				'const LAZY = path.join(__dirname, "..", "spawned.js");',
			].join("\n"),
		);
		write("scripts/lib/dep.js", 'require("node:fs");\n');
		write("scripts/spawned.js", "");
		write(
			"scripts/lib/g.sh",
			[`source "${DIRNAME}/one.sh"`, `node "${STRIPPED}/two.js"`].join("\n"),
		);
		write("scripts/lib/one.sh", "");
		write("scripts/lib/two.js", "");
		write(
			"scripts/lib/p.py",
			"import os, re\nfrom pathlib import Path\nfrom sib import x\n",
		);
		write("scripts/lib/sib.py", "import subprocess\n");
		buildTree(root, out);
		expect(fs.existsSync(path.join(out, "scripts/spawned.js"))).toBe(true);
	});

	it("refuses an entry point the render lacks, naming it and leaving no tree", () => {
		surface("scripts/lib/h.js");
		expect(() => buildTree(root, out)).toThrow(
			"helper surface: entry point scripts/lib/h.js is missing from the render",
		);
		expect(fs.existsSync(out)).toBe(false);
	});

	it("refuses a command the render lacks, and a file it reaches, naming each and what reached the file (#655)", () => {
		write(
			"scripts/lib/helper-surface.json",
			JSON.stringify({
				entryPoints: {},
				commands: { "scripts/c.js": { positionals: [], flags: [], exit: {} } },
			}),
		);
		expect(() => buildTree(root, out)).toThrow(
			"helper surface: command scripts/c.js is missing from the render",
		);
		write("scripts/c.js", 'require("./lib/typed");\n');
		write("scripts/lib/typed.ts", "export {};\n");
		expect(() => buildTree(root, out)).toThrow(
			"helper surface: scripts/lib/typed, reached from scripts/c.js, is missing from the render",
		);
	});

	it("refuses a file the closure reaches that the render leaves out, naming it and the file that reached it", () => {
		surface("scripts/lib/h.js");
		write("scripts/lib/h.js", 'require("./typed");\n');
		write("scripts/lib/typed.ts", "export {};\n");
		expect(() => buildTree(root, out)).toThrow(
			"helper surface: scripts/lib/typed, reached from scripts/lib/h.js, is missing from the render",
		);
	});

	it("refuses a missing file reached by a __dirname path or a shell sibling", () => {
		surface("scripts/lib/h.js", "scripts/lib/g.sh");
		write(
			"scripts/lib/h.js",
			'const A = path.join(__dirname, "..", "spawned.js");\n',
		);
		write("scripts/lib/g.sh", `source "${STRIPPED}/gone.sh"\n`);
		expect(() => buildTree(root, out)).toThrow(
			/scripts\/spawned\.js, reached from scripts\/lib\/h\.js[\s\S]*scripts\/lib\/gone\.sh, reached from scripts\/lib\/g\.sh/,
		);
	});

	it("follows no edge written on a comment line", () => {
		surface("scripts/lib/h.js", "scripts/lib/g.sh");
		write("scripts/lib/h.js", '// require("./gone");\n');
		write("scripts/lib/g.sh", `# source "${STRIPPED}/gone.sh"\n`);
		buildTree(root, out);
	});

	it("refuses a closure that requires an npm package, naming the file and the package", () => {
		surface("scripts/lib/h.js");
		write("scripts/lib/h.js", 'require("./dep.js");\n');
		write("scripts/lib/dep.js", 'require("left-pad");\n');
		expect(() => buildTree(root, out)).toThrow(
			"scripts/lib/dep.js requires the npm package left-pad",
		);
	});

	it("follows a relative, package and ;-joined Python import, and reads no docstring (#465)", () => {
		surface("scripts/lib/p.py");
		write(
			"scripts/lib/p.py",
			[
				'"""Import the helper before use."""',
				"from . import sib",
				"import os; from pkg.sub import y",
			].join("\n"),
		);
		write("scripts/lib/sib.py", "import sys\n");
		write("scripts/lib/pkg/__init__.py", "import yaml\n");
		expect(() => buildTree(root, out)).toThrow(
			/^helper surface: scripts\/lib\/pkg\/__init__\.py imports yaml, which is neither stdlib nor shipped beside it$/,
		);
		fs.rmSync(path.join(root, "scripts/lib/sib.py"));
		fs.writeFileSync(path.join(root, "scripts/lib/pkg/__init__.py"), "");
		expect(() => buildTree(root, out)).toThrow(
			"helper surface: scripts/lib/sib.py, reached from scripts/lib/p.py, is missing from the render",
		);
	});

	it("refuses a Python module neither stdlib nor beside its importer, naming both (#465)", () => {
		surface("scripts/lib/p.py");
		write("scripts/lib/p.py", "from sib import x\n");
		write("scripts/lib/sib.py", "import yaml\n");
		expect(() => buildTree(root, out)).toThrow(
			"helper surface: scripts/lib/sib.py imports yaml, which is neither stdlib nor shipped beside it",
		);
	});
});
