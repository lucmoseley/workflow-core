// @vitest-environment node
/*
 * The render against the real core proves the #4 acceptance criteria on what
 * would ship today: no skill or command body spells a repo-relative script
 * path, and nothing shipped needs npm. An output-style body is left
 * repo-relative, since #64 measured the harness never substituting
 * `${CLAUDE_PLUGIN_ROOT}` there.
 *
 * The acceptance cases render the real core, since the guarantee is about what
 * ships today; the refusal and edge cases render a fixture tree under the
 * system temp dir. Two cases (#65) do write into the core: each drops the gate
 * harness's pid-named fixture into its scripts/ and removes it on the way out.
 *
 * full-sweep-only: renders the whole core and reads every file it ships, a
 * set the render decides, so no literal can name them.
 *
 * `release-plugin.js` (`npm run release:plugin`) cuts the tree every adopter
 * installs from this render; loosen a case and a release can ship a script
 * that needs npm, a path that resolves nowhere in the install cache, or a bare
 * citation read against the wrong tracker.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTree, isShipped, REWRITTEN } from "./plugin-tree.js";
import {
	buildCitableLineTest,
	CITATION_CEILING,
	qualifyCitations,
} from "./qualify-citations.js";
import { runInProcess } from "./run-in-process.js";
import { isCollectedTestOrConftest } from "./test-kind.js";

const CORE = path.resolve(__dirname, "../..");
// Spelled in pieces: a `${…}` literal in a plain string trips Biome's template lint.
const PLUGIN_ROOT = ["$", "{CLAUDE_PLUGIN_ROOT}"].join("");
const SKILL_DIR = ["$", "{CLAUDE_SKILL_DIR}"].join("");
const REPO_RELATIVE_SCRIPT = /(?<![\w./$}-])(?:\.\/)?scripts\/[\w*.-]/;
const REPO_RELATIVE_SKILL_SCRIPT =
	/(?<![\w./$}-])\.claude\/skills\/[^\s/`]+\/scripts\//;
/* The mods' modules and state contracts, which the engine loads from the
 * install cache (#933), and the one contract the release composes from them
 * (#3251). */
const LIVENESS_MODULE = ".claude/skills/wfc-liveness/hooks/register.tsx";
const LIVENESS_CONTRACT = ".claude/skills/wfc-liveness/types/index.d.ts";
const DELIVERY_CONTRACT = ".claude/skills/wfc-delivery/types/index.d.ts";
const HOST_CONTRACT = "types/index.d.ts";
/* The reporters and globalSetup an adopter's vitest config attaches, the only
 * TypeScript under scripts/ the release ships (#552). */
const VITEST_LOADED = [
	"scripts/vitest-pass-reporter.ts",
	"scripts/vitest-inflight-reporter.ts",
	"scripts/vitest-tree-watch.ts",
];
/* The plugin's entry module, which loads both mods (#946). */
const ENTRY = "hooks/register.ts";
const SHIPPED_MOD_TS = [
	".claude/skills/wfc-delivery/hooks/register.ts",
	LIVENESS_MODULE,
	LIVENESS_CONTRACT,
	DELIVERY_CONTRACT,
];

const readFiles = (root: string) =>
	fs
		.readdirSync(root, { recursive: true, withFileTypes: true })
		.filter((e) => e.isFile())
		.map((e) => path.relative(root, path.join(e.parentPath, e.name)))
		.sort();

