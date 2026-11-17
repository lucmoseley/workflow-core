// @vitest-environment node
/*
 * touched-tests.js's own suite: which tests a bare run selects
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
	/* `near.py`, imported relatively by `test_rel.py`. */
	"scripts/m/near.py": "W = 1\n",
	"scripts/m/test_rel.py": "from . import near\n",
	/* Reached by path, never imported: `run.py` as a subprocess,
	 * `sub/load.py` through `spec_from_file_location`. */
	"scripts/m/run.py": "print(1)\n",
	"scripts/m/test_run.py": 'SCRIPT = HERE / "run.py"\n',
	"scripts/m/sub/load.py": "Z = 1\n",
	"scripts/m/test_load.py": 'spec(HERE / "sub" / "load.py")\n',
	"scripts/elsewhere/run.py": "print(2)\n",
};
const EDGES = { "doc.md": ["doc.test.ts"] };

function repo(files: Record<string, string> = FILES) {
	const dir = mkScratchDir("touched-");
	dirs.push(dir);
	for (const [f, text] of Object.entries(files)) {
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

/* The three checker-only files (#4967), each with its checker tests and readers
 * that only read it as part of the tree: `bystander.test.ts` reads all three
 * and `notes.md`; `reader.test.ts` reads both anchors files and imports
 * `unit.js`; `test_anchors.py` names the instruction-surface anchors. */
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
	/* Built once, every case but those minting their own only reading it:
	 * popped, so `afterEach` leaves it for `afterAll`. */
	let tree: string;
	beforeAll(() => {
		tree = repo(CHECKER_ONLY_FILES);
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
		const dir = repo(CHECKER_ONLY_FILES);
		fs.writeFileSync(
			path.join(dir, "pytest.ini"),
			"[pytest]\npython_files = check_*.py\n",
		);
		const { leftOut, banner } = pick([SURFACE], { suite: "pytest" }, dir);
		expect(leftOut).toEqual([]);
		expect(banner).not.toContain("LEFT TO THE LANDER");
	});

	it("selects a checker-only file's readers as any other's in a tree holding none of its checker tests", () => {
		const { [COPIES]: _copies, ...withoutChecker } = CHECKER_ONLY_FILES;
		const { files, leftOut } = pick([MANIFEST], {}, repo(withoutChecker));
		expect(files).toEqual([BYSTANDER]);
		expect(leftOut).toEqual([]);
	});
});

/* A branch of two own commits past verified main, then a staged change: the
 * shape a commit gate's tree holds (#5320). Under `head` only the staged
 * paths are the session's; under `merge-base`, all three. */
