// @vitest-environment node
/*
 * The lexical read graph: which tracked files a test reaches at runtime, so a
 * change to one selects its readers (mantahostels#2031, mantahostels#2441, #157).
 *
 * The library is pure — a source string, a tracked set, a reader function — so
 * every branch is reachable in-process and none of it needs a git repo.
 *
 * `run-vitest.js` unions these edges into every bare `npm run test` and
 * `--changed` run, and a push is judged attested by those runs' certificates; loosen a case
 * and a changed document selects none of the tests that assert over it, which
 * then go unrun while the push reads attested.
 */

import { describe, expect, it } from "vitest";
import { buildManifest, testsReading } from "./test-read-edges.js";

/* Joined rather than written whole: spelling either path out here — in code OR
 * in a comment, which the pass also scans — would make this test a reader of
 * the real document in the generated manifest, which it is not. */
const DOC = ["docs", "doc-map.md"].join("/");
const CLAUDE = ["CLAUDE", "md"].join(".");
const tracked = new Set([
	DOC,
	CLAUDE,
	"scripts/a.test.ts",
	"scripts/b.test.ts",
]);

/** A separate tracked set for the hop-resolution cases, so it never adds an
 * unread test file to the plain `buildManifest` cases above. */
const withHelper = new Set([
	...tracked,
	"scripts/lib/helper.ts",
	"scripts/c.test.ts",
]);

/**
 * The tracked paths `buildManifest` records `self` as reading, where `self` is
 * a test file whose text is `source` and every other tracked file reads empty —
 * so no hop, own-module or spawned-script edge can join the direct reads.
 */
function readsOf(source: string, files: Set<string>, self: string): string[] {
	const { edges } = buildManifest(files, (p) => (p === self ? source : ""));
	return Object.keys(edges)
		.filter((p) => edges[p].includes(self))
		.sort();
}

describe("a test's direct reads", () => {
	it("records an edge when a repo-root anchor and a tracked literal are both present", () => {
		const src = `const p = path.join(ROOT, "${DOC}"); readFileSync(p);`;
		expect(readsOf(src, tracked, "scripts/a.test.ts")).toEqual([DOC]);
	});

	it("records nothing when the literal is a tempdir fixture with no anchor", () => {
		const src = `fs.writeFileSync(path.join(os.tmpdir(), "${DOC}"), body);`;
		expect(readsOf(src, tracked, "scripts/a.test.ts")).toEqual([]);
	});

	it("accepts each anchor spelling the repo actually uses", () => {
		for (const anchor of [
			'path.join(ROOT, "X")',
			'path.join(REPO, "X")',
			'path.join(repoRoot, "X")',
			'path.join(projectRoot, "X")',
			"process.cwd()",
			'path.resolve(__dirname, "..")',
		]) {
			const src = `${anchor}; read("${CLAUDE}");`;
			expect(readsOf(src, tracked, "scripts/a.test.ts")).toEqual([CLAUDE]);
		}
	});

	it("sorts its own return, so a reader list never depends on literal order", () => {
		/* Named in reverse order in the source. */
		const src = `process.cwd(); read("${DOC}"); read("${CLAUDE}");`;
		expect(readsOf(src, tracked, "scripts/a.test.ts")).toEqual([CLAUDE, DOC]);
	});

	it("never records a test as its own reader", () => {
		const src = `process.cwd(); read("scripts/a.test.ts"); read("${DOC}");`;
		expect(readsOf(src, tracked, "scripts/a.test.ts")).toEqual([DOC]);
	});

	it("ignores a literal that names no tracked file", () => {
		const src = `process.cwd(); read("docs/does-not-exist.md");`;
		expect(readsOf(src, tracked, "scripts/a.test.ts")).toEqual([]);
	});

	it("strips a leading ./ so both spellings reach the same key", () => {
		const src = `process.cwd(); read("./${DOC}");`;
		expect(readsOf(src, tracked, "scripts/a.test.ts")).toEqual([DOC]);
	});

	it("reads a literal in any of the three quote styles", () => {
		for (const q of ['"', "'", "`"]) {
			const src = `process.cwd(); read(${q}${DOC}${q});`;
			expect(readsOf(src, tracked, "scripts/a.test.ts")).toEqual([DOC]);
		}
	});
});

