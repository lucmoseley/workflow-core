// @vitest-environment node
/*
 * Pins that every anchored rule region is a fragment on disk byte for byte with
 * a trigger, that `--check` refuses a source edit left unrendered or a malformed
 * anchor pair, that an absent source is skipped aloud, and that
 * `.husky/pre-commit` arms `--check` on the generator's own `--sources` list,
 * refusing a commit when that list cannot be read (#3118).
 *
 * generate-rule-fragments.js renders docs/agents/rules/<id>.txt from an anchor
 * pair in the document that authors the rule (mantahostels#2493, spec mantahostels#2457 §T2).
 *
 * The store's own copy is asserted against the live document, not against a
 * fixture: a fixture would let the two drift and still pass.
 *
 * `--check` is a hard gate in `.husky/pre-commit`: a false pass lets a rule's
 * authored text and the fragment a guard hands sessions drift apart, so a
 * session is handed a rule the documents no longer state.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	cutGateScript,
	registerTempCleanup,
	stagedRepo,
} from "./lib/precommit-gate-harness";
import { runInProcess } from "./lib/run-in-process";

const ROOT = path.resolve(__dirname, "..");
const GEN = path.join(ROOT, "scripts", "generate-rule-fragments.js");
const STORE = path.join("docs", "agents", "rules");
const MANIFEST = "docs/agents/rules/manifest.json";

const check = () =>
	spawnSync("node", [GEN, "--check"], {
		cwd: ROOT,
		encoding: "utf8",
		env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT },
	});

/** The generator run over `dir` as the host repo. */
const runOver = (dir: string, args: string[] = []) =>
	runInProcess(GEN, args, { env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });

/** A scratch host repo, removed once `fn` returns. */
function scratch<T>(fn: (dir: string) => T): T {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rule-frag-"));
	try {
		return fn(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/** The committed manifest's rules: id → the source anchoring it. */
const readCommitted = (): Record<string, { source: string; trigger: string }> =>
	JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST), "utf8")).rules;

/** Every source the generator scans, as it names them when each is absent. */
const sourcesSkipped = () =>
	scratch((dir) =>
		[...runOver(dir).stdout.matchAll(/SKIP (\S+) \(absent/g)].map((m) =>
			String(m[1]),
		),
	);

describe("the committed store matches its anchored source", () => {
	it("--check is green on the tree as committed", () => {
		const r = check();
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
	});

	it("rendering the live documents afresh reproduces every fragment on disk, byte for byte", () => {
		const rules = readCommitted();
		expect(Object.keys(rules).length).toBeGreaterThan(0);
		scratch((dir) => {
			for (const s of sourcesSkipped()) {
				fs.mkdirSync(path.dirname(path.join(dir, s)), { recursive: true });
				fs.copyFileSync(path.join(ROOT, s), path.join(dir, s));
			}
			expect(runOver(dir).status).toBe(0);
			expect(fs.readFileSync(path.join(dir, MANIFEST), "utf8")).toBe(
				fs.readFileSync(path.join(ROOT, MANIFEST), "utf8"),
			);
			for (const id of Object.keys(rules)) {
				const read = (root: string) =>
					fs.readFileSync(path.join(root, STORE, `${id}.txt`), "utf8");
				// Trailing newlines are what both accessors trim; nothing else may differ.
				expect(read(dir).replace(/\n+$/, "")).toBe(
					read(ROOT).replace(/\n+$/, ""),
				);
			}
		});
	});
});

describe("--check refuses a source edit that was not re-rendered", () => {
	it("names the stale fragment and exits 1", () => {
		const rel = "docs/agents/rules/takes-value-vocabulary.txt";
		const file = path.join(ROOT, rel);
		const before = fs.readFileSync(file, "utf8");
		try {
			// Stand in for an edit to the anchored region: the two sides disagree
			// either way, and mutating the generated copy leaves the authored
			// document untouched for every other session sharing this tree.
			fs.writeFileSync(
				file,
				`${before}| \`takes:invented\` | not a value | — |\n`,
			);
			const r = check();
			expect(r.status).toBe(1);
			expect(r.stderr).toContain(rel);
			expect(r.stderr).toContain("gen:rule-fragments");
		} finally {
			fs.writeFileSync(file, before);
		}
		expect(check().status).toBe(0);
	});
});

describe("a malformed anchor pair refuses rather than rendering half a rule", () => {
	/** A repo whose first source holds `body` alone, checked by the generator. */
	const checkOver = (body: string) =>
		scratch((dir) => {
			const [first] = sourcesSkipped();
			if (first === undefined) throw new Error("the generator names no source");
			const file = path.join(dir, first);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, body);
			return runOver(dir, ["--check"]);
		});

	it.each([
		["an unclosed anchor", "<!-- rule:a-b:begin -->\ntext\n", /never closed/],
		[
			"a nested anchor",
			"<!-- rule:a-b:begin -->\n<!-- rule:c-d:begin -->\n",
			/opens inside/,
		],
		[
			"an empty region",
			"<!-- rule:a-b:begin -->\n\n<!-- rule:a-b:end -->\n",
			/is empty/,
		],
		["an end that closes nothing", "<!-- rule:a-b:end -->\n", /closes nothing/],
		[
			"an anchored id with no trigger",
			"<!-- rule:a-b:begin -->\ntext\n<!-- rule:a-b:end -->\n",
			/rule:a-b is anchored in .* but names no trigger/,
		],
	])("%s refuses", (_name, body, message) => {
		const r = checkOver(body);
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(message);
	});
});