let tmp: string;
beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-tree-"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("the tree rendered from the core", () => {
	it("ships what runs, with no npm or test file and no TypeScript but what vitest or the engine loads", () => {
		const out = path.join(tmp, "out");
		buildTree(CORE, out);
		const shipped = readFiles(out);

		// #1939: MIT's one condition is that the notice travels with every copy.
		const notices = ".claude/skills/THIRD-PARTY-NOTICES.md";
		expect(fs.readFileSync(path.join(out, notices), "utf8")).toBe(
			fs.readFileSync(path.join(CORE, notices), "utf8"),
		);

		expect(shipped).toContain(".claude-plugin/plugin.json");
		// #117: a release tag without this can't be `marketplace add`ed by ref.
		// `buildTree` copies it verbatim, so the ref-pins-the-tag invariant is
		// release-plugin.test.ts's to prove, against the tag it actually cuts.
		expect(shipped).toContain(".claude-plugin/marketplace.json");
		expect(shipped).toContain(".claude/output-styles/core-voice.md");
		expect(shipped).toContain(".claude/skills/pick-next/SKILL.md");
		expect(shipped).toContain(".claude/skills/card-close/SKILL.md");
		expect(shipped).toContain("scripts/session-arbiter.js");
		// The adopter's ruff gate reads it by --config (#106).
		expect(shipped).toContain("ruff.toml");
		expect(shipped).not.toContain("package.json");
		// #1380: js-yaml's consumers ship, loading it from the adopter's install.
		expect(shipped).toContain("scripts/check-workflow-permissions.js");
		expect(shipped).toContain("scripts/check-skill-frontmatter.js");
		expect(shipped).toContain("scripts/lib/host-package.js");
		// #440's core-only class, and its members a shipped file names.
		expect(shipped).not.toContain("scripts/release-plugin.js");
		expect(shipped).not.toContain("scripts/measure-burn/scan_burn.py");
		// #691: an adopter is never offered a command that creates repos.
		expect(
			fs.existsSync(
				path.join(CORE, ".claude/skills/new-repo/scripts/new-repo.js"),
			),
		).toBe(true);
		expect(
			shipped.filter((f) => f.startsWith(".claude/skills/new-repo/")),
		).toEqual([]);
		expect(shipped).toContain("scripts/measure-turn-band.js");
		// #1734: the one way an adopter builds the table its launch cap reads.
		expect(shipped).toContain("scripts/measure-session-cost.js");
		expect(
			shipped.filter(
				(f) =>
					isCollectedTestOrConftest(f) || /\.tsx?$|(^|\/)fixtures\//.test(f),
			),
		).toEqual(
			[...VITEST_LOADED, ...SHIPPED_MOD_TS, ENTRY, HOST_CONTRACT].sort(),
		);

		expect(fs.readFileSync(path.join(out, "hooks/hooks.json"), "utf8")).toBe(
			fs.readFileSync(path.join(CORE, "hooks/hooks.json"), "utf8"),
		);
		// #2441: the self-plugin is the core's own; its render ships in its place.
		expect(fs.existsSync(path.join(CORE, "self-plugin"))).toBe(true);
		expect(shipped.filter((f) => f.startsWith("self-plugin/"))).toEqual([]);
		const manifest = JSON.parse(
			fs.readFileSync(path.join(out, "hooks/hooks.json"), "utf8"),
		);
		expect(Object.keys(manifest)).toEqual(["description", "hooks", "modules"]);
		expect(manifest.modules).toEqual(["./register.ts"]);
		expect(fs.readFileSync(path.join(out, ENTRY), "utf8")).toBe(
			qualifyCitations(fs.readFileSync(path.join(CORE, ENTRY), "utf8"), ENTRY),
		);

		const scripts = shipped.filter((f) => f.startsWith("scripts/"));
		// #4 (the packaging measurement)
		expect(scripts.length).toBeGreaterThanOrEqual(59);
		// Byte for byte, bar the citations #396 qualifies.
		const readExpected = (f: string) => {
			const source = fs.readFileSync(path.join(CORE, f));
			const text = source.toString("utf8");
			const qualified = qualifyCitations(text, f);
			return qualified === text ? source : Buffer.from(qualified);
		};
		expect(
			scripts.filter(
				(f) => !fs.readFileSync(path.join(out, f)).equals(readExpected(f)),
			),
		).toEqual([]);

		const bodies = shipped.filter((f) => REWRITTEN.test(f));
		expect(bodies).toContain(".claude/skills/pick-next/SKILL.md");
		const repoRelative = bodies.flatMap((f) =>
			fs
				.readFileSync(path.join(out, f), "utf8")
				.split("\n")
				.filter(
					(line) =>
						REPO_RELATIVE_SCRIPT.test(line) ||
						REPO_RELATIVE_SKILL_SCRIPT.test(line),
				)
				.map((line) => `${f}: ${line}`),
		);
		expect(repoRelative).toEqual([]);
	});

	// #741: an adopter's review axes run on the plugin's copy, and the harness
	// loads an agent only from a manifest `agents` entry naming its file — a
	// directory string fails the manifest's validation.
	it("ships every agent definition and lists each in the manifest", () => {
		const out = path.join(tmp, "out");
		buildTree(CORE, out);
		const agents = fs
			.readdirSync(path.join(CORE, ".claude/agents"))
			.filter((f) => f.endsWith(".md"))
			.map((f) => `./.claude/agents/${f}`);
		expect(agents).toContain("./.claude/agents/code-reviewer.md");
		const manifest = JSON.parse(
			fs.readFileSync(path.join(out, ".claude-plugin/plugin.json"), "utf8"),
		);
		expect([...manifest.agents].sort()).toEqual(agents.sort());
		for (const rel of agents) {
			expect(fs.existsSync(path.join(out, rel)), rel).toBe(true);
		}
	});

	// #1377: the wrapper follows or replaces the vendored skill's steps by
	// heading, so a re-vendor that moves one must go red here, not run silently
	// against a step that is gone.
	it("ships the architecture-scan wrapper beside the vendored skill, every step heading it names still there", () => {
		const out = path.join(tmp, "out");
		buildTree(CORE, out);
		const read = (rel: string) =>
			fs.readFileSync(
				path.join(out, ".claude/skills", rel, "SKILL.md"),
				"utf8",
			);
		const wrapper = read("architecture-scan");
		const vendored = read("improve-codebase-architecture").split("\n");

		const named = [
			...new Set([...wrapper.matchAll(/`(### [^`]+)`/g)].map((m) => m[1])),
		];
		expect(named).toEqual([
			"### 1. Explore",
			"### 2. Present candidates as an HTML report",
			"### 3. Grilling loop",
		]);
		expect(named.filter((h) => !vendored.includes(h))).toEqual([]);
	});

	// `$.state` belongs to the host plugin, not the mod (#903 F8).
	it("ships the mods' modules, and one contract composing their state under workflow-core (#3251)", () => {
		const out = path.join(tmp, "out");
		buildTree(CORE, out);
		const shipped = readFiles(out);

		expect(shipped).toEqual(expect.arrayContaining(SHIPPED_MOD_TS));
		expect(
			shipped.filter((f) => /\/tests\/|\/types\/claude-code\//.test(f)),
		).toEqual([]);
		// Neither runs in an adopter (#1050).
		for (const mod of ["wfc-delivery", "wfc-liveness"]) {
			expect(shipped).not.toContain(`.claude/skills/${mod}/tsconfig.json`);
			expect(shipped).not.toContain(`.claude/skills/${mod}/hooks/hooks.json`);
		}

		const module = fs.readFileSync(path.join(out, LIVENESS_MODULE), "utf8");
		expect(module).toContain('plugin: "workflow-core", key: "records"');
		expect(module).toContain('plugin: "workflow-core", key: "rows"');
		expect(module).not.toContain('plugin: "wfc-liveness"');
		// The mod's own name stays where it names the mod, not a state owner.
		expect(module).toContain('const modName = "wfc-liveness";');

		const contract = fs.readFileSync(path.join(out, HOST_CONTRACT), "utf8");
		expect(contract).toMatch(
			/interface PluginState \{\s*"workflow-core": \{[\s\S]*isTurnRunning: boolean;\s*records: [^;]+;\s*rows: [^;]+;\s*\};\s*\}/,
		);
		expect(contract).toContain("export interface LivenessRecord {");
		expect(contract).not.toContain('"wfc-liveness"');
		expect(contract).not.toContain('"wfc-delivery"');
		for (const rel of [LIVENESS_CONTRACT, DELIVERY_CONTRACT])
			expect(fs.readFileSync(path.join(out, rel), "utf8")).not.toContain(
				"PluginState",
			);
		// The shape #903 validated: no `export {}` after the module block.
		expect(contract.trimEnd()).toMatch(
			/declare module "claude-code" \{[\s\S]*\}$/,
		);
		expect(contract).not.toMatch(/export \{\s*\}/);

		// The source keeps its own name, so it still loads stand-alone.
		expect(fs.readFileSync(path.join(CORE, LIVENESS_MODULE), "utf8")).toContain(
			'plugin: "wfc-liveness"',
		);
		expect(
			fs.readFileSync(path.join(CORE, LIVENESS_CONTRACT), "utf8"),
		).toContain('"wfc-liveness": {');

		const manifest = JSON.parse(
			fs.readFileSync(path.join(out, ".claude-plugin/plugin.json"), "utf8"),
		);
		expect(manifest.types).toBe(`./${HOST_CONTRACT}`);
	});

	it("keeps the repo's own skill bodies repo-relative", () => {
		const body = fs.readFileSync(
			path.join(CORE, ".claude/skills/pick-next/SKILL.md"),
			"utf8",
		);
		expect(body).toMatch(REPO_RELATIVE_SCRIPT);
		expect(body).not.toContain(PLUGIN_ROOT);
	});

	it("ships the output style with its script paths untouched", () => {
		const out = path.join(tmp, "out");
		buildTree(CORE, out);
		const shipped = fs.readFileSync(
			path.join(out, ".claude/output-styles/core-voice.md"),
			"utf8",
		);
		const source = fs.readFileSync(
			path.join(CORE, ".claude/output-styles/core-voice.md"),
			"utf8",
		);
		expect(shipped).toBe(qualifyCitations(source, "core-voice.md"));
		expect(shipped).not.toContain(PLUGIN_ROOT);
	});

	// The ladder ships to every adopter, so this machine's Chrome profile,
	// accounts and config dirs stay in the machine note (#1070). The scan
	// covers the three kinds #1070 names, each in the spelling the machine
	// note uses; the `Default` profile, a Windows path and a bare username
	// pass unseen.
	const privateKinds: [RegExp, string][] = [
		[/\bProfile \d+\b/, 'Chrome "Profile 1"'],
		[/profile-directory/, '--profile-directory="Default"'],
		[/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/, "someone.travel@gmail.com"],
		[
			/(?:~|\$HOME|\/home\/[^/\s]+)\/\.claude\d*\b/,
			"CLAUDE_CONFIG_DIR=~/.claude3",
		],
	];

	it("ships the browser-ladder skill free of this machine's profile, addresses and config dirs", () => {
		const out = path.join(tmp, "out");
		buildTree(CORE, out);
		const skill = path.join(out, ".claude/skills/browser-ladder");
		expect(fs.existsSync(path.join(skill, "SKILL.md"))).toBe(true);
		for (const rel of readFiles(skill)) {
			const body = fs.readFileSync(path.join(skill, rel), "utf8");
			for (const [re] of privateKinds) {
				expect(body, `${rel} ${re}`).not.toMatch(re);
			}
		}
	});

	it("catches each private kind the browser-ladder scan looks for", () => {
		for (const [re, sample] of privateKinds) expect(sample).toMatch(re);
	});

	// #65: precommit-gate-harness.test.ts's writeCheckerDelegates suite drops a
	// pid-suffixed fixture into the real scripts/ and removes it in its own
	// afterEach. A render racing that window must never ship, or even touch,
	// that file.
	it("never ships a live pre-commit-gate-harness test fixture", () => {
		const fixtureName = `__precommit-gate-harness-test-fixture-${process.pid}.js`;
		const fixturePath = path.join(CORE, "scripts", fixtureName);
		fs.writeFileSync(fixturePath, "process.exit(0);\n");
		try {
			const out = path.join(tmp, "out");
			buildTree(CORE, out);
			expect(readFiles(out)).not.toContain(`scripts/${fixtureName}`);
		} finally {
			fs.rmSync(fixturePath, { force: true });
		}
	});

	// The harness deletes its fixture between the listing that names it and
	// the render reaching it, so a stat run on the vanished name must never
	// happen, only a name-based skip.
	it("skips the fixture by name rather than touching it, even where it is deleted between listing and reaching it", () => {
		const fixtureName = `__precommit-gate-harness-test-fixture-${process.pid}.js`;
		const fixturePath = path.join(CORE, "scripts", fixtureName);
		const scriptsDir = path.join(CORE, "scripts");
		fs.writeFileSync(fixturePath, "process.exit(0);\n");
		const realReaddirSync = fs.readdirSync.bind(fs);
		const spy = vi
			.spyOn(fs, "readdirSync")
			.mockImplementation((dir: fs.PathLike, opts?: unknown) => {
				// biome-ignore lint/suspicious/noExplicitAny: forwarding readdirSync's own overload set
				const listing = (realReaddirSync as any)(dir, opts);
				if (dir === scriptsDir && Array.isArray(listing)) {
					fs.rmSync(fixturePath, { force: true });
				}
				return listing;
			});
		try {
			const out = path.join(tmp, "out");
			expect(() => buildTree(CORE, out)).not.toThrow();
			expect(readFiles(out)).not.toContain(`scripts/${fixtureName}`);
		} finally {
			spy.mockRestore();
			fs.rmSync(fixturePath, { force: true });
		}
	});
});

/* What the release drops for being test or TypeScript code, not for being
 * core-only: test-kind.js's tests, and a restatement of plugin-tree.js's
 * SKIPPED_DIRS and SKIPPED_FILE, which keep it private. A kind missing here
 * only widens what counts as left behind, so drift turns the scan below red
 * rather than blind. */
const TS_OR_SKIPPED_DIR = /\.[cm]?tsx?$|^(fixtures|__pycache__|node_modules)$/;
/** Whether the release leaves `rel` behind as core-only (#440). */
const isLeftBehind = (root: string, rel: string) =>
	!isShipped(root, rel) &&
	!TS_OR_SKIPPED_DIR.test(path.basename(rel)) &&
	!isCollectedTestOrConftest(path.basename(rel));

/**
 * Every line of a shipped file naming a left-behind script, as
 * `<shipped>:<line> -> <left-behind>`: a script's or .husky hook's code lines,
 * and any line of a skill, command, docs/agents file or hooks.json.
 */
const readLeftBehindReferences = (root: string, out: string) => {
	const scripts = path.join(root, "scripts");
	const behind = fs
		.readdirSync(scripts)
		.map((n) => `scripts/${n}`)
		.concat(
			fs.existsSync(path.join(scripts, "lib"))
				? fs
						.readdirSync(path.join(scripts, "lib"))
						.map((n) => `scripts/lib/${n}`)
				: [],
		)
		.filter((rel) => isLeftBehind(root, rel))
		.map((rel) => ({
			rel,
			pattern: new RegExp(
				`(?<![\\w-])${path
					.basename(rel)
					.replace(/\.(c|m)?(js|sh|py)$/, "")
					.replace(/\./g, "\\.")}(?![\\w-])`,
			),
		}));
	return readFiles(out)
		.filter((f) =>
			/^(scripts|\.husky|\.claude\/skills|docs\/agents)\/|^hooks\/hooks\.json$/.test(
				f,
			),
		)
		.flatMap((f) => {
			const isComment =
				/^(scripts|\.husky)\//.test(f) && !f.endsWith(".md")
					? buildCitableLineTest(f)
					: null;
			return fs
				.readFileSync(path.join(out, f), "utf8")
				.split("\n")
				.flatMap((line, i) =>
					isComment?.(line)
						? []
						: behind
								.filter((b) => b.pattern.test(line))
								.map((b) => `${f}:${i + 1} -> ${b.rel}`),
				);
		});
};

describe("the core-only class (#440)", () => {
	/* Named, never run, in an adopter: each pair's reference is dead there, or
	 * true there of a script that runs only in the core. */
	const namedNotRun = [
		// Its remedies print only on a repo carrying .claude-plugin/marketplace.json
		// — the core; an adopter without one SKIPs.
		"scripts/check-release-pin.js -> scripts/release-plugin.js",
		// Named to run in a core checkout, the only clone carrying release tags.
		"docs/agents/adopter-upgrade.md -> scripts/release-contains.js",
		// An allowlist key; an entry whose file is absent is silent.
		"scripts/check-host-root.js -> scripts/cut-mantahostels.js",
		// Required only where docs/code-standards-base.md exists: the core (#963).
		"scripts/check-code-standards.js -> scripts/lib/plugin-tree.js",
		// Required only where it exists beside it: the core (#1151).
		"scripts/lib/write-scan.js -> scripts/lib/plugin-tree.js",
		// release-plugin.js, run in the core, files into each adopter tracker it
		// is named, so triage-labels.md's census is true there (#1692).
		"docs/agents/triage-labels.md -> scripts/release-plugin.js",
	];

	it("ships nothing that names a left-behind script, bar the pairs excused", () => {
		const out = path.join(tmp, "out");
		buildTree(CORE, out);
		const found = readLeftBehindReferences(CORE, out);
		const pair = (ref: string) => ref.replace(/:\d+ -> /, " -> ");
		expect(found.filter((ref) => !namedNotRun.includes(pair(ref)))).toEqual([]);
		// An excuse whose reference has gone is removed, not left to excuse the next.
		expect(
			namedNotRun.filter((p) => !found.some((ref) => pair(ref) === p)),
		).toEqual([]);
	});

	it("finds a left-behind script wired into a shipped hook, skill or doc", () => {
		const root = path.join(tmp, "src");
		const tree: Record<string, string> = {
			"self-plugin/hooks/hooks.json": JSON.stringify({ hooks: {} }),
			"scripts/measure-x.js": "",
			"scripts/measure-dir/scan.py": "",
			"scripts/guard.sh":
				"# re-derive with scripts/measure-x.js\nnode scripts/measure-x.js\n",
			"scripts/g.js": "// measure-dir\nrequire('./measure-x');\n",
			".claude/skills/s/SKILL.md": "Run `scripts/measure-dir/scan.py`.\n",
			"docs/agents/a.md": "Gated by `release-plugin.js`.\n",
			"scripts/templates/T.md": "Run scripts/measure-x.js.\n",
			"scripts/release-plugin.js": "",
		};
		for (const [rel, body] of Object.entries(tree)) {
			fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
			fs.writeFileSync(path.join(root, rel), body);
		}
		const out = path.join(tmp, "out");
		buildTree(root, out);
		expect(readFiles(out)).not.toContain("scripts/measure-x.js");
		expect(readLeftBehindReferences(root, out)).toEqual([
			".claude/skills/s/SKILL.md:1 -> scripts/measure-dir",
			"docs/agents/a.md:1 -> scripts/release-plugin.js",
			"scripts/g.js:2 -> scripts/measure-x.js",
			"scripts/guard.sh:2 -> scripts/measure-x.js",
			"scripts/templates/T.md:1 -> scripts/measure-x.js",
		]);
	});

	it("leaves behind a class member by path, directories included, and ships one KEPT", () => {
		const shipped = (rel: string) => isShipped(CORE, rel);
		expect(shipped("scripts/measure-burn")).toBe(false);
		expect(shipped("scripts/measure-burn/scan_burn.py")).toBe(false);
		expect(shipped("scripts/measure_model_switch_cache.py")).toBe(false);
		expect(shipped("scripts/lib/plugin-tree.js")).toBe(false);
		expect(shipped("scripts/measure-turn-band.js")).toBe(true);
		expect(shipped("scripts/measure-session-cost.js")).toBe(true);
		expect(shipped("scripts/lib/measure-x.js")).toBe(true);
		expect(shipped("scripts/session-arbiter.js")).toBe(true);
	});
});

describe("citation qualification (#396)", () => {
	const qualifiedPrefix = "workflow-core#";
	const render = (tree: Record<string, string>) => {
		const root = path.join(tmp, "src");
		for (const [rel, body] of Object.entries(tree)) {
			fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
			fs.writeFileSync(path.join(root, rel), body);
		}
		fs.mkdirSync(path.join(root, "self-plugin/hooks"), { recursive: true });
		fs.writeFileSync(
			path.join(root, "self-plugin/hooks/hooks.json"),
			JSON.stringify({ hooks: {} }),
		);
		const out = path.join(tmp, "out");
		buildTree(root, out);
		return (rel: string) => fs.readFileSync(path.join(out, rel), "utf8");
	};

	it("qualifies every citation in a shipped .md, skill bodies included", () => {
		const shipped = render({
			"docs/agents/x.md": "Ruled at #396 (see #12), pre-#129 too.\n",
			".claude/skills/s/SKILL.md": "Run `x` first (#21).\n",
		});
		expect(shipped("docs/agents/x.md")).toBe(
			`Ruled at ${qualifiedPrefix}396 (see ${qualifiedPrefix}12), pre-${qualifiedPrefix}129 too.\n`,
		);
		expect(shipped(".claude/skills/s/SKILL.md")).toBe(
			`Run \`x\` first (${qualifiedPrefix}21).\n`,
		);
	});

	it("qualifies a comment line of a .js, .sh and .py, and a code line's #N only inside a same-line bracket (#435)", () => {
		const shipped = render({
			"scripts/a.js":
				"// set at #12\nconst x = 'refused (#13)';\n/* see #14\n * and #15\n */\n",
			"scripts/b.sh":
				"#!/bin/sh\n# see #16\necho 'no (#17, mantahostels#9)' # trailing (#18)\n",
			"scripts/c.py": "# ruled #19\nx = '(#20)'\n",
		});
		expect(shipped("scripts/a.js")).toBe(
			`// set at ${qualifiedPrefix}12\nconst x = 'refused (${qualifiedPrefix}13)';\n/* see ${qualifiedPrefix}14\n * and ${qualifiedPrefix}15\n */\n`,
		);
		expect(shipped("scripts/b.sh")).toBe(
			`#!/bin/sh\n# see ${qualifiedPrefix}16\necho 'no (${qualifiedPrefix}17, mantahostels#9)' # trailing (${qualifiedPrefix}18)\n`,
		);
		expect(shipped("scripts/c.py")).toBe(
			`# ruled ${qualifiedPrefix}19\nx = '(#20)'\n`,
		);
	});

	it("qualifies a .py triple-quoted string's lines, and no code line after it closes (#427)", () => {
		const shipped = render({
			"scripts/d.py": [
				'"""Mirror of the seam (#1).',
				"",
				'per `#2`, see #3."""',
				"x = '(#4)'",
				"# a ''' in a comment opens nothing, #5",
				"y = '#6'",
				"def f():",
				"    '''One line (#7).'''",
				'    """One line (#8)."""',
				"",
			].join("\n"),
		});
		expect(shipped("scripts/d.py")).toBe(
			[
				`"""Mirror of the seam (${qualifiedPrefix}1).`,
				"",
				`per \`#2\`, see ${qualifiedPrefix}3."""`,
				"x = '(#4)'",
				`# a ''' in a comment opens nothing, ${qualifiedPrefix}5`,
				"y = '#6'",
				"def f():",
				`    '''One line (${qualifiedPrefix}7).'''`,
				`    """One line (${qualifiedPrefix}8)."""`,
				"",
			].join("\n"),
		);
	});

	it("reads an extensionless .husky hook as a shell script (#435)", () => {
		const shipped = render({
			".husky/pre-commit":
				"#!/usr/bin/env sh\n# gate #21\necho 'refused (#22)' >&2\n",
		});
		expect(shipped(".husky/pre-commit")).toBe(
			`#!/usr/bin/env sh\n# gate ${qualifiedPrefix}21\necho 'refused (${qualifiedPrefix}22)' >&2\n`,
		);
	});

	it("reads a call's, subshell's or array's own ( as syntax, never a bracket (#435)", () => {
		const tree = {
			"scripts/a.sh": [
				'say("the #26 hazard")',
				'x=$(echo "#27")',
				'A+=("on #28")',
				'say("the hazard (#29)")',
				"",
			].join("\n"),
		};
		expect(() => render(tree)).toThrow(
			/^scripts\/a\.sh:1 prints #26[^\n]*\nscripts\/a\.sh:2 prints #27[^\n]*\nscripts\/a\.sh:3 prints #28[^\n]*$/,
		);
		tree["scripts/a.sh"] = 'say("the hazard (#29)")\n';
		expect(render(tree)("scripts/a.sh")).toBe(
			`say("the hazard (${qualifiedPrefix}29)")\n`,
		);
	});

	it("never lets a fence-shaped code line switch a script's citations off (#435)", () => {
		const body = "const t = `\n```\n`;\nsay('refused (#30)');\n";
		expect(render({ "scripts/a.js": body })("scripts/a.js")).toBe(
			body.replace("#30", `${qualifiedPrefix}30`),
		);
	});

	it("refuses a code line's #N outside a same-line bracket, bar one a bare-citation-ok comment excuses and leaves bare, naming each file and line and leaving no tree (#435)", () => {
		const tree = {
			"scripts/a.js": [
				"const a = 'the #23 hazard';",
				"// bare-citation-ok: the citation form's own example",
				"const b = say('a form (cite as `#24 (gloss)`)');",
				"const c = 'opens (see",
				"#25) on a later line';",
				"",
			].join("\n"),
		};
		expect(() => render(tree)).toThrow(
			/^scripts\/a\.js:1 prints #23 outside[^\n]*\nscripts\/a\.js:5 prints #25 outside/,
		);
		expect(fs.existsSync(path.join(tmp, "out"))).toBe(false);
		tree["scripts/a.js"] = tree["scripts/a.js"]
			.replace("the #23 hazard", "the hazard (#23)")
			.replace("#25) on", ") on")
			.replace("opens (see", "opens (see #25)");
		expect(render(tree)("scripts/a.js")).toContain(
			"say('a form (cite as `#24 (gloss)`)')",
		);
	});

	it("leaves a quoted bare-citation example, another tracker and a qualified one alone", () => {
		const body = [
			"Cite as `#22 (gloss)`, never a bare `#42`.",
			'A line like "Fixes #77" closes it; so does “Closes #78”.',
			"mantahostels#316 and workflow-core#7 already name their tracker.",
			"",
		].join("\n");
		expect(render({ "docs/agents/x.md": body })("docs/agents/x.md")).toBe(body);
	});

	it("carries a backtick span across a line break, but not past a blank line", () => {
		const shipped = render({
			"scripts/a.js":
				'/* a referring phrase: `#22 (the nav-layer\n * question)`, {"B1"} `x (#23).\n\n// #24\n',
			"docs/agents/x.md": "An open ` span\n\nthen #25.\n",
		});
		expect(shipped("scripts/a.js")).toBe(
			`/* a referring phrase: \`#22 (the nav-layer\n * question)\`, {"B1"} \`x (#23).\n\n// ${qualifiedPrefix}24\n`,
		);
		expect(shipped("docs/agents/x.md")).toBe(
			`An open \` span\n\nthen ${qualifiedPrefix}25.\n`,
		);
	});

	it("leaves a fenced block and a number above any core issue alone", () => {
		const body = [
			"```md",
			"- #42 — an adopter's own issue",
			"```",
			"then #26, not claude-code #82259.",
			"",
		].join("\n");
		expect(render({ "docs/agents/x.md": body })("docs/agents/x.md")).toBe(
			body.replace("#26", `${qualifiedPrefix}26`),
		);
	});

	it("leaves a shell comment whose #N is no citation alone", () => {
		const body = [
			"#!/bin/sh",
			// Spelled in pieces, as PLUGIN_ROOT above is.
			[
				"# $",
				"{#1} is the argument's length, and $#1 is no issue either.",
			].join(""),
			"# &#39; is an entity, s#1#2# a sed, ##3 a heading and #4a a colour.",
			`# a prompt naming #${CITATION_CEILING + 1} names no core issue.`,
			"",
		].join("\n");
		expect(render({ "scripts/b.sh": body })("scripts/b.sh")).toBe(body);
	});

	it("writes nothing back to the core, whose citation check still passes", () => {
		const out = path.join(tmp, "out");
		/* Byte for byte, not by grepping for a qualified citation: a core file
		 * may carry one of its own, as retro-sweep's adopter-tracker example
		 * does (#964). */
		const read = (f: string) => fs.readFileSync(path.join(CORE, f), "utf8");
		const shipped = spawnSync("git", ["ls-files"], {
			cwd: CORE,
			encoding: "utf8",
		})
			.stdout.split("\n")
			.filter(
				(f) =>
					f &&
					isShipped(CORE, f) &&
					fs.statSync(path.join(CORE, f), { throwIfNoEntry: false })?.isFile(),
			);
		expect(shipped.length).toBeGreaterThan(0);
		const before = new Map(shipped.map((f) => [f, read(f)]));
		buildTree(CORE, out);
		expect(shipped.filter((f) => before.get(f) !== read(f))).toEqual([]);
		const check = runInProcess(
			path.join(CORE, "scripts/check-citation-tracker.js"),
			["--all"],
			{ cwd: CORE },
		);
		expect(check.status, check.stdout + check.stderr).toBe(0);
	});
});