describe("a test's direct reads under __dirname", () => {
	/* The guard-test shape mantahostels#2433 found: the subject is named by bare filename,
	 * so it is tracked only under the test's own directory. Joined from
	 * fragments for the same reason DOC and CLAUDE are, above. */
	const guard = ["scripts", "guard-x.sh"].join("/");
	const parse = ["scripts", "lib", "guard-log.sh"].join("/");
	const helper = ["scripts", "lib", "helper.ts"].join("/");
	const siblings = new Set([...tracked, guard, parse, helper]);

	it("resolves a bare sibling name against the test's own directory", () => {
		const src = `const G = path.resolve(__dirname, "guard-x.sh");`;
		expect(readsOf(src, siblings, "scripts/a.test.ts")).toEqual([guard]);
	});

	it("resolves a name that descends from the test's directory", () => {
		const src = `path.resolve(__dirname, "lib/guard-log.sh");`;
		expect(readsOf(src, siblings, "scripts/a.test.ts")).toEqual([parse]);
	});

	it("anchors on a bare __dirname, with no .. climb to the repo root", () => {
		const src = `const G = path.join(__dirname, "guard-x.sh");`;
		expect(readsOf(src, siblings, "scripts/a.test.ts")).toEqual([guard]);
	});

	it("keeps the two anchors apart, so __dirname alone licenses no root edge", () => {
		/* Were a bare __dirname to license the ROOT pass too, every tempdir
		 * fixture beside one would become a false root edge (mantahostels#2433). */
		const src = `path.join(__dirname, "x"); writeFileSync(join(os.tmpdir(), "${DOC}"), body);`;
		expect(readsOf(src, siblings, "scripts/a.test.ts")).toEqual([]);
	});

	it("runs both passes when the source carries both anchors", () => {
		const src = `process.cwd(); read("${DOC}"); path.join(__dirname, "guard-x.sh");`;
		expect(readsOf(src, siblings, "scripts/a.test.ts")).toEqual([DOC, guard]);
	});

	it("does not exclude a sibling the test reaches by runtime require", () => {
		const src = `const h = require("./lib/helper.ts");\npath.resolve(__dirname, "lib/helper.ts");`;
		expect(readsOf(src, siblings, "scripts/a.test.ts")).toEqual([helper]);
	});

	it("resolves nothing against the directory when no __dirname is present", () => {
		const src = `process.cwd(); read("guard-x.sh");`;
		expect(readsOf(src, siblings, "scripts/a.test.ts")).toEqual([]);
	});

	it("never records the test as its own reader through the sibling path", () => {
		const src = `path.resolve(__dirname, "a.test.ts");`;
		expect(readsOf(src, siblings, "scripts/a.test.ts")).toEqual([]);
	});

	it("joins a run of literals composed across several arguments (mantahostels#2441)", () => {
		const src = `path.resolve(__dirname, "lib", "guard-log.sh");`;
		expect(readsOf(src, siblings, "scripts/a.test.ts")).toEqual([parse]);
	});

	it("resolves a composed run that climbs with .. before descending", () => {
		const src = `path.resolve(__dirname, "..", "${DOC}");`;
		expect(readsOf(src, siblings, "scripts/a.test.ts")).toEqual([DOC]);
	});

	it("resolves a composed run under the root anchor, not just __dirname", () => {
		/* A fictional path, not a real tracked file: this fixture's raw text
		 * would otherwise make THIS test file a false reader of whatever it
		 * names. */
		const nowhere = ["docs", "not-a-real-file.md"].join("/");
		const src = `process.cwd(); path.join(ROOT, "docs", "not-a-real-file.md");`;
		const many = new Set([...tracked, nowhere]);
		expect(readsOf(src, many, "scripts/a.test.ts")).toEqual([nowhere]);
	});

	it("ignores a composed run naming no tracked file", () => {
		const src = `path.resolve(__dirname, "no", "such-file.sh");`;
		expect(readsOf(src, siblings, "scripts/a.test.ts")).toEqual([]);
	});

	it("never reads an Array#join's comma run as a composed path", () => {
		/* A composed pass that fired on any comma run, rather than one gated
		 * on an actual `path.resolve`/`path.join` call, would defeat that
		 * (mantahostels#2441). */
		const src = `process.cwd(); const p = ["docs", "doc-map.md"].join("/");`;
		expect(readsOf(src, tracked, "scripts/a.test.ts")).toEqual([]);
	});

	it("mints no sibling edge for a file the test already imports", () => {
		/* An import specifier is a literal too. */
		const src = `import { f } from "./lib/helper.ts";\npath.join(__dirname, "x");`;
		expect(readsOf(src, siblings, "scripts/a.test.ts")).toEqual([]);
	});

	it("still mints the edge for a script it spawns rather than imports", () => {
		/* A .js named as a subprocess argument is in no import graph. */
		const src = `execFileSync("node", [path.resolve(__dirname, "lib/helper.ts")]);`;
		expect(readsOf(src, siblings, "scripts/a.test.ts")).toEqual([helper]);
	});

	it("keeps the edge when the only static import is type-only (#1223)", () => {
		/* vitest erases the type import, so only the require reaches it. */
		const src = `import type { H } from "./lib/helper.ts";\nconst h = require("./lib/helper.ts");\npath.join(__dirname, "x");`;
		expect(readsOf(src, siblings, "scripts/a.test.ts")).toEqual([helper]);
	});
});

describe("a test's direct reads under a directory-class call (#157)", () => {
	/* Fictional directory names throughout — a real one (e.g. "docs/agents/
	 * rules") would make THIS test file a true reader of it once the real
	 * generator scans this source. */
	const fdir = ["docs", "zzz-fixture-dir"].join("/");
	const ruleA = [fdir, "a.txt"].join("/");
	const ruleB = [fdir, "b.txt"].join("/");
	const other = ["docs", "zzz-fixture-other", "x.txt"].join("/");
	const dirTracked = new Set([ruleA, ruleB, other, "scripts/a.test.ts"]);

	it("attributes every tracked file under the directory a template literal's variable segment names", () => {
		const src = `process.cwd(); path.join(ROOT, "docs", "zzz-fixture-dir", \`\${id}.txt\`);`;
		expect(readsOf(src, dirTracked, "scripts/a.test.ts")).toEqual([
			ruleA,
			ruleB,
		]);
	});

	it("does not fire on a bare-variable final segment, only a template literal", () => {
		/* A bare variable is too often a single named file rather than a
		 * directory walk for a lexical pass to tell apart (#157). */
		const src =
			'process.cwd(); path.join(ROOT, "docs", "zzz-fixture-dir", file);';
		expect(readsOf(src, dirTracked, "scripts/a.test.ts")).toEqual([]);
	});

	it("resolves the directory against __dirname, not just the root anchor", () => {
		const siblingDir = new Set([
			...dirTracked,
			"scripts/zzz-sibling-dir/x.txt",
		]);
		const src = `path.join(__dirname, "zzz-sibling-dir", \`\${id}.txt\`);`;
		expect(readsOf(src, siblingDir, "scripts/a.test.ts")).toEqual([
			"scripts/zzz-sibling-dir/x.txt",
		]);
	});

	it("mints nothing for a directory that names no tracked file", () => {
		const src = `process.cwd(); path.join(ROOT, "docs", "zzz-no-such-dir", \`\${id}.txt\`);`;
		expect(readsOf(src, dirTracked, "scripts/a.test.ts")).toEqual([]);
	});

	it("mints nothing when the composed directory resolves outside the tree", () => {
		const src = `path.join(__dirname, "..", "..", "..", "zzz-outside", \`\${id}.txt\`);`;
		expect(readsOf(src, dirTracked, "scripts/a.test.ts")).toEqual([]);
	});

	it("excludes a swept file the test already imports, same as the sibling COMPOSED_CALL pass", () => {
		const siblingDir = new Set([
			...dirTracked,
			"scripts/zzz-sibling-dir/helper.ts",
			"scripts/zzz-sibling-dir/other.txt",
		]);
		const src = `import { f } from "./zzz-sibling-dir/helper.ts";\npath.join(__dirname, "zzz-sibling-dir", \`\${id}.txt\`);`;
		expect(readsOf(src, siblingDir, "scripts/a.test.ts")).toEqual([
			"scripts/zzz-sibling-dir/other.txt",
		]);
	});

	it("never records the reading test itself, even when it sits under the named directory", () => {
		const src = `process.cwd(); path.join(ROOT, "docs", "zzz-fixture-dir", \`\${id}.txt\`);`;
		const inside = [fdir, "x.test.ts"].join("/");
		expect(readsOf(src, new Set([...dirTracked, inside]), inside)).toEqual([
			ruleA,
			ruleB,
		]);
	});

	it("does not fire when every argument after the anchor is a plain literal", () => {
		/* That shape is COMPOSED_CALL's, naming one file rather than a directory. */
		const src =
			'process.cwd(); path.join(ROOT, "docs", "zzz-fixture-dir", "a.txt");';
		expect(readsOf(src, dirTracked, "scripts/a.test.ts")).toEqual([ruleA]);
	});
});

