// @vitest-environment node
/*
 * inject-test-rules.sh hands a session base §X8, §X9 and §X10 the first time it
 * writes a test file (#1887, spec #1869). Break it and a session writes a slow
 * or unselectable test with the rules it breaks never in front of it.
 *
 * Fragments are read from docs/agents/rules/ and the byte cap from
 * guard-parse.sh, never copied.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineTemplate, initGitRepo, mkScratchDir } from "./lib/git-fixture";
import { guardOutput } from "./lib/pretool-guard-testkit";
import { shellConst } from "./lib/shell-const-testkit";
import { COLLECTED_TEST, isTestKind } from "./lib/test-kind.js";

const HOOK = path.resolve(__dirname, "inject-test-rules.sh");
const GP_RULE_CAP = shellConst(
	path.join(__dirname, "lib", "guard-parse.sh"),
	"GP_RULE_CAP",
);
const RUN_COST = fs
	.readFileSync(
		path.resolve(
			__dirname,
			"..",
			"docs",
			"agents",
			"rules",
			"test-run-cost.txt",
		),
		"utf8",
	)
	.trim();
const TIME_SEAM = fs
	.readFileSync(
		path.resolve(
			__dirname,
			"..",
			"docs",
			"agents",
			"rules",
			"test-time-seam.txt",
		),
		"utf8",
	)
	.trim();
const READS_VISIBLE = fs
	.readFileSync(
		path.resolve(
			__dirname,
			"..",
			"docs",
			"agents",
			"rules",
			"test-reads-visible.txt",
		),
		"utf8",
	)
	.trim();

/* A `node` ahead of the real one on PATH that records each start, so a case
 * can tell whether the hook started one. */
const template = defineTemplate((root) => {
	const hooks = path.join(root, "no-hooks");
	fs.mkdirSync(hooks);
	initGitRepo(path.join(root, "repo"), hooks);
	const bin = path.join(root, "bin");
	fs.mkdirSync(bin);
	fs.writeFileSync(
		path.join(bin, "node"),
		`#!/usr/bin/env bash\necho started >>"\${0%/*}/../node-starts"\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
		{ mode: 0o755 },
	);
});

let dir: string;
let repo: string;

beforeEach(() => {
	dir = mkScratchDir("test-rules-");
	template.instantiate(dir);
	repo = path.join(dir, "repo");
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const nodeStarts = () => {
	const log = path.join(dir, "node-starts");
	return fs.existsSync(log)
		? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).length
		: 0;
};

const envelope = (
	file: string,
	{
		tool = "Write",
		extra = {} as Record<string, string>,
		base = repo,
		project = repo,
	} = {},
): string | null => {
	const parsed = guardOutput(
		HOOK,
		{
			tool_name: tool,
			tool_input:
				tool === "NotebookEdit"
					? { notebook_path: `${base}/${file}` }
					: { file_path: `${base}/${file}` },
			session_id: "abcdef12-3456",
		},
		{
			project,
			config: dir,
			env: { PATH: `${path.join(dir, "bin")}:${process.env.PATH}`, ...extra },
		},
	);
	if (!parsed) return null;
	expect(parsed.permissionDecision).toBeUndefined();
	return parsed.additionalContext;
};

describe("a test-file write", () => {
	it("injects §X8, §X9 and §X10 in that order, and a second write nothing", () => {
		expect(envelope("scripts/foo.test.ts")).toBe(
			`${RUN_COST}\n\n${TIME_SEAM}\n\n${READS_VISIBLE}`,
		);
		expect(envelope("scripts/bar.test.js", { tool: "Edit" })).toBeNull();
	});

	// One spawn per word the shell pre-filter passes, isTestKind imported so an
	// edit to the predicate selects this file.
	it.each([
		"app/a.test.jsx",
		"scripts/test_foo.py",
		"lib/fixtures/data.json",
		"lib/stubs/gh.js",
		"lib/fake-clock.js",
		"scripts/lib/run-harness.js",
		"pkg/a.test.py",
		"src/a.spec.ts",
	])(
		"injects on %s, a path base §X binds or a runner collects (#2101, #2109)",
		(file) => {
			expect(isTestKind(file) || COLLECTED_TEST.test(file)).toBe(true);
			expect(envelope(file)).toContain(RUN_COST);
		},
	);

	it("injects on a mid-path `..` that stays inside the checkout (#2546)", () => {
		expect(envelope("sub/../tests/a.ts")).toContain(RUN_COST);
	});

	// The harness sends CLAUDE_PROJECT_DIR physical and the path as the model
	// spelled it, measured on Claude Code 2.1.308 (#2553); a symlinked project
	// dir is gr_root's to resolve.
	it.each([
		["physical", false],
		["the symlink", true],
	])(
		"injects on a write spelled through a symlink to the checkout, project dir %s (#2553)",
		(_, viaLink) => {
			const link = path.join(dir, "link");
			fs.symlinkSync(repo, link);
			const project = viaLink ? link : repo;
			expect(envelope("scripts/a.test.ts", { base: link, project })).toBe(
				`${RUN_COST}\n\n${TIME_SEAM}\n\n${READS_VISIBLE}`,
			);
		},
	);

	it("carries a deferral under the cap to the next test write", () => {
		const store = path.join(dir, "rules");
		fs.mkdirSync(store);
		fs.writeFileSync(
			path.join(store, "test-run-cost.txt"),
			"r".repeat(GP_RULE_CAP - 100),
		);
		fs.writeFileSync(path.join(store, "test-time-seam.txt"), "t".repeat(200));
		fs.writeFileSync(
			path.join(store, "test-reads-visible.txt"),
			"v".repeat(200),
		);
		const extra = { WFC_RULES_DIR: store };
		expect(envelope("a.test.ts", { extra })).toBe(
			"r".repeat(GP_RULE_CAP - 100),
		);
		expect(envelope("b.test.ts", { extra })).toBe(
			`${"t".repeat(200)}\n\n${"v".repeat(200)}`,
		);
	});
});

describe("any other write", () => {
	it("injects nothing and starts no node on a path with no test-like name", () => {
		expect(envelope("docs/notes.md")).toBeNull();
		expect(envelope("x.ipynb", { tool: "NotebookEdit" })).toBeNull();
		expect(nodeStarts()).toBe(0);
	});

	it("injects nothing where the shared predicate refuses a name the pre-filter let through", () => {
		expect(envelope("docs/latest.md")).toBeNull();
		expect(envelope("scripts/stubborn.js")).toBeNull();
		expect(envelope("lib/inspect.ts")).toBeNull();
		// Not vacuous: the predicate ran, through the stub.
		expect(nodeStarts()).toBe(3);
	});

	// Under a `tests/` the predicate would match, the path as the harness may
	// send it, `..` unresolved, leading or mid-path.
	it.each(["../tests/notes.md", "sub/../../tests/a.ts"])(
		"injects nothing and starts no node on %s, a write outside the checkout (#2101, #2546)",
		(file) => {
			expect(envelope(file)).toBeNull();
			expect(nodeStarts()).toBe(0);
		},
	);
});