describe("the base a touched selection takes (#5320)", () => {
	const git = (dir: string, ...args: string[]) =>
		execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
	const commit = (dir: string, file: string, message: string) => {
		fs.appendFileSync(path.join(dir, file), "// more\n");
		git(dir, "add", file);
		git(
			dir,
			"-c",
			"user.email=t@example.com",
			"-c",
			"user.name=t",
			"commit",
			"-qm",
			message,
		);
	};
	/** `files`' repo, verified main at its root, then `lib/a.js` and `doc.md`
	 * committed and `paths` staged. */
	function branch(paths: string[], files: Record<string, string> = FILES) {
		const dir = repo(files);
		git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
		commit(dir, "lib/a.js", "own one");
		commit(dir, "doc.md", "own two");
		for (const f of paths) {
			fs.appendFileSync(path.join(dir, f), "// staged\n");
			git(dir, "add", f);
		}
		return dir;
	}
	/* Built once for the cases that only read them: popped, so `afterEach`
	 * leaves them for `afterAll`. */
	let staged: string;
	let clean: string;
	beforeAll(() => {
		staged = branch(["lib/setup.js"]);
		clean = branch([]);
		dirs.splice(-2);
	});
	afterAll(() => {
		for (const d of [staged, clean])
			fs.rmSync(d, { recursive: true, force: true });
	});
	const at = (dir: string, from: "head" | "merge-base", options = {}) =>
		selectTouched(dir, {
			from,
			ownWork: null,
			loadEdges: () => EDGES,
			renderEdges: () => EDGES,
			...options,
		});

	it("selects under `head` only what the staged paths reach, and under `merge-base` what all three commits' paths reach", () => {
		const dir = staged;
		expect(at(dir, "head").files).toEqual(["lib/setup.test.ts"]);
		expect(at(dir, "merge-base").files).toEqual([
			"doc.test.ts",
			"lib/a.test.ts",
			"lib/setup.test.ts",
		]);
	});

	it("names the commit's changes over HEAD's short sha under `head`, and says the earlier commits answered for themselves", () => {
		const dir = staged;
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
		const dir = staged;
		const { base, banner } = at(dir, "merge-base");
		expect(banner).toContain(
			`TOUCHED TESTS ONLY — 3 test file(s) your own work since ${base.slice(0, 12)} edited, or that directly import or read a file it changed. The lander runs the full suite (#2930).`,
		);
	});

	it("takes an untracked file under `head`", () => {
		const dir = branch([]);
		fs.writeFileSync(path.join(dir, "lib/new.test.ts"), "export {};\n");
		expect(at(dir, "head").files).toEqual(["lib/new.test.ts"]);
	});

	it("gives the no-touched-tests line worded for the commit where nothing changed over HEAD", () => {
		const dir = clean;
		const head = git(dir, "rev-parse", "HEAD");
		const { files, banner } = at(dir, "head");
		expect(files).toEqual([]);
		expect(banner).toContain(
			`NO TOUCHED TESTS — no test file is edited, imports or reads a file this commit's changes over HEAD ${head.slice(0, 12)} changed, so nothing ran.`,
		);
	});

	it("keeps the checker-only rule under `head`: a staged checker-only file selects its checkers alone (#4967)", () => {
		const dir = repo(CHECKER_ONLY_FILES);
		git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
		commit(dir, "scripts/unit.js", "own one");
		fs.appendFileSync(path.join(dir, GUARD), "\n");
		git(dir, "add", GUARD);
		const { files, leftOut } = selectTouched(dir, {
			from: "head",
			loadEdges: () => CHECKER_ONLY_EDGES,
			renderEdges: () => CHECKER_ONLY_EDGES,
		});
		expect(files).toEqual(GUARD_CHECKERS);
		expect(leftOut).toEqual([BYSTANDER, READER]);
	});

	it("keeps the collection filter under `head`: a staged test the runner does not collect is named, not run (#2952)", () => {
		const dir = branch([], {
			...FILES,
			"pytest.ini": "[pytest]\npython_files = check_*.py\n",
		});
		fs.appendFileSync(path.join(dir, "scripts/m/test_scan.py"), "# staged\n");
		git(dir, "add", "scripts/m/test_scan.py");
		const { files, banner } = at(dir, "head", { suite: "pytest" });
		expect(files).toEqual([]);
		expect(uncollectedIn(banner)).toEqual(["scripts/m/test_scan.py"]);
		expect(banner).toContain("every test file this commit's changes over HEAD");
	});

	it("falls back to the staged paths' same-stem siblings alone under `head`", () => {
		const dir = branch(["lib/a.js"]);
		const { files, banner } = at(dir, "head", {
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

/* A merge of main into a branch, the commit's gate under `head` (#5334): the
 * branch committed `lib/a.js`'s first line, main `doc.md`. A merge answers
 * for its own content alone, never for main's incoming paths. */
describe("a merge's own content under `head` (#5334)", () => {
	const git = (dir: string, ...args: string[]) =>
		execFileSync(
			"git",
			["-c", "user.email=t@example.com", "-c", "user.name=t", ...args],
			{ cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
		).trim();
	const write = (dir: string, file: string, text: string) =>
		fs.writeFileSync(path.join(dir, file), text);
	const commitAll = (dir: string, message: string) => {
		git(dir, "add", "-A");
		git(dir, "commit", "-qm", message);
	};
	const branchA = { "lib/a.js": "ONE\ntwo\nthree\nfour\nfive\n" };
	const mainA = { "lib/a.js": "one\ntwo\nthree\nfour\nFIVE\n" };
	/** The branch checked out, main's `edits` committed on `main`, then
	 * `git merge --no-commit --no-ff main`; MERGE_HEAD as git leaves it, a
	 * conflict resolved to "resolved". Popped, so `afterEach` leaves it. */
	function merging(
		branchEdits: Record<string, string>,
		mainEdits: Record<string, string>,
	) {
		const dir = repo({
			...FILES,
			"lib/a.js": "one\ntwo\nthree\nfour\nfive\n",
		});
		dirs.pop();
		git(dir, "branch", "-M", "br");
		git(dir, "branch", "main");
		for (const [f, t] of Object.entries(branchEdits)) write(dir, f, t);
		commitAll(dir, "branch");
		git(dir, "checkout", "-q", "main");
		write(dir, "doc.md", "# doc, main's\n");
		for (const [f, t] of Object.entries(mainEdits)) write(dir, f, t);
		commitAll(dir, "main");
		git(dir, "checkout", "-q", "br");
		try {
			git(dir, "merge", "--no-commit", "--no-ff", "main");
		} catch {
			for (const f of Object.keys(mainEdits)) write(dir, f, "resolved\n");
			git(dir, "add", "-A");
		}
		return { dir, main: git(dir, "rev-parse", "main") };
	}
	/* Built once: main's paths disjoint from the branch's; `lib/a.js` changed
	 * on both sides and auto-merged; `lib/setup.js` conflicted and resolved;
	 * and the auto-merge again with no MERGE_HEAD, as pre-merge-commit runs
	 * before git writes it. */
	let disjoint: ReturnType<typeof merging>;
	let both: ReturnType<typeof merging>;
	let conflicted: ReturnType<typeof merging>;
	let premerge: ReturnType<typeof merging>;
	beforeAll(() => {
		disjoint = merging(branchA, { "lib/setup.js": "main\n" });
		both = merging(branchA, mainA);
		conflicted = merging(
			{ ...branchA, "lib/setup.js": "branch\n" },
			{ "lib/setup.js": "main\n" },
		);
		premerge = merging(branchA, mainA);
		fs.rmSync(path.join(premerge.dir, ".git", "MERGE_HEAD"));
	});
	afterAll(() => {
		for (const { dir } of [disjoint, both, conflicted, premerge])
			fs.rmSync(dir, { recursive: true, force: true });
	});
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

	it("selects no test that only main's incoming paths reach, and says so worded for the merge", () => {
		const { dir, main } = disjoint;
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
		const { changed, files, banner } = at(both.dir);
		expect(changed).toEqual(["lib/a.js"]);
		expect(files).toEqual(["lib/a.test.ts"]);
		expect(banner).toContain(
			"TOUCHED TESTS ONLY — 1 test file(s) this merge's own content over HEAD",
		);
	});

	it("selects a hand-resolved conflict's tests with MERGE_HEAD present, main-only paths adding nothing", () => {
		const { dir } = conflicted;
		expect(git(dir, "rev-parse", "-q", "--verify", "MERGE_HEAD")).not.toBe("");
		expect(at(dir).files).toEqual(["lib/setup.test.ts"]);
	});

	it("reads the parents off GITHEAD_<sha> where git has written no MERGE_HEAD yet, as pre-merge-commit sees them", () => {
		expect(at(premerge.dir, githead(premerge)).files).toEqual([
			"lib/a.test.ts",
		]);
	});

	it("falls back to the tree's changes over HEAD where no merge parent will read, with no crash", () => {
		const today = ["doc.test.ts", "lib/a.test.ts"];
		expect(at(premerge.dir).files).toEqual(today);
		const unread = at(both.dir, { WFC_MERGE_PARENTS: "no-sha" });
		expect(unread.files).toEqual(today);
		expect(unread.banner).not.toContain("merge");
		const gone = { WFC_MERGE_PARENTS: "f".repeat(40) };
		expect(at(both.dir, gone).files).toEqual(today);
	});

	it("leaves a `merge-base` run selecting every path since the merge base, main's included", () => {
		const { dir } = disjoint;
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
		/** The probe's selection, run as the commit gate runs its suite, with
		 * no merge parent in `env` but `extra`'s. */
		const gateRun = (dir: string, extra: NodeJS.ProcessEnv = {}) => {
			const env = { ...process.env };
			for (const k of Object.keys(env))
				if (k.startsWith("GITHEAD_") || k === "WFC_MERGE_PARENTS")
					delete env[k];
			const r = runInTree(dir, git(dir, "write-tree"), `node ${probe}`, {
				env: { ...env, ...extra },
			});
			expect(r.error).toBeNull();
			expect(r.status).toBe(0);
			const out = JSON.parse(r.output) as { cwd: string; changed: string[] };
			expect(out.cwd).not.toBe(dir);
			return out.changed;
		};

		it("takes the parents from MERGE_HEAD on a resolution commit", () => {
			expect(gateRun(conflicted.dir)).toEqual(["lib/setup.js"]);
		});

		it("takes the parents from GITHEAD_<sha> on pre-merge-commit's route", () => {
			expect(gateRun(premerge.dir, githead(premerge))).toEqual(["lib/a.js"]);
		});

		it("selects as today on an ordinary commit", () => {
			const dir = repo();
			write(dir, "doc.md", "# staged\n");
			git(dir, "add", "doc.md");
			expect(gateRun(dir)).toEqual(["doc.md"]);
		});
	});
});
