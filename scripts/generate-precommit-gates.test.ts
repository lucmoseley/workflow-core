// @vitest-environment node
/*
 * generate-precommit-gates.js (#4597): the live hook is the render of the
 * live registry, a new row is one block in its region, and `--check` judges
 * the index. The hook gate running `--check` is pinned in
 * precommit-whole-repo-gates.test.ts.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { begin, end, render } from "./generate-precommit-gates.js";
import { registerTempCleanup, stagedRepo } from "./lib/precommit-gate-harness";
import { HOOK, ROOT } from "./lib/precommit-gate-testkit";
import { FLAG_ARGS, GATES, type PrecommitGate } from "./lib/precommit-gates.js";
import { runInProcess } from "./lib/run-in-process.js";

const temps = registerTempCleanup();
const registry = { FLAG_ARGS, GATES };
/* Interpolated: a shell `${...}` in a plain string trips Biome's
 * noTemplateCurlyInString. */
const Dollar = "$";
const SCRIPT = path.join(ROOT, "scripts", "generate-precommit-gates.js");
const REGISTRY_SOURCE = fs.readFileSync(
	path.join(ROOT, "scripts", "lib", "precommit-gates.js"),
	"utf8",
);

/** A hook carrying both empty regions around the merge-set exit. */
const SKELETON = [
	"#!/bin/sh",
	begin("merge"),
	end("merge"),
	'if [ "$wfc_gates" = merge ]; then',
	"  exit 0",
	"fi",
	begin("batch"),
	end("batch"),
	"",
].join("\n");

const row = (over: Partial<PrecommitGate>): PrecommitGate => ({
	id: "new-gate",
	script: "scripts/check-new-gate.js",
	flag: "index",
	arm: String.raw`'^scripts/.+\.js$'`,
	lander: "batch",
	staged: "scripts/a.js",
	refusals: ["a new fault"],
	notice: { scope: "every new fault", cite: "(#1)", cost: "refuses" },
	floor: true,
	...over,
});

const renderOf = (...gates: PrecommitGate[]) =>
	render(SKELETON, { ...registry, GATES: gates });

describe("the live hook", () => {
	it("is the render of the live registry", () => {
		expect(render(HOOK, registry)).toBe(HOOK);
	});

	it("renders the merge region before the merge set's exit, the batch region after", () => {
		const exit = HOOK.indexOf('if [ "$wfc_gates" = merge ]; then');
		expect(HOOK.indexOf(end("merge"))).toBeLessThan(exit);
		expect(HOOK.indexOf(begin("batch"))).toBeGreaterThan(exit);
	});
});

describe("a registry row", () => {
	it("renders as one gate block in the batch region, with no other edit", () => {
		expect(renderOf(row({}))).toBe(
			SKELETON.replace(
				`${begin("batch")}\n`,
				() =>
					`${begin("batch")}\n` +
					"if armed '^scripts/.+\\.js$'; then\n" +
					`  node "${Dollar}{WFC_PLUGIN_ROOT:-.}"/scripts/check-new-gate.js --index || exit "$?"\n` +
					"fi\n",
			),
		);
	});

	it("stands down in the lander's batch set unless it is a batch gate", () => {
		expect(renderOf(row({ lander: "none" }))).toContain(
			"if ! lander_batch && armed '^scripts/.+\\.js$'; then",
		);
	});

	it("renders in the merge region where the merge set runs it", () => {
		const out = renderOf(row({ lander: "merge", flag: "against" }));
		expect(out.indexOf("check-new-gate.js --against HEAD")).toBeLessThan(
			out.indexOf(end("merge")),
		);
	});

	it("puts a blank line between blocks", () => {
		expect(renderOf(row({}), row({ script: "scripts/check-b.js" }))).toContain(
			'|| exit "$?"\nfi\n\nif armed',
		);
	});
});

it("refuses a hook missing a region's marker pair", () => {
	expect(() =>
		render(SKELETON.replace(`${end("batch")}\n`, ""), registry),
	).toThrow(/precommit-gates:batch/);
});

describe("--check, over the index", () => {
	const repo = (staged: Record<string, string>) =>
		stagedRepo("precommit-gates-", temps, {}, staged).root;
	const run = (cwd: string, args = ["--check"]) =>
		runInProcess(SCRIPT, args, {
			cwd,
			env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
		});
	const fresh = {
		".husky/pre-commit": HOOK,
		"scripts/lib/precommit-gates.js": REGISTRY_SOURCE,
	};
	const stale = HOOK.replace(
		"check-jsonl-reads.js --index",
		"check-x.js --index",
	);

	it("passes a hook that is the registry's render", () => {
		expect(run(repo(fresh)).status).toBe(0);
	});

	it("refuses a stale region, naming the re-render", () => {
		const r = run(repo({ ...fresh, ".husky/pre-commit": stale }));
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("precommit-gates regions are stale");
		expect(r.stderr).toContain("generate-precommit-gates.js, then stage");
	});

	it("judges the index, not an unstaged worktree edit", () => {
		const root = repo(fresh);
		fs.writeFileSync(path.join(root, ".husky", "pre-commit"), stale);
		expect(run(root).status).toBe(0);
	});

	it("passes a repo whose index holds no registry", () => {
		expect(run(repo({ ".husky/pre-commit": stale })).status).toBe(0);
	});

	it("exits 2 on a hook with no region", () => {
		const r = run(repo({ ...fresh, ".husky/pre-commit": "#!/bin/sh\n" }));
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("precommit-gates:merge");
	});
});

it("re-renders the worktree's hook in place", () => {
	const root = stagedRepo("precommit-gates-", temps, {}, {}).root;
	fs.mkdirSync(path.join(root, ".husky"));
	fs.mkdirSync(path.join(root, "scripts", "lib"), { recursive: true });
	fs.writeFileSync(path.join(root, ".husky", "pre-commit"), SKELETON);
	fs.writeFileSync(
		path.join(root, "scripts", "lib", "precommit-gates.js"),
		REGISTRY_SOURCE,
	);

	const r = runInProcess(SCRIPT, [], {
		cwd: root,
		env: { ...process.env, CLAUDE_PROJECT_DIR: root },
	});

	expect(r.status).toBe(0);
	expect(fs.readFileSync(path.join(root, ".husky", "pre-commit"), "utf8")).toBe(
		render(SKELETON, registry),
	);
});