/* Both spelled in pieces: written whole, a call in a fixture below would make
 * THIS file a reader of whatever it lists once the real generator scans it. */
const READDIR = ["readdir", "Sync"].join("");
const LS_FILES = ["ls", "files"].join("-");

describe("a test's direct reads through a directory listing (#1770)", () => {
	const self = "scripts/zzz-list/a.test.ts";
	const listed = new Set([
		self,
		"scripts/zzz-list/guard-x.sh",
		"scripts/zzz-list/guard-y.js",
		"scripts/zzz-list/guard-y.test.ts",
		"scripts/zzz-list/notes.md",
		"scripts/zzz-list/sub/guard-z.sh",
		"scripts/zzz-other/guard-w.sh",
	]);
	const reads = (src: string) => readsOf(src, listed, self);

	it("lists a bare __dirname one level deep, never the test itself", () => {
		expect(reads(`fs.${READDIR}(__dirname);`)).toEqual([
			"scripts/zzz-list/guard-x.sh",
			"scripts/zzz-list/guard-y.js",
			"scripts/zzz-list/guard-y.test.ts",
			"scripts/zzz-list/notes.md",
		]);
	});

	it("traces a const through path.join to the directory it names, and keeps only what a chained .filter regex passes", () => {
		const src = [
			'const UP = path.join(__dirname, "..");',
			'const DIR = path.join(UP, "zzz-list");',
			`fs.${READDIR}(DIR).filter((f) => /^guard-.*\\.(js|sh)$/.test(f) && !f.includes(".test."));`,
		].join("\n");
		expect(reads(src)).toEqual([
			"scripts/zzz-list/guard-x.sh",
			"scripts/zzz-list/guard-y.js",
		]);
	});

	it("narrows on endsWith, and on a for-of loop's opening `if (!…) continue`", () => {
		expect(
			reads(`fs.${READDIR}(__dirname).filter((n) => n.endsWith(".sh"));`),
		).toEqual(["scripts/zzz-list/guard-x.sh"]);
		const loop = `process.cwd();\nfor (const f of fs.${READDIR}(path.join(ROOT, "scripts", "zzz-list"))) {\n\tif (!f.endsWith(".js")) continue;\n}`;
		expect(reads(loop)).toEqual(["scripts/zzz-list/guard-y.js"]);
	});

	it("narrows nothing on a filter holding ||, since its regex alone would under-include", () => {
		const src = `fs.${READDIR}(__dirname).filter((f) => /\\.sh$/.test(f) || f === "x");`;
		expect(reads(src)).toHaveLength(4);
	});

	it("narrows nothing on a filter it cannot read as a conjunction of tests, which would otherwise keep the inverse (#1770 review)", () => {
		for (const body of [
			'(f) => !(f.endsWith(".md"))',
			"(f) => !(/\\.md$/.test(f))",
			'(f) => f.endsWith(".md") === false',
			'(f) => { if (f.startsWith(".")) return false; return true; }',
		])
			expect(reads(`fs.${READDIR}(__dirname).filter(${body});`)).toHaveLength(
				4,
			);
	});

	it("reads only the tests made on the listed name, never one on another value", () => {
		expect(
			reads(
				`fs.${READDIR}(__dirname).filter((f) => process.env.X.includes("y"));`,
			),
		).toHaveLength(4);
		const loop = `for (const f of fs.${READDIR}(__dirname)) {\n\tif (!process.env.X.includes("y")) continue;\n}`;
		expect(reads(loop)).toHaveLength(4);
		const dirent = `fs.${READDIR}(__dirname, { withFileTypes: true }).filter((e) => e.name.endsWith(".sh"));`;
		expect(reads(dirent)).toEqual(["scripts/zzz-list/guard-x.sh"]);
	});

	it("descends into subdirectories only for a recursive listing", () => {
		const src = `fs.${READDIR}(__dirname, { recursive: true }).filter((f) => f.endsWith(".sh"));`;
		expect(reads(src)).toEqual([
			"scripts/zzz-list/guard-x.sh",
			"scripts/zzz-list/sub/guard-z.sh",
		]);
	});

	it("lists nothing for a directory that traces to no anchor, a tempdir fixture's shape", () => {
		const src = `const tmp = fs.mkdtempSync("x");\nfs.${READDIR}(path.join(tmp, "zzz-list"));\n__dirname;`;
		expect(reads(src)).toEqual([]);
	});
});

describe("a test's direct reads through git ls-files (#1770)", () => {
	const self = "scripts/a.test.ts";
	const files = new Set([
		self,
		"docs/zzz-specs/a.txt",
		"docs/zzz-specs/deep/b.txt",
		"docs/zzz-specs/c.md",
		"docs/zzz-specs/c.test.ts",
		"docs/zzz-elsewhere/d.txt",
	]);
	const reads = (src: string) => readsOf(src, files, self);

	it("lists a literal glob pathspec as git does, its * crossing /", () => {
		const src = `execFileSync("git", ["${LS_FILES}", "-z", "docs/zzz-specs/*.txt"], { cwd: ROOT });`;
		expect(reads(src)).toEqual([
			"docs/zzz-specs/a.txt",
			"docs/zzz-specs/deep/b.txt",
		]);
	});

	it("lists the literal each call passes for a pathspec parameter, a directory included", () => {
		const src = [
			"const ROOT = process.cwd();",
			"function shipped(spec: string, keep: (r: string) => boolean) {",
			`\treturn execFileSync("git", ["${LS_FILES}", spec], { cwd: ROOT });`,
			"}",
			'shipped("docs/zzz-elsewhere", () => true);',
			'shipped("docs/zzz-specs/*.md", (r) => r.length > 0);',
		].join("\n");
		expect(reads(src)).toEqual([
			"docs/zzz-elsewhere/d.txt",
			"docs/zzz-specs/c.md",
		]);
	});

	it("drops what an exclude pathspec names", () => {
		const src = `execFileSync("git", ["${LS_FILES}", "--", "docs/zzz-specs", ":!docs/zzz-specs/*.test.ts"], { cwd: ROOT });`;
		expect(reads(src)).toEqual([
			"docs/zzz-specs/a.txt",
			"docs/zzz-specs/c.md",
			"docs/zzz-specs/deep/b.txt",
		]);
	});

	it("lists nothing without a root anchor, or with no pathspec at all", () => {
		expect(
			reads(`execFileSync("git", ["${LS_FILES}", "docs/zzz-specs"]);`),
		).toEqual([]);
		expect(
			reads(`execFileSync("git", ["${LS_FILES}", "-z"], { cwd: ROOT });`),
		).toEqual([]);
	});
});