/* An adopter need not carry every source: fantasy-books has no
 * triage-labels.md, and a throw there refused every commit its gate saw. */
describe("an absent source is skipped aloud, never thrown on", () => {
	it("passes --check in a repo holding neither source nor a store, naming each skip", () => {
		scratch((dir) => {
			runOver(dir);
			const r = runOver(dir, ["--check"]);
			expect(r.stderr).toBe("");
			expect(r.status).toBe(0);
			const sources = new Set(
				Object.values(readCommitted()).map((e) => e.source),
			);
			expect(sources.size).toBeGreaterThan(0);
			for (const s of sources) expect(r.stdout).toContain(`SKIP ${s}`);
			// Rendered into the host's own store, not the core's fallback one.
			expect(fs.existsSync(path.join(dir, MANIFEST))).toBe(true);
		});
	});
});

describe("the source list", () => {
	it("names documents that exist", () => {
		const sources = sourcesSkipped();
		expect(sources.length).toBeGreaterThan(0);
		for (const s of sources)
			expect(fs.existsSync(path.join(ROOT, s))).toBe(true);
	});
});

describe("the pre-commit gate's arming (#3118)", () => {
	const temps = registerTempCleanup(afterEach);

	/** The gate, cut from the real hook, run over `cwd` as the host repo. */
	const runGate = (cwd: string, plugin = ROOT) =>
		spawnSync(
			"sh",
			[
				"-c",
				`{ ${cutGateScript("generate-rule-fragments.js --check")}\n} 2>&1`,
			],
			{
				cwd,
				env: {
					...process.env,
					WFC_PLUGIN_ROOT: plugin,
					CLAUDE_PROJECT_DIR: cwd,
				},
				encoding: "utf8",
			},
		);

	/** Every source and the committed store, as the core holds them. */
	const committed = () =>
		Object.fromEntries(
			[
				...sourcesSkipped(),
				...fs
					.readdirSync(path.join(ROOT, STORE))
					.map((f) => path.join(STORE, f)),
			].map((rel) => [rel, fs.readFileSync(path.join(ROOT, rel), "utf8")]),
		);

	it("--sources lists every document the generator scans", () => {
		const r = runOver(ROOT, ["--sources"]);
		expect(r.status).toBe(0);
		expect(r.stdout.trimEnd().split("\n")).toEqual(sourcesSkipped());
	});

	it.each(sourcesSkipped())(
		"refuses a commit editing an anchored region of %s left unrendered",
		(source) => {
			const seed = committed();
			const edited = seed[source].replace(
				/(<!-- rule:[^:]+:begin -->\n)/,
				"$1An edit inside the anchors.\n",
			);
			expect(edited).not.toBe(seed[source]);
			const { root } = stagedRepo("rule-frag-gate-", temps, seed, {
				[source]: edited,
			});
			const r = runGate(root);
			expect(r.stdout).toMatch(/out of step with their anchored source/);
			expect(r.status).toBe(1);
		},
	);

	it("refuses --check and --sources together as a usage error", () => {
		const r = runOver(ROOT, ["--check", "--sources"]);
		expect(r.stderr).toMatch(/exclusive/);
		expect(r.status).toBe(2);
	});

	it("refuses the commit when the generator cannot list its sources", () => {
		const broken = fs.mkdtempSync(path.join(os.tmpdir(), "rule-frag-plugin-"));
		temps.push(broken);
		fs.mkdirSync(path.join(broken, "scripts"));
		fs.writeFileSync(
			path.join(broken, "scripts", "generate-rule-fragments.js"),
			"process.exit(3);\n",
		);
		const { root } = stagedRepo(
			"rule-frag-gate-",
			temps,
			{},
			{
				"docs/other.md": "unrelated\n",
			},
		);
		const r = runGate(root, broken);
		expect(r.stdout).toMatch(/could not list its sources/);
		expect(r.status).toBe(1);
	});

	it("stays unarmed on a commit touching no source and no fragment", () => {
		const { root } = stagedRepo(
			"rule-frag-gate-",
			temps,
			{},
			{
				"docs/other.md": "unrelated\n",
			},
		);
		const r = runGate(root);
		expect(r.stdout).toBe("");
		expect(r.status).toBe(0);
	});
});

describe("the standards base as a source (#1887)", () => {
	it("anchors §X8, §X9 and §X10, each bound at a test-file write, judging sentences left out", () => {
		const rules = readCommitted();
		const rendered = {
			"test-run-cost": {
				heading: "### §X8 ·",
				text: fs.readFileSync(
					path.join(ROOT, "docs/agents/rules/test-run-cost.txt"),
					"utf8",
				),
			},
			"test-time-seam": {
				heading: "### §X9 ·",
				text: fs.readFileSync(
					path.join(ROOT, "docs/agents/rules/test-time-seam.txt"),
					"utf8",
				),
			},
			"test-reads-visible": {
				heading: "### §X10 ·",
				text: fs.readFileSync(
					path.join(ROOT, "docs/agents/rules/test-reads-visible.txt"),
					"utf8",
				),
			},
		};
		for (const [id, { heading, text }] of Object.entries(rendered)) {
			expect(rules[id]).toEqual({
				source: "docs/code-standards-base.md",
				trigger: "a `Write`, `Edit` or `NotebookEdit` to a test file",
			});
			expect(text.startsWith(heading)).toBe(true);
			expect(text).not.toMatch(/^Judge |^`judgement` because|ruled widening/m);
		}
	});
});
