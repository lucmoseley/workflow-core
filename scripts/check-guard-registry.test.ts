// @vitest-environment node
/*
 * Pins that every parallel-safety rule's backing marker is true — an Enforced
 * or Advisory rule names a guard that exists and is wired — and the script's
 * three later assertions: implicit behaviours (mantahostels#1261), the
 * rule-text store (mantahostels#1644) and the hook `if` narrowing
 * (mantahostels#2212).
 *
 * Tests for scripts/check-guard-registry.js (mantahostels#102). The script is
 * copied into a `scripts/` inside each fixture, because the checker reads its
 * own siblings; but the TREE it scans is the host root, not `..` from its own
 * location, so every runner below names the fixture with `CLAUDE_PROJECT_DIR`
 * as well. Without that the checker walks this repo and every case reads the
 * live registry's findings.
 *
 * It is a hard gate in .husky/pre-commit and roadmap-digest.yml: loosen a case
 * and a rule can claim **Enforced** while its guard is missing or unwired.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { installLib } from "./lib/lib-install-testkit";
import { expectFixtureSupplies } from "./lib/precommit-gate-harness";
import { runInProcess } from "./lib/run-in-process";

const REAL_SCRIPT = path.join(__dirname, "check-guard-registry.js");
const SELF_PLUGIN_HOOKS = "self-plugin/hooks/hooks.json";

const temps: string[] = [];

afterEach(() => {
	for (const t of temps.splice(0))
		fs.rmSync(t, { recursive: true, force: true });
});

interface Fixture {
	claude?: string;
	/** Extra files to create, path → contents. */
	files?: Record<string, string>;
}

const FIXTURE_SH_LIBS = new Set(["rule-text.sh", "guard-parse.sh"]);

const ANCHORS = ".claude/guard-registry-anchors.json";

function build(fx: Fixture): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-registry-"));
	temps.push(root);
	// The check reads every lib it finds for a `rule:<id>` citation (mantahostels#3135),
	// and one real lib cites an id no fixture here holds a fragment for.
	installLib(path.join(root, "scripts", "lib"), {
		keep: (lib) => !lib.endsWith(".sh") || FIXTURE_SH_LIBS.has(lib),
	});
	fs.copyFileSync(
		REAL_SCRIPT,
		path.join(root, "scripts", "check-guard-registry.js"),
	);
	// checker-new-faults.js sits in scripts/ itself, not scripts/lib/ — the
	// whole-directory copy above does not reach it, and lib/check.js's --against
	// limb requires it directly (mantahostels#2077).
	fs.copyFileSync(
		path.join(__dirname, "checker-new-faults.js"),
		path.join(root, "scripts", "checker-new-faults.js"),
	);
	if (fx.claude !== undefined)
		fs.writeFileSync(path.join(root, "CLAUDE.md"), fx.claude);
	/* A core tree registers its hooks in the self-plugin's file (#2442), which
	 * the real core always carries. */
	const files = { [SELF_PLUGIN_HOOKS]: '{"hooks": {}}', ...fx.files };
	for (const [rel, body] of Object.entries(files)) {
		const abs = path.join(root, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, body);
	}
	return root;
}

interface Result {
	code: number;
	kinds: string[];
	/**
	 * The human-readable report — the prose a session actually reads, which
	 * --json otherwise sends nowhere (mantahostels#1962).
	 *
	 * WFC_CHECK_SAY_FD is lib/check.js's own channel for exactly this: it
	 * makes say() write to the given fd even under --json, so one run yields
	 * the envelope on stdout and the report on stderr.
	 */
	report: string;
	json: {
		regionCount: number;
		ruleCount: number;
		byMarker: Record<string, number>;
		findings: {
			kind: string;
			file: string;
			detail: string;
			line: number;
			message: string;
		}[];
		warnings: {
			kind: string;
			guard: string;
			detail: string;
			rules: { file: string; line: number; gist: string }[];
			spans?: { span: string; coverage: number }[];
		}[];
	};
}

/**
 * The environment a `--review` run gets. A runner's `env` REPLACES the
 * environment, so the caller's is merged back in — minus WFC_RULES_DIR, which
 * run() strips for the reason its docstring gives.
 */
function reviewEnv(root: string, env: Record<string, string> = {}) {
	const { WFC_RULES_DIR: _drop, ...outer } = process.env;
	return { ...outer, CLAUDE_PROJECT_DIR: root, ...env };
}

/**
 * `--review` prints prose, not JSON, so it needs its own runner. It exits on
 * its own path rather than through runCheck, so a non-zero status is raised
 * here.
 */
function reviewIn(
	root: string,
	paths: string[] = [],
	env: Record<string, string> = {},
): string {
	const r = runInProcess(
		path.join(root, "scripts", "check-guard-registry.js"),
		["--review", ...paths],
		{ env: reviewEnv(root, env) },
	);
	if (r.status !== 0)
		throw new Error(`--review exited ${r.status}\n${r.stdout}${r.stderr}`);
	return r.stdout;
}