describe("resolving a test's import to the helper it hops through", () => {
	/**
	 * Which of `helpers` the import `spec` in `test` resolves to, read off the
	 * manifest: each helper reads a marker of its own, and a helper's reads are
	 * credited to the test importing it.
	 */
	function resolvedHelper(
		test: string,
		spec: string,
		helpers: string[],
		importOf = (s: string) => `require("${s}");`,
	): string | null {
		const marker = (h: string) => `${h}.read-marker`;
		const files: Record<string, string> = { [test]: importOf(spec) };
		for (const h of helpers) {
			files[h] = `process.cwd(); read("${marker(h)}");`;
			files[marker(h)] = "";
		}
		const { edges } = buildManifest(
			new Set(Object.keys(files)),
			(p) => files[p],
		);
		const hit = helpers.filter((h) => edges[marker(h)]?.includes(test));
		expect(hit.length).toBeLessThanOrEqual(1);
		return hit[0] ?? null;
	}

	const helperTs = "scripts/lib/helper.ts";

	it("resolves a same-directory specifier with no extension, trying .ts first", () => {
		expect(
			resolvedHelper("scripts/lib/a.test.ts", "./helper", [
				helperTs,
				"scripts/lib/helper.js",
			]),
		).toBe(helperTs);
	});

	it("follows a helper named in an ESM from-import", () => {
		expect(
			resolvedHelper(
				"scripts/c.test.ts",
				"./lib/helper",
				[helperTs],
				(s) => `import { f } from "${s}";\nf();`,
			),
		).toBe(helperTs);
	});

	it("resolves a specifier that descends into a subdirectory", () => {
		expect(
			resolvedHelper("scripts/c.test.ts", "./lib/helper", [helperTs]),
		).toBe(helperTs);
	});

	it("resolves a specifier that climbs a directory with ..", () => {
		expect(
			resolvedHelper("scripts/lib/deep/d.test.ts", "../helper", [helperTs]),
		).toBe(helperTs);
	});

	it("strips a TS-ESM .js specifier's extension to find the .ts source", () => {
		expect(
			resolvedHelper("scripts/c.test.ts", "./lib/helper.js", [helperTs]),
		).toBe(helperTs);
	});

	it("resolves nothing when nothing tracked matches any extension", () => {
		expect(
			resolvedHelper("scripts/c.test.ts", "./no-such-helper", [helperTs]),
		).toBeNull();
	});
});

describe("buildManifest", () => {
	const sources: Record<string, string> = {
		"scripts/a.test.ts": `process.cwd(); read("${DOC}"); read("${CLAUDE}");`,
		"scripts/b.test.ts": `read("${DOC}");`, // no anchor: a fixture, not a read
	};

	it("keys by document and lists only the anchored readers", () => {
		const { edges } = buildManifest(tracked, (p) => sources[p]);
		expect(edges[DOC]).toEqual(["scripts/a.test.ts"]);
		expect(edges[CLAUDE]).toEqual(["scripts/a.test.ts"]);
	});

	it("counts anchored test files against the total, for the render line", () => {
		const { anchored, tests } = buildManifest(tracked, (p) => sources[p]);
		expect({ anchored, tests }).toEqual({ anchored: 1, tests: 2 });
	});

	it("emits keys and readers sorted, so the file is byte-stable across runs", () => {
		const many = new Set([...tracked, "scripts/c.test.ts"]);
		const src = (p: string) =>
			p === "scripts/b.test.ts" ? sources[p] : `process.cwd(); read("${DOC}");`;
		const { edges } = buildManifest(many, src);
		expect(edges[DOC]).toEqual(["scripts/a.test.ts", "scripts/c.test.ts"]);
		expect(Object.keys(edges)).toEqual([...Object.keys(edges)].sort());
	});

	it("attributes a helper's read literal to a test that names no literal itself", () => {
		const withHop: Record<string, string> = {
			...sources,
			"scripts/lib/helper.ts": `process.cwd(); read("${CLAUDE}");`,
			"scripts/c.test.ts": `import { f } from "./lib/helper";\nf();`,
		};
		const { edges } = buildManifest(withHelper, (p) => withHop[p]);
		expect(edges[CLAUDE]).toEqual(["scripts/a.test.ts", "scripts/c.test.ts"]);
	});

	it("never lists the importing test as its own reader through a hop", () => {
		/* A harness naming the test paths it drives, beside an anchor, must not
		 * make the self-exclusion (pinned above for the direct path)
		 * fail to reach the test on the OTHER side of the hop. */
		const selfNaming: Record<string, string> = {
			"scripts/lib/helper.ts": `process.cwd(); read("scripts/c.test.ts");`,
			"scripts/c.test.ts": `import { f } from "./lib/helper";\nf();`,
		};
		const many = new Set(["scripts/lib/helper.ts", "scripts/c.test.ts"]);
		const { edges } = buildManifest(many, (p) => selfNaming[p]);
		expect(edges["scripts/c.test.ts"]).toBeUndefined();
	});

	it("takes no edge from a path a helper's comment cites (#2093)", () => {
		const citing: Record<string, string> = {
			"scripts/lib/helper.ts": `process.cwd();\n// "${CLAUDE}" §N8\n/* "${DOC}" */`,
			"scripts/c.test.ts": `import { f } from "./lib/helper";\nf();`,
		};
		const { edges } = buildManifest(withHelper, (p) => citing[p] ?? "");
		expect(edges[CLAUDE]).toBeUndefined();
		expect(edges[DOC]).toBeUndefined();
	});

	it("does not walk a second hop, so a helper's own helper reads nothing", () => {
		const twoHop: Record<string, string> = {
			"scripts/lib/helper.ts": `import { g } from "./inner";\ng();`,
			"scripts/lib/inner.ts": `process.cwd(); read("${CLAUDE}");`,
			"scripts/c.test.ts": `import { f } from "./lib/helper";\nf();`,
		};
		const many = new Set([
			CLAUDE,
			"scripts/lib/helper.ts",
			"scripts/lib/inner.ts",
			"scripts/c.test.ts",
		]);
		const { edges } = buildManifest(many, (p) => twoHop[p]);
		expect(edges[CLAUDE]).toBeUndefined();
	});
});

/* Fictional paths under scripts/zz/, so this file reads none of them. */
const T = "scripts/zz/t.test.ts";
const drives = (target: string) => `process.cwd(); load("${target}");`;
const build = (files: Record<string, string>) =>
	buildManifest(new Set(Object.keys(files)), (p) => files[p]);

