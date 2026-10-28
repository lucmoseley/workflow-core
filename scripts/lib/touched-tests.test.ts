// @vitest-environment node
/*
 * touched-tests.js's own suite: which tests a bare run under `landing` selects
 * from a session's changed paths (#2930), over a throwaway repo whose tests,
 * helpers and documents are known exactly.
 *
 * A loosened case either widens the bare run past the unit changed or drops a
 * test that reads it, unrun until the lander's full suite.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { mkScratchDir } from "./git-fixture";

const require = createRequire(import.meta.url);
const { selectTouched } = require("./touched-tests.js");

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length > 0)
		fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/* A unit `a.js` imported by `a.test.ts` and by a helper `h.js`, which
 * `chain.test.ts` imports in turn; `setup.js` imported for its side effect
 * by `setup.test.ts`; `doc.md` read by `doc.test.ts`. */
const FILES: Record<string, string> = {
	"lib/a.js": "module.exports = 1;\n",
	"lib/setup.js": "globalThis.x = 1;\n",
	"lib/setup.test.ts": 'import "./setup.js";\n',
	"lib/a.test.ts": 'import a from "./a.js";\n',
	"lib/a.extra.test.ts": "export {};\n",
	"lib/a.spec.ts": "export {};\n",
	"lib/h.js": 'module.exports = require("./a.js");\n',
	"lib/chain.test.ts": 'const h = require("./h.js");\n',
	"lib/other.test.ts": "export {};\n",
	"doc.md": "# doc\n",
	"doc.test.ts": "export {};\n",
	/* pytest's route (#2934): `scan.py` imported by `test_scan.py` and by a
	 * helper `wrap.py`, which `test_wrap.py` imports; `pkg/mod.py` imported
	 * as a submodule by `test_pkg.py`. */
	"scripts/m/scan.py": "X = 1\n",
	"scripts/m/scan.test.ts": "export {};\n",
	"scripts/m/test_scan.py": "import os, scan as s\n",
	"scripts/m/scan_test.py": "import os\n",
	"scripts/m/wrap.py": "import scan\n",
	"scripts/m/test_wrap.py": "from wrap import X\n",
	"scripts/m/test_other.py": "import os\n",
	"scripts/pkg/__init__.py": "",
	"scripts/pkg/mod.py": "Y = 1\n",
	"scripts/m/test_pkg.py": "from pkg import (mod,\n  other)\n",
	/* Reached by path, never imported: `run.py` as a subprocess,
	 * `sub/load.py` through `spec_from_file_location`. */
	"scripts/m/run.py": "print(1)\n",
	"scripts/m/test_run.py": 'SCRIPT = HERE / "run.py"\n',
	"scripts/m/sub/load.py": "Z = 1\n",
	"scripts/m/test_load.py": 'spec(HERE / "sub" / "load.py")\n',
	"scripts/elsewhere/run.py": "print(2)\n",
};
const EDGES = { "doc.md": ["doc.test.ts"] };

function repo() {
	const dir = mkScratchDir("touched-");
	dirs.push(dir);
	for (const [f, text] of Object.entries(FILES)) {
		fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
		fs.writeFileSync(path.join(dir, f), text);
	}
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: dir, stdio: "ignore" });
	git("init", "-q");
	git("add", ".");
	git(
		"-c",
		"user.email=t@example.com",
		"-c",
		"user.name=t",
		"commit",
		"-qm",
		"root",
	);
	return dir;
}

/* Built once for the cases that only read it. */
let shared: string;
beforeAll(() => {
	shared = repo();
	dirs.pop();
});
afterAll(() => fs.rmSync(shared, { recursive: true, force: true }));

interface Options {
	suite?: "vitest" | "pytest";
	loadEdges?: () => object;
	renderEdges?: () => object;
	execFn?: (...args: unknown[]) => unknown;
}

/** The selection with `changed` as the session's whole own work. */
const select = (dir: string, changed: string[], options: Options = {}) =>
	selectTouched(dir, {
		ownWork: { paths: changed, dropped: [], carriesUntracked: true },
		loadEdges: () => EDGES,
		renderEdges: () => EDGES,
		...options,
	});

/** The test files the banner lists as left uncollected. */
const uncollectedIn = (banner: string) => {
	const lines = banner.split("\n");
	const at = lines.findIndex((l) => l.startsWith("NOT COLLECTED"));
	if (at === -1) return [];
	const rest = lines.slice(at + 1);
	const end = rest.findIndex((l) => !l.startsWith("  "));
	return rest.slice(0, end === -1 ? undefined : end).map((l) => l.trim());
};

const failing = () => {
	throw new Error("render failed");
};

const resolve = (changed: string[], edges: () => object = () => EDGES) =>
	select(shared, changed, { loadEdges: edges, renderEdges: edges });

const resolvePy = (changed: string[], edges: () => object = () => EDGES) =>
	select(shared, changed, {
		suite: "pytest",
		loadEdges: edges,
		renderEdges: edges,
	});