describe("a skill body's script paths", () => {
	/** `body` as the release writes it into skill `s`, which carries
	 * scripts/local.sh of its own. */
	const shipped = (body: string) => {
		const root = path.join(tmp, "src");
		const tree: Record<string, string> = {
			"self-plugin/hooks/hooks.json": JSON.stringify({ hooks: {} }),
			".claude/skills/s/SKILL.md": body,
			".claude/skills/s/scripts/local.sh": "",
		};
		for (const [rel, text] of Object.entries(tree)) {
			fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
			fs.writeFileSync(path.join(root, rel), text);
		}
		fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
		const out = path.join(tmp, "out");
		buildTree(root, out);
		return fs.readFileSync(path.join(out, ".claude/skills/s/SKILL.md"), "utf8");
	};

	it("spells a core script through the plugin root", () => {
		expect(
			shipped(
				"run `node scripts/a.js --x`\nrun ./scripts/c.sh\n(`scripts/guard-*.sh`)",
			),
		).toBe(
			[
				`run \`node ${PLUGIN_ROOT}/scripts/a.js --x\``,
				`run ${PLUGIN_ROOT}/scripts/c.sh`,
				`(\`${PLUGIN_ROOT}/scripts/guard-*.sh\`)`,
			].join("\n"),
		);
	});

	it("spells a script only the skill carries through the skill dir", () => {
		expect(shipped("`scripts/local.sh`")).toBe(
			`\`${SKILL_DIR}/scripts/local.sh\``,
		);
	});

	it("roots a .claude/skills path once, leaving its inner scripts/ alone", () => {
		expect(shipped("node .claude/skills/s/scripts/v.js")).toBe(
			`node ${PLUGIN_ROOT}/.claude/skills/s/scripts/v.js`,
		);
	});

	it("leaves a longer path, a bare directory name and a rewritten body alone", () => {
		const body = [
			"src/scripts/a.js",
			"a scratch or `scripts/` directory",
			`${PLUGIN_ROOT}/scripts/a.js`,
		].join("\n");
		expect(shipped(body)).toBe(body);
	});
});