describe("buildManifest's own-module edge (#1126)", () => {
	it("selects a test's same-named module loaded by a bare require", () => {
		const { edges } = build({
			"scripts/zz/x.test.ts": `const { f } = require("./x.js");`,
			"scripts/zz/x.js": "",
		});
		expect(edges["scripts/zz/x.js"]).toEqual(["scripts/zz/x.test.ts"]);
	});

	it("selects one loaded through createRequire", () => {
		const { edges } = build({
			"scripts/zz/x.test.ts": [
				"const req = createRequire(import.meta.url);",
				`const m = req("./x.cjs");`,
			].join("\n"),
			"scripts/zz/x.cjs": "",
		});
		expect(edges["scripts/zz/x.cjs"]).toEqual(["scripts/zz/x.test.ts"]);
	});

	it("selects a shell module the test only spawns", () => {
		const { edges } = build({
			"scripts/zz/x.test.ts": `spawnSync("bash", [script]);`,
			"scripts/zz/x.sh": "",
		});
		expect(edges["scripts/zz/x.sh"]).toEqual(["scripts/zz/x.test.ts"]);
	});

	it("selects a .spec.ts test's same-named module (#2545)", () => {
		const { edges } = build({
			"scripts/zz/x.spec.ts": `const { f } = require("./x.js");`,
			"scripts/zz/x.js": "",
		});
		expect(edges["scripts/zz/x.js"]).toEqual(["scripts/zz/x.spec.ts"]);
	});

	it("pairs only the same directory and the same stem", () => {
		const { edges } = build({
			"scripts/zz/x.test.ts": "",
			"scripts/x.js": "",
			"scripts/zz/xy.js": "",
		});
		expect(edges).toEqual({});
	});
});

describe("buildManifest over a spawned script's dependencies (#657, #1126)", () => {
	it("attributes none of a read script's dependencies that another test selects", () => {
		const { edges } = build({
			[T]: drives("scripts/zz/run.js"),
			"scripts/zz/run.js": `require("./lib/a");`,
			"scripts/zz/lib/a.js": `require("./b.js");`,
			"scripts/zz/lib/a.test.ts": `require("./a.js");`,
			"scripts/zz/lib/b.js": "",
			"scripts/zz/lib/c.test.ts": `import { f } from "./b.js";`,
		});
		expect(edges["scripts/zz/run.js"]).toEqual([T]);
		expect(edges["scripts/zz/lib/a.js"]).toEqual(["scripts/zz/lib/a.test.ts"]);
		expect(edges["scripts/zz/lib/b.js"]).toBeUndefined();
	});

	it("counts a bare side-effect import as selecting, but not a type-only one", () => {
		const { edges } = build({
			[T]: drives("scripts/zz/run.js"),
			"scripts/zz/run.js": `require("./lib/a");\nrequire("./lib/b");`,
			"scripts/zz/lib/a.js": "",
			"scripts/zz/lib/b.js": "",
			"scripts/zz/lib/c.test.ts": [
				`import "./a.js";`,
				`import type { B } from "./b.js";`,
			].join("\n"),
		});
		expect(edges["scripts/zz/lib/a.js"]).toBeUndefined();
		expect(edges["scripts/zz/lib/b.js"]).toEqual([T]);
	});

	it("keeps only the nearest readers of a file nothing else selects", () => {
		const U = "scripts/zz/u.test.ts";
		const { edges } = build({
			[T]: drives("scripts/zz/run.js"),
			[U]: drives("scripts/zz/other.js"),
			"scripts/zz/run.js": `require("./lib/a");`,
			"scripts/zz/other.js": `require("./lib/b");`,
			"scripts/zz/lib/a.js": `require("./b.js");`,
			"scripts/zz/lib/b.js": `require("./a");`, // a cycle terminates
		});
		expect(edges["scripts/zz/lib/a.js"]).toEqual([T]);
		expect(edges["scripts/zz/lib/b.js"]).toEqual([U]);
	});

	it("resolves source lines written through a directory variable", () => {
		const { edges, warnings } = build({
			[T]: drives("scripts/zz/guard.sh"),
			"scripts/zz/guard.sh": [
				`here="$(cd "$(dirname "$0")" && pwd)"`,
				`source "$here/lib/one.sh" 2>/dev/null`,
				`source "$(dirname "\${BASH_SOURCE[0]}")/lib/two.sh"`,
			].join("\n"),
			"scripts/zz/lib/one.sh": `source "\${BASH_SOURCE[0]%/*}/three.sh"`,
			"scripts/zz/lib/two.sh": "",
			"scripts/zz/lib/three.sh": "",
		});
		for (const lib of ["one", "two", "three"])
			expect(edges[`scripts/zz/lib/${lib}.sh`]).toEqual([T]);
		expect(warnings).toEqual([]);
	});

	it("resolves a hook's root-relative source", () => {
		const { edges } = build({
			[T]: drives(".husky/zz-hook"),
			".husky/zz-hook": ". ./scripts/zz/gate.sh",
			"scripts/zz/gate.sh": "",
		});
		expect(edges["scripts/zz/gate.sh"]).toEqual([T]);
	});

	it("warns on a source it cannot resolve rather than dropping it, naming the sourcing file and the source line", () => {
		const { warnings } = build({
			[T]: drives("scripts/zz/guard.sh"),
			"scripts/zz/guard.sh": `source "$here/lib/gone.sh"\nsource "$DYNAMIC"`,
		});
		expect(warnings).toEqual([
			'scripts/zz/guard.sh: source "$here/lib/gone.sh" resolves to no tracked file',
			'scripts/zz/guard.sh: source "$DYNAMIC" resolves to no tracked file',
		]);
	});

	it("resolves a real source opening a subshell's body", () => {
		const { edges } = build({
			[T]: drives("scripts/zz/guard.sh"),
			"scripts/zz/guard.sh": `(\n\t. "$here/lib/one.sh"\n)`,
			"scripts/zz/lib/one.sh": "",
		});
		expect(edges["scripts/zz/lib/one.sh"]).toEqual([T]);
	});

	it("still warns where the only -f naming the path is not a test", () => {
		const { warnings } = build({
			[T]: drives("scripts/zz/guard.sh"),
			"scripts/zz/guard.sh": `rm -f lib/gone.sh\nsource "$here/lib/gone.sh"`,
		});
		expect(warnings).toHaveLength(1);
	});

	it("stays silent on a -f-guarded optional source and a '.' array element", () => {
		const { warnings } = build({
			[T]: drives("scripts/zz/guard.sh"),
			"scripts/zz/guard.sh": [
				"if [ -f .husky/zz.local ]; then",
				"\t. ./.husky/zz.local",
				"fi",
				"PROSE=(",
				"\t. ':(exclude)*.js'",
				")",
			].join("\n"),
		});
		expect(warnings).toEqual([]);
	});

	it("gives a test driving a script what the script reads in code (#2093)", () => {
		const { edges } = build({
			[T]: drives("scripts/zz/run.js"),
			"scripts/zz/run.js": [
				`const ROOT = path.resolve(__dirname, "../..");`,
				`fs.readFileSync(path.join(ROOT, "docs/zz/a.md"));`,
				`fs.readFileSync("docs/zz/b.md");`,
				`// fs.readFileSync("docs/zz/c.md");`,
				`const NAMED = "docs/zz/d.md";`,
			].join("\n"),
			"docs/zz/a.md": "",
			"docs/zz/b.md": "",
			"docs/zz/c.md": "",
			"docs/zz/d.md": "",
		});
		expect(edges["docs/zz/a.md"]).toEqual([T]);
		expect(edges["docs/zz/b.md"]).toEqual([T]);
		expect(edges["docs/zz/c.md"]).toBeUndefined();
		expect(edges["docs/zz/d.md"]).toBeUndefined();
	});

	it("reads a shell script's path operands, never its comments, heredocs or prose", () => {
		/* Interpolated: a shell `${...}` written in a plain string trips
		 * Biome's noTemplateCurlyInString. */
		const Dollar = "$";
		const { edges } = build({
			[T]: drives("scripts/zz/run.sh"),
			"scripts/zz/run.sh": [
				`base="$root/docs/zz/a.md" # docs/zz/c.md`,
				"# cat docs/zz/c.md",
				"grep -q x docs/zz/b.md",
				`echo "see docs/zz/c.md for why"`,
				"cat <<'EOF'",
				"docs/zz/c.md",
				"EOF",
				`n=$# x=${Dollar}{#y} cat docs/zz/e.md`,
			].join("\n"),
			"docs/zz/a.md": "",
			"docs/zz/b.md": "",
			"docs/zz/c.md": "",
			"docs/zz/e.md": "",
		});
		expect(edges["docs/zz/a.md"]).toEqual([T]);
		expect(edges["docs/zz/b.md"]).toEqual([T]);
		expect(edges["docs/zz/e.md"]).toEqual([T]);
		expect(edges["docs/zz/c.md"]).toBeUndefined();
	});

	it("gives a script's read to no driving test where another test selects the file", () => {
		const U = "scripts/zz/u.test.ts";
		const { edges } = build({
			[T]: drives("scripts/zz/run.js"),
			[U]: `process.cwd(); read("docs/zz/a.md");`,
			"scripts/zz/run.js": `fs.readFileSync("docs/zz/a.md");`,
			"docs/zz/a.md": "",
		});
		expect(edges["docs/zz/a.md"]).toEqual([U]);
	});

	it("gives a script's own test nothing the script reads", () => {
		const { edges } = build({
			"scripts/zz/x.test.ts": `spawnSync("node", [script]);`,
			"scripts/zz/x.js": `fs.readFileSync("docs/zz/a.md");`,
			"docs/zz/a.md": "",
		});
		expect(edges["docs/zz/a.md"]).toBeUndefined();
	});

	it("follows nothing from a file the test reads that is not a script", () => {
		const { edges } = build({
			[T]: drives("scripts/zz/notes.md"),
			"scripts/zz/notes.md": `require("./lib/a");`,
			"scripts/zz/lib/a.js": "",
		});
		expect(edges["scripts/zz/lib/a.js"]).toBeUndefined();
	});
});