describe("selectTouched", () => {
	it("selects an edited test", () => {
		const { files, banner } = resolve(["lib/other.test.ts"]);
		expect(files).toEqual(["lib/other.test.ts"]);
		expect(banner).not.toContain("FELL BACK");
		expect(uncollectedIn(banner)).toEqual([]);
	});

	it("selects a direct importer and excludes a transitive one", () => {
		const { files } = resolve(["lib/a.js"]);
		expect(files).toEqual(["lib/a.test.ts"]);
		expect(files).not.toContain("lib/chain.test.ts");
	});

	it("selects a bare side-effect importer", () => {
		expect(resolve(["lib/setup.js"]).files).toEqual(["lib/setup.test.ts"]);
	});

	it("selects the importers of a deleted module", () => {
		const dir = repo();
		fs.rmSync(path.join(dir, "lib/a.js"));
		expect(select(dir, ["lib/a.js"]).files).toEqual(["lib/a.test.ts"]);
	});

	it("selects a direct reader of a document off the manifest", () => {
		expect(resolve(["doc.md"]).files).toEqual(["doc.test.ts"]);
	});

	it("takes readers the tree renders beside the committed manifest", () => {
		const { files } = select(shared, ["doc.md"], {
			loadEdges: () => ({}),
		});
		expect(files).toEqual(["doc.test.ts"]);
	});

	it("falls back to edited tests and same-stem siblings, .spec. ones included, where the manifest will not render, and says so (#3012)", () => {
		const { files, banner } = resolve(["lib/a.js", "doc.test.ts"], failing);
		expect(files).toEqual([
			"doc.test.ts",
			"lib/a.extra.test.ts",
			"lib/a.spec.ts",
			"lib/a.test.ts",
		]);
		expect(banner).toMatch(/FELL BACK.*render failed/);
	});

	it("selects nothing where no test is edited, imports or reads a changed path", () => {
		expect(resolve(["README.md", "lib/gone.js"]).files).toEqual([]);
	});

	it("selects an edited pytest file on pytest's route, and no JS test", () => {
		const { files, banner } = resolvePy([
			"scripts/m/test_other.py",
			"lib/other.test.ts",
		]);
		expect(files).toEqual(["scripts/m/test_other.py"]);
		expect(banner).not.toContain("FELL BACK");
		expect(uncollectedIn(banner)).toEqual([]);
	});

	it("selects a pytest file importing a changed module, and excludes a transitive one", () => {
		const { files } = resolvePy(["scripts/m/scan.py"]);
		expect(files).toEqual(["scripts/m/test_scan.py"]);
		expect(files).not.toContain("scripts/m/test_wrap.py");
	});

	it("selects a pytest file importing a changed submodule from its package", () => {
		expect(resolvePy(["scripts/pkg/mod.py"]).files).toEqual([
			"scripts/m/test_pkg.py",
		]);
	});

	it("selects a pytest file naming a changed script by path, and none for a same-named script elsewhere", () => {
		expect(resolvePy(["scripts/m/run.py"]).files).toEqual([
			"scripts/m/test_run.py",
		]);
		expect(resolvePy(["scripts/m/sub/load.py"]).files).toEqual([
			"scripts/m/test_load.py",
		]);
		expect(resolvePy(["scripts/elsewhere/run.py"]).files).toEqual([]);
	});

	it("keeps pytest's lexical edges where the manifest will not render", () => {
		expect(
			resolvePy(["scripts/pkg/mod.py", "scripts/m/run.py"], failing).files,
		).toEqual(["scripts/m/test_pkg.py", "scripts/m/test_run.py"]);
	});

	it("falls back on pytest's route to test_<stem>.py and <stem>_test.py beside a changed <stem>.py (#3170)", () => {
		const { files, banner } = resolvePy(["scripts/m/scan.py"], failing);
		expect(files).toEqual(["scripts/m/scan_test.py", "scripts/m/test_scan.py"]);
		expect(banner).toMatch(/FELL BACK.*render failed/);
	});

	describe("keeps each route to what its runner collects (#2952)", () => {
		const Py = [
			"tools/test_x.py",
			"scripts/m/x_test.py",
			"scripts/.hidden/test_h.py",
			"scripts/m/test_other.py",
		];
		const pyRepo = (
			config: Record<string, string>,
			execFn?: Options["execFn"],
		) => {
			const dir = repo();
			for (const [f, text] of Object.entries(config))
				fs.writeFileSync(path.join(dir, f), text);
			for (const f of Py) {
				fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
				fs.writeFileSync(path.join(dir, f), "import os\n");
			}
			return select(dir, Py, {
				suite: "pytest",
				...(execFn ? { execFn } : {}),
			});
		};

		it.each([
			[
				"pytest.ini",
				"[pytest]\ntestpaths =\n  scripts\npython_files = test_*.py\n",
			],
			[
				"tox.ini",
				"[tox]\n[pytest]\ntestpaths = scr*\npython_files = test_*.py\n",
			],
			[
				"pyproject.toml",
				'[tool.pytest.ini_options]\ntestpaths = ["scripts"]\npython_files = "test_*.py"\n',
			],
		])(
			"drops a pytest file outside %s's testpaths, python_files or a default norecursedirs",
			(file, text) => {
				const { files, banner } = pyRepo({ [file]: text });
				expect(files).toEqual(["scripts/m/test_other.py"]);
				expect(banner).not.toContain("FELL BACK");
				expect(uncollectedIn(banner)).toEqual([
					"scripts/.hidden/test_h.py",
					"scripts/m/x_test.py",
					"tools/test_x.py",
				]);
			},
		);

		/* A directory at pytest.ini's path reads as EISDIR: present, unreadable. */
		it("throws where a pytest config is present but unreadable, never falling back to the defaults", () => {
			const dir = repo();
			fs.mkdirSync(path.join(dir, "pytest.ini"));
			expect(() =>
				select(dir, ["scripts/m/test_other.py"], { suite: "pytest" }),
			).toThrow(/EISDIR/);
		});

		it("reads pyproject.toml through the python WFC_PYTHON names", () => {
			const fake = "/opt/fake/python3";
			vi.stubEnv("WFC_PYTHON", fake);
			const ran: string[] = [];
			try {
				const { files } = pyRepo(
					{ "pyproject.toml": "[tool.pytest.ini_options]\n" },
					(cmd: unknown, args: unknown, opts: unknown) => {
						if (cmd !== fake)
							return execFileSync(
								cmd as string,
								args as string[],
								opts as object,
							);
						ran.push(cmd);
						return '{"testpaths": ["tools"]}';
					},
				);
				expect(ran).toEqual([fake]);
				expect(files).toEqual(["tools/test_x.py"]);
			} finally {
				vi.unstubAllEnvs();
			}
		});

		it("keeps every default-named pytest file where no config sets testpaths", () => {
			expect(pyRepo({}).files).toEqual([
				"scripts/m/test_other.py",
				"scripts/m/x_test.py",
				"tools/test_x.py",
			]);
		});

		/* Real `vitest list` over the repo's own install. */
		const vitestRepo = () => {
			const dir = repo();
			fs.symlinkSync(
				fileURLToPath(new URL("../../node_modules", import.meta.url)),
				path.join(dir, "node_modules"),
			);
			fs.writeFileSync(
				path.join(dir, "vitest.config.ts"),
				'export default { test: { exclude: ["**/node_modules/**", "lib/other.test.ts"] } };\n',
			);
			return dir;
		};

		it("drops a JS test vitest.config.ts excludes", () => {
			const { files, banner } = select(vitestRepo(), [
				"lib/other.test.ts",
				"lib/a.test.ts",
			]);
			expect(files).toEqual(["lib/a.test.ts"]);
			expect(banner).not.toContain("FELL BACK");
			expect(uncollectedIn(banner)).toEqual(["lib/other.test.ts"]);
		});

		it("throws, naming both causes, where the collection cannot be read in the fallback", () => {
			expect(() =>
				select(vitestRepo(), ["lib/a.test.ts"], {
					loadEdges: failing,
					execFn: () => {
						throw new Error("list failed");
					},
				}),
			).toThrow(/list failed.*render failed/);
		});
	});

	it("drops an edited test the disk no longer holds", () => {
		const dir = repo();
		fs.rmSync(path.join(dir, "lib/other.test.ts"));
		expect(select(dir, ["lib/other.test.ts"]).files).toEqual([]);
	});
});