function run(
	root: string,
	extra: string[] = [],
	{ cwd, env = {} }: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Result {
	/*
	 * WFC_RULES_DIR is stripped so a stray value in this process's
	 * environment cannot redirect the fixture's store out from under it.
	 *
	 * WFC_CHECK_SAY_FD puts the human report on fd 2 while stdout stays a
	 * single parseable document, so a case can assert on either without a
	 * second run of the fixture (mantahostels#1962).
	 *
	 * cwd is only ever passed for an --against case: the git subprocesses that
	 * limb spawns take no --cwd of their own, so they read whatever this
	 * process's cwd is (mantahostels#2077).
	 */
	const {
		status: code,
		stdout,
		stderr,
	} = runInProcess(
		path.join(root, "scripts", "check-guard-registry.js"),
		["--json", ...extra],
		{
			env: {
				...process.env,
				CLAUDE_PROJECT_DIR: root,
				WFC_RULES_DIR: "",
				WFC_RULES_FALLBACK_DIR: "",
				WFC_CHECK_SAY_FD: "2",
				...env,
			},
			...(cwd ? { cwd } : {}),
		},
	);
	const json = JSON.parse(stdout);
	/* `kinds` means the gating claims. The advisory staleness warnings ride in
	 * the same `findings` array as WARNs, and are asserted separately via
	 * `json.warnings`. */
	return {
		code,
		kinds: json.findings
			.filter((f: { severity: string }) => f.severity === "FAIL")
			.map((f: { tag: string }) => f.tag),
		json,
		report: stderr,
	};
}

/** A region wrapper, so each case states only the rules it is about. */
function region(...rules: string[]): string {
	return [
		"## Conventions",
		"",
		"<!-- guard-registry:begin -->",
		"",
		...rules,
		"",
		"<!-- guard-registry:end -->",
		"",
	].join("\n");
}

/* A hooks file that wires the named scripts as PreToolUse hooks. */
function hooksWiring(...guards: string[]): string {
	return JSON.stringify({
		hooks: {
			PreToolUse: guards.map((g) => ({
				matcher: "Bash",
				hooks: [{ type: "command", command: `"$CLAUDE_PROJECT_DIR"/${g}` }],
			})),
		},
	});
}

describe("false enforcement claims — the reason the script exists", () => {
	it("fails when an Enforced rule names a guard that does not exist", () => {
		const root = build({
			claude: region(
				"- Stay on `main`. **Enforced** (#110): `scripts/guard-branch.sh` denies it.",
			),
			files: {
				[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-branch.sh"),
			},
		});
		const r = run(root);
		expect(r.code).toBe(1);
		expect(r.kinds).toEqual(["BROKEN-CLAIM"]);
		expect(r.json.findings[0].detail).toContain("does not exist");
	});

	it("fails when the guard exists but nothing triggers it, as UNWIRED", () => {
		const root = build({
			claude: region(
				"- Stay on `main`. **Enforced** (#110): `scripts/guard-branch.sh` denies it.",
			),
			files: {
				"scripts/guard-branch.sh": "#!/bin/sh\nexit 0\n",
				[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-last30days.sh"),
			},
		});
		const r = run(root);
		expect(r.code).toBe(1);
		expect(r.kinds).toEqual(["UNWIRED"]);
		expect(r.json.findings[0].detail).toContain("nothing triggers it");
	});

	it("passes when the guard exists and the self-plugin file wires it", () => {
		const root = build({
			claude: region(
				"- Stay on `main`. **Enforced** (#110): `scripts/guard-branch.sh` denies it.",
			),
			files: {
				"scripts/guard-branch.sh": "#!/bin/sh\nexit 0\n",
				[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-branch.sh"),
			},
		});
		const r = run(root);
		expect(r.code).toBe(0);
		expect(r.kinds).toEqual([]);
		expect(r.json.byMarker.Enforced).toBe(1);
	});

	it("treats a .husky hook as wired by existence", () => {
		// git runs every file in core.hooksPath by name, so pre-commit is live
		// without being referenced anywhere. Requiring a reference would make the
		// repo's real branch guard report as unwired.
		const root = build({
			claude: region(
				"- Stay on `main`. **Enforced** (#110): `.husky/pre-commit` blocks it.",
			),
			/* The hook also owes the second assertion its annotation, since mantahostels#1261
			 * reaches every .husky hook by existence too. */
			files: {
				".husky/pre-commit": [
					"# IMPLICIT:  runs the gate stack on every commit.",
					"# JUSTIFIED: fail-safe — nothing else gates before the work is shared.",
					"# DEFEAT:    none",
					"exit 0",
					"",
				].join("\n"),
			},
		});
		expect(run(root).code).toBe(0);
	});

	it("fails an Enforced rule that names no guard at all", () => {
		const root = build({
			claude: region(
				"- Stay on `main`. **Enforced** — a hook takes care of it.",
			),
		});
		const r = run(root);
		expect(r.code).toBe(1);
		expect(r.kinds).toEqual(["NO-GUARD-NAMED"]);
	});
});

describe("marker presence", () => {
	it("fails a rule inside the region carrying no marker", () => {
		const root = build({
			claude: region("- Commit by pathspec, never `git add` first."),
		});
		const r = run(root);
		expect(r.code).toBe(1);
		expect(r.kinds).toEqual(["UNMARKED"]);
	});

	it("fails a rule carrying two conflicting markers", () => {
		const root = build({
			claude: region(
				"- A rule. **Enforced** by nothing. **Unenforceable** anyway.",
			),
		});
		const r = run(root);
		expect(r.code).toBe(1);
		expect(r.kinds).toEqual(["AMBIGUOUS"]);
	});

	it("does not let Unenforced swallow Unenforceable", () => {
		// "Unenforced" is a prefix of "Unenforceable". Reading the longer word as
		// the shorter one would demand an owning issue for a rule no mechanism
		// could ever check — an UNOWNED finding on a correct rule.
		const root = build({
			claude: region(
				"- Show the diff before committing. **Unenforceable**: nobody can see it.",
			),
		});
		const r = run(root);
		expect(r.code).toBe(0);
		expect(r.json.byMarker.Unenforceable).toBe(1);
		expect(r.json.byMarker.Unenforced).toBe(0);
	});

	it("requires an Unenforced rule to name the issue that owns the guard", () => {
		const root = build({
			claude: region(
				"- Commit by pathspec. **Unenforced**: nothing catches this today.",
			),
		});
		const r = run(root);
		expect(r.code).toBe(1);
		expect(r.kinds).toEqual(["UNOWNED"]);
	});

	it("accepts an Unenforced rule that names its owning issue", () => {
		const root = build({
			claude: region(
				"- Commit by pathspec. **Unenforced**: #117 builds the guard; honour system until then.",
			),
		});
		expect(run(root).code).toBe(0);
	});
});

describe("the Advisory marker (#185)", () => {
	// A wired guard that observes the rule and speaks, never refusing. It owes a
	// path like Enforced does, and owes no issue.
	it("accepts an Advisory rule naming a wired path and no issue", () => {
		const root = build({
			claude: region(
				"- A hand-rolled wait loop takes a ceiling. **Advisory**: `scripts/guard-wait-loop.sh` warns and never denies.",
			),
			files: {
				"scripts/guard-wait-loop.sh": "#!/bin/sh\nexit 0\n",
				[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-wait-loop.sh"),
			},
		});
		const r = run(root);
		expect(r.code).toBe(0);
		expect(r.kinds).toEqual([]);
		expect(r.json.byMarker.Advisory).toBe(1);
		expect(r.json.byMarker.Enforced).toBe(0);
	});

	it("fails an Advisory rule that names no guard path", () => {
		const root = build({
			claude: region(
				"- A hand-rolled wait loop takes a ceiling. **Advisory** (#2042): a hook warns on it.",
			),
		});
		const r = run(root);
		expect(r.code).toBe(1);
		expect(r.kinds).toEqual(["NO-GUARD-NAMED"]);
		expect(r.json.findings[0].detail).toContain("**Advisory**");
	});

	it("tests the named path for existence like Enforced does", () => {
		const root = build({
			claude: region(
				"- A hand-rolled wait loop takes a ceiling. **Advisory**: `scripts/guard-nope.sh` warns.",
			),
		});
		const r = run(root);
		expect(r.code).toBe(1);
		expect(r.kinds).toEqual(["BROKEN-CLAIM"]);
		expect(r.json.findings[0].detail).toContain("does not exist");
	});

	it("tests the named path for wiring like Enforced does", () => {
		const root = build({
			claude: region(
				"- A hand-rolled wait loop takes a ceiling. **Advisory**: `scripts/guard-wait-loop.sh` warns.",
			),
			files: { "scripts/guard-wait-loop.sh": "#!/bin/sh\nexit 0\n" },
		});
		const r = run(root);
		expect(r.code).toBe(1);
		expect(r.kinds).toEqual(["UNWIRED"]);
		expect(r.json.findings[0].detail).toContain("nothing triggers it");
	});
});

describe("the plain-prose decision seam's Advisory entry (#205)", () => {
	/* The one live Advisory rule the seam-1 Jev guard backs. */
	const styleText = fs.readFileSync(
		path.join(__dirname, "..", ".claude", "output-styles", "core-voice.md"),
		"utf8",
	);
	const opens = "- **A choice put to the founder in plain prose";
	const liveRule = styleText.split("\n").find((l) => l.startsWith(opens));

	it("stands in core-voice.md, marked Advisory, naming both wired scripts", () => {
		expect(liveRule, `no rule in core-voice.md opens "${opens}"`).toBeDefined();
		expect(liveRule).toContain("**Advisory**");
		expect(liveRule).toContain("`scripts/guard-jev-advisory.js`");
		expect(liveRule).toContain("`scripts/check-jev-flags.js`");
	});

	it("leaves the conceding clause nowhere in the style", () => {
		expect(styleText).not.toContain("caught by nothing");
	});

	it("passes the checker the way #185's Advisory case does", () => {
		const root = build({
			claude: region(liveRule as string),
			files: {
				"scripts/guard-jev-advisory.js": "#!/usr/bin/env node\n",
				"scripts/check-jev-flags.js": "#!/usr/bin/env node\n",
				[SELF_PLUGIN_HOOKS]: hooksWiring(
					"scripts/guard-jev-advisory.js",
					"scripts/check-jev-flags.js",
				),
			},
		});
		const r = run(root);
		expect(r.code).toBe(0);
		expect(r.kinds).toEqual([]);
		expect(r.json.byMarker.Advisory).toBe(1);
		expect(r.json.byMarker.Enforced).toBe(0);
	});
});

describe("a guard path named under Unenforced (mantahostels#2347)", () => {
	const rule =
		"- Nothing refuses a Bash-route write. **Unenforced** (#287): `scripts/guard-claimed-bash-write.sh` injects the claims.";

	it("fails when the path does not exist, as BROKEN-CLAIM", () => {
		const root = build({
			claude: region(rule),
			files: {
				[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-claimed-bash-write.sh"),
			},
		});
		const r = run(root);
		expect(r.code).toBe(1);
		expect(r.kinds).toEqual(["BROKEN-CLAIM"]);
		expect(r.json.findings[0].detail).toContain("does not exist");
	});

	it("fails when the path exists but nothing triggers it, as UNWIRED", () => {
		const root = build({
			claude: region(rule),
			files: {
				"scripts/guard-claimed-bash-write.sh": "#!/bin/sh\nexit 0\n",
				[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-branch.sh"),
			},
		});
		const r = run(root);
		expect(r.code).toBe(1);
		expect(r.kinds).toEqual(["UNWIRED"]);
		expect(r.json.findings[0].detail).toContain("nothing triggers it");
	});

	it("passes when the path exists and is wired", () => {
		const root = build({
			claude: region(rule),
			files: {
				"scripts/guard-claimed-bash-write.sh": "#!/bin/sh\nexit 0\n",
				[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-claimed-bash-write.sh"),
			},
		});
		const r = run(root);
		expect(r.code).toBe(0);
		expect(r.json.byMarker.Unenforced).toBe(1);
	});

	it("reports the bad path alongside UNOWNED, not instead of it", () => {
		const root = build({
			claude: region(
				"- Nothing refuses it. **Unenforced**: `scripts/guard-nope.sh` does the injecting.",
			),
		});
		const r = run(root);
		expect(r.code).toBe(1);
		expect(r.kinds.sort()).toEqual(["BROKEN-CLAIM", "UNOWNED"]);
	});

	it("tests a path named under Unenforceable too", () => {
		// The marker branches sit BELOW the test, so none of them can return first.
		const root = build({
			claude: region(
				"- Push when the suite is green. **Unenforceable** (#244): `scripts/guard-push-rules.sh` hands you the rule.",
			),
		});
		const r = run(root);
		expect(r.code).toBe(1);
		expect(r.kinds).toEqual(["BROKEN-CLAIM"]);
	});

	it("leaves an Unenforced rule naming no path alone", () => {
		// The marker's normal case: the guard is unbuilt, so there is no path to test.
		const root = build({
			claude: region(
				"- Nothing makes a session release a file. **Unenforced** (#121): nothing calls it.",
			),
		});
		expect(run(root).code).toBe(0);
	});
});

describe("package.json as wiring (mantahostels#2347)", () => {
	const rule =
		"- Run the suite. **Enforced** (#1230): `scripts/run-vitest.js` records the certificate.";

	it("treats a script an npm script runs as wired", () => {
		const root = build({
			claude: region(rule),
			files: {
				"scripts/run-vitest.js": "process.exit(0);\n",
				"package.json": JSON.stringify({
					scripts: { test: "node scripts/run-vitest.js" },
				}),
			},
		});
		expect(run(root).code).toBe(0);
	});

	it("reads every script key, not just `test`", () => {
		const root = build({
			claude: region(rule),
			files: {
				"scripts/run-vitest.js": "process.exit(0);\n",
				"package.json": JSON.stringify({
					scripts: {
						test: "vitest run",
						"test:changed": "node scripts/run-vitest.js --changed",
					},
				}),
			},
		});
		expect(run(root).code).toBe(0);
	});

	it("does not let package.json's comments block wire a path", () => {
		// The comments block describes those same scripts in prose, so reading the
		// whole file would wire a path by anecdote.
		const root = build({
			claude: region(rule),
			files: {
				"scripts/run-vitest.js": "process.exit(0);\n",
				"package.json": JSON.stringify({
					scripts: { test: "vitest run" },
					comments: { "scripts.test": "routed through scripts/run-vitest.js" },
				}),
			},
		});
		const r = run(root);
		expect(r.code).toBe(1);
		expect(r.kinds).toEqual(["UNWIRED"]);
	});
});

describe("rule boundaries", () => {
	it("treats indented sub-bullets as continuation, not as separate rules", () => {
		// The pathspec rule has four sub-cases sharing one enforcement story.
		// Marking each would be four places to go stale instead of one.
		const root = build({
			claude: region(
				"- Commit by pathspec. **Unenforced**: #117 owns it.",
				"  - Never `git commit -a`.",
				"  - Never `git commit -i`.",
			),
		});
		const r = run(root);
		expect(r.code).toBe(0);
		expect(r.json.ruleCount).toBe(1);
	});

	it("ignores rules outside the delimiters", () => {
		const root = build({
			claude: [
				"- Commit messages are short and imperative.",
				"",
				region("- Stay on `main`. **Unenforceable**: nothing to check."),
				"- Biome is the formatter of record.",
			].join("\n"),
		});
		const r = run(root);
		expect(r.code).toBe(0);
		expect(r.json.ruleCount).toBe(1);
	});

	it("finds regions in any scanned document, not just CLAUDE.md", () => {
		const root = build({
			files: {
				"docs/environment.md": region(
					"- A rule. **Unenforceable**: nothing to check.",
				),
			},
		});
		const r = run(root);
		expect(r.code).toBe(0);
		expect(r.json.regionCount).toBe(1);
	});
});

describe("regressions found by code review — a gate that passed when it should fail", () => {
	it("fails a rule written as an ordered-list item or a bold paragraph instead of a bullet, each as UNRULED", () => {
		const root = build({
			claude: region(
				"1. Never checkout the shared tree.",
				"",
				"**A rule written as a bold paragraph.**",
				"",
				"- A valid bullet. **Unenforceable**: nothing to check.",
			),
		});
		const r = run(root);
		expect(r.code).toBe(1);
		expect(r.kinds.filter((k) => k === "UNRULED")).toHaveLength(2);
	});

	it("does not count a guard mentioned only in a comment as wired", () => {
		const root = build({
			claude: region("- R. **Enforced** (#1): `scripts/guard-x.sh`."),
			files: {
				"scripts/guard-x.sh": "#!/bin/sh\nexit 0\n",
				".github/workflows/w.yml":
					"# TODO: one day wire scripts/guard-x.sh here\n",
			},
		});
		const r = run(root);
		expect(r.code).toBe(1);
		expect(r.kinds).toEqual(["UNWIRED"]);
	});

	it("counts a guard named in a workflow run: step as wired", () => {
		// The other side of the comment-stripping change: a real invocation in a
		// workflow must still pass, or every CI-run check would report unwired.
		const root = build({
			claude: region("- R. **Enforced** (#1): `scripts/guard-x.sh`."),
			files: {
				"scripts/guard-x.sh": "#!/bin/sh\nexit 0\n",
				".github/workflows/w.yml":
					"jobs:\n  a:\n    steps:\n      - run: bash scripts/guard-x.sh\n",
			},
		});
		expect(run(root).code).toBe(0);
	});

	it("does not count a path outside a hook command as wiring", () => {
		// The registration is parsed, not grepped: only `command` strings count.
		const root = build({
			claude: region("- R. **Enforced** (#1): `scripts/guard-x.sh`."),
			files: {
				"scripts/guard-x.sh": "#!/bin/sh\nexit 0\n",
				[SELF_PLUGIN_HOOKS]: JSON.stringify({
					hooks: {},
					notes: "scripts/guard-x.sh is planned",
				}),
			},
		});
		const r = run(root);
		expect(r.code).toBe(1);
		expect(r.kinds).toEqual(["UNWIRED"]);
	});

	it("reports the rule's true file line", () => {
		// region.body starts mid-BEGIN-line, so body index 0 is already the BEGIN
		// line and must not be counted twice.
		const root = build({
			claude: [
				"# Heading",
				"",
				"<!-- guard-registry:begin -->",
				"",
				"- Unmarked rule.",
				"",
				"<!-- guard-registry:end -->",
				"",
			].join("\n"),
		});
		const r = run(root);
		expect(r.json.findings[0].kind).toBe("UNMARKED");
		expect(r.json.findings[0].line).toBe(5);
	});

	it("ignores a bullet inside a fenced code block", () => {
		const root = build({
			claude: region(
				"- A real rule. **Unenforceable**: nothing to check.",
				"",
				"```",
				"- this is an example, not a rule",
				"```",
			),
		});
		const r = run(root);
		expect(r.code).toBe(0);
		expect(r.json.ruleCount).toBe(1);
	});
});

describe("the region itself", () => {
	it("fails when no region exists anywhere", () => {
		// Deleting the delimiters silently drops every rule out of scope.
		const root = build({ claude: "## Conventions\n\n- Stay on `main`.\n" });
		const r = run(root);
		expect(r.code).toBe(1);
		expect(r.kinds).toEqual(["NO-REGION"]);
	});

	it("fails an opened region that is never closed", () => {
		const root = build({
			claude:
				"<!-- guard-registry:begin -->\n\n- A rule. **Unenforceable**: no.\n",
		});
		const r = run(root);
		expect(r.code).toBe(1);
		expect(r.kinds).toContain("UNTERMINATED");
	});
});

describe("the guard-registry document (#2033)", () => {
	const registryDoc = "docs/agents/guard-registry.md";

	it("passes rules moved out of CLAUDE.md into it, CLAUDE.md keeping its own region", () => {
		const root = build({
			claude: region(
				"- Show the diff before committing. **Unenforceable**: nobody can see it.",
			),
			files: {
				[registryDoc]: `# Guard registry\n\n${region(
					"- **Stay on `main`.** **Enforced** (#110): `scripts/guard-branch.sh`.",
					"- **Release a held file.** **Unenforced** (mantahostels#121): nothing makes a session call it.",
				)}`,
				"scripts/guard-branch.sh": "#!/bin/sh\nexit 0\n",
				[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-branch.sh"),
			},
		});
		const r = run(root);
		expect(r.code).toBe(0);
		expect(r.json.regionCount).toBe(2);
		expect(r.json.ruleCount).toBe(3);
	});

	it("refuses a rule in it carrying no tag", () => {
		const root = build({
			claude: region(
				"- Show the diff before committing. **Unenforceable**: nobody can see it.",
			),
			files: {
				[registryDoc]: region("- **Stay on `main`.** Nothing said about it."),
			},
		});
		const r = run(root);
		expect(r.code).toBe(1);
		expect(r.kinds).toEqual(["UNMARKED"]);
		expect(r.json.findings[0]?.file).toBe(registryDoc);
	});
});

describe("reporting", () => {
	it("--warn reports the same findings but exits 0", () => {
		const root = build({ claude: region("- A rule with no marker.") });
		expect(run(root).code).toBe(1);
		const warned = run(root, ["--warn"]);
		expect(warned.code).toBe(0);
		expect(warned.kinds).toEqual(["UNMARKED"]);
	});

	it("does not mistake ordinary backticked prose for a guard path", () => {
		// The real branch rule quotes `git worktree add …`, `WFC_ALLOW_BRANCH=1`
		// and `--no-verify`. Reading any of those as a claimed guard would fail
		// the repo's one genuinely enforced rule.
		const root = build({
			claude: region(
				'- Stay on `main`; use `git worktree add "$CLAUDE_JOB_DIR/tmp/x" main`, never `--no-verify`, escape with `WFC_ALLOW_BRANCH=1`. **Enforced** (#110): `scripts/guard-branch.sh`.',
			),
			files: {
				"scripts/guard-branch.sh": "#!/bin/sh\nexit 0\n",
				[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-branch.sh"),
			},
		});
		expect(run(root).code).toBe(0);
	});
});

describe("stale prose — has the guard moved since anyone confirmed the sentence", () => {
	function anchors(root: string): Record<string, string> {
		return JSON.parse(fs.readFileSync(path.join(root, ANCHORS), "utf8"));
	}

	function guardRepo(): string {
		return build({
			claude: region(
				"- Stay on `main`. **Enforced** (#110): `scripts/guard-branch.sh` denies the checkout.",
			),
			files: {
				"scripts/guard-branch.sh": "#!/bin/sh\nexit 2\n",
				[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-branch.sh"),
			},
		});
	}

	it("warns that a guard nobody has confirmed the prose against is unanchored, naming the guard", () => {
		const r = run(guardRepo());
		expect(r.code).toBe(0);
		expect(r.json.warnings.map((w) => w.kind)).toEqual(["UNANCHORED"]);
		expect(r.json.warnings[0].guard).toBe("scripts/guard-branch.sh");
	});

	it("--review clears the warning and records the guard's digest", () => {
		const root = guardRepo();
		const out = reviewIn(root);
		expect(out).toContain("anchored scripts/guard-branch.sh");
		expect(out).toContain("describes: CLAUDE.md");
		expect(Object.keys(anchors(root))).toEqual(["scripts/guard-branch.sh"]);
		expect(run(root).json.warnings).toEqual([]);
	});

	/*
	 * A SPAWN, KEPT FOR A REAL FD (§X3): the in-process runner captures writes
	 * before any pipe sees them, so only a spawn shows what reaches a session's
	 * Bash pipe. node drops what is still buffered on one at process.exit, and
	 * 64 KiB is the pipe buffer: 1,500 missing paths clear it, and the summary
	 * is written last.
	 */
	it("prints a report longer than the pipe buffer whole, summary included (#1444)", () => {
		const root = guardRepo();
		const missing = Array.from(
			{ length: 1500 },
			(_, i) => `scripts/guard-never-written-${String(i).padStart(4, "0")}.sh`,
		);
		const r = spawnSync(
			process.execPath,
			[
				path.join(root, "scripts", "check-guard-registry.js"),
				"--review",
				...missing,
			],
			{
				cwd: root,
				encoding: "utf8",
				env: reviewEnv(root, { WFC_ANCHOR_LOCKS: "[]" }),
			},
		);
		expect(r.status).toBe(0);
		expect(r.stdout.length).toBeGreaterThan(64 * 1024);
		expect(r.stdout).toContain(
			"skipped scripts/guard-never-written-1499.sh — file does not exist",
		);
		expect(r.stdout.trimEnd()).toMatch(
			/0 path\(s\) re-anchored in [^\n]*\. Re-anchoring asserts everything printed as anchored above was re-read against the file\.$/,
		);
	});

	it("warns when the guard changes and its registry sentence does not, as STALE-PROSE", () => {
		const root = guardRepo();
		reviewIn(root);
		fs.writeFileSync(
			path.join(root, "scripts", "guard-branch.sh"),
			"#!/bin/sh\n# now it only warns\nexit 0\n",
		);
		const r = run(root);
		expect(r.code).toBe(0);
		expect(r.json.warnings.map((w) => w.kind)).toEqual(["STALE-PROSE"]);
		expect(r.json.warnings[0].detail).toContain("last reviewed");
	});

	it("stops warning by itself when the guard is changed back", () => {
		// A content digest, not a commit sha: a revert restores the reviewed
		// bytes, and re-reviewing an unchanged guard would be a rubber stamp.
		const root = guardRepo();
		reviewIn(root);
		const guard = path.join(root, "scripts", "guard-branch.sh");
		const original = fs.readFileSync(guard, "utf8");
		fs.writeFileSync(guard, "#!/bin/sh\nexit 0\n");
		expect(run(root).json.warnings).toHaveLength(1);
		fs.writeFileSync(guard, original);
		expect(run(root).json.warnings).toEqual([]);
	});

	it("names every rule describing the changed guard, not just the first", () => {
		const root = build({
			claude: region(
				"- Claiming. **Enforced** (#113): `scripts/guard-file-claim.sh` denies the write.",
				"- Debt. **Enforced** (#120): the same `scripts/guard-file-claim.sh` hook registers it.",
			),
			files: {
				"scripts/guard-file-claim.sh": "#!/bin/sh\nexit 2\n",
				[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-file-claim.sh"),
			},
		});
		reviewIn(root);
		fs.writeFileSync(
			path.join(root, "scripts", "guard-file-claim.sh"),
			"#!/bin/sh\nexit 0\n",
		);
		const w = run(root).json.warnings;
		expect(w).toHaveLength(1);
		expect(w[0].rules).toHaveLength(2);
	});

	it("anchors a guard named inside a longer backticked command", () => {
		// The release rule (mantahostels#121, mantahostels#126) says `node scripts/session-arbiter.js
		// release <path>` — the pending staleness instance the ticket cites. An
		// extractor that only reads whole-span paths misses exactly that case.
		const root = build({
			claude: region(
				"- Release it: `node scripts/session-arbiter.js release <path>`. **Unenforced** (#121): nothing makes a session call it.",
			),
			files: { "scripts/session-arbiter.js": "// arbiter\n" },
		});
		expect(run(root).json.warnings[0].guard).toBe("scripts/session-arbiter.js");
	});

	it("does not anchor a config file a rule mentions in passing", () => {
		// The release rule recounts a session holding `.claude/settings.json` for
		// hours. Anchoring that would warn on every unrelated settings edit —
		// unclearable wallpaper. An unwired guard is UNWIRED's job, not this one.
		const root = build({
			claude: region(
				"- A session held `.claude/settings.json` too long. **Unenforced** (#121): nothing makes it release.",
			),
			files: { [SELF_PLUGIN_HOOKS]: hooksWiring() },
		});
		expect(run(root).json.warnings).toEqual([]);
	});

	it("reports an anchor no rule names any more, and a bare --review drops it", () => {
		const root = guardRepo();
		reviewIn(root);
		fs.writeFileSync(
			path.join(root, ANCHORS),
			JSON.stringify({
				"scripts/guard-branch.sh": anchors(root)["scripts/guard-branch.sh"],
				"scripts/guard-gone.sh": "deadbeefdeadbeef",
			}),
		);
		expect(run(root).json.warnings.map((w) => w.kind)).toEqual([
			"ORPHAN-ANCHOR",
		]);
		expect(reviewIn(root)).toContain("dropped scripts/guard-gone.sh");
		expect(run(root).json.warnings).toEqual([]);
	});

	it("--review <path> re-anchors only that guard", () => {
		const root = build({
			claude: region(
				"- One. **Enforced** (#1): `scripts/guard-a.sh`.",
				"- Two. **Enforced** (#2): `scripts/guard-b.sh`.",
			),
			files: {
				"scripts/guard-a.sh": "#!/bin/sh\nexit 0\n",
				"scripts/guard-b.sh": "#!/bin/sh\nexit 0\n",
				[SELF_PLUGIN_HOOKS]: hooksWiring(
					"scripts/guard-a.sh",
					"scripts/guard-b.sh",
				),
			},
		});
		reviewIn(root);
		fs.writeFileSync(
			path.join(root, "scripts", "guard-a.sh"),
			"#!/bin/sh\nexit 1\n",
		);
		fs.writeFileSync(
			path.join(root, "scripts", "guard-b.sh"),
			"#!/bin/sh\nexit 1\n",
		);
		expect(run(root).json.warnings).toHaveLength(2);
		reviewIn(root, ["scripts/guard-a.sh"]);
		const w = run(root).json.warnings;
		expect(w).toHaveLength(1);
		expect(w[0].guard).toBe("scripts/guard-b.sh");
	});

	/*
	 * mantahostels#2636's fixture. Two guards, so a per-path run has something it must
	 * leave alone — and a real git repo, because the claim check reads the
	 * working tree's dirty set before it reads any claim.
	 */
	function twoGuards(): string {
		const root = build({
			claude: region(
				"- One. **Enforced** (#1): `scripts/guard-a.sh`.",
				"- Two. **Enforced** (#2): `scripts/guard-b.sh`.",
			),
			files: {
				"scripts/guard-a.sh": "#!/bin/sh\nexit 0\n",
				"scripts/guard-b.sh": "#!/bin/sh\nexit 0\n",
				[SELF_PLUGIN_HOOKS]: hooksWiring(
					"scripts/guard-a.sh",
					"scripts/guard-b.sh",
				),
			},
		});
		const git = (...args: string[]) =>
			execFileSync("git", args, { cwd: root, encoding: "utf8" });
		git("init", "-q", ".");
		git("config", "user.email", "test@example.com");
		git("config", "user.name", "test");
		git("add", "-A");
		git("commit", "-qm", "x");
		return root;
	}

	const self = "self-session";
	const neighbour = "neighbour-session";

	/*
	 * A lock record as `listLocks` hands one over. Injected at the STORE, not at
	 * the checker's own answer, so neighbourDirty's own filtering — is it mine,
	 * is it dirty, has a dead claim aged out — runs against it.
	 */
	function lock(rel: string, { alive = true } = {}) {
		return {
			path: rel,
			sessionId: neighbour,
			pid: 4242,
			alive,
			claimedAt: new Date().toISOString(),
		};
	}

	function env(locks: unknown[]): Record<string, string> {
		return {
			CLAUDE_CODE_SESSION_ID: self,
			WFC_ANCHOR_LOCKS: JSON.stringify(locks),
		};
	}

	/** Dirty in git's eyes, and a different digest from the committed bytes. */
	function dirty(root: string, guard: string): void {
		fs.writeFileSync(path.join(root, "scripts", guard), "#!/bin/sh\nexit 1\n");
	}

	it("--review <path> leaves every entry but the named one byte-identical (mantahostels#2636)", () => {
		const root = twoGuards();
		reviewIn(root);
		const before = fs.readFileSync(path.join(root, ANCHORS), "utf8");
		// Both move on disk; only one is named, so only one may be rewritten.
		dirty(root, "guard-a.sh");
		dirty(root, "guard-b.sh");
		reviewIn(root, ["scripts/guard-a.sh"], env([]));
		const after = fs.readFileSync(path.join(root, ANCHORS), "utf8");
		expect(after).not.toBe(before);
		const strip = (raw: string) =>
			raw
				.split("\n")
				.filter((l) => !l.includes('"scripts/guard-a.sh"'))
				.join("\n");
		expect(strip(after)).toBe(strip(before));
	});

	it("counts what the run wrote, not what the anchors file holds (mantahostels#2636)", () => {
		const root = twoGuards();
		reviewIn(root);
		const out = reviewIn(root, ["scripts/guard-a.sh"], env([]));
		expect(out).toContain("1 path(s) re-anchored");
		expect(out).toContain("1 existing entry was left byte-identical");
		expect(reviewIn(root, [], env([]))).toContain("2 path(s) re-anchored");
	});

	it("will not anchor a path a live neighbour holds dirty, and says whose", () => {
		const root = twoGuards();
		reviewIn(root);
		const before = anchors(root);
		dirty(root, "guard-a.sh");
		const out = reviewIn(
			root,
			["scripts/guard-a.sh"],
			env([lock("scripts/guard-a.sh")]),
		);
		expect(out).toContain("not anchored scripts/guard-a.sh");
		expect(out).toContain(neighbour);
		expect(out).toContain("0 path(s) re-anchored");
		expect(out).toContain("Re-run once the holder releases");
		expect(anchors(root)).toEqual(before);
	});

	it("anchors the named path when the claim is on a DIFFERENT file", () => {
		// The positive half of the pair: a skip that fired on everything would
		// pass the case above and fail this one.
		const root = twoGuards();
		reviewIn(root);
		const before = anchors(root);
		dirty(root, "guard-a.sh");
		dirty(root, "guard-b.sh");
		const out = reviewIn(
			root,
			["scripts/guard-a.sh"],
			env([lock("scripts/guard-b.sh")]),
		);
		expect(out).toContain("anchored scripts/guard-a.sh");
		expect(out).toContain("1 path(s) re-anchored");
		expect(anchors(root)["scripts/guard-a.sh"]).not.toBe(
			before["scripts/guard-a.sh"],
		);
	});

	it("tells a reader a GONE holder will never release", () => {
		const root = twoGuards();
		reviewIn(root);
		dirty(root, "guard-a.sh");
		const out = reviewIn(
			root,
			["scripts/guard-a.sh"],
			env([lock("scripts/guard-a.sh", { alive: false })]),
		);
		expect(out).toContain("(GONE)");
		expect(out).toContain("commit or revert the file");
		expect(out).not.toContain("Re-run once the holder releases");
	});

	it("a bare --review carries a held path's anchor over rather than dropping it", () => {
		const root = twoGuards();
		reviewIn(root);
		const before = anchors(root);
		dirty(root, "guard-a.sh");
		reviewIn(root, [], env([lock("scripts/guard-a.sh")]));
		// Dropped, it would read as UNANCHORED — a worse claim than a stale one.
		expect(anchors(root)["scripts/guard-a.sh"]).toBe(
			before["scripts/guard-a.sh"],
		);
		expect(run(root).json.warnings.map((w) => w.kind)).toEqual(["STALE-PROSE"]);
	});

	it("says so when it could not ask who holds what", () => {
		const root = twoGuards();
		dirty(root, "guard-a.sh");
		const out = reviewIn(root, ["scripts/guard-a.sh"], {
			CLAUDE_CODE_SESSION_ID: "",
		});
		expect(out).toContain("claim check skipped");
		expect(out).toContain("anchored here unnoticed");
		expect(out).toContain("1 path(s) re-anchored");
	});

	it("keeps a stale anchor from masking a real enforcement failure", () => {
		// Staleness is advisory; the false-claim checks are not.
		const root = build({
			claude: region(
				"- Stay on `main`. **Enforced** (#110): `scripts/guard-branch.sh`.",
			),
			files: { "scripts/guard-branch.sh": "#!/bin/sh\nexit 0\n" },
		});
		const r = run(root);
		expect(r.code).toBe(1);
		expect(r.kinds).toEqual(["UNWIRED"]);
		expect(r.json.warnings.map((w) => w.kind)).toEqual(["UNANCHORED"]);
	});
});

describe("the live repository", () => {
	it("passes against this repo's own CLAUDE.md", () => {
		// This is the case that catches a guard deleted or unwired later, and the
		// one place here that keeps a real process: it runs against the live repo
		// rather than a fixture, so a stray require of this repo's own modules
		// into the test process would read as the checker's own state.
		let code = 0;
		try {
			execFileSync(process.execPath, [REAL_SCRIPT], { encoding: "utf8" });
		} catch (e) {
			code = (e as { status: number }).status;
			throw new Error(
				`check-guard-registry.js fails on the live repo:\n${(e as { stdout: string }).stdout}`,
				{ cause: e },
			);
		}
		expect(code).toBe(0);
	});
});

describe("assertion 4 — the hook `if` narrowing (mantahostels#2212)", () => {
	/** A hooks file wiring one script, with or without an `if` field. */
	function wiringWithIf(script: string, ifField?: string): string {
		return JSON.stringify({
			hooks: {
				PreToolUse: [
					{
						matcher: "Bash",
						hooks: [
							{
								type: "command",
								command: `"$CLAUDE_PROJECT_DIR"/${script}`,
								...(ifField ? { if: ifField } : {}),
							},
						],
					},
				],
			},
		});
	}

	const guard = "scripts/guard-x.sh";
	const other = "scripts/guard-other.sh";
	const rule = "- Rule. **Enforced** (#1): `scripts/guard-x.sh`.";

	function guardBody(header: string): string {
		return ["#!/usr/bin/env bash", ...header.split("\n"), "", "exit 0"].join(
			"\n",
		);
	}

	it("fails a hook narrowed by `if` whose script never says so", () => {
		const root = build({
			claude: region(rule),
			files: {
				[guard]: guardBody("# PreToolUse guard.\n#\n# LIMITS\n#  - none."),
				[SELF_PLUGIN_HOOKS]: wiringWithIf(guard, "Bash(*git*)"),
			},
		});
		const r = run(root);
		expect(r.kinds).toContain("UNDECLARED-IF");
		expect(r.code).toBe(1);
	});

	it("passes once the script's header states that narrowing verbatim", () => {
		const root = build({
			claude: region(rule),
			files: {
				[guard]: guardBody(
					"# PreToolUse guard.\n#\n# LIMITS\n#  - Wired with `if: Bash(*git*)` since #2061.",
				),
				[SELF_PLUGIN_HOOKS]: wiringWithIf(guard, "Bash(*git*)"),
			},
		});
		const r = run(root);
		expect(r.kinds).not.toContain("UNDECLARED-IF");
		expect(r.kinds).not.toContain("UNWIRED-IF");
	});

	it("fails a header claiming a narrowing the wiring no longer carries", () => {
		const root = build({
			claude: region(rule),
			files: {
				[guard]: guardBody(
					"# PreToolUse guard.\n#\n# LIMITS\n#  - Wired with `if: Bash(*git*)` since #2061.",
				),
				[SELF_PLUGIN_HOOKS]: wiringWithIf(guard),
			},
		});
		const r = run(root);
		expect(r.kinds).toContain("STALE-IF");
		expect(
			r.json.findings.find((f) => f.kind === "STALE-IF")?.detail,
		).toContain("no `if` field at all");
	});

	it("fails a header stating a DIFFERENT narrowing from the wiring's", () => {
		const root = build({
			claude: region(rule),
			files: {
				[guard]: guardBody(
					"# PreToolUse guard.\n#\n#  - Wired with `if: Bash(*gh*)` since #2061.",
				),
				[SELF_PLUGIN_HOOKS]: wiringWithIf(guard, "Bash(*git*)"),
			},
		});
		const r = run(root);
		expect(r.kinds).toEqual(
			expect.arrayContaining(["UNDECLARED-IF", "STALE-IF"]),
		);
	});

	it("reads the header only — a matcher spelled in the body is code, not a declaration", () => {
		const root = build({
			claude: region(rule),
			files: {
				[guard]: [
					"#!/usr/bin/env bash",
					"# PreToolUse guard.",
					"",
					'echo "if: Bash(*git*)"',
				].join("\n"),
				[SELF_PLUGIN_HOOKS]: wiringWithIf(guard, "Bash(*git*)"),
			},
		});
		expect(run(root).kinds).toContain("UNDECLARED-IF");
	});

	it("says nothing about a bare hook whose script mentions no narrowing", () => {
		const root = build({
			claude: region(rule),
			files: {
				[guard]: guardBody("# PreToolUse guard."),
				[SELF_PLUGIN_HOOKS]: wiringWithIf(guard),
			},
		});
		const r = run(root);
		expect(r.kinds).not.toContain("UNDECLARED-IF");
		expect(r.kinds).not.toContain("STALE-IF");
		expect(r.code).toBe(0);
	});

	it("names every narrowed script in the run's own report", () => {
		const root = build({
			claude: region(rule),
			files: {
				[guard]: guardBody(
					"# PreToolUse guard.\n#  - Wired with `if: Bash(*git*)` since #2061.",
				),
				[SELF_PLUGIN_HOOKS]: wiringWithIf(guard, "Bash(*git*)"),
			},
		});
		const r = run(root);
		expect(r.report).toContain(
			"Hook `if` narrowings: 1 wired script(s) exec'd on a narrowed set, " +
				"0 unreadable emitter(s) skipped on the declared side (mantahostels#2234).",
		);
		expect(r.json).toMatchObject({
			ifNarrowings: [{ file: guard, values: ["Bash(*git*)"] }],
		});
	});

	it("does not fault a script wired twice, once narrowed and once bare", () => {
		// The known limit stated beside HEADER_IF_RE: values aggregate per script.
		const root = build({
			claude: region(rule),
			files: {
				[guard]: guardBody(
					"# PreToolUse guard.\n#  - Wired with `if: Bash(*gh*)` since #2061.",
				),
				[SELF_PLUGIN_HOOKS]: JSON.stringify({
					hooks: {
						PreToolUse: [
							{
								matcher: "Bash",
								hooks: [
									{
										type: "command",
										command: `./${guard}`,
										if: "Bash(*gh*)",
									},
								],
							},
						],
						PostToolUse: [
							{
								matcher: "Bash",
								hooks: [{ type: "command", command: `./${guard}` }],
							},
						],
					},
				}),
			},
		});
		const r = run(root);
		expect(r.kinds).not.toContain("STALE-IF");
		expect(r.kinds).not.toContain("UNDECLARED-IF");
	});

	it("cites the file line the narrowing is stated on, past the shebang", () => {
		const root = build({
			claude: region(rule),
			files: {
				[guard]: guardBody(
					"# PreToolUse guard.\n#\n#  - Wired with `if: Bash(*git*)` since #2061.",
				),
				[SELF_PLUGIN_HOOKS]: wiringWithIf(guard),
			},
		});
		// #!/usr/bin/env bash is line 1, so the declaration is on line 4.
		expect(
			run(root).json.findings.find((f) => f.kind === "STALE-IF")?.line,
		).toBe(4);
	});

	it("clears a matcher shape the header regex cannot parse, off the wiring's own string", () => {
		const root = build({
			claude: region(rule),
			files: {
				[guard]: guardBody(
					'# PreToolUse guard.\n#  - Wired with `if: Bash(git commit -m "(x)"*)`.',
				),
				[SELF_PLUGIN_HOOKS]: wiringWithIf(guard, 'Bash(git commit -m "(x)"*)'),
			},
		});
		const r = run(root);
		expect(r.kinds).not.toContain("UNDECLARED-IF");
		expect(r.kinds).not.toContain("STALE-IF");
	});

	it("reports the fault under `wiring:`, not `rule:`", () => {
		const root = build({
			claude: region(rule),
			files: {
				[guard]: guardBody("# PreToolUse guard."),
				[SELF_PLUGIN_HOOKS]: wiringWithIf(guard, "Bash(*git*)"),
			},
		});
		expect(run(root).report).toMatch(
			/wiring:\s+wired in self-plugin\/hooks\/hooks\.json/,
		);
	});

	it("fails a script dropped from the wiring entirely, its header still stating a narrowing (mantahostels#2234)", () => {
		const root = build({
			claude: region(rule),
			files: {
				[guard]: guardBody(
					"# PreToolUse guard.\n#\n#  - Wired with `if: Bash(*git*)` since #2061.",
				),
				[SELF_PLUGIN_HOOKS]: JSON.stringify({ hooks: {} }),
			},
		});
		const r = run(root);
		expect(r.kinds).toContain("UNWIRED-IF");
		// The declaration is on line 4, past the shebang, as STALE-IF cites it.
		expect(r.report).toContain(`UNWIRED-IF  ${guard}:4`);
		const detail = r.json.findings.find((f) => f.kind === "UNWIRED-IF")?.detail;
		expect(detail).toContain("names this script at all");
		expect(detail).toContain("Delete the line or wire the script");
		expect(r.code).toBe(1);
	});

	it("wires an exec-form entry whose script path sits in `args` (mantahostels#2266)", () => {
		// `command` is the bare interpreter, so a reader taking it alone finds no
		// script and raises UNWIRED-IF against one the file plainly wires.
		const root = build({
			claude: region(rule),
			files: {
				[guard]: guardBody(
					"# PreToolUse guard.\n#\n#  - Wired with `if: Bash(*git*)` since #2061.",
				),
				[SELF_PLUGIN_HOOKS]: JSON.stringify({
					hooks: {
						PreToolUse: [
							{
								matcher: "Bash",
								hooks: [
									{
										type: "command",
										command: "node",
										args: [`\${CLAUDE_PROJECT_DIR}/${guard}`],
										if: "Bash(*git*)",
									},
								],
							},
						],
					},
				}),
			},
		});
		const r = run(root);
		expect(r.kinds).toEqual([]);
		expect(r.code).toBe(0);
	});

	it("still faults an exec-form entry that wires some other script (mantahostels#2266)", () => {
		// The paired negative: reading `args` must not make every narrowing pass.
		const root = build({
			claude: region(rule),
			files: {
				[guard]: guardBody(
					"# PreToolUse guard.\n#\n#  - Wired with `if: Bash(*git*)` since #2061.",
				),
				[SELF_PLUGIN_HOOKS]: JSON.stringify({
					hooks: {
						PreToolUse: [
							{
								matcher: "Bash",
								hooks: [
									{
										type: "command",
										command: "node",
										args: [`\${CLAUDE_PROJECT_DIR}/${other}`],
									},
								],
							},
						],
					},
				}),
			},
		});
		expect(run(root).kinds).toContain("UNWIRED-IF");
	});

	it("faults a narrowing in a script no rule names and the wiring never mentioned (mantahostels#2234)", () => {
		// The open question mantahostels#2234 settles: a retired guard kept for reference is
		// not exempt.
		const retired = "scripts/guard-retired.sh";
		const root = build({
			claude: region(
				"- Rule. **Enforced** (#1): `scripts/guard-other.sh` denies it.",
			),
			files: {
				[other]: guardBody("# PreToolUse guard."),
				[retired]: guardBody(
					"# Retired guard, kept for reference.\n#  - Wired with `if: Bash(*gh*)` since #2061.",
				),
				[SELF_PLUGIN_HOOKS]: wiringWithIf(other),
			},
		});
		const r = run(root);
		expect(r.kinds).toContain("UNWIRED-IF");
		expect(r.kinds).not.toContain("UNWIRED");
		expect(r.report).toContain(`UNWIRED-IF  ${retired}:3`);
		expect(r.report).toMatch(
			/wiring:\s+absent from self-plugin\/hooks\/hooks\.json/,
		);
		expect(
			r.json.findings.find((f) => f.kind === "UNWIRED-IF")?.detail,
		).toContain("Delete the line or wire the script");
		expect(r.code).toBe(1);
	});
});

function committedRepo(fx: Fixture): string {
	const root = build(fx);
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: root, encoding: "utf8" });
	git("init", "-q", ".");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "test");
	git("add", "-A");
	git("commit", "-qm", "x");
	return root;
}

describe("--against HEAD, the shape .husky/pre-commit's guard-registry gate runs (mantahostels#2077)", () => {
	/*
	 * Unlike every fixture above, this one is a real git repository: --against
	 * materialises both sides with `git archive`/`git write-tree`, so there has
	 * to be a HEAD to read and an index to diff it against. run()'s cwd
	 * option is what makes those subprocesses see this repo rather than the
	 * one hosting the test.
	 */
	const kept =
		"- Stay on `main`. **Enforced** (#110): `scripts/guard-branch.sh` denies it.";
	/*
	 * A BROKEN-CLAIM already at HEAD, not fixed by any case below. runAgainst()
	 * only materialises and diffs the HEAD baseline when the staged side ALREADY
	 * has a gating fault (lib/check.js's `if (gating.length || …)`) — a genuinely
	 * clean baseline would skip that whole path, and the "passes" case below
	 * would then go green whether or not the fixture's scripts/lib/ copy actually
	 * works. Carrying one inherited fault throughout forces the real
	 * materialise/diff to run in every case.
	 */
	const preexisting =
		"- A pre-existing gap. **Enforced** (#1): `scripts/guard-preexisting.sh` denies it.";
	const clean = region(kept, preexisting);
	const cleanFiles = {
		"scripts/guard-branch.sh": "#!/bin/sh\nexit 0\n",
		[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-branch.sh"),
	};

	it("reports the fault a staged change adds over a clean HEAD", () => {
		const root = committedRepo({ claude: clean, files: cleanFiles });
		// Staged, not committed: HEAD stays the clean baseline reread() diffs
		// against. The new bullet goes INSIDE the region, not after its closing
		// delimiter — outside it, the scanner would never see it at all.
		fs.writeFileSync(
			path.join(root, "CLAUDE.md"),
			region(
				kept,
				preexisting,
				"- A new rule. **Enforced** (#2077): `scripts/guard-nope.sh` denies it.",
			),
		);
		execFileSync("git", ["add", "-A"], { cwd: root });

		const r = run(root, ["--against", "HEAD"], { cwd: root });
		expect(r.code).toBe(1);
		// Only the new BROKEN-CLAIM gates — the pre-existing one at HEAD is
		// inherited, and reports as a WARN rather than sitting in this list.
		expect(r.kinds).toEqual(["NEW-FAULT"]);
		// The underlying BROKEN-CLAIM's own message rides inside the NEW-FAULT
		// finding's message.
		expect(r.json.findings[0].message).toContain("does not exist");
	});

	it("passes when the staged tree adds no fault HEAD did not already carry", () => {
		const root = committedRepo({ claude: clean, files: cleanFiles });
		fs.mkdirSync(path.join(root, "docs"), { recursive: true });
		fs.writeFileSync(path.join(root, "docs", "note.md"), "unrelated\n");
		execFileSync("git", ["add", "-A"], { cwd: root });

		const r = run(root, ["--against", "HEAD"], { cwd: root });
		expect(r.code).toBe(0);
		expect(r.kinds).toEqual([]);
	});

	it("reports the materialised side's gitignore filter as not run, never FAILED OPEN (#710)", () => {
		/* A real subprocess: the re-exec streams its report to fd 2, which the
		 * in-process run() cannot capture. */
		const root = committedRepo({ claude: clean, files: cleanFiles });
		const r = spawnSync(
			"node",
			[
				path.join(root, "scripts", "check-guard-registry.js"),
				"--against",
				"HEAD",
			],
			{
				cwd: root,
				encoding: "utf8",
				env: {
					...process.env,
					CLAUDE_PROJECT_DIR: root,
					WFC_RULES_DIR: "",
					WFC_RULES_FALLBACK_DIR: "",
				},
			},
		);
		expect(r.status).toBe(0);
		expect(r.stderr + r.stdout).toContain("Gitignore filter: not run");
		expect(r.stderr + r.stdout).not.toContain("FAILED OPEN");
	});
});

/*
 * Pure bookkeeping, not a --against exercise: expectFixtureSupplies reads only
 * what `.husky/pre-commit`'s own fragment spawns as a runnable
 * (`node|bash|sh scripts/x.js`), which is `check-guard-registry.js` alone — the
 * checker's own `require()`s of checker-new-faults.js/lib/fault-diff.js are
 * invisible to that scan, so this asserts nothing about whether build() copies
 * them. It duplicates scripts/precommit-ci-gates.test.ts's identical assertion
 * for the same gate.
 */
describe("the pre-commit anchor's own supply set (mantahostels#2077)", () => {
	it("supplies exactly the script the pre-commit anchor invokes", () => {
		expectFixtureSupplies("scripts/check-guard-registry.js", [
			"scripts/check-guard-registry.js",
		]);
	});
});

describe("a guard's digest covers the libraries it sources (mantahostels#140)", () => {
	/* A guard that reaches its verdict through a shared library, as the three
	 * Bash guards do. The library is named in no rule, so it can never be
	 * anchored on its own: the checker rejects an anchor no rule mentions. */
	const withLib = (lib: string) =>
		build({
			claude: region(
				"- Stay on `main`. **Enforced** (#110): `scripts/guard-branch.sh` denies the checkout.",
			),
			files: {
				"scripts/guard-branch.sh":
					'#!/bin/sh\nsource "$(dirname "$0")/lib/guard-parse.sh"\nexit 2\n',
				"scripts/lib/guard-parse.sh": lib,
				[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-branch.sh"),
			},
		});

	it("warns the guard is stale when only its library changed, naming the guard, not the library", () => {
		// gp_deny lives in the library, so a change there can falsify the rule
		// describing the guard.
		const root = withLib("gp_deny() { exit 2; }\n");
		reviewIn(root);
		fs.writeFileSync(
			path.join(root, "scripts", "lib", "guard-parse.sh"),
			"gp_deny() { exit 0; }\n",
		);

		const r = run(root);
		expect(r.json.warnings.map((w) => w.kind)).toEqual(["STALE-PROSE"]);
		expect(r.json.warnings[0].guard).toBe("scripts/guard-branch.sh");
	});

	it("still anchors the guard alone, never the library", () => {
		// An anchor for the library would fail as ORPHAN-ANCHOR: no rule names it.
		const root = withLib("gp_deny() { exit 2; }\n");
		reviewIn(root);

		expect(Object.keys(anchorsOf(root))).toEqual(["scripts/guard-branch.sh"]);
		expect(run(root).json.warnings).toEqual([]);
	});

	it("is quiet when neither guard nor library has moved", () => {
		const root = withLib("gp_deny() { exit 2; }\n");
		reviewIn(root);

		expect(run(root).json.warnings).toEqual([]);
	});

	it("survives a library that sources itself", () => {
		// A cycle must not hang or blow the stack; each file is hashed once.
		const root = withLib('source "$(dirname "$0")/lib/guard-parse.sh"\n');
		reviewIn(root);

		expect(run(root).json.warnings).toEqual([]);
	});

	it("ignores a source line that is commented out", () => {
		const root = withLib("gp_deny() { exit 2; }\n");
		reviewIn(root);
		fs.writeFileSync(
			path.join(root, "scripts", "guard-branch.sh"),
			'#!/bin/sh\nsource "$(dirname "$0")/lib/guard-parse.sh"\n# source "$(dirname "$0")/lib/absent.sh"\nexit 2\n',
		);

		// The guard's own bytes changed, so it is stale — but on its own account,
		// not because a commented path was followed to a missing file.
		const r = run(root);
		expect(r.json.warnings.map((w) => w.kind)).toEqual(["STALE-PROSE"]);
	});

	function anchorsOf(root: string): Record<string, string> {
		return JSON.parse(fs.readFileSync(path.join(root, ANCHORS), "utf8"));
	}
});

describe("--touched-by <rev>, the post-commit notice (#2375)", () => {
	/* Two guards, one sourcing a library, anchored and committed, so each
	 * case's own commit is the one under judgement. */
	function anchoredRepo() {
		const root = build({
			claude: region(
				"- Stay on `main`. **Enforced** (#110): `scripts/guard-branch.sh` denies the checkout.",
				"- Never amend. **Enforced** (#111): `scripts/guard-amend.sh` denies it.",
			),
			files: {
				"scripts/guard-branch.sh":
					'#!/bin/sh\nsource "$(dirname "$0")/lib/guard-parse.sh"\nexit 2\n',
				"scripts/guard-amend.sh": "#!/bin/sh\nexit 2\n",
				"scripts/lib/guard-parse.sh": "gp_deny() { exit 2; }\n",
				[SELF_PLUGIN_HOOKS]: hooksWiring(
					"scripts/guard-branch.sh",
					"scripts/guard-amend.sh",
				),
			},
		});
		reviewIn(root);
		const git = (...args: string[]) =>
			execFileSync("git", args, { cwd: root, encoding: "utf8" });
		git("init", "-q", ".");
		git("config", "user.email", "test@example.com");
		git("config", "user.name", "test");
		git("add", "-A");
		git("commit", "-qm", "base");
		/* null deletes the file; the commit takes `rel` and `also` alone. */
		const commit = (rel: string, body: string | null, also: string[] = []) => {
			if (body === null) fs.rmSync(path.join(root, rel));
			else fs.writeFileSync(path.join(root, rel), body);
			git("add", "-A", "--", rel, ...also);
			git("commit", "-qm", `change ${rel}`, "--", rel, ...also);
		};
		return { root, commit };
	}

	const touched = (root: string) =>
		run(root, ["--touched-by", "HEAD", "--root", root], { cwd: root });

	it("names a guard whose library the commit changed, through it, with its rule and the --review line", () => {
		const { root, commit } = anchoredRepo();
		commit("scripts/lib/guard-parse.sh", "gp_deny() { exit 0; }\n");
		const r = touched(root);
		expect(r.code).toBe(0);
		expect(r.json.warnings.map((w) => [w.kind, w.guard])).toEqual([
			["STALE-PROSE", "scripts/guard-branch.sh"],
		]);
		expect(r.report).toContain(
			"STALE-PROSE  scripts/guard-branch.sh (through scripts/lib/guard-parse.sh)",
		);
		expect(r.report).toContain("rule:  CLAUDE.md:");
		expect(r.report).toContain(
			"node scripts/check-guard-registry.js --review <guard-path>",
		);
	});

	it("is OK where the commit re-anchored what it changed", () => {
		const { root, commit } = anchoredRepo();
		fs.writeFileSync(
			path.join(root, "scripts", "guard-amend.sh"),
			"#!/bin/sh\nexit 1\n",
		);
		reviewIn(root, ["scripts/guard-amend.sh"]);
		commit("scripts/guard-amend.sh", "#!/bin/sh\nexit 1\n", [ANCHORS]);
		const r = touched(root);
		expect(r.code).toBe(0);
		expect(r.json.warnings).toEqual([]);
	});

	it("leaves a guard stale from before to the full run, where this commit did not touch it", () => {
		const { root, commit } = anchoredRepo();
		commit("scripts/guard-amend.sh", "#!/bin/sh\nexit 1\n");
		commit(
			"CLAUDE.md",
			`${fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8")}\n`,
		);
		expect(touched(root).json.warnings).toEqual([]);
		expect(run(root).json.warnings.map((w) => w.guard)).toEqual([
			"scripts/guard-amend.sh",
		]);
	});

	it("names a guard the commit re-anchored on disk but left its anchor out of", () => {
		const { root, commit } = anchoredRepo();
		fs.writeFileSync(
			path.join(root, "scripts", "guard-amend.sh"),
			"#!/bin/sh\nexit 1\n",
		);
		reviewIn(root, ["scripts/guard-amend.sh"]);
		commit("scripts/guard-amend.sh", "#!/bin/sh\nexit 1\n");
		const r = touched(root);
		expect(r.code).toBe(0);
		expect(r.json.warnings.map((w) => w.guard)).toEqual([
			"scripts/guard-amend.sh",
		]);
		expect(r.report).toContain(
			"node scripts/check-guard-registry.js --review <guard-path>",
		);
		expect(r.report).toContain(`and commit ${ANCHORS}`);
	});

	it("names an anchored guard the commit deleted, and --review <path> drops its anchor", () => {
		const { root, commit } = anchoredRepo();
		commit("scripts/guard-amend.sh", null);
		const r = touched(root);
		expect(r.code).toBe(0);
		expect(r.json.warnings.map((w) => [w.kind, w.guard])).toEqual([
			["GUARD-GONE", "scripts/guard-amend.sh"],
		]);
		expect(r.report).toContain("rule:  CLAUDE.md:");
		expect(r.report).toContain(
			"node scripts/check-guard-registry.js --review <guard-path>",
		);
		expect(reviewIn(root, ["scripts/guard-amend.sh"])).toContain(
			"dropped scripts/guard-amend.sh — file does not exist",
		);
		expect(
			Object.keys(
				JSON.parse(fs.readFileSync(path.join(root, ANCHORS), "utf8")),
			),
		).toEqual(["scripts/guard-branch.sh"]);
	});

	it("is BROKEN, in the words .husky/post-commit prints aloud, past its git ceiling (#2210)", () => {
		const { root, commit } = anchoredRepo();
		commit("scripts/guard-amend.sh", "#!/bin/sh\nexit 1\n");
		const r = run(root, ["--touched-by", "HEAD", "--root", root], {
			cwd: root,
			env: { WFC_TOUCHED_BY_CEILING_MS: "1" },
		});
		expect(r.code).toBe(2);
		expect(JSON.stringify(r.json)).toMatch(
			/--touched-by passed its \S+ ceiling/,
		);
	});

	it("is BROKEN where the anchors the commit carries are not a JSON object", () => {
		const { root, commit } = anchoredRepo();
		commit(ANCHORS, "[]\n");
		const r = touched(root);
		expect(r.code).toBe(2);
		expect(JSON.stringify(r.json)).toContain(
			`${ANCHORS} at HEAD is not a JSON object; restore it, re-anchor with  node scripts/check-guard-registry.js --review`,
		);
	});

	it("names the live guard-dispatch-rewrite.sh through the lib/dispatch-rewrite.js it runs from a variable (#2487)", () => {
		const guard = "scripts/guard-dispatch-rewrite.sh";
		const lib = "scripts/lib/dispatch-rewrite.js";
		const root = committedRepo({
			claude: region(
				`- One rewrite per dispatch. **Enforced** (#2013): \`${guard}\` rewrites it.`,
			),
			files: {
				[guard]: fs.readFileSync(
					path.join(__dirname, "guard-dispatch-rewrite.sh"),
					"utf8",
				),
				[SELF_PLUGIN_HOOKS]: hooksWiring(guard),
			},
		});
		reviewIn(root);
		const git = (...args: string[]) =>
			execFileSync("git", args, { cwd: root, encoding: "utf8" });
		git("add", "--", ANCHORS);
		git("commit", "-qm", "anchor", "--", ANCHORS);
		fs.appendFileSync(path.join(root, lib), "\n// changed\n");
		git("commit", "-qm", "change the lib", "--", lib);

		const r = touched(root);
		expect(r.code).toBe(0);
		expect(r.json.warnings.map((w) => [w.kind, w.guard])).toEqual([
			["STALE-PROSE", guard],
		]);
		expect(r.report).toContain(`STALE-PROSE  ${guard} (through ${lib})`);
		expect(r.report).toContain(
			"node scripts/check-guard-registry.js --review <guard-path>",
		);
	});

	it("refuses --review beside it", () => {
		const root = build({ claude: region() });
		const r = runInProcess(
			path.join(root, "scripts", "check-guard-registry.js"),
			["--touched-by", "HEAD", "--review"],
			{ env: reviewEnv(root), cwd: root },
		);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("does not combine with --review");
	});
});

describe("--against HEAD refuses the commit that expires an anchor (#2617)", () => {
	/* Two guards, one sourcing a library, anchored and committed with their
	 * anchors, so each case stages the change under judgement. */
	let template = "";
	beforeAll(() => {
		const built = build({
			claude: region(
				"- Stay on `main`. **Enforced** (#110): `scripts/guard-branch.sh` denies the checkout.",
				"- Never amend. **Enforced** (#111): `scripts/guard-amend.sh` denies it.",
			),
			files: {
				"scripts/guard-branch.sh":
					'#!/bin/sh\nsource "$(dirname "$0")/lib/guard-parse.sh"\nexit 2\n',
				"scripts/guard-amend.sh": "#!/bin/sh\nexit 2\n",
				"scripts/lib/guard-parse.sh": "gp_deny() { exit 2; }\n",
				[SELF_PLUGIN_HOOKS]: hooksWiring(
					"scripts/guard-branch.sh",
					"scripts/guard-amend.sh",
				),
			},
		});
		reviewIn(built, [], claims());
		const init = (...args: string[]) =>
			execFileSync("git", args, { cwd: built, encoding: "utf8" });
		init("init", "-q", ".");
		init("config", "user.email", "test@example.com");
		init("config", "user.name", "test");
		init("add", "-A");
		init("commit", "-qm", "base");
		/* Out of `temps`, which afterEach empties after the first case. */
		temps.splice(temps.indexOf(built), 1);
		template = built;
	});
	afterAll(() => fs.rmSync(template, { recursive: true, force: true }));

	function anchoredRepo() {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-registry-"));
		temps.push(root);
		fs.cpSync(template, root, { recursive: true });
		const git = (...args: string[]) =>
			execFileSync("git", args, { cwd: root, encoding: "utf8" });
		const stage = (files: Record<string, string>, also: string[] = []) => {
			for (const [rel, body] of Object.entries(files))
				fs.writeFileSync(path.join(root, rel), body);
			git("add", "--", ...Object.keys(files), ...also);
		};
		return { root, git, stage };
	}

	/* Claims are injected at the store, so the live arbiter's never reach a
	 * fixture whose paths share their names. */
	function claims(locks: unknown[] = []) {
		return {
			CLAUDE_CODE_SESSION_ID: "self-session",
			WFC_ANCHOR_LOCKS: JSON.stringify(locks),
		};
	}
	const gate = (root: string, locks: unknown[] = []) =>
		run(root, ["--against", "HEAD"], { cwd: root, env: claims(locks) });
	const review = (root: string, paths: string[]) =>
		reviewIn(root, paths, claims());
	/* .husky/pre-commit's own guard-registry line, so the case runs what the
	 * hook runs. */
	const hookLine = () => {
		const line = fs
			.readFileSync(path.join(__dirname, "..", ".husky", "pre-commit"), "utf8")
			.split("\n")
			.find((l) => l.includes("check-guard-registry.js --against HEAD"));
		if (!line) throw new Error("no guard-registry line in .husky/pre-commit");
		return line.trim();
	};
	const added = (r: Result) =>
		r.json.findings
			.filter((f) => (f as { tag?: string }).tag === "NEW-FAULT")
			.map((f) => f.message);

	it("refuses a library change that expires a guard's anchor, naming the path, its rule, the --review line and the pathspec", () => {
		const { root, stage } = anchoredRepo();
		stage({ "scripts/lib/guard-parse.sh": "gp_deny() { exit 0; }\n" });
		const r = gate(root);
		expect(r.code).toBe(1);
		expect(added(r)).toEqual([
			expect.stringContaining("scripts/guard-branch.sh — changed since"),
		]);
		expect(r.report).toContain("STALE-PROSE  scripts/guard-branch.sh");
		expect(r.report).toContain("rule:  CLAUDE.md:");
		expect(r.report).toContain(
			"node scripts/check-guard-registry.js --review scripts/guard-branch.sh",
		);
		expect(r.report).toContain(`put ${ANCHORS} in this commit's pathspec`);
	});

	it("passes the same change once its re-anchor is staged with it", () => {
		const { root, stage } = anchoredRepo();
		stage({ "scripts/guard-amend.sh": "#!/bin/sh\nexit 1\n" });
		expect(gate(root).code).toBe(1);
		review(root, ["scripts/guard-amend.sh"]);
		stage({}, [ANCHORS]);
		const r = gate(root);
		expect(r.code).toBe(0);
		expect(added(r)).toEqual([]);
	});

	it("passes a commit over a row already stale at HEAD", () => {
		const { root, git, stage } = anchoredRepo();
		stage({ "scripts/guard-amend.sh": "#!/bin/sh\nexit 1\n" });
		git("commit", "-qm", "stale at HEAD");
		stage({
			"CLAUDE.md": `${fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8")}\n`,
		});
		const r = gate(root);
		expect(r.code).toBe(0);
		expect(added(r)).toEqual([]);
	});

	it("stands down a path a live neighbour holds dirty, and says whose", () => {
		const { root, stage } = anchoredRepo();
		stage({ "scripts/lib/guard-parse.sh": "gp_deny() { exit 0; }\n" });
		// Dirty in the working tree only: the neighbour's, not this commit's.
		fs.writeFileSync(
			path.join(root, "scripts", "guard-branch.sh"),
			'#!/bin/sh\nsource "$(dirname "$0")/lib/guard-parse.sh"\nexit 3\n',
		);
		const r = gate(root, [
			{
				path: "scripts/guard-branch.sh",
				sessionId: "neighbour-session",
				pid: 4242,
				alive: true,
				claimedAt: new Date().toISOString(),
			},
		]);
		expect(r.code).toBe(0);
		expect(r.report).toContain("not refusing scripts/guard-branch.sh");
		expect(r.report).toContain("neighbour-session");
	});

	it("stands down a row whose LIBRARY a live neighbour holds dirty, not only its guard", () => {
		const { root, stage } = anchoredRepo();
		stage({ "scripts/lib/guard-parse.sh": "gp_deny() { exit 0; }\n" });
		fs.writeFileSync(
			path.join(root, "scripts", "lib", "guard-parse.sh"),
			"gp_deny() { exit 5; }\n",
		);
		const r = gate(root, [
			{
				path: "scripts/lib/guard-parse.sh",
				sessionId: "neighbour-session",
				pid: 4242,
				alive: true,
				claimedAt: new Date().toISOString(),
			},
		]);
		expect(r.code).toBe(0);
		expect(r.report).toContain(
			"not refusing scripts/guard-branch.sh — scripts/lib/guard-parse.sh is dirty and claimed by neighbour-session",
		);
	});

	it("names the library a guard went stale through", () => {
		const { root, stage } = anchoredRepo();
		stage({ "scripts/lib/guard-parse.sh": "gp_deny() { exit 0; }\n" });
		expect(gate(root).report).toContain(
			"STALE-PROSE  scripts/guard-branch.sh (through scripts/lib/guard-parse.sh)",
		);
	});

	it("is the refusal a pathspec commit meets through the hook's own line", () => {
		const { root, git } = anchoredRepo();
		const hook = path.join(root, ".git", "hooks", "pre-commit");
		fs.writeFileSync(hook, `#!/bin/sh\n${hookLine()}\n`, { mode: 0o755 });
		fs.writeFileSync(
			path.join(root, "scripts", "guard-amend.sh"),
			"#!/bin/sh\nexit 1\n",
		);
		const env = {
			...reviewEnv(root, claims()),
			WFC_RULES_DIR: "",
			WFC_RULES_FALLBACK_DIR: "",
		};
		const commit = (...paths: string[]) =>
			spawnSync("git", ["commit", "-qm", "x", "--", ...paths], {
				cwd: root,
				encoding: "utf8",
				env,
			});
		const refused = commit("scripts/guard-amend.sh");
		expect(refused.status).not.toBe(0);
		expect(refused.stderr).toContain("--review scripts/guard-amend.sh");
		review(root, ["scripts/guard-amend.sh"]);
		expect(commit("scripts/guard-amend.sh", ANCHORS).status).toBe(0);
		expect(git("status", "--porcelain")).toBe("");
	});

	it("says so where the working tree differs from the staged bytes a re-anchor must match", () => {
		const { root, stage } = anchoredRepo();
		stage({ "scripts/lib/guard-parse.sh": "gp_deny() { exit 0; }\n" });
		fs.writeFileSync(
			path.join(root, "scripts", "lib", "guard-parse.sh"),
			"gp_deny() { exit 4; }\n",
		);
		review(root, ["scripts/guard-branch.sh"]);
		stage({}, [ANCHORS]);
		const r = gate(root);
		expect(r.code).toBe(1);
		expect(r.report).toContain(
			"scripts/lib/guard-parse.sh in the working tree differs from the staged copy, and --review hashes the working tree",
		);
	});

	it("says so where a re-anchor already run is left out of the commit", () => {
		const { root, stage } = anchoredRepo();
		stage({ "scripts/guard-amend.sh": "#!/bin/sh\nexit 1\n" });
		review(root, ["scripts/guard-amend.sh"]);
		const r = gate(root);
		expect(r.code).toBe(1);
		expect(r.report).toContain(
			`${ANCHORS} in the working tree differs from the staged copy`,
		);
	});

	it("refuses a rule newly naming a guard nobody anchored, as UNANCHORED", () => {
		const { root, stage } = anchoredRepo();
		stage({
			"CLAUDE.md": region(
				"- Stay on `main`. **Enforced** (#110): `scripts/guard-branch.sh` denies the checkout.",
				"- Never amend. **Enforced** (#111): `scripts/guard-amend.sh` denies it.",
				"- Never rebase. **Enforced** (#112): `scripts/guard-rebase.sh` denies it.",
			),
			"scripts/guard-rebase.sh": "#!/bin/sh\nexit 2\n",
			[SELF_PLUGIN_HOOKS]: hooksWiring(
				"scripts/guard-branch.sh",
				"scripts/guard-amend.sh",
				"scripts/guard-rebase.sh",
			),
		});
		const r = gate(root);
		expect(r.code).toBe(1);
		expect(r.report).toContain("UNANCHORED  scripts/guard-rebase.sh");
		expect(r.report).toContain("--review scripts/guard-rebase.sh");
	});

	it("refuses a commit that orphans an anchor, which --review <path> then drops", () => {
		const { root, stage } = anchoredRepo();
		stage({
			"CLAUDE.md": region(
				"- Stay on `main`. **Enforced** (#110): `scripts/guard-branch.sh` denies the checkout.",
			),
			[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-branch.sh"),
		});
		const r = gate(root);
		expect(r.code).toBe(1);
		expect(r.report).toContain("ORPHAN-ANCHOR  scripts/guard-amend.sh");
		expect(review(root, ["scripts/guard-amend.sh"])).toContain(
			"dropped scripts/guard-amend.sh — no rule names it and no wiring reaches it",
		);
		stage({}, [ANCHORS]);
		expect(gate(root).code).toBe(0);
	});
});

describe("a JS guard's digest covers the modules it requires (mantahostels#159)", () => {
	/* session-arbiter.js's shape after mantahostels#159: a CLI named by the rule, whose
	 * behaviour sits two requires away in lib/. */
	const withModules = (leaf: string) =>
		build({
			claude: region(
				"- Release a file you are done with. **Enforced** (#126): `scripts/session-arbiter.js` releases it.",
			),
			files: {
				"scripts/session-arbiter.js":
					'const store = require("./lib/arbiter-store.js");\nstore.release();\n',
				"scripts/lib/arbiter-store.js":
					'const proc = require("./arbiter-proc.js");\nmodule.exports = { release: () => proc.holderAlive({}) };\n',
				"scripts/lib/arbiter-proc.js": leaf,
				[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/session-arbiter.js"),
			},
		});

	it("warns the CLI is stale when only the leaf two requires away changed, naming the CLI, not the leaf", () => {
		const root = withModules("module.exports = { holderAlive: () => true };\n");
		reviewIn(root);
		fs.writeFileSync(
			path.join(root, "scripts", "lib", "arbiter-proc.js"),
			"module.exports = { holderAlive: () => false };\n",
		);

		const r = run(root);
		expect(r.json.warnings.map((w) => w.kind)).toEqual(["STALE-PROSE"]);
		expect(r.json.warnings[0].guard).toBe("scripts/session-arbiter.js");
	});

	it("still anchors the CLI alone, never the modules under it", () => {
		const root = withModules("module.exports = { holderAlive: () => true };\n");
		reviewIn(root);

		expect(Object.keys(anchorsOf(root))).toEqual([
			"scripts/session-arbiter.js",
		]);
		expect(run(root).json.warnings).toEqual([]);
	});

	it("does not follow a require that leaves lib/", () => {
		// Widening past lib/ would start hashing node_modules and every sibling
		// script.
		const root = withModules("module.exports = { holderAlive: () => true };\n");
		fs.writeFileSync(
			path.join(root, "scripts", "lib", "arbiter-store.js"),
			'const proc = require("./arbiter-proc.js");\nconst other = require("../unrelated.js");\nmodule.exports = { release: () => proc.holderAlive({}) && other };\n',
		);
		fs.writeFileSync(
			path.join(root, "scripts", "unrelated.js"),
			"module.exports = 1;\n",
		);
		reviewIn(root);

		fs.writeFileSync(
			path.join(root, "scripts", "unrelated.js"),
			"module.exports = 2;\n",
		);
		expect(run(root).json.warnings).toEqual([]);
	});

	it("does not follow a require that is commented out", () => {
		const root = withModules("module.exports = { holderAlive: () => true };\n");
		fs.writeFileSync(
			path.join(root, "scripts", "lib", "arbiter-store.js"),
			'const proc = require("./arbiter-proc.js");\n// const old = require("./arbiter-legacy.js");\nmodule.exports = { release: () => proc.holderAlive({}) };\n',
		);
		fs.writeFileSync(
			path.join(root, "scripts", "lib", "arbiter-legacy.js"),
			"module.exports = 1;\n",
		);
		reviewIn(root);

		fs.writeFileSync(
			path.join(root, "scripts", "lib", "arbiter-legacy.js"),
			"module.exports = 2;\n",
		);
		expect(run(root).json.warnings).toEqual([]);
	});

	it("follows a second require sharing a line with the first", () => {
		const root = withModules("module.exports = { holderAlive: () => true };\n");
		fs.writeFileSync(
			path.join(root, "scripts", "lib", "arbiter-store.js"),
			'const proc = require("./arbiter-proc.js"), extra = require("./arbiter-extra.js");\nmodule.exports = { release: () => proc.holderAlive({}) && extra };\n',
		);
		fs.writeFileSync(
			path.join(root, "scripts", "lib", "arbiter-extra.js"),
			"module.exports = 1;\n",
		);
		reviewIn(root);

		fs.writeFileSync(
			path.join(root, "scripts", "lib", "arbiter-extra.js"),
			"module.exports = 2;\n",
		);
		expect(run(root).json.warnings.map((w) => w.kind)).toEqual(["STALE-PROSE"]);
	});

	function anchorsOf(root: string): Record<string, string> {
		return JSON.parse(fs.readFileSync(path.join(root, ANCHORS), "utf8"));
	}
});

describe("a thin shell guard's digest covers the program it runs (mantahostels#358)", () => {
	/* guard-file-claim.sh's shape: a shell guard that extracts a path and shells
	 * out, with every rule-bearing decision in the node program it runs. */
	const withDelegate = (store = 'const REFUSING = ["docs/"];\n') =>
		build({
			claude: region(
				"- A file a live session has written is taken. **Enforced** (#113): `scripts/guard-file-claim.sh` refuses the write.",
			),
			files: {
				"scripts/guard-file-claim.sh":
					'#!/bin/bash\nhere="$(dirname "$0")"\ntimeout 5 node "$here/session-arbiter.js" check "$file" "$session"\n',
				"scripts/session-arbiter.js":
					'const store = require("./lib/arbiter-store.js");\nstore.check();\n',
				"scripts/lib/arbiter-store.js": store,
				[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-file-claim.sh"),
			},
		});

	it("warns the guard is stale when only the store two hops away changed, naming the guard, not the store", () => {
		const root = withDelegate();
		reviewIn(root);
		fs.writeFileSync(
			path.join(root, "scripts", "lib", "arbiter-store.js"),
			'const REFUSING = ["docs/", "scripts/"];\n',
		);

		const r = run(root);
		expect(r.json.warnings.map((w) => w.kind)).toEqual(["STALE-PROSE"]);
		expect(r.json.warnings[0].guard).toBe("scripts/guard-file-claim.sh");
	});

	it("still anchors the shell guard alone, never the program it runs", () => {
		const root = withDelegate();
		reviewIn(root);

		expect(Object.keys(anchorsOf(root))).toEqual([
			"scripts/guard-file-claim.sh",
		]);
		expect(run(root).json.warnings).toEqual([]);
	});

	it("is quiet when neither the guard nor anything under it has moved", () => {
		const root = withDelegate();
		reviewIn(root);

		expect(run(root).json.warnings).toEqual([]);
	});

	it("does not follow a bare path, which is how guards quote advice back", () => {
		// Following an advice line would tie an unrelated helper's internals to a
		// rule about which flags are denied.
		const root = withDelegate();
		fs.writeFileSync(
			path.join(root, "scripts", "guard-file-claim.sh"),
			'#!/bin/bash\nhere="$(dirname "$0")"\necho "Use: node scripts/issue-body.js append"\ntimeout 5 node "$here/session-arbiter.js" check\n',
		);
		fs.writeFileSync(
			path.join(root, "scripts", "issue-body.js"),
			"module.exports = 1;\n",
		);
		reviewIn(root);

		fs.writeFileSync(
			path.join(root, "scripts", "issue-body.js"),
			"module.exports = 2;\n",
		);
		expect(run(root).json.warnings).toEqual([]);
	});

	it("does not follow a node call that is commented out", () => {
		const root = withDelegate();
		fs.writeFileSync(
			path.join(root, "scripts", "guard-file-claim.sh"),
			'#!/bin/bash\nhere="$(dirname "$0")"\n# node "$here/arbiter-legacy.js" check\nnode "$here/session-arbiter.js" check\n',
		);
		fs.writeFileSync(
			path.join(root, "scripts", "arbiter-legacy.js"),
			"module.exports = 1;\n",
		);
		reviewIn(root);

		fs.writeFileSync(
			path.join(root, "scripts", "arbiter-legacy.js"),
			"module.exports = 2;\n",
		);
		expect(run(root).json.warnings).toEqual([]);
	});

	it("follows a call whose expansion names the repo root, not the guard's dir", () => {
		// `node "$root/scripts/x.js"` resolves against the repo root; joining it to
		// the guard's own directory instead gives scripts/scripts/x.js, which is
		// nowhere, and the real dependency drops out silently.
		const root = withDelegate();
		fs.writeFileSync(
			path.join(root, "scripts", "guard-file-claim.sh"),
			'#!/bin/bash\nroot="$(git rev-parse --show-toplevel)"\nnode "$root/scripts/session-arbiter.js" check\n',
		);
		reviewIn(root);
		fs.writeFileSync(
			path.join(root, "scripts", "lib", "arbiter-store.js"),
			'const REFUSING = ["docs/", "scripts/"];\n',
		);

		expect(run(root).json.warnings.map((w) => w.kind)).toEqual(["STALE-PROSE"]);
	});

	it("does not follow a node call commented out the JS way", () => {
		// sourcedBy runs over JS guards too, where a dead line is `//`, not `#`.
		const root = build({
			claude: region(
				"- Release a file you are done with. **Enforced** (#126): `scripts/session-arbiter.js` releases it.",
			),
			files: {
				"scripts/session-arbiter.js":
					'// const cmd = "timeout 5 node $here/arbiter-legacy.js check";\nrequire("./lib/arbiter-store.js");\n',
				"scripts/lib/arbiter-store.js": 'const REFUSING = ["docs/"];\n',
				"scripts/arbiter-legacy.js": "module.exports = 1;\n",
				[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/session-arbiter.js"),
			},
		});
		reviewIn(root);

		fs.writeFileSync(
			path.join(root, "scripts", "arbiter-legacy.js"),
			"module.exports = 2;\n",
		);
		expect(run(root).json.warnings).toEqual([]);
	});

	it("follows a program the guard runs through a variable it assigns (#2487)", () => {
		// guard-dispatch-rewrite.sh's shape: lib="$here/lib/x.js" … node "$lib".
		const root = withDelegate();
		fs.writeFileSync(
			path.join(root, "scripts", "guard-file-claim.sh"),
			'#!/bin/bash\nhere="$(dirname "$0")"\narbiter="$here/session-arbiter.js"\nout="$(printf x | node "$arbiter" check "$file")"\n',
		);
		reviewIn(root);
		fs.writeFileSync(
			path.join(root, "scripts", "lib", "arbiter-store.js"),
			'const REFUSING = ["docs/", "scripts/"];\n',
		);

		const r = run(root);
		expect(r.code).toBe(0);
		expect(r.json.warnings.map((w) => w.kind)).toEqual(["STALE-PROSE"]);
		expect(r.json.warnings[0].guard).toBe("scripts/guard-file-claim.sh");
		expect(r.json.warnings[0].detail).toMatch(/re-read the rule/);
	});

	it("follows a variable run inside a command substitution", () => {
		// guard-unasked-rerun.sh's shape: x="$(node "$judge" …)".
		const root = withDelegate();
		fs.writeFileSync(
			path.join(root, "scripts", "guard-file-claim.sh"),
			'#!/bin/bash\nhere="$(dirname "$0")"\narbiter="$here/session-arbiter.js"  # the judge\nout="$(node "$arbiter" check)"\n',
		);
		reviewIn(root);
		fs.writeFileSync(
			path.join(root, "scripts", "lib", "arbiter-store.js"),
			'const REFUSING = ["docs/", "scripts/"];\n',
		);

		const r = run(root);
		expect(r.code).toBe(0);
		expect(r.json.warnings.map((w) => w.kind)).toEqual(["STALE-PROSE"]);
		expect(r.json.warnings[0].detail).toMatch(/re-read the rule/);
	});

	it("follows every program a variable assigned twice names", () => {
		// .husky/post-commit's shape: `script` names one program, then another.
		const root = withDelegate();
		fs.writeFileSync(
			path.join(root, "scripts", "guard-file-claim.sh"),
			'#!/bin/bash\nhere="$(dirname "$0")"\nscript="$here/session-arbiter.js"\nnode "$script" check\nscript="$here/issue-body.js"\nnode "$script" append\n',
		);
		fs.writeFileSync(
			path.join(root, "scripts", "issue-body.js"),
			"module.exports = 1;\n",
		);
		reviewIn(root);
		fs.writeFileSync(
			path.join(root, "scripts", "lib", "arbiter-store.js"),
			'const REFUSING = ["docs/", "scripts/"];\n',
		);

		const r = run(root);
		expect(r.code).toBe(0);
		expect(r.json.warnings.map((w) => w.kind)).toEqual(["STALE-PROSE"]);
		expect(r.json.warnings[0].detail).toMatch(/re-read the rule/);
	});

	it("does not follow a variable's path that node never runs", () => {
		const root = withDelegate();
		fs.writeFileSync(
			path.join(root, "scripts", "guard-file-claim.sh"),
			'#!/bin/bash\nhere="$(dirname "$0")"\nhint="$here/issue-body.js"\necho "Use: $hint"\nnode "$here/session-arbiter.js" check\n',
		);
		fs.writeFileSync(
			path.join(root, "scripts", "issue-body.js"),
			"module.exports = 1;\n",
		);
		reviewIn(root);

		fs.writeFileSync(
			path.join(root, "scripts", "issue-body.js"),
			"module.exports = 2;\n",
		);
		const r = run(root);
		expect(r.code).toBe(0);
		expect(r.json.warnings).toEqual([]);
	});

	it("survives a node call naming a file that is not there", () => {
		const root = withDelegate();
		fs.writeFileSync(
			path.join(root, "scripts", "guard-file-claim.sh"),
			'#!/bin/bash\nhere="$(dirname "$0")"\nnode "$here/absent.js" check\n',
		);
		reviewIn(root);

		// Absence is the BROKEN-CLAIM check's business, not the digest's.
		expect(run(root).json.warnings).toEqual([]);
	});

	function anchorsOf(root: string): Record<string, string> {
		return JSON.parse(fs.readFileSync(path.join(root, ANCHORS), "utf8"));
	}
});

describe("the checker breaking is not the same event as a rule being false", () => {
	/**
	 * Raw runner: these cases are about the process's own outcome, so nothing
	 * here may assume the output parses — and this one keeps its spawn for the
	 * same reason, needing a real fd layout (stdout piped, stdin closed) that
	 * the in-process seam does not reproduce.
	 */
	function raw(root: string, extra: string[] = []) {
		try {
			const stdout = execFileSync(
				process.execPath,
				[path.join(root, "scripts", "check-guard-registry.js"), ...extra],
				{
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
					/* Off deliberately: with it set, check.js writes the BROKEN message
					 * to stdout as a ::error:: annotation, and the stdout-discipline
					 * assertions below are about the non-Actions path. Inheriting it made
					 * these pass locally and fail on a runner. */
					env: {
						...process.env,
						CLAUDE_PROJECT_DIR: root,
						GITHUB_ACTIONS: "",
					},
				},
			);
			return { code: 0, stdout, stderr: "" };
		} catch (e) {
			const err = e as { status: number; stdout: string; stderr: string };
			return { code: err.status, stdout: err.stdout, stderr: err.stderr };
		}
	}

	const wellFormed = () =>
		region("- Stay on `main`. **Unenforceable**: no hook can see this.");

	it("reports an unexpected throw as BROKEN at exit 2, not as a false claim at exit 1", () => {
		const root = build({ claude: wellFormed() });
		// .husky exists but is a file, so reading it as a directory throws ENOTDIR
		// from inside the scan. Exit 1 would say "a rule's stated backing is false",
		// which is a claim about the repo this run is in no position to make.
		fs.writeFileSync(path.join(root, ".husky"), "not a directory\n");

		const r = raw(root);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("BROKEN:");
		expect(r.stderr).toContain("unhandled error in guard-registry");
		// The stack goes out because at this point nobody knows what happened.
		expect(r.stderr).toContain("ENOTDIR");
	});

	it("keeps the same throw off stdout, which belongs to the machine reader", () => {
		const root = build({ claude: wellFormed() });
		fs.writeFileSync(path.join(root, ".husky"), "not a directory\n");

		const r = raw(root);
		expect(r.stdout).toBe("");
	});

	/* chmod is a no-op for root, which can read the directory anyway. */
	const asRoot = typeof process.getuid === "function" && process.getuid() === 0;

	it.skipIf(asRoot)(
		"reports a tracked directory it cannot read as BROKEN, not as a clean scan",
		() => {
			const root = build({ claude: wellFormed() });
			fs.mkdirSync(path.join(root, "docs"));
			fs.writeFileSync(path.join(root, "docs", "rules.md"), wellFormed());
			fs.chmodSync(path.join(root, "docs"), 0o000);

			try {
				const r = raw(root);
				// Swallowing this reports OK over scope that was never scanned.
				expect(r.code).toBe(2);
				expect(r.stderr).toContain("BROKEN:");
				expect(r.stderr).toContain("EACCES");
			} finally {
				fs.chmodSync(path.join(root, "docs"), 0o755);
			}
		},
	);

	it("refuses --review --json with its usage line, and anchors nothing, rather than describe a run that never happened", () => {
		const root = build({ claude: wellFormed() });
		const r = raw(root, ["--review", "--json"]);

		expect(r.code).toBe(2);
		// --review writes anchors and reports no findings, so there is no outcome
		// to serialise, so the run is refused instead.
		const envelope = JSON.parse(r.stdout);
		expect(envelope.outcome).toBe("BROKEN");
		expect(envelope.summary).toContain("no --json form");
		expect(envelope.summary).toContain("usage:");
		// Nothing was anchored: the refusal precedes the write.
		expect(
			fs.existsSync(path.join(root, ".claude", "guard-registry-anchors.json")),
		).toBe(false);
	});
});

describe("a rule whose text its guard reprints when it denies (mantahostels#1032)", () => {
	/** Rationale: the checker's "reprinted rules" section (mantahostels#886). */
	const reprintedSentence =
		"It commits every dirty tracked file, so it takes a parallel session's " +
		"uncommitted edits — they need not have staged anything, only have a file open.";

	const rule = `- **Never \`git commit -a\`.** ${reprintedSentence} **Enforced** (#1): \`scripts/guard-x.sh\`.`;

	/** A denying guard in the house shape. */
	function guard(body: string, header = ""): string {
		return [
			"#!/usr/bin/env bash",
			header,
			"deny_it() {",
			"  local reason",
			"  IFS= read -r -d '' reason <<'EOF' || :",
			body,
			"EOF",
			'  gp_deny "$reason" "$1"',
			"}",
			"deny_it x",
			"",
		].join("\n");
	}

	function reprints(root: string) {
		return run(root).json.warnings.filter((w) => w.kind === "REPRINTED");
	}

	it("warns, naming the guard and the span it reprints", () => {
		const root = build({
			claude: region(rule),
			files: {
				"scripts/guard-x.sh": guard(reprintedSentence),
				[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-x.sh"),
			},
		});
		const [warning, ...rest] = reprints(root);
		expect(rest).toEqual([]);
		expect(warning.guard).toBe("scripts/guard-x.sh");
		expect(warning.rules[0].file).toBe("CLAUDE.md");
		expect(warning.spans?.[0].span).toContain("every dirty");
		expect(warning.detail).toContain("first trigger");
	});

	it("reads a heredoc read into a second variable and appended to the denied one (#1865)", () => {
		const root = build({
			claude: region(rule),
			files: {
				// scripts/guard-agent-poll.sh's read and ListAgents branches.
				"scripts/guard-x.sh": [
					"#!/usr/bin/env bash",
					'reason="Instead: commit by pathspec."',
					"IFS= read -r -d '' rest <<'EOF' || :",
					reprintedSentence,
					"EOF",
					'reason+="$rest"',
					'gp_deny "$reason"',
					"",
				].join("\n"),
				[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-x.sh"),
			},
		});
		expect(reprints(root).map((w) => w.guard)).toEqual(["scripts/guard-x.sh"]);
	});

	it("moves an appended body rather than copying it, so a variable reused for a warning never reaches the deny (#1865)", () => {
		/* A copy would leave the warning's body in `rest`, to be appended into
		 * `reason` with the deny's. */
		const root = build({
			claude: region(rule),
			files: {
				"scripts/guard-x.sh": [
					"#!/usr/bin/env bash",
					'case "$1" in',
					"  a)",
					"    IFS= read -r -d '' rest <<'EOF' || :",
					reprintedSentence,
					"EOF",
					'    warning+="$rest"',
					'    gp_warn "$warning"',
					"    ;;",
					"  *)",
					"    IFS= read -r -d '' rest <<'EOF' || :",
					"Commit by pathspec instead, naming only the files you changed.",
					"EOF",
					'    reason+="$rest"',
					'    gp_deny "$reason"',
					"    ;;",
					"esac",
					"",
				].join("\n"),
				[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-x.sh"),
			},
		});
		expect(reprints(root)).toEqual([]);
	});

	it("never gates — the run still exits 0 with no FAIL", () => {
		const root = build({
			claude: region(rule),
			files: {
				"scripts/guard-x.sh": guard(reprintedSentence),
				[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-x.sh"),
			},
		});
		const result = run(root);
		expect(result.code).toBe(0);
		expect(result.kinds).toEqual([]);
	});

	it("is silent on a warn-only guard — the action completes, so the session had to know the rule first", () => {
		const root = build({
			claude: region(rule),
			files: {
				"scripts/guard-x.sh": [
					"#!/usr/bin/env bash",
					"warn_it() {",
					"  local reason",
					"  IFS= read -r -d '' reason <<'EOF' || :",
					reprintedSentence,
					"EOF",
					'  gp_warn "$reason"',
					"}",
					"warn_it",
					"",
				].join("\n"),
				[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-x.sh"),
			},
		});
		expect(reprints(root)).toEqual([]);
	});

	it("is silent on a guard declaring `deny-timing: delayed` — the deny arrives too late to pay", () => {
		const root = build({
			claude: region(rule),
			files: {
				"scripts/guard-x.sh": guard(
					reprintedSentence,
					"# deny-timing: delayed — the third call is denied, not the first",
				),
				[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-x.sh"),
			},
		});
		expect(reprints(root)).toEqual([]);
	});

	it("is silent where only a path is shared — the live pair mantahostels#964 ruled did not qualify", () => {
		/*
		 * mantahostels#964 ruled this pair did not qualify: "already a pointer line; nothing
		 * to gain". Both halves are verbatim from the tree, so rewording either is
		 * what should redden this.
		 */
		const root = build({
			claude: region(
				"- **Every issue-body edit goes through `node scripts/issue-body.js`** — a raw " +
					"body write erases whatever a parallel session wrote in the window (#128). " +
					"**Enforced** (#1): `scripts/guard-x.sh`. " +
					"Spellings, warn cases and recovery: `docs/agents/issue-tracker.md` §Editing an issue body.",
			),
			files: {
				"scripts/guard-x.sh": guard(
					"Prefer a comment where the content allows it — `gh issue comment` creates a new " +
						"resource and cannot be clobbered at all. Commands and recovery: " +
						"docs/agents/issue-tracker.md §Editing an issue body.",
				),
				[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-x.sh"),
			},
		});
		expect(reprints(root)).toEqual([]);
	});

	it("is silent where the deny text shares the rule's topic but not its words", () => {
		const root = build({
			claude: region(rule),
			files: {
				"scripts/guard-x.sh": guard(
					"Commit by pathspec instead, naming only the files you changed: git commit -m … -- <paths>.",
				),
				[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-x.sh"),
			},
		});
		expect(reprints(root)).toEqual([]);
	});
});

describe("the live delayed-deny guard, mantahostels#964's counter-example", () => {
	/*
	 * The REAL guard is copied in, so the declaration keeping it silent is under
	 * test rather than a fixture's imitation of it. The rule beside it quotes that
	 * guard's own deny text verbatim — CLAUDE.md's live wording of the same rule
	 * happens not to, so pairing the two as they stand would assert nothing: the
	 * warning would be silent whatever the declaration said.
	 */
	const poll = "scripts/guard-agent-poll.sh";
	const source = fs.readFileSync(
		path.join(__dirname, "guard-agent-poll.sh"),
		"utf8",
	);

	/** Verbatim from the guard's own `noop` deny heredoc. */
	const quoted =
		"A no-op command like `true` re-invokes this session — which is why " +
		"the loop it is meant to break keeps going.";
	const rule =
		"- **While something runs in the background, end the turn.** " +
		`${quoted} **Enforced** (#627): \`${poll}\`.`;

	function pollFixture(guardSource: string): string {
		return build({
			claude: region(rule),
			files: {
				[poll]: guardSource,
				[SELF_PLUGIN_HOOKS]: hooksWiring(poll),
			},
		});
	}

	it("declares its timing, and draws no REPRINTED warning even where the rule quotes its deny text", () => {
		// The pairing asserts nothing unless the quote is still the guard's own
		// wording, so drift in the heredoc fails here rather than going silent.
		expect(source).toContain(quoted);
		expect(source).toMatch(/^\s*#\s*deny-timing:\s*delayed\b/m);
		const root = pollFixture(source);
		expect(
			run(root).json.warnings.filter((w) => w.kind === "REPRINTED"),
		).toEqual([]);
	});

	it("would warn on that same pair as REPRINTED, naming the guard, without the declaration — so the silence above is the declaration's doing", () => {
		const undeclared = source.replace(/^#\s*deny-timing:.*$/m, "#");
		expect(undeclared).not.toMatch(/deny-timing:\s*delayed/);
		const root = pollFixture(undeclared);
		const [warning] = run(root).json.warnings.filter(
			(w) => w.kind === "REPRINTED",
		);
		expect(warning?.guard).toBe(poll);
	});
});

/*
 * The second assertion (mantahostels#1261): every script the ACTING wiring reaches says what
 * it does to a session that never asked for it.
 *
 * A guard is a refusal; an implicit behaviour is an action taken for you
 * (mantahostels#1180). The load-bearing property under test throughout is that
 * the set is DERIVED FROM THE WIRING rather than listed anywhere — so wiring a
 * new hook fails the build until its header says what it does.
 */
describe("implicit behaviours — the second assertion (mantahostels#1261)", () => {
	const annotated = [
		"#!/bin/sh",
		"# Does a thing.",
		"#",
		"# IMPLICIT:  rewrites the file the session just wrote.",
		"# JUSTIFIED: fail-safe — an unformatted file is read as a clobber later.",
		"# DEFEAT:    none — every failure path exits 0.",
		"exit 0",
		"",
	].join("\n");

	/* A hooks file wiring one script at one event, with the house command
	 * spelling — the `"$CLAUDE_PROJECT_DIR"/…` form the real file uses. */
	function wiredAt(event: string, ...scripts: string[]): string {
		return JSON.stringify({
			hooks: {
				[event]: [
					{
						matcher: "Bash",
						hooks: scripts.map((s) => ({
							type: "command",
							command: `"$CLAUDE_PROJECT_DIR"/${s}`,
						})),
					},
				],
			},
		});
	}

	const rules = region("- A rule. **Unenforceable**: nothing can check it.");

	function implicitOf(r: Result) {
		return (
			r.json as unknown as {
				implicit: {
					file: string;
					triggers: string[];
					annotation: Record<string, string> | null;
				}[];
			}
		).implicit;
	}

	it("fails a PostToolUse script whose header says nothing about what it does", () => {
		const root = build({
			claude: rules,
			files: {
				"scripts/post-write.sh": "#!/bin/sh\n# Formats things.\nexit 0\n",
				[SELF_PLUGIN_HOOKS]: wiredAt("PostToolUse", "scripts/post-write.sh"),
			},
		});
		const r = run(root);
		expect(r.code).toBe(1);
		expect(r.kinds).toEqual(["UNANNOTATED"]);
		expect(r.json.findings[0].detail).toContain("PostToolUse");
	});

	it("passes the same script once it carries all three lines", () => {
		const root = build({
			claude: rules,
			files: {
				"scripts/post-write.sh": annotated,
				[SELF_PLUGIN_HOOKS]: wiredAt("PostToolUse", "scripts/post-write.sh"),
			},
		});
		expect(run(root).code).toBe(0);
	});

	it("reaches all four acting events and no others", () => {
		// PreToolUse is the REFUSING event, and the first assertion's business:
		// a guard that only refuses owes no implicit annotation.
		const events = [
			"PostToolUse",
			"UserPromptSubmit",
			"SessionStart",
			"Stop",
			"PreToolUse",
		];
		const files: Record<string, string> = {
			[SELF_PLUGIN_HOOKS]: JSON.stringify({
				hooks: Object.fromEntries(
					events.map((e) => [
						e,
						[
							{
								hooks: [
									{
										type: "command",
										command: `"$CLAUDE_PROJECT_DIR"/scripts/act-${e}.sh`,
									},
								],
							},
						],
					]),
				),
			}),
		};
		for (const e of events)
			files[`scripts/act-${e}.sh`] = "#!/bin/sh\n# Silent.\nexit 0\n";
		const r = run(build({ claude: rules, files }));
		const named = (
			r.json.findings as unknown as { severity: string; file?: string }[]
		)
			.filter((f) => f.severity === "FAIL")
			.map((f) => f.file);
		expect(named.sort()).toEqual([
			"scripts/act-PostToolUse.sh",
			"scripts/act-SessionStart.sh",
			"scripts/act-Stop.sh",
			"scripts/act-UserPromptSubmit.sh",
		]);
	});

	it("takes a PreToolUse guard that ALSO acts, on its own declaration", () => {
		// scripts/guard-file-claim.sh is the live instance: it refuses a write to a
		// held file AND takes a claim the session never asked for. Declared, not
		// inferred — reading "also acts" out of a guard's body is reading intent.
		const root = build({
			claude: rules,
			files: {
				"scripts/guard-file-claim.sh": annotated.replace(
					"# DEFEAT:    none — every failure path exits 0.",
					"# DEFEAT:    none",
				),
				[SELF_PLUGIN_HOOKS]: wiredAt(
					"PreToolUse",
					"scripts/guard-file-claim.sh",
				),
			},
		});
		const r = run(root);
		expect(r.code).toBe(0);
		expect(implicitOf(r).map((i) => i.file)).toEqual([
			"scripts/guard-file-claim.sh",
		]);
		expect(implicitOf(r)[0].triggers).toEqual(["PreToolUse (declared)"]);
	});

	it("walks the canary the core's settings keep beside the self-plugin's file (#2473)", () => {
		const root = build({
			claude: rules,
			files: {
				"scripts/self-plugin-canary.sh": annotated,
				".claude/settings.json": wiredAt(
					"PreToolUse",
					"scripts/self-plugin-canary.sh",
				),
			},
		});
		const r = run(root);
		expect(r.code).toBe(0);
		expect(implicitOf(r).map((i) => i.file)).toEqual([
			"scripts/self-plugin-canary.sh",
		]);
	});

	it("names each missing line rather than the annotation as a whole", () => {
		const root = build({
			claude: rules,
			files: {
				"scripts/x.sh": "#!/bin/sh\n# IMPLICIT:  does a thing.\nexit 0\n",
				[SELF_PLUGIN_HOOKS]: wiredAt("Stop", "scripts/x.sh"),
			},
		});
		const r = run(root);
		expect(r.code).toBe(1);
		expect(r.kinds).toEqual(["INCOMPLETE-ANNOTATION", "INCOMPLETE-ANNOTATION"]);
		const details = r.json.findings.map((f) => f.detail).join("\n");
		expect(details).toContain("`JUSTIFIED:`");
		expect(details).toContain("`DEFEAT:`");
	});

	it("fails a line that is present and empty", () => {
		const root = build({
			claude: rules,
			files: {
				"scripts/x.sh": [
					"#!/bin/sh",
					"# IMPLICIT:  does a thing.",
					"# JUSTIFIED: convenience — nothing degrades.",
					"# DEFEAT:",
					"exit 0",
					"",
				].join("\n"),
				[SELF_PLUGIN_HOOKS]: wiredAt("Stop", "scripts/x.sh"),
			},
		});
		const r = run(root);
		expect(r.code).toBe(1);
		expect(r.kinds).toEqual(["EMPTY-ANNOTATION"]);
	});

	it("accepts convenience as a verdict, and `none` as a defeat", () => {
		// mantahostels#1181 ruled Archon's "individually defeatable" clause does not transfer:
		// in a shared tree almost every implicit behaviour protects NEIGHBOURS, so
		// a per-session off switch is a hole by construction. DEFEAT records what
		// escape exists; it never demands one. Convenience is likewise legal;
		// whether it is good enough is a reader's call (mantahostels#1180).
		const root = build({
			claude: rules,
			files: {
				"scripts/name-session.sh": [
					"#!/bin/sh",
					"# IMPLICIT:  renames the session after its issue.",
					"# JUSTIFIED: convenience — nothing degrades but legibility.",
					"# DEFEAT:    none",
					"exit 0",
					"",
				].join("\n"),
				[SELF_PLUGIN_HOOKS]: wiredAt(
					"UserPromptSubmit",
					"scripts/name-session.sh",
				),
			},
		});
		expect(run(root).code).toBe(0);
	});

	it("fails a verdict that is neither fail-safe nor convenience, as BAD-JUSTIFICATION", () => {
		const root = build({
			claude: rules,
			files: {
				"scripts/x.sh": annotated.replace(
					"# JUSTIFIED: fail-safe — an unformatted file is read as a clobber later.",
					"# JUSTIFIED: necessary — obviously.",
				),
				[SELF_PLUGIN_HOOKS]: wiredAt("Stop", "scripts/x.sh"),
			},
		});
		const r = run(root);
		expect(r.code).toBe(1);
		expect(r.kinds).toEqual(["BAD-JUSTIFICATION"]);
	});

	it("fails a verdict asserted with no reason behind it, as BAD-JUSTIFICATION", () => {
		// "fail-safe" alone is the stale label mantahostels#102 ruled out: a verdict showing no
		// working, which nothing can ever check.
		const root = build({
			claude: rules,
			files: {
				"scripts/x.sh": annotated.replace(
					"# JUSTIFIED: fail-safe — an unformatted file is read as a clobber later.",
					"# JUSTIFIED: fail-safe",
				),
				[SELF_PLUGIN_HOOKS]: wiredAt("Stop", "scripts/x.sh"),
			},
		});
		expect(run(root).kinds).toEqual(["BAD-JUSTIFICATION"]);
	});

	it("reads only the header, not an annotation buried in the body", () => {
		// A reader arriving at the file must meet the annotation without
		// scrolling (mantahostels#102).
		const root = build({
			claude: rules,
			files: {
				"scripts/x.sh": [
					"#!/bin/sh",
					"# Does a thing.",
					"exit 0",
					"",
					"# IMPLICIT:  does a thing.",
					"# JUSTIFIED: fail-safe — because.",
					"# DEFEAT:    none",
					"",
				].join("\n"),
				[SELF_PLUGIN_HOOKS]: wiredAt("Stop", "scripts/x.sh"),
			},
		});
		expect(run(root).kinds).toEqual(["UNANNOTATED"]);
	});

	it("reads a block comment and a // header as well as a # one", () => {
		const root = build({
			claude: rules,
			files: {
				"scripts/a.js": [
					"#!/usr/bin/env node",
					"/*",
					" * a.js — does a thing.",
					" *",
					" * IMPLICIT:  injects a report into the session's context.",
					" * JUSTIFIED: fail-safe — nothing else reports it.",
					" * DEFEAT:    none",
					" */",
					"process.exit(0);",
					"",
				].join("\n"),
				"scripts/b.ts": [
					"// IMPLICIT:  records the run's verdict.",
					"// JUSTIFIED: fail-safe — any doubt reads as not-green.",
					"// DEFEAT:    none",
					"export default {};",
					"",
				].join("\n"),
				[SELF_PLUGIN_HOOKS]: wiredAt(
					"SessionStart",
					"scripts/a.js",
					"scripts/b.ts",
				),
			},
		});
		expect(run(root).code).toBe(0);
	});

	it("reaches every husky hook by existence, including one added later", () => {
		// git runs every file in core.hooksPath by name, so nothing references them.
		const root = build({
			claude: rules,
			files: {
				".husky/pre-commit": "# Gates.\nexit 0\n",
				".husky/post-commit": annotated,
				".husky/pre-push": annotated,
				/* Read from the directory, not a list — a hook added later is wired
				 * by its own existence and named by nothing, so a list here would be
				 * the one place it escapes the assertion silently. */
				".husky/post-merge": annotated,
				".husky/_/husky.sh": "# husky's own runner, in a subdirectory.\n",
			},
		});
		const r = run(root);
		expect(r.code).toBe(1);
		expect(r.kinds).toEqual(["UNANNOTATED"]);
		expect(r.json.findings[0]).toMatchObject({ file: ".husky/pre-commit" });
		expect(implicitOf(r).map((i) => i.file)).toEqual(
			[
				".husky/post-commit",
				".husky/pre-commit",
				".husky/pre-push",
				".husky/post-merge",
			].sort(),
		);
	});

	it("reaches vitest's globalSetup and custom reporters, and nothing else in the config", () => {
		const root = build({
			claude: rules,
			files: {
				"scripts/vitest-tree-watch.ts": annotated,
				"scripts/vitest-pass-reporter.ts": annotated,
				"scripts/vitest-retired.ts": annotated,
				"scripts/vitest-setup.ts": "#!/bin/sh\nexit 0\n",
				"vitest.config.ts": [
					"export default {",
					"  test: {",
					'    setupFiles: ["./scripts/vitest-setup.ts"],',
					'    globalSetup: ["./scripts/vitest-tree-watch.ts"],',
					'    // reporters: ["./scripts/vitest-retired.ts"],',
					'    reporters: ["default", "./scripts/vitest-pass-reporter.ts"],',
					"  },",
					"};",
					"",
				].join("\n"),
			},
		});
		const r = run(root);
		expect(r.code).toBe(0);
		// setupFiles is not wiring this assertion covers, "default" is no file of
		// ours, and a commented-out reporter runs nothing.
		expect(implicitOf(r).map((i) => i.file)).toEqual([
			"scripts/vitest-pass-reporter.ts",
			"scripts/vitest-tree-watch.ts",
		]);
	});

	it("is BROKEN, not OK, at a core with no self-plugin file (#2442)", () => {
		// The core registers only there, so its absence is a missing input, not
		// a repo wiring nothing.
		const root = build({ claude: rules });
		fs.rmSync(path.join(root, SELF_PLUGIN_HOOKS));
		const { status } = runInProcess(
			path.join(root, "scripts", "check-guard-registry.js"),
			[],
			{ env: { ...process.env, CLAUDE_PROJECT_DIR: root } },
		);
		expect(status).toBe(2);
	});

	it("is BROKEN, not OK, when the self-plugin file is there and unparseable", () => {
		// scripts/lib/check.js's SUBJECT/APPARATUS split: swallowing a tracked file
		// this checker READS THE REPO WITH empties the acting set, and the new FAIL
		// gate then reports OK over scope it never looked at.
		const root = build({
			claude: rules,
			files: { [SELF_PLUGIN_HOOKS]: "{ not json" },
		});
		const { status } = runInProcess(
			path.join(root, "scripts", "check-guard-registry.js"),
			[],
			{ env: { ...process.env, CLAUDE_PROJECT_DIR: root } },
		);
		expect(status).toBe(2);
	});

	it("treats a registration carrying no hooks as an answer, not a failure", () => {
		// A repo with no hooks genuinely wires nothing; that is true, not broken.
		const root = build({ claude: rules });
		const r = run(root);
		expect(r.code).toBe(0);
		expect(implicitOf(r)).toEqual([]);
	});

	it("skips a wired path that does not exist rather than reporting it", () => {
		// There is no header to annotate, and a hook command pointing at a missing
		// file is the registration's problem, not this assertion's.
		const root = build({
			claude: rules,
			files: {
				[SELF_PLUGIN_HOOKS]: wiredAt("Stop", "scripts/gone.sh"),
			},
		});
		const r = run(root);
		expect(r.code).toBe(0);
		expect(implicitOf(r)).toEqual([]);
	});

	it("collects every event a script is wired at", () => {
		const root = build({
			claude: rules,
			files: {
				"scripts/both.sh": annotated,
				[SELF_PLUGIN_HOOKS]: JSON.stringify({
					hooks: {
						SessionStart: [
							{
								hooks: [
									{
										type: "command",
										command: `"$CLAUDE_PROJECT_DIR"/scripts/both.sh start`,
									},
								],
							},
						],
						Stop: [
							{
								hooks: [
									{
										type: "command",
										command: `"$CLAUDE_PROJECT_DIR"/scripts/both.sh stop`,
									},
								],
							},
						],
					},
				}),
			},
		});
		expect(implicitOf(run(root))[0].triggers).toEqual(["SessionStart", "Stop"]);
	});

	it("reads the `cd && node scripts/x.js` command spelling too", () => {
		const root = build({
			claude: rules,
			files: {
				"scripts/x.js": "#!/usr/bin/env node\n// Nothing.\n",
				[SELF_PLUGIN_HOOKS]: JSON.stringify({
					hooks: {
						SessionStart: [
							{
								hooks: [
									{
										type: "command",
										command:
											'command -v node >/dev/null 2>&1 && cd "$CLAUDE_PROJECT_DIR" && node scripts/x.js --notify || true',
									},
								],
							},
						],
					},
				}),
			},
		});
		expect(run(root).kinds).toEqual(["UNANNOTATED"]);
	});
});

describe("implicit behaviours share the guards' anchor sidecar (mantahostels#1261)", () => {
	const rules = region("- A rule. **Unenforceable**: nothing can check it.");
	const annotated = [
		"#!/bin/sh",
		"# IMPLICIT:  does a thing to a session that never asked.",
		"# JUSTIFIED: fail-safe — nothing else covers it.",
		"# DEFEAT:    none",
		"exit 0",
		"",
	].join("\n");

	function repo(): string {
		return build({
			claude: rules,
			files: {
				"scripts/act.sh": annotated,
				[SELF_PLUGIN_HOOKS]: JSON.stringify({
					hooks: {
						PostToolUse: [
							{
								matcher: "Bash",
								hooks: [
									{
										type: "command",
										command: '"$CLAUDE_PROJECT_DIR"/scripts/act.sh',
									},
								],
							},
						],
					},
				}),
			},
		});
	}

	it("warns that nobody has read a wired script's annotation against it, as UNANCHORED, naming the IMPLICIT / JUSTIFIED / DEFEAT annotation", () => {
		const r = run(repo());
		expect(r.code).toBe(0);
		expect(r.json.warnings.map((w) => w.kind)).toEqual(["UNANCHORED"]);
		expect(r.json.warnings[0].detail).toContain(
			"IMPLICIT / JUSTIFIED / DEFEAT",
		);
	});

	it("--review clears it, and prints what the re-anchor is asserting", () => {
		const root = repo();
		const out = reviewIn(root);
		expect(out).toContain("anchored scripts/act.sh");
		expect(out).toContain("[PostToolUse]");
		expect(out).toContain("does a thing to a session that never asked");
		expect(run(root).json.warnings).toEqual([]);
	});

	it("warns again once the script moves under its annotation, as STALE-PROSE, naming the IMPLICIT / JUSTIFIED / DEFEAT annotation", () => {
		const root = repo();
		reviewIn(root);
		fs.appendFileSync(path.join(root, "scripts", "act.sh"), "echo drift\n");
		const w = run(root).json.warnings;
		expect(w.map((x) => x.kind)).toEqual(["STALE-PROSE"]);
		expect(w[0].detail).toContain("IMPLICIT / JUSTIFIED / DEFEAT");
	});

	it("is not an orphan anchor — the wiring reaching it is what keeps it", () => {
		const root = repo();
		reviewIn(root);
		expect(run(root).json.warnings.map((w) => w.kind)).not.toContain(
			"ORPHAN-ANCHOR",
		);
	});

	it("still orphans an anchor nothing reaches at all", () => {
		const root = repo();
		fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
		fs.writeFileSync(
			path.join(root, ANCHORS),
			JSON.stringify({ "scripts/retired.sh": "deadbeefdeadbeef" }),
		);
		const w = run(root).json.warnings;
		expect(w.map((x) => x.kind)).toContain("ORPHAN-ANCHOR");
		expect(w.find((x) => x.kind === "ORPHAN-ANCHOR")?.guard).toBe(
			"scripts/retired.sh",
		);
	});

	it("says both things where a rule names a script the wiring also reaches", () => {
		const root = build({
			claude: region(
				"- Claims are taken for you. **Enforced** (#113): `scripts/act.sh` records the write.",
			),
			files: {
				"scripts/act.sh": annotated,
				[SELF_PLUGIN_HOOKS]: JSON.stringify({
					hooks: {
						PostToolUse: [
							{
								matcher: "Bash",
								hooks: [
									{
										type: "command",
										command: '"$CLAUDE_PROJECT_DIR"/scripts/act.sh',
									},
								],
							},
						],
					},
				}),
			},
		});
		const w = run(root).json.warnings;
		expect(w[0].kind).toBe("UNANCHORED");
		expect(w[0].detail).toContain("the rule(s) at CLAUDE.md:");
		expect(w[0].detail).toContain("IMPLICIT / JUSTIFIED / DEFEAT");
	});
});

describe("the roster names what the wiring reached (mantahostels#1261)", () => {
	const rules = region("- A rule. **Unenforceable**: nothing can check it.");

	/* The human report goes to stderr — stdout is reserved for machine readers
	 * (scripts/lib/check.js) — so this reads both streams. */
	function prose(root: string, extra: string[] = []): string {
		const r = runInProcess(
			path.join(root, "scripts", "check-guard-registry.js"),
			extra,
			{ env: { ...process.env, CLAUDE_PROJECT_DIR: root } },
		);
		return `${r.stdout}${r.stderr}`;
	}

	function repo(annotated: boolean): string {
		return build({
			claude: rules,
			files: {
				"scripts/act.sh": annotated
					? [
							"#!/bin/sh",
							"# IMPLICIT:  sweeps every session's expired markers.",
							"# JUSTIFIED: fail-safe — an unswept store grows without bound.",
							"# DEFEAT:    none",
							"exit 0",
							"",
						].join("\n")
					: "#!/bin/sh\nexit 0\n",
				[SELF_PLUGIN_HOOKS]: JSON.stringify({
					hooks: {
						SessionStart: [
							{
								hooks: [
									{
										type: "command",
										command: '"$CLAUDE_PROJECT_DIR"/scripts/act.sh',
									},
								],
							},
						],
					},
				}),
			},
		});
	}

	it("names every wired script on every run, with no flag to find first", () => {
		// mantahostels#1261's Done-when: the run names every wired script it
		// reached. Behind a flag they are visible only to someone who already
		// knew to ask.
		const out = prose(repo(true));
		expect(out).toContain("1 implicit behaviour(s) — 1 fail-safe");
		expect(out).toContain("scripts/act.sh  [SessionStart]  fail-safe");
	});

	it("holds the DETAIL back until asked, so a clean run stays short", () => {
		// This check runs in .husky/pre-commit on every commit touching docs/,
		// .claude/, scripts/ or .husky/, so the roster's unchanging prose on each
		// is the unclearable wallpaper mantahostels#109 ruled against.
		expect(prose(repo(true))).not.toContain(
			"sweeps every session's expired markers",
		);
		expect(prose(repo(true), ["--roster"])).toContain(
			"sweeps every session's expired markers",
		);
	});

	it("prints the detail unasked when something in the set is unannotated", () => {
		const out = prose(repo(false));
		expect(out).toContain("scripts/act.sh  [SessionStart]  unannotated");
		expect(out).toContain("(no IMPLICIT / JUSTIFIED / DEFEAT annotation)");
	});
});

/*
 * The rule-text store (mantahostels#1644, spec mantahostels#1641).
 *
 * A rule relocated out of CLAUDE.md into the guard that refuses the mistake has
 * two parts that must agree — the fragment and the wired guard printing it —
 * and any `rule:<id>` trigger left behind must resolve to one.
 */
describe("the rule-text store", () => {
	/** A region rule carrying a trigger for `id`, enforced by `guard`. */
	function triggerRule(id: string, guard: string): string {
		return `- **Commit by pathspec.** The rule itself is in \`rule:${id}\`. **Enforced** (#117): \`${guard}\` prints it.`;
	}

	/** A bash script whose only interesting property is the call it makes; the case's hooksWiring decides whether it is wired. */
	function bashEmitter(id: string): string {
		return `#!/usr/bin/env bash\n# shellcheck source=scripts/lib/rule-text.sh\nsource "$here/lib/rule-text.sh"\ngp_deny "$(rule_text ${id})"\n`;
	}

	it("passes on an empty store with no triggers — the state this ticket lands in", () => {
		const r = run(
			build({
				claude: region(
					"- Stay on `main`. **Enforced** (#110): `scripts/guard-branch.sh` denies it.",
				),
				files: {
					"scripts/guard-branch.sh": "#!/usr/bin/env bash\n",
					[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-branch.sh"),
				},
			}),
		);
		expect(r.kinds).toEqual([]);
		expect(r.code).toBe(0);
	});

	/**
	 * A wired bash guard that prints its rule PRE-EMPTIVELY (mantahostels#1804) rather than
	 * in a refusal. gp_rule resolves the id through rule_text at run time, so
	 * nothing in this file carries a literal accessor call.
	 */
	function preemptiveEmitter(...ids: string[]): string {
		return `#!/usr/bin/env bash\n# shellcheck source=scripts/lib/guard-parse.sh\nsource "$here/lib/guard-parse.sh"\ngp_rule ${ids.join(" ")}\n`;
	}

	it("counts a fragment printed only pre-emptively as printed by a wired emitter", () => {
		const r = run(
			build({
				claude: region(
					triggerRule("commit-pathspec", "scripts/guard-commit.sh"),
				),
				files: {
					"docs/agents/rules/commit-pathspec.txt": "Commit by pathspec.\n",
					"scripts/guard-commit.sh": preemptiveEmitter("commit-pathspec"),
					[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-commit.sh"),
				},
			}),
		);
		expect(r.kinds).toEqual([]);
	});

	it("reads every id in one pre-emptive call, not just the first", () => {
		const r = run(
			build({
				claude: region(
					[
						triggerRule("commit-pathspec", "scripts/guard-commit.sh"),
						triggerRule("branch-shared-tree", "scripts/guard-commit.sh"),
					].join("\n"),
				),
				files: {
					"docs/agents/rules/commit-pathspec.txt": "Commit by pathspec.\n",
					"docs/agents/rules/branch-shared-tree.txt": "Stay on main.\n",
					"scripts/guard-commit.sh": preemptiveEmitter(
						"commit-pathspec",
						"branch-shared-tree",
					),
					[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-commit.sh"),
				},
			}),
		);
		expect(r.kinds).toEqual([]);
	});

	it("fails a pre-emptive call naming an id no fragment answers to", () => {
		// The accessor throws on an unknown id, so this is a guard that will die
		// mid-hook — caught here rather than on the session that trips it.
		const r = run(
			build({
				claude: region(
					triggerRule("commit-pathspec", "scripts/guard-commit.sh"),
				),
				files: {
					"docs/agents/rules/commit-pathspec.txt": "Commit by pathspec.\n",
					"scripts/guard-commit.sh": preemptiveEmitter(
						"commit-pathspec",
						"no-such-rule",
					),
					[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-commit.sh"),
				},
			}),
		);
		expect(r.kinds).toContain("EMITTED-MISSING");
	});

	it("counts a fragment printed only pre-emptively by a script nothing wires as unprinted", () => {
		const r = run(
			build({
				claude: region(triggerRule("file-claim", "scripts/guard-claim.sh")),
				files: {
					"docs/agents/rules/file-claim.txt":
						"A live session's file is taken.\n",
					"scripts/guard-claim.sh": "#!/usr/bin/env bash\n",
					"scripts/unwired.sh": preemptiveEmitter("file-claim"),
					[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-claim.sh"),
				},
			}),
		);
		expect(r.kinds).toContain("UNPRINTED-RULE");
	});

	it("passes when the fragment, the wired emitter and the trigger all agree", () => {
		const r = run(
			build({
				claude: region(
					triggerRule("commit-pathspec", "scripts/guard-commit.sh"),
				),
				files: {
					"docs/agents/rules/commit-pathspec.txt": "Commit by pathspec.\n",
					"scripts/guard-commit.sh": bashEmitter("commit-pathspec"),
					[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-commit.sh"),
				},
			}),
		);
		expect(r.kinds).toEqual([]);
	});

	it("fails a trigger naming an id no fragment answers to", () => {
		const r = run(
			build({
				claude: region(triggerRule("no-such-rule", "scripts/guard-commit.sh")),
				files: {
					"scripts/guard-commit.sh": "#!/usr/bin/env bash\n",
					[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-commit.sh"),
				},
			}),
		);
		expect(r.kinds).toContain("ORPHAN-TRIGGER");
		expect(r.code).toBe(1);
		expect(
			r.json.findings.find((f) => f.kind === "ORPHAN-TRIGGER")?.detail,
		).toMatch(/no fragment/);
	});

	it("fails a fragment no emitter prints at all", () => {
		const r = run(
			build({
				claude: region(triggerRule("file-claim", "scripts/guard-claim.sh")),
				files: {
					"docs/agents/rules/file-claim.txt":
						"A file a live session wrote is taken.\n",
					"scripts/guard-claim.sh": "#!/usr/bin/env bash\n",
					[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-claim.sh"),
				},
			}),
		);
		expect(r.kinds).toContain("UNPRINTED-RULE");
	});

	it("names two parts in the help text, the trigger no longer among them", () => {
		/* The JSON envelope is not what reaches a session at a pre-commit gate —
		 * the prose is (mantahostels#1962). Captured off fd 2, see run()'s Result.report. */
		const r = run(
			build({
				claude: region(triggerRule("file-claim", "scripts/guard-claim.sh")),
				files: {
					"docs/agents/rules/file-claim.txt":
						"A file a live session wrote is taken.\n",
					"scripts/guard-claim.sh": "#!/usr/bin/env bash\n",
					[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-claim.sh"),
				},
			}),
		);
		expect(r.report).toContain("has two parts that must agree");
		expect(r.report).not.toContain("trigger left in the region");
	});

	it("fails a fragment printed only by a script nothing wires, as UNPRINTED-RULE, offering a call from the refusing guard as the way out", () => {
		const r = run(
			build({
				claude: region(triggerRule("file-claim", "scripts/guard-claim.sh")),
				files: {
					"docs/agents/rules/file-claim.txt":
						"A file a live session wrote is taken.\n",
					"scripts/guard-claim.sh": "#!/usr/bin/env bash\n",
					"scripts/orphan-emitter.sh": bashEmitter("file-claim"),
					[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-claim.sh"),
				},
			}),
		);
		expect(r.kinds).toContain("UNPRINTED-RULE");
		const detail = r.json.findings.find(
			(f) => f.kind === "UNPRINTED-RULE",
		)?.detail;
		expect(detail).toMatch(/no wired emitter/);
		/* #925: the adopter wording, which names its own wiring, stays out of
		 * the core's. */
		expect(detail).toContain("Call it from the guard that refuses the mistake");
		expect(detail).not.toContain("this repo's .claude/settings.json");
	});

	it("counts a lib the wired guard sources as a live emitter", () => {
		const r = run(
			build({
				claude: region(triggerRule("file-claim", "scripts/guard-claim.sh")),
				files: {
					"docs/agents/rules/file-claim.txt":
						"A file a live session wrote is taken.\n",
					"scripts/guard-claim.sh":
						'#!/usr/bin/env bash\nsource "$here/lib/claim-msg.sh"\n',
					"scripts/lib/claim-msg.sh": bashEmitter("file-claim"),
					[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-claim.sh"),
				},
			}),
		);
		expect(r.kinds).toEqual([]);
	});

	it("reads the Node call shape as well as the bash one", () => {
		const r = run(
			build({
				claude: region(triggerRule("dirty-turn", "scripts/guard-dirty.js")),
				files: {
					"docs/agents/rules/dirty-turn.txt": "Never end a turn dirty.\n",
					"scripts/guard-dirty.js":
						'const { ruleText } = require("./lib/rule-text");\nconsole.log(ruleText("dirty-turn"));\n',
					[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-dirty.js"),
				},
			}),
		);
		expect(r.kinds).toEqual([]);
	});

	it.each([
		[
			"single-line",
			'console.log(ruleTextOr("dirty-turn", "Never end a turn dirty.", "guard-dirty"));\n',
		],
		[
			"multi-line",
			'console.log(\n\truleTextOr(\n\t\t"dirty-turn",\n\t\t"Never end a turn dirty.",\n\t\t"guard-dirty",\n\t),\n);\n',
		],
	])("reads a %s ruleTextOr call as the guard's emitter", (_, call) => {
		const r = run(
			build({
				claude: region(triggerRule("dirty-turn", "scripts/guard-dirty.js")),
				files: {
					"docs/agents/rules/dirty-turn.txt": "Never end a turn dirty.\n",
					"scripts/guard-dirty.js": `const { ruleTextOr } = require("./lib/rule-text");\n${call}`,
					[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-dirty.js"),
				},
			}),
		);
		expect(r.kinds).toEqual([]);
	});

	it("fails an emitter naming a fragment that does not exist", () => {
		const r = run(
			build({
				claude: region(
					"- Stay on `main`. **Enforced** (#110): `scripts/guard-claim.sh` denies it.",
				),
				files: {
					"scripts/guard-claim.sh": bashEmitter("typo-in-the-id"),
					[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-claim.sh"),
				},
			}),
		);
		expect(r.kinds).toContain("EMITTED-MISSING");
		expect(
			r.json.findings.find((f) => f.kind === "EMITTED-MISSING")?.detail,
		).toMatch(/fails at hook time/);
	});

	it("fails an empty fragment as UNREADABLE-FRAGMENT, which a guard would print as nothing at all", () => {
		const r = run(
			build({
				claude: region(triggerRule("file-claim", "scripts/guard-claim.sh")),
				files: {
					"docs/agents/rules/file-claim.txt": "\n   \n",
					"scripts/guard-claim.sh": bashEmitter("file-claim"),
					[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-claim.sh"),
				},
			}),
		);
		expect(r.kinds).toContain("UNREADABLE-FRAGMENT");
	});

	it("reads a trigger sitting outside any guard-registry region", () => {
		/* A file can carry guard-backed material outside any region
		 * (mantahostels#1641), so a trigger left there must still be checked. */
		const root = build({
			claude: `${region(
				"- Stay on `main`. **Enforced** (#110): `scripts/guard-branch.sh` denies it.",
			)}\n## Gotchas\n\n- The claim protocol is in \`rule:no-such-rule\`.\n`,
			files: {
				"scripts/guard-branch.sh": "#!/usr/bin/env bash\n",
				[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-branch.sh"),
			},
		});
		expect(run(root).kinds).toContain("ORPHAN-TRIGGER");
	});

	it("collects a trigger under any marker, not just **Enforced**", () => {
		const r = run(
			build({
				claude: region(
					"- **Release a guarded file when done.** The rule is in `rule:release-discipline`. **Unenforced** (#121): nothing makes a session call it.",
				),
				files: {
					"scripts/guard-branch.sh": "#!/usr/bin/env bash\n",
					[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-branch.sh"),
				},
			}),
		);
		expect(r.kinds).toContain("ORPHAN-TRIGGER");
	});

	/*
	 * THE SECOND FRAGMENT CLASS (mantahostels#2496). A rule with no observable Bash trigger
	 * is delivered by a command's injected index and fetched by the session, not
	 * printed by a guard — so the manifest, not the emitter scan, is what says
	 * the fragment is alive.
	 */
	function manifest(rules: Record<string, unknown>): string {
		return `${JSON.stringify({ comment: "fixture", rules }, null, "\t")}\n`;
	}

	/** An injector carrying a per-command index that names `ids`. */
	function injectorIndex(...ids: string[]): string {
		return `#!/usr/bin/env bash\n${ids
			.map((id) => `index='- \`rule:${id}\` — before the act it binds on.'`)
			.join("\n")}\n`;
	}

	it("exempts a manifest fragment no emitter prints, when an index names it", () => {
		const r = run(
			build({
				claude: region(
					"- Pick the right label. **Enforced** (#453): `scripts/guard-label.sh` denies it.",
				),
				files: {
					"docs/agents/rules/takes-value-vocabulary.txt":
						"Use this repo's labels.\n",
					"docs/agents/rules/manifest.json": manifest({
						"takes-value-vocabulary": {
							source: "docs/agents/triage-labels.md",
							trigger: "a `gh issue create` on the Bash tool",
						},
					}),
					"scripts/inject-tracker-docs.sh": injectorIndex(
						"takes-value-vocabulary",
					),
					"scripts/guard-label.sh": "#!/usr/bin/env bash\n",
					[SELF_PLUGIN_HOOKS]: hooksWiring(
						"scripts/guard-label.sh",
						"scripts/inject-tracker-docs.sh",
					),
				},
			}),
		);
		expect(r.kinds).toEqual([]);
		expect(r.code).toBe(0);
	});

	it("still fails a fragment in neither the manifest nor any emitter, as UNPRINTED-RULE naming that fragment alone", () => {
		const r = run(
			build({
				claude: region(
					"- Pick the right label. **Enforced** (#453): `scripts/guard-label.sh` denies it.",
				),
				files: {
					"docs/agents/rules/takes-value-vocabulary.txt":
						"Use this repo's labels.\n",
					"docs/agents/rules/dead-rule.txt": "Nobody prints this.\n",
					"docs/agents/rules/manifest.json": manifest({
						"takes-value-vocabulary": {
							source: "docs/agents/triage-labels.md",
							trigger: "a `gh issue create` on the Bash tool",
						},
					}),
					"scripts/inject-tracker-docs.sh": injectorIndex(
						"takes-value-vocabulary",
					),
					"scripts/guard-label.sh": "#!/usr/bin/env bash\n",
					[SELF_PLUGIN_HOOKS]: hooksWiring(
						"scripts/guard-label.sh",
						"scripts/inject-tracker-docs.sh",
					),
				},
			}),
		);
		expect(r.kinds).toEqual(["UNPRINTED-RULE"]);
		expect(
			r.json.findings.find((f: { kind: string }) => f.kind === "UNPRINTED-RULE")
				?.file,
		).toContain("dead-rule");
	});

	it("fails a manifest id that no fragment answers to, as MANIFEST-ORPHAN, naming generate-rule-fragments as the way out", () => {
		const r = run(
			build({
				claude: region(
					"- Pick the right label. **Enforced** (#453): `scripts/guard-label.sh` denies it.",
				),
				files: {
					"docs/agents/rules/manifest.json": manifest({
						"no-such-rule": {
							source: "docs/agents/triage-labels.md",
							trigger: "a `gh issue create` on the Bash tool",
						},
					}),
					"scripts/inject-tracker-docs.sh": injectorIndex("no-such-rule"),
					"scripts/guard-label.sh": "#!/usr/bin/env bash\n",
					[SELF_PLUGIN_HOOKS]: hooksWiring(
						"scripts/guard-label.sh",
						"scripts/inject-tracker-docs.sh",
					),
				},
			}),
		);
		expect(r.kinds).toContain("MANIFEST-ORPHAN");
		expect(r.code).toBe(1);
		expect(
			r.json.findings.find(
				(f: { kind: string }) => f.kind === "MANIFEST-ORPHAN",
			)?.detail,
		).toMatch(/no fragment/);
		expect(
			r.json.findings.find(
				(f: { kind: string }) => f.kind === "MANIFEST-ORPHAN",
			)?.detail,
		).toMatch(/generate-rule-fragments/);
	});

	it("fails a manifest entry that names no trigger", () => {
		const r = run(
			build({
				claude: region(
					"- Pick the right label. **Enforced** (#453): `scripts/guard-label.sh` denies it.",
				),
				files: {
					"docs/agents/rules/takes-value-vocabulary.txt":
						"Use this repo's labels.\n",
					"docs/agents/rules/manifest.json": manifest({
						"takes-value-vocabulary": {
							source: "docs/agents/triage-labels.md",
							trigger: "   ",
						},
					}),
					"scripts/inject-tracker-docs.sh": injectorIndex(
						"takes-value-vocabulary",
					),
					"scripts/guard-label.sh": "#!/usr/bin/env bash\n",
					[SELF_PLUGIN_HOOKS]: hooksWiring(
						"scripts/guard-label.sh",
						"scripts/inject-tracker-docs.sh",
					),
				},
			}),
		);
		expect(r.kinds).toEqual(["MANIFEST-NO-TRIGGER"]);
		expect(r.code).toBe(1);
		expect(
			r.json.findings.find(
				(f: { kind: string }) => f.kind === "MANIFEST-NO-TRIGGER",
			)?.detail,
		).toMatch(/takes-value-vocabulary.+names no trigger/);
	});

	it("fails a manifest id no emitter prints and no index names", () => {
		const r = run(
			build({
				claude: region(
					"- Pick the right label. **Enforced** (#453): `scripts/guard-label.sh` denies it.",
				),
				files: {
					"docs/agents/rules/takes-value-vocabulary.txt":
						"Use this repo's labels.\n",
					"docs/agents/rules/manifest.json": manifest({
						"takes-value-vocabulary": {
							source: "docs/agents/triage-labels.md",
							trigger: "a `gh issue create` on the Bash tool",
						},
						"commit-pathspec": {
							source: "CLAUDE.md",
							trigger: "a `git add` on the Bash tool",
						},
					}),
					// The injector exists and indexes something else — a fragment of
					// its own, so the index is not itself a dangling citation (mantahostels#3135).
					"docs/agents/rules/commit-pathspec.txt": "Commit by pathspec.\n",
					"scripts/inject-tracker-docs.sh": injectorIndex("commit-pathspec"),
					"scripts/guard-label.sh": "#!/usr/bin/env bash\n",
					[SELF_PLUGIN_HOOKS]: hooksWiring(
						"scripts/guard-label.sh",
						"scripts/inject-tracker-docs.sh",
					),
				},
			}),
		);
		expect(r.kinds).toEqual(["UNINDEXED-RULE"]);
		expect(r.code).toBe(1);
		const found = r.json.findings.find(
			(f: { kind: string }) => f.kind === "UNINDEXED-RULE",
		);
		expect(found?.detail).toMatch(/takes-value-vocabulary/);
		expect(found?.detail).toMatch(/inject-tracker-docs\.sh/);
	});

	it("counts an index nothing wires as no index at all", () => {
		const r = run(
			build({
				claude: region(
					"- Pick the right label. **Enforced** (#453): `scripts/guard-label.sh` denies it.",
				),
				files: {
					"docs/agents/rules/takes-value-vocabulary.txt":
						"Use this repo's labels.\n",
					"docs/agents/rules/manifest.json": manifest({
						"takes-value-vocabulary": {
							source: "docs/agents/triage-labels.md",
							trigger: "a `gh issue create` on the Bash tool",
						},
					}),
					"scripts/inject-tracker-docs.sh": injectorIndex(
						"takes-value-vocabulary",
					),
					"scripts/guard-label.sh": "#!/usr/bin/env bash\n",
					[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-label.sh"),
				},
			}),
		);
		expect(r.kinds).toEqual(["UNINDEXED-RULE"]);
	});

	it("fails a manifest entry whose trigger key is absent, not merely blank", () => {
		const r = run(
			build({
				claude: region(
					"- Pick the right label. **Enforced** (#453): `scripts/guard-label.sh` denies it.",
				),
				files: {
					"docs/agents/rules/takes-value-vocabulary.txt":
						"Use this repo's labels.\n",
					"docs/agents/rules/manifest.json": manifest({
						"takes-value-vocabulary": {
							source: "docs/agents/triage-labels.md",
						},
					}),
					"scripts/inject-tracker-docs.sh": injectorIndex(
						"takes-value-vocabulary",
					),
					"scripts/guard-label.sh": "#!/usr/bin/env bash\n",
					[SELF_PLUGIN_HOOKS]: hooksWiring(
						"scripts/guard-label.sh",
						"scripts/inject-tracker-docs.sh",
					),
				},
			}),
		);
		expect(r.kinds).toEqual(["MANIFEST-NO-TRIGGER"]);
	});

	it("passes a manifest id a wired emitter prints, with no index entry", () => {
		// The delivery routes are alternatives, not both (spec mantahostels#2457, T4).
		const r = run(
			build({
				claude: region(
					triggerRule("takes-value-vocabulary", "scripts/guard-label.sh"),
				),
				files: {
					"docs/agents/rules/takes-value-vocabulary.txt":
						"Use this repo's labels.\n",
					"docs/agents/rules/manifest.json": manifest({
						"takes-value-vocabulary": {
							source: "docs/agents/triage-labels.md",
							trigger: "a `gh issue create` on the Bash tool",
						},
					}),
					"scripts/guard-label.sh": preemptiveEmitter("takes-value-vocabulary"),
					[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-label.sh"),
				},
			}),
		);
		expect(r.kinds).toEqual([]);
		expect(r.code).toBe(0);
	});
});

describe("gitignored scratch under a scan root (mantahostels#2243)", () => {
	/*
	 * `.claude/tmp/` is where docs/agents/guard-registry.md §Subagent dispatch sends every review
	 * and concision artefact.
	 *
	 * A real git repository, because the filter asks `git check-ignore`. Only
	 * the case that needs a tracked file sets `commit`.
	 */
	function gitRepo(
		fx: Fixture & { ignore?: string; commit?: boolean },
	): string {
		const root = build(fx);
		if (fx.ignore !== undefined)
			fs.writeFileSync(path.join(root, ".gitignore"), fx.ignore);
		const git = (...args: string[]) =>
			execFileSync("git", args, { cwd: root, encoding: "utf8" });
		git("init", "-q", ".");
		if (fx.commit) {
			git("config", "user.email", "test@example.com");
			git("config", "user.name", "test");
			git("add", "-Af");
			git("commit", "-qm", "x");
		}
		return root;
	}

	const trigger = "The claim protocol is in `rule:no-such-rule`.\n";
	const files = {
		"scripts/guard-branch.sh": "#!/usr/bin/env bash\n",
		[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-branch.sh"),
	};
	const claude = region(
		"- Stay on `main`. **Enforced** (#110): `scripts/guard-branch.sh` denies it.",
	);

	it("does not scan an ignored file", () => {
		const r = run(
			gitRepo({
				claude,
				ignore: ".claude/tmp/\n",
				files: { ...files, ".claude/tmp/review-spec-1.md": trigger },
			}),
		);
		expect(r.kinds).not.toContain("ORPHAN-TRIGGER");
		expect(r.code).toBe(0);
	});

	it("scans an untracked file that is not ignored", () => {
		/* Why the filter is not `git ls-files`: an uncommitted docs/research note
		 * is one `git add` from a commit, and --against reads the INDEX, so
		 * scoping to the tracked set would drop it while it is still the only
		 * copy anyone reads. */
		const r = run(
			gitRepo({
				claude,
				ignore: ".claude/tmp/\n",
				files: { ...files, "docs/research/note.md": trigger },
			}),
		);
		expect(r.kinds).toContain("ORPHAN-TRIGGER");
	});

	it("skips the filter on a --root tree outside any repo, and says so", () => {
		/* The materialised --against tree: `git archive` wrote it tracked-only,
		 * so there is nothing to drop (#710). */
		const root = build({
			claude,
			files: {
				...files,
				// Present and matching, so a hand-rolled .gitignore parser
				// swapped in for `git check-ignore` would fail this case.
				".gitignore": ".claude/tmp/\n",
				".claude/tmp/review-spec-1.md": trigger,
			},
		});
		const r = run(root, ["--root", root]);
		expect(r.kinds).toContain("ORPHAN-TRIGGER");
		expect(r.code).toBe(1);
		expect(r.report).toContain("Gitignore filter: not run");
		expect(r.report).not.toContain("FAILED OPEN");
	});

	it("fails open, and says so, where git cannot answer in a repo", () => {
		const root = gitRepo({
			claude,
			ignore: ".claude/tmp/\n",
			files: { ...files, ".claude/tmp/review-spec-1.md": trigger },
		});
		// PATH, not a WFC_ binary var (docs/code-standards-base.md §N7): the case is git missing from PATH.
		const r = run(root, [], { env: { PATH: "" } });
		expect(r.kinds).toContain("ORPHAN-TRIGGER");
		expect(r.code).toBe(1);
		expect(r.report).toContain("Gitignore filter FAILED OPEN");
	});

	it("scans a tracked file that matches an ignore pattern", () => {
		/* The safety net, and the reason `--no-index` is not on the call: without
		 * it, `check-ignore` consults the index and will not call a tracked path
		 * ignored — so a broad pattern cannot quietly take a committed document
		 * out of the gate. */
		const r = run(
			gitRepo({
				claude,
				ignore: "docs/\n",
				commit: true,
				files: { ...files, "docs/research/note.md": trigger },
			}),
		);
		expect(r.kinds).toContain("ORPHAN-TRIGGER");
	});

	it("does not read a gitignored emitter", () => {
		/* The emitter corpus is a SECOND walk over .claude/, and its read is
		 * deliberately unguarded so an unreadable emitter surfaces as BROKEN. An
		 * unreadable scratch file must therefore not reach it: .claude/tmp/ is the
		 * one directory a neighbouring session writes and deletes in while this
		 * runs. Mode 0 stands in for that race, which cannot be staged directly. */
		const root = gitRepo({
			claude,
			ignore: ".claude/tmp/\n",
			files: { ...files, ".claude/tmp/mut.sh": "#!/usr/bin/env bash\n" },
		});
		fs.chmodSync(path.join(root, ".claude", "tmp", "mut.sh"), 0o000);
		const r = run(root);
		expect(r.code).toBe(0);
	});
});

describe("a `rule:<id>` cited in a script's comment or string (mantahostels#3135)", () => {
	const claude = region(
		"- Stay on `main`. **Enforced** (#110): `scripts/guard-branch.sh` denies it.",
	);
	const wired = {
		[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-branch.sh"),
	};
	const orphan = (r: Result) =>
		r.json.findings.filter((f) => f.kind === "ORPHAN-TRIGGER");

	it("fails a dangling id cited in a wired guard's comment, naming the file, line and id", () => {
		const r = run(
			build({
				claude,
				files: {
					...wired,
					"scripts/guard-branch.sh":
						"#!/usr/bin/env bash\n# a condition `rule:no-such-rule` says is live\nexit 0\n",
				},
			}),
		);
		expect(orphan(r)).toEqual([
			expect.objectContaining({
				file: "scripts/guard-branch.sh",
				line: 2,
			}),
		]);
		expect(orphan(r)[0]?.detail).toMatch(/cites rule id "no-such-rule"/);
		expect(r.code).toBe(1);
	});

	it("fails one cited in a hand-run script nothing wires, naming the script", () => {
		const r = run(
			build({
				claude,
				files: {
					...wired,
					"scripts/guard-branch.sh": "#!/usr/bin/env bash\n",
					"scripts/issue-body.js": "// see `rule:no-such-rule`\n",
				},
			}),
		);
		expect(orphan(r).map((f) => f.file)).toEqual(["scripts/issue-body.js"]);
	});

	it("reads a citation inside a double-quoted bash string", () => {
		/* Bash spells the backtick there as \`. */
		const r = run(
			build({
				claude,
				files: {
					...wired,
					"scripts/guard-branch.sh":
						'#!/usr/bin/env bash\necho "no watchdog (\\`rule:no-such-rule\\`)"\n',
				},
			}),
		);
		expect(orphan(r).map((f) => f.line)).toEqual([2]);
	});

	it("passes a cited id a fragment answers to", () => {
		const r = run(
			build({
				claude,
				files: {
					...wired,
					"docs/agents/rules/branch-shared-tree.txt": "Stay on main.\n",
					"scripts/guard-branch.sh":
						'#!/usr/bin/env bash\n# prints `rule:branch-shared-tree` below\nsource "$here/lib/rule-text.sh"\ngp_deny "$(rule_text branch-shared-tree)"\n',
				},
			}),
		);
		expect(r.kinds).toEqual([]);
	});

	it("does not read an id spelled without backticks", () => {
		/* How a guard's log line names a rule in passing. */
		const r = run(
			build({
				claude,
				files: {
					...wired,
					"scripts/guard-branch.sh":
						"#!/usr/bin/env bash\n# rule:no-such-rule was not selected\n",
				},
			}),
		);
		expect(r.kinds).toEqual([]);
	});

	it("does not read the store's grammar placeholders as citations", () => {
		/* `rule:x` and `rule:-x` are how the accessors and the emitter patterns
		 * discuss the id grammar; both are copied into every fixture here. */
		const r = run(
			build({
				claude,
				files: {
					...wired,
					"scripts/guard-branch.sh":
						"#!/usr/bin/env bash\n# bares `rule:x` to `x`; `rule:-x` never matches; `rule:rule:x` strips once\n",
				},
			}),
		);
		expect(r.kinds).toEqual([]);
	});

	it("reads a lib nothing sources", () => {
		/* Not narrowed to what the liveness walk reaches: that walk cannot see
		 * an extension-less require, the majority spelling, so most of
		 * scripts/lib/ would go unread. */
		const r = run(
			build({
				claude,
				files: {
					...wired,
					"scripts/guard-branch.sh": "#!/usr/bin/env bash\n",
					"scripts/lib/orphan-lib.sh": "# see `rule:no-such-rule`\n",
				},
			}),
		);
		expect(orphan(r).map((f) => f.file)).toEqual(["scripts/lib/orphan-lib.sh"]);
	});
});

/* #97. Run as the plugin runs it: the REAL script,
 * outside the adopter's tree, so the core's own emitters are the plugin's. */
describe("an adopter that generates its own rule fragments", () => {
	const gen = path.join(__dirname, "generate-rule-fragments.js");
	/* A core fragment no emitter the adopter carries prints. */
	const coreId = "claim-bash-route";

	function adopter(): string {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "guard-registry-adopter-"),
		);
		temps.push(root);
		execFileSync("git", ["init", "-q"], { cwd: root });
		fs.mkdirSync(path.join(root, "docs", "agents"), { recursive: true });
		fs.writeFileSync(
			path.join(root, "docs", "agents", "issue-tracker.md"),
			"# Tracker\n\n<!-- rule:takes-value-vocabulary:begin -->\nEvery issue takes one `takes:` label.\n<!-- rule:takes-value-vocabulary:end -->\n",
		);
		fs.writeFileSync(
			path.join(root, "CLAUDE.md"),
			`# Adopter\n\n<!-- guard-registry:begin -->\n- **A Bash-route write to a claimed file is announced.** **Unenforceable**: \`rule:${coreId}\`.\n<!-- guard-registry:end -->\n`,
		);
		return root;
	}

	function gate(root: string, extra: string[] = []) {
		const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: root };
		delete env.WFC_RULES_DIR;
		delete env.WFC_RULES_FALLBACK_DIR;
		const r = spawnSync("node", [REAL_SCRIPT, "--json", ...extra], {
			cwd: root,
			encoding: "utf8",
			env,
		});
		const json = JSON.parse(r.stdout);
		const fails: { kind: string; file: string; message?: string }[] =
			json.findings.filter((f: { severity: string }) => f.severity === "FAIL");
		return {
			status: r.status,
			kinds: fails.map((f) => `${f.kind} ${f.file}`),
			messages: fails.map((f) => f.message ?? ""),
		};
	}

	it("passes generate-rule-fragments --check and this gate on the same tree", () => {
		const root = adopter();
		const env = { ...process.env, CLAUDE_PROJECT_DIR: root };
		spawnSync("node", [gen], { env });
		const check = spawnSync("node", [gen, "--check"], {
			env,
			encoding: "utf8",
		});
		expect(check.status, check.stderr).toBe(0);
		expect(
			fs.existsSync(
				path.join(
					root,
					"docs",
					"agents",
					"rules",
					"takes-value-vocabulary.txt",
				),
			),
		).toBe(true);
		expect(gate(root).kinds).toEqual([]);
		expect(gate(root, ["--root", root]).kinds).toEqual([]);
	});

	it("--against HEAD judges the commit that first adds the store, not the worktree", () => {
		/* The HEAD side has no store. Read off the worktree instead, it would
		 * see the staged fragment too and call its fault inherited. */
		const root = adopter();
		const git = (...a: string[]) =>
			execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], {
				cwd: root,
			});
		git("add", "-A");
		git("commit", "-q", "-m", "start");
		spawnSync("node", [gen], {
			env: { ...process.env, CLAUDE_PROJECT_DIR: root },
		});
		fs.writeFileSync(
			path.join(root, "docs", "agents", "rules", "adopter-only.txt"),
			"Printed by nobody.\n",
		);
		git("add", "-A");
		const r = gate(root, ["--against", "HEAD"]);
		expect(r.status).toBe(1);
		expect(r.messages).toHaveLength(1);
		expect(r.messages[0]).toContain("adopter-only");
	});

	/* The adopter's own fragment, and a guard of its own that prints it —
	 * wired by nothing until a case wires it. */
	function ownGuard(root: string): void {
		spawnSync("node", [gen], {
			env: { ...process.env, CLAUDE_PROJECT_DIR: root },
		});
		fs.writeFileSync(
			path.join(root, "docs", "agents", "rules", "adopter-only.txt"),
			"Printed by the adopter's own guard.\n",
		);
		fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
		fs.writeFileSync(
			path.join(root, "scripts", "guard-adopter.sh"),
			'#!/usr/bin/env bash\nsource "$here/lib/rule-text.sh"\ngp_deny "$(rule_text adopter-only)"\n',
		);
	}

	it("still reports a fragment of the adopter's own that no wired guard prints, naming its wiring", () => {
		const root = adopter();
		ownGuard(root);
		const r = gate(root);
		expect(r.status).toBe(1);
		expect(r.kinds).toEqual([
			"UNPRINTED-RULE docs/agents/rules/adopter-only.txt",
		]);
		const [message] = r.messages;
		expect(message).toContain("adopter-only");
		expect(message).toContain("this repo's .claude/settings.json");
		expect(message).toContain("a package.json script");
		expect(message).toContain("a .husky hook");
		expect(message).toContain("workflow-core's docs/agents/rules/README.md");
	});

	/* #925: the route docs/agents/rules/README.md §Adding one promises. */
	it("passes a fragment of the adopter's own that a guard it wires itself prints", () => {
		const root = adopter();
		ownGuard(root);
		fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
		fs.writeFileSync(
			path.join(root, ".claude", "settings.json"),
			hooksWiring("scripts/guard-adopter.sh"),
		);
		expect(gate(root).kinds).toEqual([]);
	});
});