describe("a pointer to a core doc (#1452)", () => {
	/** A source holding a shipped doc, a core-only one and a host-owned one,
	 * plus `extra`. */
	const source = (extra: Record<string, string>) => {
		const root = path.join(tmp, "src");
		const tree: Record<string, string> = {
			"self-plugin/hooks/hooks.json": JSON.stringify({ hooks: {} }),
			"docs/environment.md": "limits\n",
			"docs/agents/a.md": "rules\n",
			"docs/working-contract.md": "contract\n",
			"docs/doc-map.md": "map\n",
			...extra,
		};
		for (const [rel, text] of Object.entries(tree)) {
			fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
			fs.writeFileSync(path.join(root, rel), text);
		}
		return root;
	};
	const faultsOf = (root: string) => {
		try {
			buildTree(root, path.join(tmp, "out"));
			return [];
		} catch (err) {
			return (err as Error).message
				.split("\n")
				.map((l) => l.slice(0, l.indexOf(", which")));
		}
	};

	it("spells a shipped top-level doc in a skill body through the plugin root, and leaves docs/agents and a host's doc alone", () => {
		const root = source({
			".claude/skills/s/SKILL.md":
				"read `docs/environment.md` §6 and docs/agents/a.md.\nedit docs/doc-map.md, not x/docs/environment.md",
		});
		const out = path.join(tmp, "out");
		buildTree(root, out);
		expect(
			fs.readFileSync(path.join(out, ".claude/skills/s/SKILL.md"), "utf8"),
		).toBe(
			[
				`read \`${PLUGIN_ROOT}/docs/environment.md\` §6 and docs/agents/a.md.`,
				"edit docs/doc-map.md, not x/docs/environment.md",
			].join("\n"),
		);
	});

	it("refuses a core-only doc named in a skill, docs/agents file, rule or script code line, naming each and leaving no tree", () => {
		const root = source({
			".claude/skills/s/SKILL.md": "see `docs/working-contract.md`.\n",
			".claude/skills/t/SKILL.md": "x\nper docs/working-contract.md\n",
			"docs/agents/b.md": "docs/working-contract.md binds\n",
			"docs/agents/rules/r.txt": "read docs/working-contract.md\n",
			"scripts/a.js": 'console.log("docs/working-contract.md");\n',
			"scripts/b.sh": 'echo "see docs/working-contract.md"\n',
		});
		expect(faultsOf(root).sort()).toEqual(
			[
				".claude/skills/s/SKILL.md:1",
				".claude/skills/t/SKILL.md:2",
				"docs/agents/b.md:1",
				"docs/agents/rules/r.txt:1",
				"scripts/a.js:1",
				"scripts/b.sh:1",
			].map((at) => `${at} names docs/working-contract.md`),
		);
		expect(fs.existsSync(path.join(tmp, "out"))).toBe(false);
	});

	it("passes a comment, a docstring, a data file, a host's doc, a doc the core lacks and a deeper path it lacks", () => {
		const root = source({
			"scripts/a.js":
				"// docs/working-contract.md\n/* docs/working-contract.md */\n",
			"scripts/b.sh": "# docs/working-contract.md\n",
			"scripts/c.py":
				'"""Per docs/working-contract.md."""\n# docs/working-contract.md\n',
			"scripts/d.json": '{"p": "docs/working-contract.md"}\n',
			"scripts/lib/implement-carveout.js":
				'const p = "docs/working-contract.md";\n',
			"docs/agents/b.md":
				"docs/doc-map.md, docs/sources.md, docs/research/working-contract.md, https://x/docs/working-contract.md\n",
		});
		expect(faultsOf(root)).toEqual([]);
	});

	it("refuses an unshipped research artefact or ADR a shipped file names, unless that file's pointer to it is registered as never read (#1673)", () => {
		const root = source({
			"docs/research/r.md": "finding\n",
			"docs/research/always-loaded-shed-candidates.md": "register\n",
			"docs/adr/0001-a.md": "ruling\n",
			".claude/skills/s/SKILL.md": "read `docs/research/r.md` first.\n",
			"docs/agents/b.md": "per docs/adr/0001-a.md\n",
			"scripts/a.js": 'console.log("see docs/research/r.md");\n',
			"docs/agents/rules/README.md":
				"(`docs/research/always-loaded-shed-candidates.md`)\nand docs/research/r.md\n",
		});
		expect(faultsOf(root).sort()).toEqual([
			".claude/skills/s/SKILL.md:1 names docs/research/r.md",
			"docs/agents/b.md:1 names docs/adr/0001-a.md",
			"docs/agents/rules/README.md:2 names docs/research/r.md",
			"scripts/a.js:1 names docs/research/r.md",
		]);
	});
});