describe("selectTouched's changed paths", () => {
	const edges = () => EDGES;

	/* An own set read as the overlay carries it already holds the session's
	 * new files: adding the tree's untracked ones would select a neighbour's
	 * test in this session's run (#2958). */
	it("adds no untracked file of the tree to an own set that carries its own (#2958)", () => {
		const dir = repo();
		fs.writeFileSync(path.join(dir, "scripts/m/test_new.py"), "import os\n");
		const { changed, files } = selectTouched(dir, {
			suite: "pytest",
			ownWork: {
				paths: ["scripts/m/scan.py"],
				dropped: [],
				carriesUntracked: true,
			},
			loadEdges: edges,
			renderEdges: edges,
		});
		expect(changed).toEqual(["scripts/m/scan.py"]);
		expect(files).not.toContain("scripts/m/test_new.py");
	});

	it("adds the tree's untracked files to an own set that does not carry them", () => {
		const dir = repo();
		fs.writeFileSync(path.join(dir, "scripts/m/test_new.py"), "import os\n");
		const { changed } = selectTouched(dir, {
			suite: "pytest",
			ownWork: { paths: ["scripts/m/scan.py"], dropped: [] },
			loadEdges: edges,
			renderEdges: edges,
		});
		expect(changed).toEqual(["scripts/m/scan.py", "scripts/m/test_new.py"]);
	});
});
