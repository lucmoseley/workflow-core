// @vitest-environment node
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
import { defineTemplate, mkScratchDir } from "./git-fixture";
import { keptSpawn } from "./kept-spawn.js";
import type { TouchedBase } from "./test-pass-marker.js";

const require = createRequire(import.meta.url);
const { selectTouched } = require("./touched-tests.js");
const { MERGE_PARENTS_ENV } = require("./merge-heads.js");
const { readUncovered } = require("./push-coverage.js");
const QUEUE_RUN = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"queue-run.js",
);

const git = (dir: string, ...args: string[]) =>
	execFileSync(
		"git",
		["-c", "user.email=t@example.com", "-c", "user.name=t", ...args],
		{ cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
	).trim();

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length > 0)
		fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

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
	"scripts/m/near.py": "W = 1\n",
	"scripts/m/test_rel.py": "from . import near\n",
	"scripts/m/run.py": "print(1)\n",
	"scripts/m/test_run.py": 'SCRIPT = HERE / "run.py"\n',
	"scripts/m/sub/load.py": "Z = 1\n",
	"scripts/m/test_load.py": 'spec(HERE / "sub" / "load.py")\n',
	"scripts/elsewhere/run.py": "print(2)\n",
};
const EDGES = { "doc.md": ["doc.test.ts"] };

const seeded = defineTemplate({
	files: (dir) => seed(dir, FILES),
	checkerOnly: (dir) => seed(dir, CHECKER_ONLY_FILES),
	withoutChecker: (dir) => {
		const { [COPIES]: _copies, ...withoutChecker } = CHECKER_ONLY_FILES;
		seed(dir, withoutChecker);
	},
});

function repo(
	variant: "files" | "checkerOnly" | "withoutChecker" = "files",
): string {
	const dir = mkScratchDir("touched-");
	dirs.push(dir);
	return seeded.instantiate(dir, variant);
}

function seed(dir: string, files: Record<string, string>) {
	for (const [f, text] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
		fs.writeFileSync(path.join(dir, f), text);
	}
	git(dir, "init", "-q");
	git(dir, "add", ".");
	git(dir, "commit", "-qm", "root");
}

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