/* Joined for the reason DOC is, and the fixture test sits in scripts/ so its
 * "./lib/rule-text" resolves under scripts/lib/lib/ when this file is scanned. */
const RULE_TEXT = ["scripts/lib", "rule-text.js"].join("/");
const FRAGMENT = ["docs/agents/rules", "x.txt"].join("/");
const R = "scripts/r.test.ts";
const LOADS = `const { readRuleText } = require("./lib/rule-text");\n`;
const CARRIES =
	"const carries = (id, clause) => expect(readRuleText(id)).toContain(clause);\n";
const fragmentReaders = (src: string) =>
	buildManifest(new Set([R, RULE_TEXT, FRAGMENT]), (p) => (p === R ? src : ""))
		.edges[FRAGMENT];

describe("buildManifest over a rule id read through readRuleText (#1296)", () => {
	it("selects the fragment a wrapper forwarding to readRuleText names", () => {
		expect(
			fragmentReaders(`${LOADS}${CARRIES}carries("x", "a clause");`),
		).toEqual([R]);
	});

	it("selects it under the rule: prefix and a createRequire load", () => {
		const load = `createRequire(__filename)("./lib/rule-text.js");\n`;
		expect(fragmentReaders(`${load}readRuleText("rule:x");`)).toEqual([R]);
	});

	it("selects nothing for an id naming no tracked fragment", () => {
		expect(
			fragmentReaders(`${LOADS}${CARRIES}carries("y", "a clause");`),
		).toBeUndefined();
	});

	it("selects nothing in a test that never loads rule-text", () => {
		expect(
			fragmentReaders(`${CARRIES}carries("x", "a clause");`),
		).toBeUndefined();
	});
});

describe("buildManifest over a patch a test reads (#3206)", () => {
	const fix = "scripts/fixes/x.patch";
	const reader = "scripts/a.test.ts";
	const files = new Set([...tracked, fix, "scripts/x.js", "scripts/x.test.ts"]);
	/** What `reader` reads when it reads a patch holding `patch`. */
	const readsWith = (patch: string) => {
		const text: Record<string, string> = {
			[reader]: `const ROOT = "."; read(ROOT, "${fix}");`,
			[fix]: patch,
		};
		const { edges } = buildManifest(files, (p) => text[p] ?? "");
		return Object.keys(edges)
			.filter((p) => edges[p].includes(reader))
			.sort();
	};

	it("selects the reader on an edit to a file the patch's headers name", () => {
		expect(
			readsWith(
				"--- a/scripts/x.js\n+++ b/scripts/x.js\n@@ -1 +1 @@\n-a\n+b\n" +
					"--- b/scripts/x.test.ts\t2026-01-01\n+++ a/scripts/x.test.ts\n",
			),
		).toEqual([fix, "scripts/x.js", "scripts/x.test.ts"]);
	});

	it("mints nothing for /dev/null or a header naming no tracked file", () => {
		expect(readsWith("--- /dev/null\n+++ b/scripts/gone.js\n")).toEqual([fix]);
	});
});