describe("a render in a fixture", () => {
	const fixture = (script: string) => {
		const root = path.join(tmp, "src");
		fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
		fs.mkdirSync(path.join(root, "scripts"));
		fs.writeFileSync(path.join(root, "scripts/a.js"), script);
		fs.mkdirSync(path.join(root, "self-plugin/hooks"), { recursive: true });
		fs.writeFileSync(
			path.join(root, "self-plugin/hooks/hooks.json"),
			JSON.stringify({ hooks: {} }),
		);
		return root;
	};

	it("refuses a shipped script that requires a package, naming the script and the package and leaving no tree", () => {
		const out = path.join(tmp, "out");
		expect(() => buildTree(fixture('require("left-pad");'), out)).toThrow(
			"scripts/a.js requires the npm package left-pad",
		);
		expect(fs.existsSync(out)).toBe(false);
	});

	it("names each package a shipped script requires, never a builtin, a relative path or prose", () => {
		const source = [
			'const yaml = require("js-yaml");',
			'const fs = require("node:fs");',
			'const cp = require("child_process");',
			'const lib = require("./lib/x.js");',
			'import { a } from "@scope/pkg/sub";',
			'const late = await import("dyn");',
			'import "side-effect";',
			'const where = require.resolve("resolved");',
			'// cleared from "never fired" to live',
			'// the old guard did require("js-yaml")',
			' * see from "main" for the reason',
		].join("\n");
		let message = "";
		try {
			buildTree(fixture(source), path.join(tmp, "out"));
		} catch (err) {
			message = (err as Error).message;
		}
		expect(
			[...message.matchAll(/requires the npm package (\S+)/g)].map((m) => m[1]),
		).toEqual(["js-yaml", "@scope/pkg/sub", "dyn", "side-effect", "resolved"]);
	});

	it("follows a symlink, but not into a directory already on the walk (#3150)", () => {
		const root = fixture("");
		const out = path.join(tmp, "out");
		const link = (target: string, at: string) =>
			fs.symlinkSync(target, path.join(root, at));
		fs.mkdirSync(path.join(root, "scripts/lib"));
		link(".", "scripts/lib/self");
		link("..", "scripts/lib/up");
		fs.mkdirSync(path.join(root, "scripts/x"));
		fs.mkdirSync(path.join(root, "scripts/y"));
		link("../y", "scripts/x/to-y");
		link("../x", "scripts/y/to-x");
		fs.mkdirSync(path.join(root, "vendored"));
		fs.writeFileSync(path.join(root, "vendored/c.js"), "");
		link("../../vendored", "scripts/lib/v");
		buildTree(root, out);
		expect(readFiles(out).filter((f) => f.startsWith("scripts/"))).toEqual([
			"scripts/a.js",
			"scripts/lib/v/c.js",
		]);
	});

	it("refuses a symlink that resolves to no file, naming it (#3150)", () => {
		const root = fixture("");
		fs.symlinkSync("gone.js", path.join(root, "scripts/b.js"));
		fs.symlinkSync("q.js", path.join(root, "scripts/p.js"));
		fs.symlinkSync("p.js", path.join(root, "scripts/q.js"));
		const out = path.join(tmp, "out");
		expect(() => buildTree(root, out)).toThrow(
			[
				"scripts/b.js is a symlink that resolves to no file",
				"scripts/p.js is a symlink that resolves to no file",
				"scripts/q.js is a symlink that resolves to no file",
			].join("\n"),
		);
	});

	it("refuses an output directory that already exists", () => {
		expect(() => buildTree(fixture(""), tmp)).toThrow(/already exists/);
	});

	it("refuses a lock source the licence notices carry no section for, and an unparseable lock, leaving no tree (#1939)", () => {
		const root = fixture("");
		const lock = path.join(root, "skills-lock.json");
		fs.writeFileSync(
			lock,
			JSON.stringify({
				skills: { a: { source: "x/skills" }, b: { source: "y/skills" } },
			}),
		);
		fs.mkdirSync(path.join(root, ".claude/skills"));
		fs.writeFileSync(
			path.join(root, ".claude/skills/THIRD-PARTY-NOTICES.md"),
			"# Notices\n\n## x/skills\n\nSkills: a\n\nMIT License\n",
		);
		const out = path.join(tmp, "out");
		expect(() => buildTree(root, out)).toThrow(/vendors from y\/skills/);
		expect(fs.existsSync(out)).toBe(false);
		fs.writeFileSync(lock, "{ not json");
		expect(() => buildTree(root, out)).toThrow(/JSON/);
		expect(fs.existsSync(out)).toBe(false);
	});

	it("copies the entry module beside the manifest, and refuses a bare citation in it, naming its file and line", () => {
		const root = fixture("");
		const out = path.join(tmp, "out");
		fs.mkdirSync(path.join(root, "hooks"));
		fs.writeFileSync(
			path.join(root, "hooks/register.ts"),
			"// #1 (gloss)\nexport const register = () => {};\n",
		);
		buildTree(root, out);
		expect(readFiles(out).filter((f) => f.startsWith("hooks/"))).toEqual([
			"hooks/hooks.json",
			"hooks/register.ts",
		]);
		expect(
			JSON.parse(fs.readFileSync(path.join(out, "hooks/hooks.json"), "utf8"))
				.modules,
		).toEqual(["./register.ts"]);
		expect(fs.readFileSync(path.join(out, "hooks/register.ts"), "utf8")).toBe(
			"// workflow-core#1 (gloss)\nexport const register = () => {};\n",
		);

		fs.rmSync(out, { recursive: true });
		fs.writeFileSync(
			path.join(root, "hooks/register.ts"),
			"export const n = 1; // #1\n",
		);
		expect(() => buildTree(root, out)).toThrow(
			"hooks/register.ts:1 prints #1 outside a ( … )",
		);
	});
});