const select = (dir: string, changed: string[], options: Options = {}) =>
	selectTouched(dir, {
		ownWork: { paths: changed, dropped: [], carriesUntracked: true },
		loadEdges: () => EDGES,
		renderEdges: () => EDGES,
		...options,
	});

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

	it("selects a pytest file importing a changed module relatively", () => {
		expect(resolvePy(["scripts/m/near.py"]).files).toEqual([
			"scripts/m/test_rel.py",
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
		});

		it("keeps every default-named pytest file where no config sets testpaths", () => {
			expect(pyRepo({}).files).toEqual([
				"scripts/m/test_other.py",
				"scripts/m/x_test.py",
				"tools/test_x.py",
			]);
		});

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

const GUARD = ".claude/guard-registry-anchors.json";
const MANIFEST = "docs/test-read-edges.json";
const SURFACE = "scripts/instruction-surface-anchors.json";
const GUARD_CHECKERS = [
	"scripts/check-guard-registry-carry.test.ts",
	"scripts/check-guard-registry.test.ts",
	"scripts/lib/registry-anchors-merge.test.ts",
];
const COPIES = "scripts/lib/generated-rule-copies.test.ts";
const SURFACE_CHECKER = "scripts/check-instruction-surface.test.ts";
const BYSTANDER = "scripts/bystander.test.ts";
const READER = "scripts/reader.test.ts";
const PY_READER = "scripts/test_anchors.py";
const CHECKER_ONLY_FILES: Record<string, string> = {
	[GUARD]: "{}\n",
	[MANIFEST]: "{}\n",
	[SURFACE]: "{}\n",
	...Object.fromEntries(
		[...GUARD_CHECKERS, COPIES, SURFACE_CHECKER, BYSTANDER].map((t) => [
			t,
			"export {};\n",
		]),
	),
	"scripts/unit.js": "module.exports = 1;\n",
	[READER]: 'import "./unit.js";\n',
	[PY_READER]: 'ANCHORS = HERE / "instruction-surface-anchors.json"\n',
	"notes.md": "# notes\n",
};
const CHECKER_ONLY_EDGES = {
	[GUARD]: [...GUARD_CHECKERS, BYSTANDER, READER],
	[MANIFEST]: [COPIES, BYSTANDER],
	[SURFACE]: [SURFACE_CHECKER, COPIES, BYSTANDER, READER],
	"notes.md": [BYSTANDER],
};

describe("a checker-only file selects its checker tests alone (#4967)", () => {
	let tree: string;
	beforeAll(() => {
		tree = repo("checkerOnly");
		dirs.pop();
	});
	afterAll(() => fs.rmSync(tree, { recursive: true, force: true }));

	const pick = (changed: string[], options: Options = {}, dir: string = tree) =>
		select(dir, changed, {
			loadEdges: () => CHECKER_ONLY_EDGES,
			renderEdges: () => CHECKER_ONLY_EDGES,
			...options,
		});

	it.each([
		[GUARD, GUARD_CHECKERS, [BYSTANDER, READER]],
		[MANIFEST, [COPIES], [BYSTANDER]],
		[SURFACE, [SURFACE_CHECKER, COPIES], [BYSTANDER, READER]],
	])(
		"%s changed alone selects only its checker tests and returns its other readers as left out",
		(file, checkers, readers) => {
			const { files, leftOut } = pick([file]);
			expect(files).toEqual(checkers);
			expect(leftOut).toEqual(readers);
		},
	);

	it("keeps a reader that also imports another changed path", () => {
		const { files, leftOut } = pick([GUARD, "scripts/unit.js"]);
		expect(files).toEqual([...GUARD_CHECKERS, READER]);
		expect(leftOut).toEqual([BYSTANDER]);
	});

	it("keeps a reader that also reads another changed path off the manifest", () => {
		const { files, leftOut } = pick([GUARD, "notes.md"]);
		expect(files).toEqual([BYSTANDER, ...GUARD_CHECKERS]);
		expect(leftOut).toEqual([READER]);
	});

	it("keeps a reader the session edited", () => {
		const { files, leftOut } = pick([GUARD, BYSTANDER]);
		expect(files).toEqual([BYSTANDER, ...GUARD_CHECKERS]);
		expect(leftOut).toEqual([READER]);
	});

	it("leaves out a reader of two checker-only files changed together, and keeps one's checker that reads the other", () => {
		const { files, leftOut } = pick([MANIFEST, SURFACE]);
		expect(files).toEqual([SURFACE_CHECKER, COPIES]);
		expect(leftOut).toEqual([BYSTANDER, READER]);
	});

	it("selects every reader of a path outside the table, leaving nothing out", () => {
		const { files, leftOut, banner } = pick(["notes.md", "scripts/unit.js"]);
		expect(files).toEqual([BYSTANDER, READER]);
		expect(leftOut).toEqual([]);
		expect(banner).not.toContain("LEFT TO THE LANDER");
	});

	it("selects no pytest file naming a checker-only file in a string literal by that file's change alone", () => {
		const { files, leftOut, banner } = pick([SURFACE], { suite: "pytest" });
		expect(files).toEqual([]);
		expect(leftOut).toEqual([PY_READER]);
		expect(banner).toContain("LEFT TO THE LANDER — 1 test file(s)");
		expect(banner).toMatch(/NO TOUCHED TESTS.*left to the lander/);
	});

	it("keeps that pytest file where the session edited it", () => {
		const { files, leftOut } = pick([SURFACE, PY_READER], {
			suite: "pytest",
		});
		expect(files).toEqual([PY_READER]);
		expect(leftOut).toEqual([]);
	});

	it("cuts nothing in the same-stem-sibling fallback: lexical readers and siblings stay selected", () => {
		const broken = { loadEdges: failing, renderEdges: failing };
		const py = pick([SURFACE], { suite: "pytest", ...broken });
		expect(py.files).toEqual([PY_READER]);
		expect(py.leftOut).toEqual([]);
		expect(py.banner).toContain("FELL BACK");
		expect(py.banner).not.toContain("LEFT TO THE LANDER");
		const js = pick([GUARD, "scripts/unit.js"], broken);
		expect(js.files).toEqual([READER]);
		expect(js.leftOut).toEqual([]);
	});

	it("says in one banner block how many tests were left out, which files would have selected them, and that the lander runs them", () => {
		const { banner } = pick([GUARD, MANIFEST, "scripts/unit.js"]);
		const blocks = banner
			.split("\n")
			.filter((l: string) => l.startsWith("LEFT TO THE LANDER"));
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toContain("1 test file(s)");
		expect(blocks[0]).toContain(`${GUARD}, ${MANIFEST}`);
		expect(blocks[0]).toMatch(/lander's full suite runs these/);
		expect(banner).toContain("TOUCHED TESTS ONLY");
	});

	it("counts no left-out test the runner does not collect", () => {
		const dir = repo("checkerOnly");
		fs.writeFileSync(
			path.join(dir, "pytest.ini"),
			"[pytest]\npython_files = check_*.py\n",
		);
		const { leftOut, banner } = pick([SURFACE], { suite: "pytest" }, dir);
		expect(leftOut).toEqual([]);
		expect(banner).not.toContain("LEFT TO THE LANDER");
	});

	it("selects a checker-only file's readers as any other's in a tree holding none of its checker tests", () => {
		const { files, leftOut } = pick([MANIFEST], {}, repo("withoutChecker"));
		expect(files).toEqual([BYSTANDER]);
		expect(leftOut).toEqual([]);
	});
});

describe("the base a touched selection takes (#5320)", () => {
	const commit = (dir: string, file: string, message: string) => {
		fs.appendFileSync(path.join(dir, file), "// more\n");
		git(dir, "add", file);
		git(dir, "commit", "-qm", message);
	};
	const branch =
		(
			paths: string[],
			files: Record<string, string> = FILES,
			own = ["lib/a.js", "doc.md"],
			edit = "// staged\n",
		) =>
		(dir: string) => {
			seed(dir, files);
			git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
			for (const f of own) commit(dir, f, `own ${f}`);
			for (const f of paths) {
				fs.appendFileSync(path.join(dir, f), edit);
				git(dir, "add", f);
			}
		};
	const fixture = defineTemplate({
		staged: branch(["lib/setup.js"]),
		clean: branch([]),
		stagedUnit: branch(["lib/a.js"]),
		uncollected: branch(
			["scripts/m/test_scan.py"],
			{ ...FILES, "pytest.ini": "[pytest]\npython_files = check_*.py\n" },
			undefined,
			"# staged\n",
		),
		checkerOnly: branch([GUARD], CHECKER_ONLY_FILES, ["scripts/unit.js"], "\n"),
	});
	const copy = (variant: string) => {
		const dir = mkScratchDir("touched-");
		dirs.push(dir);
		fixture.instantiate(dir, variant);
		return dir;
	};
	const at = (dir: string, from: TouchedBase, options = {}) =>
		selectTouched(dir, {
			from,
			ownWork: null,
			loadEdges: () => EDGES,
			renderEdges: () => EDGES,
			...options,
		});

	it("selects under `head` only what the staged paths reach, and under `merge-base` what all three commits' paths reach", () => {
		const dir = copy("staged");
		expect(at(dir, "head").files).toEqual(["lib/setup.test.ts"]);
		expect(at(dir, "merge-base").files).toEqual([
			"doc.test.ts",
			"lib/a.test.ts",
			"lib/setup.test.ts",
		]);
	});

	it("names the commit's changes over HEAD's short sha under `head`, and says the earlier commits answered for themselves", () => {
		const dir = copy("staged");
		const head = git(dir, "rev-parse", "HEAD");
		const { base, banner } = at(dir, "head");
		expect(base).toBe(head);
		expect(banner).toContain(
			`TOUCHED TESTS ONLY — 1 test file(s) this commit's changes over HEAD ${head.slice(0, 12)} edited`,
		);
		expect(banner).toContain(
			"The branch's earlier commits answered for themselves at their own commits, and the lander runs the full suite (#2930, #5320).",
		);
		expect(banner).not.toContain("your own work");
	});

	it("keeps the merge-base wording under `merge-base`", () => {
		const dir = copy("staged");
		const { base, banner } = at(dir, "merge-base");
		expect(banner).toContain(
			`TOUCHED TESTS ONLY — 3 test file(s) your own work since ${base.slice(0, 12)} edited, or that directly import or read a file it changed. The lander runs the full suite (#2930).`,
		);
	});

	it("takes an untracked file under `head`", () => {
		const dir = copy("clean");
		fs.writeFileSync(path.join(dir, "lib/new.test.ts"), "export {};\n");
		expect(at(dir, "head").files).toEqual(["lib/new.test.ts"]);
	});

	it("gives the no-touched-tests line worded for the commit where nothing changed over HEAD", () => {
		const dir = copy("clean");
		const head = git(dir, "rev-parse", "HEAD");
		const { files, banner } = at(dir, "head");
		expect(files).toEqual([]);
		expect(banner).toContain(
			`NO TOUCHED TESTS — no test file is edited, imports or reads a file this commit's changes over HEAD ${head.slice(0, 12)} changed, so nothing ran.`,
		);
	});

	it("keeps the checker-only rule under `head`: a staged checker-only file selects its checkers alone (#4967)", () => {
		const { files, leftOut } = selectTouched(copy("checkerOnly"), {
			from: "head",
			loadEdges: () => CHECKER_ONLY_EDGES,
			renderEdges: () => CHECKER_ONLY_EDGES,
		});
		expect(files).toEqual(GUARD_CHECKERS);
		expect(leftOut).toEqual([BYSTANDER, READER]);
	});

	it("keeps the collection filter under `head`: a staged test the runner does not collect is named, not run (#2952)", () => {
		const { files, banner } = at(copy("uncollected"), "head", {
			suite: "pytest",
		});
		expect(files).toEqual([]);
		expect(uncollectedIn(banner)).toEqual(["scripts/m/test_scan.py"]);
		expect(banner).toContain("every test file this commit's changes over HEAD");
	});

	it("falls back to the staged paths' same-stem siblings alone under `head`", () => {
		const { files, banner } = at(copy("stagedUnit"), "head", {
			loadEdges: failing,
			renderEdges: failing,
		});
		expect(files).toEqual([
			"lib/a.extra.test.ts",
			"lib/a.spec.ts",
			"lib/a.test.ts",
		]);
		expect(banner).toContain("FELL BACK");
	});
});

describe("a merge's own content under `head` (#5334)", () => {
	const write = (dir: string, file: string, text: string) =>
		fs.writeFileSync(path.join(dir, file), text);
	const writeAll = (dir: string, edits: Record<string, string>) => {
		for (const [f, t] of Object.entries(edits)) write(dir, f, t);
	};
	const commitAll = (dir: string, message: string) => {
		git(dir, "add", "-A");
		git(dir, "commit", "-qm", message);
	};
	const branchA = { "lib/a.js": "ONE\ntwo\nthree\nfour\nfive\n" };
	const mainA = { "lib/a.js": "one\ntwo\nthree\nfour\nFIVE\n" };
	const merging =
		(
			branchEdits: Record<string, string>,
			mainEdits: Record<string, string>,
			premerge = false,
		) =>
		(dir: string) => {
			seed(dir, { ...FILES, "lib/a.js": "one\ntwo\nthree\nfour\nfive\n" });
			git(dir, "branch", "-M", "br");
			git(dir, "branch", "main");
			writeAll(dir, branchEdits);
			commitAll(dir, "branch");
			git(dir, "checkout", "-q", "main");
			writeAll(dir, { "doc.md": "# doc, main's\n", ...mainEdits });
			commitAll(dir, "main");
			git(dir, "checkout", "-q", "br");
			try {
				git(dir, "merge", "--no-commit", "--no-ff", "main");
			} catch {
				for (const f of Object.keys(mainEdits)) write(dir, f, "resolved\n");
				git(dir, "add", "-A");
			}
			if (premerge) fs.rmSync(path.join(dir, ".git", "MERGE_HEAD"));
		};
	const fixture = defineTemplate({
		disjoint: merging(branchA, { "lib/setup.js": "main\n" }),
		both: merging(branchA, mainA),
		conflicted: merging(
			{ ...branchA, "lib/setup.js": "branch\n" },
			{ "lib/setup.js": "main\n" },
		),
		premerge: merging(branchA, mainA, true),
		pytest: merging(
			{ ...branchA, "scripts/m/scan.py": "X = 2\n" },
			{ "scripts/m/scan.py": "X = 3\n" },
		),
	});
	const copy = (variant: string) => {
		const dir = mkScratchDir("touched-");
		dirs.push(dir);
		fixture.instantiate(dir, variant);
		return { dir, main: git(dir, "rev-parse", "main") };
	};
	const at = (dir: string, env: NodeJS.ProcessEnv = {}) =>
		selectTouched(dir, {
			from: "head",
			env,
			loadEdges: () => EDGES,
			renderEdges: () => EDGES,
		});
	const githead = ({ main }: { main: string }) => ({
		[`GITHEAD_${main}`]: "main",
	});
	const unmerged = () => {
		const env = { ...process.env };
		for (const k of Object.keys(env))
			if (k.startsWith("GITHEAD_") || k === MERGE_PARENTS_ENV) delete env[k];
		return env;
	};

	it("selects no test that only main's incoming paths reach, and says so worded for the merge", () => {
		const { dir, main } = copy("disjoint");
		const head = git(dir, "rev-parse", "HEAD");
		const { changed, files, banner } = at(dir);
		expect(changed).toEqual([]);
		expect(files).toEqual([]);
		expect(banner).toContain(
			`NO TOUCHED TESTS — no test file is edited, imports or reads a file this merge's own content over HEAD ${head.slice(0, 12)} and the merged-in ${main.slice(0, 12)} changed, so nothing ran.`,
		);
		expect(banner).toContain(
			"Tests reading one side's change through the other's are left to the bare `npm run test` before landing, the push-coverage warning and the lander's full suite (#2930, #5334).",
		);
	});

	it("selects exactly the tests a file both sides changed and git auto-merged reaches", () => {
		const { changed, files, banner } = at(copy("both").dir);
		expect(changed).toEqual(["lib/a.js"]);
		expect(files).toEqual(["lib/a.test.ts"]);
		expect(banner).toContain(
			"TOUCHED TESTS ONLY — 1 test file(s) this merge's own content over HEAD",
		);
	});

	it("selects a hand-resolved conflict's tests with MERGE_HEAD present, main-only paths adding nothing", () => {
		const { dir } = copy("conflicted");
		expect(git(dir, "rev-parse", "-q", "--verify", "MERGE_HEAD")).not.toBe("");
		expect(at(dir).files).toEqual(["lib/setup.test.ts"]);
	});

	it("reads the parents off GITHEAD_<sha> where git has written no MERGE_HEAD yet, as pre-merge-commit sees them", () => {
		const premerge = copy("premerge");
		expect(at(premerge.dir, githead(premerge)).files).toEqual([
			"lib/a.test.ts",
		]);
	});

	it("takes the same merge content on pytest's route, naming only the nets that reach pytest", () => {
		const { changed, banner } = selectTouched(copy("pytest").dir, {
			from: "head",
			env: {},
			suite: "pytest",
			loadEdges: () => EDGES,
			renderEdges: () => EDGES,
		});
		expect(changed).toEqual(["scripts/m/scan.py"]);
		expect(banner).toContain("this merge's own content over HEAD");
		expect(banner).toContain(
			"Tests reading one side's change through the other's are left to the bare `npm run test:py` before landing and the lander's full suite (#2930, #5334).",
		);
	});

	it("falls back to the tree's changes over HEAD where no merge parent will read, with no crash", () => {
		const overHead = ["doc.test.ts", "lib/a.test.ts"];
		const premerge = copy("premerge");
		const both = copy("both");
		expect(at(premerge.dir).files).toEqual(overHead);
		expect(at(premerge.dir).banner).not.toContain("MERGE");
		const unread = at(both.dir, { [MERGE_PARENTS_ENV]: "no-sha" });
		expect(unread.files).toEqual(overHead);
		expect(unread.banner).toContain(
			`MERGE PARENTS UNREAD — ${MERGE_PARENTS_ENV} holds no list of shas: no-sha, so every change over HEAD is selected`,
		);
		const gone = { [MERGE_PARENTS_ENV]: "f".repeat(40) };
		expect(at(both.dir, gone).files).toEqual(overHead);
		expect(at(both.dir, gone).banner).toContain("MERGE PARENTS UNREAD");
		const handedUnread = at(both.dir, { [MERGE_PARENTS_ENV]: "unread: boom" });
		expect(handedUnread.files).toEqual(overHead);
		expect(handedUnread.banner).toContain(
			"MERGE PARENTS UNREAD — the committing checkout's merge parents would not read: boom",
		);
	});

	it("leaves a `merge-base` run selecting every path since the merge base, main's included", () => {
		const { dir } = copy("disjoint");
		git(dir, "update-ref", "refs/remotes/origin/main", "HEAD~1");
		expect(
			selectTouched(dir, {
				from: "merge-base",
				ownWork: null,
				env: {},
				loadEdges: () => EDGES,
				renderEdges: () => EDGES,
			}).files,
		).toEqual(["doc.test.ts", "lib/a.test.ts", "lib/setup.test.ts"]);
	});

	describe("selected in the gate's throwaway worktree, not the committing checkout", () => {
		const probeDir = mkScratchDir("touched-probe-");
		const probe = path.join(probeDir, "probe.js");
		fs.writeFileSync(
			probe,
			`const { selectTouched } = require(${JSON.stringify(require.resolve("./touched-tests.js"))});
const r = selectTouched(process.cwd(), { from: "head", loadEdges: () => ({}), renderEdges: () => ({}) });
process.stdout.write(JSON.stringify({ cwd: process.cwd(), changed: r.changed }));
`,
		);
		afterAll(() => fs.rmSync(probeDir, { recursive: true, force: true }));
		const { runInTree } = require("./isolated-worktree.js");
		const gateRun = (dir: string, extra: NodeJS.ProcessEnv = {}) => {
			const r = runInTree(dir, git(dir, "write-tree"), `node ${probe}`, {
				env: { ...unmerged(), ...extra },
			});
			expect(r.error).toBeNull();
			expect(r.status).toBe(0);
			const out = JSON.parse(r.output) as { cwd: string; changed: string[] };
			expect(out.cwd).not.toBe(dir);
			return out.changed;
		};

		it("takes the parents from MERGE_HEAD on a resolution commit", () => {
			expect(gateRun(copy("conflicted").dir)).toEqual(["lib/setup.js"]);
		});

		it("takes the parents from GITHEAD_<sha> on pre-merge-commit's route", () => {
			const premerge = copy("premerge");
			expect(gateRun(premerge.dir, githead(premerge))).toEqual(["lib/a.js"]);
		});

		it("keeps merge parents already handed to it over its checkout's own", () => {
			const premerge = copy("premerge");
			expect(
				gateRun(premerge.dir, { [MERGE_PARENTS_ENV]: premerge.main }),
			).toEqual(["lib/a.js"]);
		});

		it("selects the changes over HEAD on an ordinary commit", () => {
			const dir = repo();
			write(dir, "doc.md", "# staged\n");
			git(dir, "add", "doc.md");
			expect(gateRun(dir)).toEqual(["doc.md"]);
		});
	});

	it("hands the checkout's merge parents to an overlay a gate run in place moves into", () => {
		const probeDir = mkScratchDir("touched-probe-");
		dirs.push(probeDir);
		const probe = path.join(probeDir, "overlay-probe.js");
		fs.writeFileSync(
			probe,
			`const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { selectTouched } = require(${JSON.stringify(require.resolve("./touched-tests.js"))});
const overlay = process.argv[2];
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).split("\\n").filter(Boolean);
git("worktree", "add", "-q", "--detach", overlay, "HEAD");
for (const f of git("diff", "--name-only", "--diff-filter=d", "HEAD"))
	fs.copyFileSync(f, path.join(overlay, f));
for (const f of git("diff", "--name-only", "--diff-filter=D", "HEAD"))
	fs.rmSync(path.join(overlay, f));
for (const f of git("ls-files", "--others", "--exclude-standard")) {
	fs.mkdirSync(path.dirname(path.join(overlay, f)), { recursive: true });
	fs.copyFileSync(f, path.join(overlay, f));
}
const r = selectTouched(overlay, { from: "head", loadEdges: () => ({}), renderEdges: () => ({}) });
process.stdout.write(JSON.stringify(r.changed));
`,
		);
		const { dir } = copy("conflicted");
		const overlay = mkScratchDir("touched-overlay-");
		dirs.push(overlay);
		const tmp = mkScratchDir("touched-tmp-");
		dirs.push(tmp);
		const env = { ...unmerged(), CLAUDE_PROJECT_DIR: dir, TMPDIR: tmp };
		const r = keptSpawn("fd").spawnSync(
			process.execPath,
			[
				QUEUE_RUN,
				"--gate",
				"--tree",
				"4b825dc642cb6eb9a060e54bf8d69288fbee4904",
				"--",
				`node ${probe} ${overlay}`,
			],
			{ cwd: dir, env, encoding: "utf8" },
		);
		expect(r.status, r.stderr).toBe(0);
		expect(JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "")).toEqual([
			"lib/setup.js",
		]);
	});
});

describe("a touched selection over 120 collected files is bounded (#5878)", () => {
	const pad = (i: number) => String(i).padStart(3, "0");
	const R = (i: number) => `t/r${pad(i)}.test.ts`;
	const S = (i: number) => `f/s${pad(i)}.test.ts`;
	const P = (i: number) => `py/test_p${pad(i)}.py`;
	const span = (n: number, from = 0, name = R) =>
		Array.from({ length: n }, (_, i) => name(from + i));
	const Sibling = "z/unit.test.ts";
	const PySibling = "py/test_pbig.py";
	const Checker = "scripts/lib/generated-rule-copies.test.ts";
	const ByChecker = "x/bystander.test.ts";
	const BoundFiles: Record<string, string> = {
		"hub.md": "# hub\n",
		"hub2.md": "# hub2\n",
		"narrow.md": "# narrow\n",
		"z/unit.js": "module.exports = 1;\n",
		[Sibling]: "export {};\n",
		"lib/big.js": "module.exports = 1;\n",
		"py/pbig.py": "B = 1\n",
		[PySibling]: "import pbig\n",
		[MANIFEST]: "{}\n",
		[Checker]: "export {};\n",
		[ByChecker]: "export {};\n",
		...Object.fromEntries(span(130).map((t) => [t, "export {};\n"])),
		...Object.fromEntries(
			span(130, 0, S).map((t) => [t, 'import "../lib/big.js";\n']),
		),
		...Object.fromEntries(span(130, 0, P).map((t) => [t, "import pbig\n"])),
	};
	const fixture = defineTemplate((dir) => seed(dir, BoundFiles));
	let tree: string;
	beforeAll(() => {
		tree = mkScratchDir("touched-bound-");
		fixture.instantiate(tree);
	});
	afterAll(() => fs.rmSync(tree, { recursive: true, force: true }));

	const pick = (
		changed: string[],
		edges: Record<string, string[]>,
		options: Options = {},
	) =>
		select(tree, changed, {
			loadEdges: () => edges,
			renderEdges: () => edges,
			...options,
		});
	const boundLine = (banner: string) =>
		banner
			.split("\n")
			.filter((l) => l.startsWith("LEFT TO THE LANDER — this work selects"));

	it("runs a selection of exactly 120 unchanged, leaving nothing out", () => {
		const r = pick(["hub.md"], { "hub.md": span(120) });
		expect(r.files).toEqual(span(120));
		expect(r.leftOut).toEqual([]);
		expect(r.boundedFrom).toBeNull();
		expect(r.banner).not.toContain("LEFT TO THE LANDER");
	});

	it("keeps 120 of 121, leaves 1 to the lander, returns the pre-bound count and names all three counts in the banner", () => {
		const r = pick(["hub.md"], { "hub.md": span(121) });
		expect(r.files).toEqual(span(120));
		expect(r.leftOut).toEqual([R(120)]);
		expect(r.boundedFrom).toBe(121);
		expect(boundLine(r.banner)).toEqual([
			"LEFT TO THE LANDER — this work selects 121 test files, over the touched run's bound of 120; the 120 nearest the change run, and the lander's full suite runs the other 1 (#5878):",
		]);
		expect(r.banner).toContain(`\n  ${R(120)}\n`);
		expect(r.banner).toContain("TOUCHED TESTS ONLY — 120 test file(s)");
	});

	it("gives the same files for the same tree and diff whatever order the changed paths and their readers arrive in", () => {
		const r = pick(["hub.md", "narrow.md"], {
			"hub.md": span(130),
			"narrow.md": [R(129), R(64)],
		});
		expect(
			pick(["narrow.md", "hub.md"], {
				"narrow.md": [R(64), R(129)],
				"hub.md": span(130).reverse(),
			}).files,
		).toEqual(r.files);
		expect(r.files).toEqual([...span(119), R(129)]);
	});

	it("always keeps a test the session edited, where ranking would drop it", () => {
		const r = pick(["hub.md", R(129)], { "hub.md": span(130) });
		expect(r.files).toEqual([...span(119), R(129)]);
		expect(r.leftOut).toEqual(span(10, 119));
	});

	it("runs every edited test where they alone exceed 120, leaving every other selected file out, worded for that case", () => {
		const r = pick(["hub.md", ...span(125)], { "hub.md": span(130) });
		expect(r.files).toEqual(span(125));
		expect(r.leftOut).toEqual(span(5, 125));
		expect(r.boundedFrom).toBe(130);
		expect(boundLine(r.banner)).toEqual([
			"LEFT TO THE LANDER — this work selects 130 test files, over the touched run's bound of 120, and 125 of them are tests it edited, so all 125 of those run and the lander's full suite runs the other 5 (#5878):",
		]);
	});

	it("ranks a changed path's same-stem sibling above a test that only reads a changed path", () => {
		const r = pick(["hub.md", "z/unit.js"], {
			"hub.md": [...span(121), Sibling],
		});
		expect(r.files).toContain(Sibling);
		expect(r.leftOut).toEqual([R(119), R(120)]);
	});

	it("ranks a narrowly read path's reader above a hub's", () => {
		const r = pick(["hub.md", "narrow.md"], {
			"hub.md": span(130),
			"narrow.md": [R(129)],
		});
		expect(r.files).toContain(R(129));
		expect(r.leftOut).toEqual(span(10, 119));
	});

	it("breaks a specificity tie by the count of changed paths selecting a file, then by path", () => {
		const r = pick(["hub.md", "hub2.md"], {
			"hub.md": span(124),
			"hub2.md": span(124, 6),
		});
		expect(r.files).toEqual([...span(2), ...span(118, 6)]);
		expect(r.leftOut).toEqual([...span(4, 2), ...span(6, 124)]);
	});

	it("reports a checker-row cut and the bound as two lines, and unions both in leftOut", () => {
		const r = pick([MANIFEST, "hub.md"], {
			[MANIFEST]: [Checker, ByChecker],
			"hub.md": span(130),
		});
		expect(r.files).toEqual([Checker, ...span(119)]);
		expect(r.leftOut).toEqual([...span(11, 119), ByChecker]);
		expect(r.banner).toContain(
			`LEFT TO THE LANDER — 1 test file(s) that only ${MANIFEST} would select.`,
		);
		expect(boundLine(r.banner)).toHaveLength(1);
		expect(boundLine(r.banner)[0]).toContain("runs the other 11 (#5878)");
	});

	it("bounds the same-stem-sibling fallback", () => {
		const r = pick(
			["lib/big.js"],
			{},
			{ loadEdges: failing, renderEdges: failing },
		);
		expect(r.banner).toContain("FELL BACK");
		expect(r.files).toEqual(span(120, 0, S));
		expect(r.leftOut).toEqual(span(10, 120, S));
		expect(r.boundedFrom).toBe(130);
	});

	it("bounds and ranks a bare `npm run test:py` the same way, keeping its sibling-named test", () => {
		const r = pick(["py/pbig.py"], {}, { suite: "pytest" });
		expect(r.files).toEqual([...span(119, 0, P), PySibling]);
		expect(r.leftOut).toEqual(span(11, 119, P));
		expect(r.boundedFrom).toBe(131);
		expect(boundLine(r.banner)).toHaveLength(1);
	});

	describe("under `head` (#5320) and a merge's own content (#5334)", () => {
		let staged: string;
		beforeAll(() => {
			staged = mkScratchDir("touched-bound-");
			fixture.instantiate(staged);
			fs.appendFileSync(path.join(staged, "hub.md"), "more\n");
			git(staged, "add", "hub.md");
		});
		afterAll(() => fs.rmSync(staged, { recursive: true, force: true }));
		const at = (env: NodeJS.ProcessEnv) =>
			selectTouched(staged, {
				from: "head",
				env,
				loadEdges: () => ({ "hub.md": span(130) }),
				renderEdges: () => ({ "hub.md": span(130) }),
			});

		it("bounds the commit's changes over HEAD", () => {
			const { [MERGE_PARENTS_ENV]: _parents, ...env } = process.env;
			const r = at(env);
			expect(r.files).toEqual(span(120));
			expect(r.boundedFrom).toBe(130);
		});

		it("bounds a merge's own content", () => {
			const r = at({ [MERGE_PARENTS_ENV]: git(staged, "rev-parse", "HEAD") });
			expect(r.banner).toContain("this merge's own content");
			expect(r.files).toEqual(span(120));
			expect(r.leftOut).toEqual(span(10, 120));
		});
	});

	it("never lists a bounded-out file as uncovered on push", () => {
		const coverage = readUncovered(tree, {
			select: () => pick(["hub.md"], { "hub.md": span(130) }),
			look: (files: string[]) => ({ run: files, refused: [], notice: null }),
		});
		expect(coverage).toMatchObject({ touched: 120 });
		expect(coverage.files).not.toContain(R(125));
	});
});