describe("testsReading", () => {
	const edges = {
		[DOC]: ["scripts/a.test.ts"],
		[CLAUDE]: ["scripts/a.test.ts", "scripts/b.test.ts"],
	};

	it("unions the readers of every changed path, without duplicates", () => {
		expect(testsReading([DOC, CLAUDE], edges)).toEqual([
			"scripts/a.test.ts",
			"scripts/b.test.ts",
		]);
	});

	it("returns nothing for a changed path no test reads", () => {
		expect(testsReading(["lib/unread.ts"], edges)).toEqual([]);
	});
});

describe("buildManifest's unseen read sites (#1881)", () => {
	const self = "scripts/a.test.ts";
	/* Built from DOC, never spelled: a quoted directory or file here would
	 * make this test a reader of it in the real manifest. */
	const [dir, file] = DOC.split("/");
	const anchored = 'const ROOT = path.resolve(__dirname, "..");\n';
	const fullSweep =
		"/*\n * full-sweep-only: reads a set built at runtime.\n */\n";

	function sitesOf(body: string): { line: number; shape: string }[] {
		const { unseen } = buildManifest(tracked, (p) => (p === self ? body : ""), {
			sites: true,
		});
		return unseen[self] ?? [];
	}

	const shapes: { shape: string; unseen: string; literal: string }[] = [
		{
			shape: "a path segment held in `f`",
			unseen: `const f = pick();\nfs.readFileSync(path.join(ROOT, "${dir}", f));`,
			literal: `fs.readFileSync(path.join(ROOT, "${dir}", "${file}"));`,
		},
		{
			shape: "a template literal with an interpolation it cannot resolve",
			unseen: `fs.readFileSync(\`\${ROOT}/${dir}/\${name}.md\`);`,
			literal: `fs.readFileSync(path.join(ROOT, "${DOC}"));`,
		},
		{
			shape: "a spread argument",
			unseen:
				"const parts = pick();\nfs.readFileSync(path.join(ROOT, ...parts));",
			literal: `fs.readFileSync(path.join(ROOT, "${dir}", "${file}"));`,
		},
		{
			shape: "a computed path argument",
			unseen: "fs.readFileSync(path.join(ROOT, cfg.file));",
			literal: `fs.readFileSync(path.join(ROOT, "${dir}", "${file}"));`,
		},
		{
			shape: "a path composed through a declared name",
			unseen: `const DOCS = path.join(ROOT, "${dir}");\nfs.readFileSync(path.join(DOCS, "${file}"));`,
			literal: `fs.readFileSync(path.join(ROOT, "${dir}", "${file}"));`,
		},
		{
			shape: "a listing whose directory it cannot trace",
			unseen: `const SUB = "${dir}";\nconst D = path.join(ROOT, SUB);\nfs.readdirSync(D);`,
			literal: `fs.readdirSync(path.join(ROOT, "${dir}"));`,
		},
		{
			shape: "a path run spread across an array `join` or `+`",
			unseen: `fs.readFileSync([ROOT, "${dir}", name].join("/"));`,
			literal: `fs.readFileSync(path.join(ROOT, "${dir}", "${file}"));`,
		},
		{
			shape: "a `git ls-files` pathspec that is not a literal",
			unseen: 'execFileSync("git", ["ls-files", spec()]);',
			literal: `execFileSync("git", ["ls-files", "${dir}"]);`,
		},
		{
			shape: "a `git ls-files` naming no pathspec, the whole tree",
			unseen: 'execFileSync("git", ["ls-files", "-z"]);',
			literal: `execFileSync("git", ["ls-files", "-z", "${dir}"]);`,
		},
	];

	for (const { shape, unseen, literal } of shapes) {
		describe(shape, () => {
			it("is reported, on the read's own line", () => {
				const body = `${anchored}${unseen}`;
				expect(sitesOf(body)).toEqual([
					{ line: body.split("\n").length, shape },
				]);
			});

			it("is not reported for a literal read of the same kind", () => {
				expect(sitesOf(`${anchored}${literal}`)).toEqual([]);
			});

			it("is not reported under a full-sweep-only header", () => {
				expect(sitesOf(`${fullSweep}${anchored}${unseen}`)).toEqual([]);
			});
		});
	}

	it("reports a path run spread across a + chain from an anchor", () => {
		const body = `${anchored}fs.readFileSync(ROOT + "/${dir}/" + name);`;
		expect(sitesOf(body).map((s) => s.shape)).toEqual([
			"a path run spread across an array `join` or `+`",
		]);
	});

	it("reports nothing for a read rooted in a tempdir rather than an anchor", () => {
		const body = `${anchored}const dir = fs.mkdtempSync(os.tmpdir());\nfs.readFileSync(path.join(dir, name));`;
		expect(sitesOf(body)).toEqual([]);
	});

	it("reports nothing for a read call written inside a string", () => {
		const body = `${anchored}const src = "fs.readFileSync(path.join(ROOT, name))";`;
		expect(sitesOf(body)).toEqual([]);
	});

	it("reports nothing for a helper's parameter every caller passes a literal for", () => {
		const body = `${anchored}const read = (p: string) => fs.readFileSync(path.join(ROOT, p));\nread("${DOC}");`;
		expect(sitesOf(body)).toEqual([]);
	});

	it("reports a helper's parameter a caller passes a variable for", () => {
		const body = `${anchored}const read = (p: string) => fs.readFileSync(path.join(ROOT, p));\nread(name);`;
		expect(sitesOf(body).map((s) => s.shape)).toEqual([
			"a path segment held in `p`",
		]);
	});

	it("reports nothing for a loop over a literal array the literal pass reads", () => {
		const body = `${anchored}for (const f of ["${DOC}"]) fs.readFileSync(path.join(ROOT, f));`;
		expect(sitesOf(body)).toEqual([]);
	});

	it("reports nothing for a callback walking a literal array the literal pass reads", () => {
		const body = `${anchored}["${DOC}"].map((f) => fs.readFileSync(path.join(ROOT, f)));`;
		expect(sitesOf(body)).toEqual([]);
	});

	it.each([
		["a spread Set of", `[...new Set(["${DOC}"])]`],
		["Array.from over", `Array.from(["${DOC}"])`],
		["an object literal's flattened values in", "Object.values(O).flat()"],
		["an object literal's values in", `Object.values({ a: "${DOC}" })`],
	])(
		"reports nothing for a callback walking %s literals the literal pass reads (#2595)",
		(_, collection) => {
			const body = `${anchored}const O = { a: ["${DOC}"], "b-c": "${DOC}" };\n${collection}.map((f) => fs.readFileSync(path.join(ROOT, f)));`;
			expect(sitesOf(body)).toEqual([]);
		},
	);

	it.each([
		["unflattened array values", "Object.values(O)"],
		["a value that is no literal", "Object.values({ a: name })"],
		["a spread of a variable", "[...new Set(name)]"],
	])(
		"reports a walk of %s as a path segment held in its name (#2595)",
		(_, collection) => {
			const body = `${anchored}const O = { a: ["${DOC}"] };\n${collection}.map((f) => fs.readFileSync(path.join(ROOT, f)));`;
			expect(sitesOf(body).map((s) => s.shape)).toEqual([
				"a path segment held in `f`",
			]);
		},
	);

	it("reports nothing for an it.each table of literals the literal pass reads", () => {
		const body = `${anchored}it.each(["${DOC}"])("%s", (f) => {\n\tfs.readFileSync(path.join(ROOT, f));\n});`;
		expect(sitesOf(body)).toEqual([]);
	});

	it("reports nothing for a read of a file the listing it walks returns (#1886)", () => {
		const body = `${anchored}for (const f of fs.readdirSync(path.join(ROOT, "${dir}")))\n\tfs.readFileSync(path.join(ROOT, "${dir}", f));`;
		expect(sitesOf(body)).toEqual([]);
	});

	it("reports nothing for a callback walking a declared, filtered listing (#1886)", () => {
		const body = `${anchored}const L = fs\n\t.readdirSync(path.join(ROOT, "${dir}"))\n\t.filter((n) => n.endsWith(".md"));\nL.map((f) => fs.readFileSync(path.join(ROOT, "${dir}", f)));`;
		expect(sitesOf(body)).toEqual([]);
	});

	it.each([
		["reassigned", "L = pick();"],
		["grown", "L.push(pick());"],
	])(
		"reports a walk of a declared array %s after its declaration",
		(_, change) => {
			const body = `${anchored}let L = ["${DOC}"];\n${change}\nfor (const f of L) fs.readFileSync(path.join(ROOT, f));`;
			expect(sitesOf(body).map((s) => s.shape)).toEqual([
				"a path segment held in `f`",
			]);
		},
	);

	/* #2595: a walked collection changed after its declaration holds more than its literals. */
	it("reports a walk of a declared array with an element assigned after its declaration", () => {
		const body = `${anchored}const L = ["${DOC}"];\nL[1] = pick();\nfor (const f of L) fs.readFileSync(path.join(ROOT, f));`;
		expect(sitesOf(body).map((s) => s.shape)).toEqual([
			"a path segment held in `f`",
		]);
	});

	it.each([
		["a key assigned", "O.b = pick();"],
		["a computed key assigned", 'O["b"] = pick();'],
		["Object.assign onto it", "Object.assign(O, extra);"],
		["a value grown", "O.a.push(pick());"],
	])(
		"reports a walk of a declared object's values with %s after its declaration",
		(_, change) => {
			const body = `${anchored}const O = { a: ["${DOC}"], c: "${DOC}" };\n${change}\nObject.values(O).flat().map((f) => fs.readFileSync(path.join(ROOT, f)));`;
			expect(sitesOf(body).map((s) => s.shape)).toEqual([
				"a path segment held in `f`",
			]);
		},
	);

	it("reports a walk of a declared Set added to after its declaration", () => {
		const body = `${anchored}const S = new Set(["${DOC}"]);\nS.add(pick());\n[...S].map((f) => fs.readFileSync(path.join(ROOT, f)));`;
		expect(sitesOf(body).map((s) => s.shape)).toEqual([
			"a path segment held in `f`",
		]);
	});

	it("reports nothing for a walk of a declared Set no line changes", () => {
		const body = `${anchored}const S = new Set(["${DOC}"]);\n[...S].map((f) => fs.readFileSync(path.join(ROOT, f)));`;
		expect(sitesOf(body)).toEqual([]);
	});

	it("reports a listing's name read one level further down, which the listing never returns", () => {
		const body = `${anchored}for (const f of fs.readdirSync(path.join(ROOT, "${dir}")))\n\tfs.readFileSync(path.join(ROOT, "${dir}", f, "${file}"));`;
		expect(sitesOf(body).map((s) => s.shape)).toEqual([
			"a path segment held in `f`",
		]);
	});

	it("reports a listing's name read in a directory other than the one listed", () => {
		const body = `${anchored}for (const f of fs.readdirSync(path.join(ROOT, "${dir}")))\n\tfs.readFileSync(path.join(ROOT, f));`;
		expect(sitesOf(body).map((s) => s.shape)).toEqual([
			"a path segment held in `f`",
		]);
	});

	it("reports a helper's parameter that a loop elsewhere happens to share a name with", () => {
		const body = `${anchored}for (const f of ["${DOC}"]) use(f);\nconst read = (f: string) => fs.readFileSync(path.join(ROOT, f));\nread(name);`;
		expect(sitesOf(body).map((s) => s.shape)).toEqual([
			"a path segment held in `f`",
		]);
	});

	it("reports nothing for an untracked path through a scoped package's directory", () => {
		const body = `${anchored}fs.readFileSync(path.join(ROOT, "node_modules", "@scope", "pkg", "x.json"));`;
		expect(sitesOf(body)).toEqual([]);
	});

	it("reports nothing for a path that resolves to no tracked file", () => {
		const body = `${anchored}const T = path.join(ROOT, ".claude", "tmp");\nfs.readFileSync(path.join(T, "x.json"));`;
		expect(sitesOf(body)).toEqual([]);
	});

	it("reports nothing for a git ls-files run in a directory no anchor names", () => {
		const body = `${anchored}execFileSync("git", ["ls-files"], { cwd: sandbox });`;
		expect(sitesOf(body)).toEqual([]);
	});

	/* #2545: base §X binds every test vitest collects, so the listing does too. */
	for (const other of ["scripts/a.spec.ts", "scripts/a.test.js"])
		it(`reports an unseen read in ${other}, a test vitest collects`, () => {
			const body = `${anchored}fs.readFileSync(path.join(ROOT, cfg.file));`;
			const { unseen } = buildManifest(
				new Set([...tracked, other]),
				(p) => (p === other ? body : ""),
				{ sites: true },
			);
			expect(unseen[other]).toEqual([
				{ line: 2, shape: "a computed path argument" },
			]);
		});

	it("finds no sites unless asked, so a suite launch's render never pays for them", () => {
		const body = `${anchored}fs.readFileSync(path.join(ROOT, cfg.file));`;
		const { unseen } = buildManifest(tracked, (p) => (p === self ? body : ""));
		expect(unseen).toEqual({});
	});
});