describe("a mod's TypeScript in a fixture (#933)", () => {
	const modDir = ".claude/skills/mod-x";
	const hostTypes = { types: `./${HOST_CONTRACT}` };
	const render = (tree: Record<string, string>, manifest = {}) => {
		const root = path.join(tmp, "src");
		const all: Record<string, string> = {
			"self-plugin/hooks/hooks.json": JSON.stringify({ hooks: {} }),
			".claude-plugin/plugin.json": JSON.stringify({
				name: "host",
				...manifest,
			}),
			[`${modDir}/.claude-plugin/plugin.json`]: JSON.stringify({
				name: "mod-x",
			}),
			...tree,
		};
		for (const [rel, body] of Object.entries(all)) {
			fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
			fs.writeFileSync(path.join(root, rel), body);
		}
		const out = path.join(tmp, "out");
		fs.rmSync(out, { recursive: true, force: true });
		buildTree(root, out);
		return readFiles(out);
	};

	it("ships a mod's hooks and types, and drops its tests, its engine types and every other TypeScript", () => {
		expect(
			render({
				[`${modDir}/hooks/register.tsx`]: "export const a = 1;\n",
				[`${modDir}/hooks/lib.ts`]: "export const b = 1;\n",
				[`${modDir}/types/index.d.ts`]: "export type T = 1;\n",
				[`${modDir}/hooks/register.test.ts`]: "",
				// #2869: a .spec. test in a mod ships no more than a .test. one.
				[`${modDir}/hooks/register.spec.ts`]: "",
				[`${modDir}/tests/mod.test.ts`]: "",
				[`${modDir}/.claude-plugin/types/claude-code/index.d.ts`]: "",
				[`${modDir}/other/x.ts`]: "",
				// A skill with no mod manifest is no mod.
				".claude/skills/plain/hooks/a.ts": "",
				"scripts/x.ts": "",
			}).filter((f) => /\.tsx?$/.test(f)),
		).toEqual([
			`${modDir}/hooks/lib.ts`,
			`${modDir}/hooks/register.tsx`,
			`${modDir}/types/index.d.ts`,
		]);
	});

	it("drops a mod's tsconfig.json and its own hooks/hooks.json, and no other skill's (#1050)", () => {
		const shipped = render({
			[`${modDir}/hooks/register.tsx`]: "export const a = 1;\n",
			[`${modDir}/hooks/hooks.json`]: "{}",
			[`${modDir}/tsconfig.json`]: "{}",
			".claude/skills/plain/hooks/hooks.json": "{}",
			".claude/skills/plain/tsconfig.json": "{}",
		});
		expect(shipped).toContain(`${modDir}/hooks/register.tsx`);
		expect(shipped).toContain(`${modDir}/.claude-plugin/plugin.json`);
		expect(shipped).not.toContain(`${modDir}/hooks/hooks.json`);
		expect(shipped).not.toContain(`${modDir}/tsconfig.json`);
		expect(shipped).toContain(".claude/skills/plain/hooks/hooks.json");
		expect(shipped).toContain(".claude/skills/plain/tsconfig.json");
	});

	it("allows claude-code only where every import of it is type-only", () => {
		expect(
			render({
				[`${modDir}/hooks/register.tsx`]:
					'import type { A } from "claude-code";\nimport type {\n\tB,\n} from "claude-code";\n',
			}),
		).toContain(`${modDir}/hooks/register.tsx`);
		expect(() =>
			render({
				[`${modDir}/hooks/register.tsx`]:
					'import type { A } from "claude-code";\nimport { b } from "claude-code";\n',
			}),
		).toThrow(
			`${modDir}/hooks/register.tsx requires the npm package claude-code`,
		);
	});

	it("refuses any other package a mod imports, type-only or not, naming the file and the package", () => {
		expect(() =>
			render({
				[`${modDir}/hooks/register.ts`]: 'import type { A } from "left-pad";\n',
			}),
		).toThrow(`${modDir}/hooks/register.ts requires the npm package left-pad`);
		expect(() =>
			render({
				[`${modDir}/hooks/register.tsx`]: 'import { a } from "left-pad";\n',
			}),
		).toThrow(`${modDir}/hooks/register.tsx requires the npm package left-pad`);
	});

	it("qualifies a kept module's citations and refuses a bare one on a code line, naming its file and line", () => {
		render({
			[`${modDir}/hooks/register.tsx`]:
				'// Ruled at #12.\nconst S = "Shipped (#34).";\n',
		});
		expect(
			fs.readFileSync(
				path.join(tmp, "out", modDir, "hooks/register.tsx"),
				"utf8",
			),
		).toBe(
			'// Ruled at workflow-core#12.\nconst S = "Shipped (workflow-core#34).";\n',
		);
		expect(() =>
			render({
				[`${modDir}/hooks/register.tsx`]: 'const S = "Shipped #34.";\n',
			}),
		).toThrow(`${modDir}/hooks/register.tsx:1 prints #34 outside a ( … )`);
	});

	it("renames the mod's state owner to the host plugin in the shipped copy only", () => {
		const module =
			'const R = { plugin: "mod-x", key: "r" } as const;\n$.ui.log("mod-x: up");\n';
		const contract =
			'export type R = number;\n\ndeclare module "claude-code" {\n\tinterface PluginState {\n\t\t"mod-x": {\n\t\t\tr: R;\n\t\t};\n\t}\n}\n';
		render(
			{
				[`${modDir}/hooks/register.ts`]: module,
				[`${modDir}/types/index.d.ts`]: contract,
			},
			hostTypes,
		);
		const readShipped = (rel: string) =>
			fs.readFileSync(path.join(tmp, "out", modDir, rel), "utf8");
		expect(readShipped("hooks/register.ts")).toBe(
			'const R = { plugin: "host", key: "r" } as const;\n$.ui.log("mod-x: up");\n',
		);
		expect(readShipped("types/index.d.ts")).toBe("export type R = number;\n\n");
		expect(fs.readFileSync(path.join(tmp, "out", HOST_CONTRACT), "utf8")).toBe(
			contract.replace('"mod-x": {', '"host": {'),
		);
		expect(
			fs.readFileSync(
				path.join(tmp, "src", modDir, "hooks/register.ts"),
				"utf8",
			),
		).toBe(module);
	});

	it("composes a contract's key behind a comment or another key", () => {
		render(
			{
				[`${modDir}/types/index.d.ts`]:
					'declare module "claude-code" {\n\tinterface PluginState {\n\t\t/** Ours. */\n\t\t"mod-x": { r: number };\n\t}\n}\n',
			},
			hostTypes,
		);
		expect(
			fs.readFileSync(path.join(tmp, "out", HOST_CONTRACT), "utf8"),
		).toContain('\t\t"host": {\n r: number\n\t\t};');
	});

	it("composes every mod's state under the host, and refuses a key two mods declare (#3251)", () => {
		const modY = ".claude/skills/mod-y";
		const contractOf = (mod: string, key: string) =>
			`declare module "claude-code" {\n\tinterface PluginState {\n\t\t"${mod}": {\n\t\t\t${key}: number;\n\t\t};\n\t}\n}\n`;
		const tree = (yKey: string) => ({
			[`${modDir}/types/index.d.ts`]: contractOf("mod-x", "r"),
			[`${modY}/.claude-plugin/plugin.json`]: JSON.stringify({ name: "mod-y" }),
			[`${modY}/types/index.d.ts`]: contractOf("mod-y", yKey),
		});
		render(tree("s"), hostTypes);
		expect(
			fs.readFileSync(path.join(tmp, "out", HOST_CONTRACT), "utf8"),
		).toContain('"host": {\n\t\t\tr: number;\n\t\t\ts: number;\n\t\t};');
		expect(() => render(tree("r"), hostTypes)).toThrow(
			`${modY}/types/index.d.ts and ${modDir}/types/index.d.ts both declare the state key r`,
		);
	});

	it("refuses a contract it cannot compose: PluginState elsewhere, or a brace never closed", () => {
		expect(() =>
			render(
				{
					[`${modDir}/hooks/state.d.ts`]:
						'declare module "claude-code" {\n\tinterface PluginState {\n\t\t"mod-x": { r: number };\n\t}\n}\n',
				},
				hostTypes,
			),
		).toThrow(
			`${modDir}/hooks/state.d.ts declares PluginState outside types/index.d.ts`,
		);
		expect(() =>
			render(
				{
					[`${modDir}/types/index.d.ts`]:
						'declare module "claude-code" {\n\tinterface PluginState {\n\t\t"mod-x": { r: number };\n',
				},
				hostTypes,
			),
		).toThrow(`${modDir}/types/index.d.ts opens a brace`);
	});

	it("refuses, rather than rescanning forever, a block ending in a comment with no newline", () => {
		expect(() =>
			render(
				{
					[`${modDir}/types/index.d.ts`]:
						'declare module "claude-code" {\n\tinterface PluginState {\n\t\t"mod-x": { r: number }; // open',
				},
				hostTypes,
			),
		).toThrow(`${modDir}/types/index.d.ts opens a brace`);
	});

	it("reads a member key past a comment or string holding a brace or slashes", () => {
		const modY = ".claude/skills/mod-y";
		const contractOf = (mod: string, members: string) =>
			`declare module "claude-code" {\n\tinterface PluginState {\n\t\t"${mod}": {\n${members}\n\t\t};\n\t}\n}\n`;
		expect(() =>
			render(
				{
					[`${modDir}/types/index.d.ts`]: contractOf(
						"mod-x",
						'\t\t\t/** A { brace. */\n\t\t\tkind: "a//b" | "{";\n\t\t\tnested: { r: number };',
					),
					[`${modY}/.claude-plugin/plugin.json`]: JSON.stringify({
						name: "mod-y",
					}),
					[`${modY}/types/index.d.ts`]: contractOf("mod-y", "\t\t\tr: number;"),
				},
				hostTypes,
			),
		).not.toThrow();
		expect(() =>
			render(
				{
					[`${modDir}/types/index.d.ts`]: contractOf(
						"mod-x",
						'\t\t\tkind: "a//b";\n\t\t\tr: number;',
					),
					[`${modY}/.claude-plugin/plugin.json`]: JSON.stringify({
						name: "mod-y",
					}),
					[`${modY}/types/index.d.ts`]: contractOf("mod-y", "\t\t\tr: number;"),
				},
				hostTypes,
			),
		).toThrow("both declare the state key r");
	});

	it("refuses a manifest naming any other types file than the composed one", () => {
		expect(() =>
			render({
				[`${modDir}/types/index.d.ts`]:
					'declare module "claude-code" {\n\tinterface PluginState {\n\t\t"mod-x": { r: number };\n\t}\n}\n',
			}),
		).toThrow(
			`.claude-plugin/plugin.json names "types": undefined, not the composed ./${HOST_CONTRACT}`,
		);
	});

	it("refuses a mod whose state owner it cannot rename", () => {
		expect(() =>
			render({
				[`${modDir}/hooks/register.ts`]:
					'const OWNER = "mod-x";\nconst R = { plugin: OWNER, key: "r" };\n$.state.get(R);\n',
			}),
		).toThrow(`${modDir}/hooks/register.ts calls $.state with no`);
		expect(() =>
			render({
				[`${modDir}/hooks/register.ts`]: "",
				[`${modDir}/types/index.d.ts`]:
					'declare module "claude-code" {\n\tinterface PluginState {\n\t\t"other": { r: number };\n\t}\n}\n',
			}),
		).toThrow(`${modDir}/types/index.d.ts declares no PluginState key "mod-x"`);
	});
});
