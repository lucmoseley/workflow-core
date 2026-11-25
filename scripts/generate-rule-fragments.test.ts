// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dispatch } from "./lib/precommit-dispatch.js";
import { registerTempCleanup, stagedRepo } from "./lib/precommit-gate-harness";
import { buildRepoPorts } from "./lib/precommit-gate-testkit";
import { GATES } from "./lib/precommit-gates.js";
import { runInProcess } from "./lib/run-in-process";

const ROOT = path.resolve(__dirname, "..");
const GEN = path.join(ROOT, "scripts", "generate-rule-fragments.js");
const STORE = path.join("docs", "agents", "rules");
const MANIFEST = "docs/agents/rules/manifest.json";

const check = () =>
	runInProcess(GEN, ["--check"], {
		cwd: ROOT,
		env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT },
	});

const runOver = (dir: string, args: string[] = []) =>
	runInProcess(GEN, args, { env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });

function scratch<T>(fn: (dir: string) => T): T {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rule-frag-"));
	try {
		return fn(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

const readCommitted = (): Record<string, { source: string; trigger: string }> =>
	JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST), "utf8")).rules;

const sourcesSkipped = () =>
	scratch((dir) =>
		[...runOver(dir).stdout.matchAll(/SKIP (\S+) \(absent/g)].map((m) =>
			String(m[1]),
		),
	);

const committed = (): Record<string, string> =>
	Object.fromEntries(
		[
			...sourcesSkipped(),
			...fs.readdirSync(path.join(ROOT, STORE)).map((f) => path.join(STORE, f)),
		].map((rel) => [rel, fs.readFileSync(path.join(ROOT, rel), "utf8")]),
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
				expect(read(dir).replace(/\n+$/, "")).toBe(
					read(ROOT).replace(/\n+$/, ""),
				);
			}
		});
	});
});

describe("--check refuses a source edit that was not re-rendered", () => {
	it("names the stale fragment and exits 1", () => {
		scratch((dir) => {
			for (const [rel, text] of Object.entries(committed())) {
				fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
				fs.writeFileSync(path.join(dir, rel), text);
			}
			expect(runOver(dir, ["--check"]).status).toBe(0);
			const rel = "docs/agents/rules/takes-value-vocabulary.txt";
			fs.appendFileSync(
				path.join(dir, rel),
				"| `takes:invented` | not a value | — |\n",
			);
			const r = runOver(dir, ["--check"]);
			expect(r.status).toBe(1);
			expect(r.stderr).toContain(rel);
			expect(r.stderr).toContain("gen:rule-fragments");
		});
	});
});

describe("an id anchored in two documents", () => {
	it("--check refuses, naming both documents", () => {
		scratch((dir) => {
			const [first, second] = sourcesSkipped();
			if (first === undefined || second === undefined)
				throw new Error("the generator names fewer than two sources");
			for (const rel of [first, second]) {
				fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
				fs.writeFileSync(
					path.join(dir, rel),
					"<!-- rule:roadmap-gating:begin -->\ntext\n<!-- rule:roadmap-gating:end -->\n",
				);
			}
			const r = runOver(dir, ["--check"]);
			expect(r.stderr).toBe(
				`generate-rule-fragments: rule:roadmap-gating is anchored in both ${first} and ${second}\n`,
			);
			expect(r.status).toBe(1);
		});
	});
});

describe("a malformed anchor pair refuses rather than rendering half a rule", () => {
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
		[
			"an unclosed span",
			"<!-- rule:a-b:begin -->\nx <!-- rule:c-d:begin -->y\n<!-- rule:a-b:end -->\n",
			/span rule:c-d is never closed/,
		],
		[
			"a nested span",
			"<!-- rule:a-b:begin -->\n<!-- rule:c-d:begin -->x<!-- rule:e-f:begin -->y\n<!-- rule:a-b:end -->\n",
			/span rule:e-f opens inside rule:c-d/,
		],
		[
			"a span closing another id",
			"<!-- rule:a-b:begin -->\n<!-- rule:c-d:begin -->x<!-- rule:e-f:end -->\n<!-- rule:a-b:end -->\n",
			/span rule:e-f closes rule:c-d/,
		],
		[
			"an empty span",
			"<!-- rule:a-b:begin -->\nx <!-- rule:c-d:begin --> <!-- rule:c-d:end -->\n<!-- rule:a-b:end -->\n",
			/span rule:c-d is empty/,
		],
		[
			"a span outside every region",
			"x <!-- rule:c-d:begin -->y<!-- rule:c-d:end -->\n",
			/a rule span sits outside every anchored region/,
		],
	])("%s refuses", (_name, body, message) => {
		const r = checkOver(body);
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(message);
	});
});

describe("a span inside a region (#4155)", () => {
	it("renders as its own fragment, and the region's fragment carries its text without the comments", () => {
		scratch((dir) => {
			const [first] = sourcesSkipped();
			if (first === undefined) throw new Error("the generator names no source");
			const file = path.join(dir, first);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(
				file,
				"<!-- rule:roadmap-gating:begin -->\nGates carry <!-- rule:gate-basis-line:begin -->a basis\nline<!-- rule:gate-basis-line:end --> beneath.\n<!-- rule:roadmap-gating:end -->\n",
			);
			expect(runOver(dir).status).toBe(0);
			const read = (id: string) =>
				fs.readFileSync(path.join(dir, STORE, `${id}.txt`), "utf8");
			expect(read("roadmap-gating")).toBe(
				"Gates carry a basis\nline beneath.\n",
			);
			expect(read("gate-basis-line")).toBe("a basis\nline\n");
			const manifest = JSON.parse(
				fs.readFileSync(path.join(dir, MANIFEST), "utf8"),
			).rules;
			expect(manifest["gate-basis-line"].source).toBe(first);
		});
	});
});

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

describe("the pre-commit row (#3118, #5172)", () => {
	const temps = registerTempCleanup(afterEach);
	const row = GATES.find((g) => g.id === "rule-fragments");
	const { PROGRAM, SOURCES } =
		require("./generate-rule-fragments.js") as typeof import("./generate-rule-fragments.js");

	async function arms(staged: Record<string, string>): Promise<boolean> {
		if (!row || !("computed" in row.arm)) throw new Error("no computed row");
		const name = row.arm.computed;
		const { root } = stagedRepo("rule-frag-arm-", temps, {}, staged);
		let ran = false;
		await dispatch({
			rows: [row],
			gates: "all",
			ports: buildRepoPorts(root, {
				computed: (n) => (n === name ? SOURCES : []),
				load: () => () => {
					ran = true;
					return { exit: 0, stdout: "", stderr: "" };
				},
			}),
		});
		return ran;
	}

	it("arms on every document the generator scans, as the generator names them", async () => {
		expect(SOURCES).toEqual(sourcesSkipped());
		for (const source of SOURCES)
			expect(await arms({ [source]: "x\n" }), source).toBe(true);
	});

	it("arms on the store, and not on a commit touching neither", async () => {
		expect(await arms({ [`${STORE}/x.txt`]: "x\n" })).toBe(true);
		expect(await arms({ "docs/other.md": "unrelated\n" })).toBe(false);
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
			const r = PROGRAM({ cwd: root, env: process.env });
			expect(r.stderr).toMatch(/out of step with their anchored source/);
			expect(r.exit).toBe(1);
		},
	);
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
