// @vitest-environment node
/*
 * Pins that every parallel-safety rule's backing marker is true — an Enforced
 * or Advisory rule names a guard that exists and is wired — and the script's
 * three later assertions: implicit behaviours (mantahostels#1261), the
 * rule-text store (mantahostels#1644) and the hook `if` narrowing
 * (mantahostels#2212).
 *
 * Tests for scripts/check-guard-registry.js (mantahostels#102): its claims,
 * markers and wiring. Its other subjects have a file each beside this one,
 * `check-guard-registry-*.test.ts` (#4294).
 *
 * It is a hard gate in .husky/pre-commit and roadmap-digest.yml: loosen a case
 * and a rule can claim **Enforced** while its guard is missing or unwired.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	asRoot,
	build,
	hooksWiring,
	REAL_SCRIPT,
	region,
	removeTemps,
	run,
	SELF_PLUGIN_HOOKS,
} from "./lib/guard-registry-testkit";
import { runInProcess } from "./lib/run-in-process";

const { DISPATCH_ENTRY, MANIFEST_REL } = require("./lib/guard-cores.js") as {
	DISPATCH_ENTRY: string;
	MANIFEST_REL: string;
};

afterEach(removeTemps);

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
				"- Push when the suite is green. **Unenforceable** (#244): `scripts/guard-push-rules.js` hands you the rule.",
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

	it("fails when it has lost its region, CLAUDE.md keeping its own, naming the registry document", () => {
		const root = build({
			claude: region(
				"- Show the diff before committing. **Unenforceable**: nobody can see it.",
			),
			files: {
				[registryDoc]:
					"# Guard registry\n\n- **Stay on `main`.** **Enforced** (#110): `scripts/guard-branch.sh`.\n",
			},
		});
		const r = run(root);
		expect(r.code).toBe(1);
		expect(r.kinds).toEqual(["NO-REGION"]);
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

describe("the live repository", () => {
	it("passes against this repo's own CLAUDE.md", () => {
		// This is the case that catches a guard deleted or unwired later: it runs
		// against the live repo rather than a fixture.
		const r = runInProcess(REAL_SCRIPT, [], {
			env: {
				...process.env,
				CLAUDE_PROJECT_DIR: path.resolve(__dirname, ".."),
			},
		});
		expect(
			r.status,
			`check-guard-registry.js fails on the live repo:\n${r.stdout}${r.stderr}`,
		).toBe(0);
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

	function buildGuardBody(header: string): string {
		return ["#!/usr/bin/env bash", ...header.split("\n"), "", "exit 0"].join(
			"\n",
		);
	}

	it("fails a hook narrowed by `if` whose script never says so", () => {
		const root = build({
			claude: region(rule),
			files: {
				[guard]: buildGuardBody("# PreToolUse guard.\n#\n# LIMITS\n#  - none."),
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
				[guard]: buildGuardBody(
					"# PreToolUse guard.\n#\n# LIMITS\n#  - Wired with `if: Bash(*git*)` (#2061).",
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
				[guard]: buildGuardBody(
					"# PreToolUse guard.\n#\n# LIMITS\n#  - Wired with `if: Bash(*git*)` (#2061).",
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
				[guard]: buildGuardBody(
					"# PreToolUse guard.\n#\n#  - Wired with `if: Bash(*gh*)` (#2061).",
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
				[guard]: buildGuardBody("# PreToolUse guard."),
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
				[guard]: buildGuardBody(
					"# PreToolUse guard.\n#  - Wired with `if: Bash(*git*)` (#2061).",
				),
				[SELF_PLUGIN_HOOKS]: wiringWithIf(guard, "Bash(*git*)"),
			},
		});
		const r = run(root);
		expect(r.report).toContain(
			"Hook `if` narrowings: 1 wired script(s) or dispatcher core(s) run on a narrowed set, " +
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
				[guard]: buildGuardBody(
					"# PreToolUse guard.\n#  - Wired with `if: Bash(*gh*)` (#2061).",
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
				[guard]: buildGuardBody(
					"# PreToolUse guard.\n#\n#  - Wired with `if: Bash(*git*)` (#2061).",
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
				[guard]: buildGuardBody(
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
				[guard]: buildGuardBody("# PreToolUse guard."),
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
				[guard]: buildGuardBody(
					"# PreToolUse guard.\n#\n#  - Wired with `if: Bash(*git*)` (#2061).",
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
				[guard]: buildGuardBody(
					"# PreToolUse guard.\n#\n#  - Wired with `if: Bash(*git*)` (#2061).",
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
				[guard]: buildGuardBody(
					"# PreToolUse guard.\n#\n#  - Wired with `if: Bash(*git*)` (#2061).",
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
				[other]: buildGuardBody("# PreToolUse guard."),
				[retired]: buildGuardBody(
					"# Retired guard, kept for reference.\n#  - Wired with `if: Bash(*gh*)` (#2061).",
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

	describe("a dispatcher core's manifest row (#3244)", () => {
		const core = "scripts/lib/x.js";

		/** The dispatcher wired, or not, its manifest running one core under `ifs`. */
		function dispatched(header: string, ifs?: unknown, wired = true) {
			return build({
				claude: region(`- Rule. **Enforced** (#1): \`${DISPATCH_ENTRY}\`.`),
				files: {
					[DISPATCH_ENTRY]: "#!/usr/bin/env node\n",
					[MANIFEST_REL]: JSON.stringify({
						PreToolUse: [
							{
								name: "guard-x",
								core: "x.js",
								tools: "Bash",
								failure: "open",
								...(ifs ? { if: ifs } : {}),
							},
						],
					}),
					[core]: `/*\n${header}\n */\nmodule.exports = {};\n`,
					[SELF_PLUGIN_HOOKS]: wired
						? hooksWiring(DISPATCH_ENTRY)
						: hooksWiring(),
				},
			});
		}

		it("calls a core's stated `if` unwired where no hook entry runs the dispatcher", () => {
			const r = run(
				dispatched(
					" * Its row narrows it with `if: Bash(git *)`.",
					["Bash(git *)"],
					false,
				),
			);
			expect(r.kinds).toContain("UNWIRED-IF");
			expect(r.code).toBe(1);
		});

		it("breaks on a row whose `if` is not an array, rather than judging its characters", () => {
			const r = run(dispatched(" * The x core.", "Bash(git *)"));
			expect(r.kinds).not.toContain("UNDECLARED-IF");
			expect(r.code).toBe(2);
		});

		it("fails a row's `if` the core's header never states, naming the manifest", () => {
			const r = run(dispatched(" * The x core.", ["Bash(git *)"]));
			const finding = r.json.findings.find((f) => f.kind === "UNDECLARED-IF");
			expect(r.report).toContain("State the narrowing verbatim in that header");
			expect(finding).toMatchObject({
				file: core,
				rule: `wired in ${MANIFEST_REL}`,
			});
			expect(r.code).toBe(1);
		});

		it("passes once the core's header states the row's `if`, and calls it neither unwired nor stale", () => {
			const r = run(
				dispatched(" * Its row narrows it with `if: Bash(git *)`.", [
					"Bash(git *)",
				]),
			);
			expect(r.kinds).not.toContain("UNDECLARED-IF");
			expect(r.kinds).not.toContain("STALE-IF");
			expect(r.kinds).not.toContain("UNWIRED-IF");
			expect(r.code).toBe(0);
			expect(r.json).toMatchObject({
				ifNarrowings: [{ file: core, values: ["Bash(git *)"] }],
			});
		});

		it("fails a core's header stating a clause its row does not carry", () => {
			const r = run(
				dispatched(" * Its row narrows it with `if: Bash(git *)`."),
			);
			expect(r.kinds).toContain("STALE-IF");
			expect(r.kinds).not.toContain("UNWIRED-IF");
			expect(
				r.json.findings.find((f) => f.kind === "STALE-IF")?.detail,
			).toContain(`no entry in ${MANIFEST_REL}`);
			expect(r.report).toContain("fails the same way");
			expect(r.code).toBe(1);
		});
	});
});

describe("the checker breaking is not the same event as a rule being false", () => {
	/**
	 * Raw runner: these cases are about the process's own outcome, so nothing
	 * here may assume the output parses.
	 */
	function raw(root: string, extra: string[] = []) {
		const r = runInProcess(
			path.join(root, "scripts", "check-guard-registry.js"),
			extra,
			{
				stdin: "",
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
		return { code: r.status, stdout: r.stdout, stderr: r.stderr };
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
				// A deny built from a variable and an appended heredoc.
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

describe("a Node guard's refusal, read from its core (#3001)", () => {
	const sentence =
		"It commits every dirty tracked file, so it takes a parallel session's " +
		"uncommitted edits — they need not have staged anything, only have a file open.";

	/** An entry running a core through guard-entry.js's run(). */
	const entry = (lib: string) =>
		[
			'const { run } = require("./lib/guard-entry.js");',
			`const { decide } = require("./lib/${lib}");`,
			"run({ decide });",
			"",
		].join("\n");

	/** A core refusing with `text`. */
	const denying = (text: string) =>
		`const REASON = ${JSON.stringify(text)};\nconst decide = () => ({ deny: REASON });\nmodule.exports = { decide };\n`;

	const manifest = (...names: string[]) =>
		JSON.stringify({
			PreToolUse: names.map((n) => ({
				name: `guard-${n}`,
				core: `${n}.js`,
				tools: "Bash",
				failure: "open",
			})),
		});

	function reprints(root: string) {
		return run(root).json.warnings.filter((w) => w.kind === "REPRINTED");
	}

	it("reads the core an entry takes decide from", () => {
		const guard = "scripts/guard-x.js";
		const root = build({
			claude: region(
				`- **Never \`git commit -a\`.** ${sentence} **Enforced** (#1): \`${guard}\`.`,
			),
			files: {
				[guard]: entry("x.js"),
				"scripts/lib/x.js": denying(sentence),
				[SELF_PLUGIN_HOOKS]: hooksWiring(guard),
			},
		});
		expect(reprints(root).map((w) => w.guard)).toEqual([guard]);
	});

	it("reads the dispatcher's manifest cores, only those the rule names where it names any", () => {
		const guard = "scripts/guard-dispatch.js";
		const fixture = (named: string) =>
			build({
				claude: region(
					`- **Never \`git commit -a\`.** ${sentence} **Enforced** (#1): \`${guard}\`${named}.`,
				),
				files: {
					[guard]: "#!/usr/bin/env node\n",
					"scripts/lib/guard-cores.json": manifest("x", "y"),
					"scripts/lib/x.js": denying(sentence),
					"scripts/lib/y.js": denying(
						"Commit by pathspec instead, naming only your files.",
					),
					[SELF_PLUGIN_HOOKS]: hooksWiring(guard),
				},
			});
		expect(reprints(fixture("")).map((w) => w.guard)).toEqual([guard]);
		expect(reprints(fixture(" (its `guard-x` core)"))).toHaveLength(1);
		expect(reprints(fixture(" (its `guard-y` core)"))).toEqual([]);
	});
});

describe("the live delayed-deny guard, mantahostels#964's counter-example", () => {
	/*
	 * The REAL core is copied in, so the declaration keeping it silent is
	 * under test rather than a fixture's imitation of it. The rule quotes the
	 * core's own refusal verbatim — CLAUDE.md's live wording of the same rule
	 * happens not to, so pairing the two as they stand would assert nothing.
	 * The rule names the dispatcher's row running the core.
	 *
	 * isolation-exempt: the core is copied in as text for the checker to
	 * read, and never run, so no fail-open can reach a log.
	 */
	const core = "scripts/lib/agent-poll.js";
	const dispatcher = "scripts/guard-dispatch.js";
	const named = " (its `guard-agent-poll` core)";
	const coreSource = fs.readFileSync(
		path.join(__dirname, "lib", "agent-poll.js"),
		"utf8",
	);

	/** Verbatim from the core's NOOP_REASON. */
	const quoted =
		"A no-op command like `true` re-invokes this session — which is why " +
		"the loop it is meant to break keeps going.";

	function pollFixture(coreText: string) {
		return build({
			claude: region(
				`- **While something runs in the background, end the turn.** ${quoted} **Enforced** (#627): \`${dispatcher}\`${named}.`,
			),
			files: {
				[core]: coreText,
				[dispatcher]: "#!/usr/bin/env node\n",
				"scripts/lib/guard-cores.json": JSON.stringify({
					PreToolUse: [
						{
							name: "guard-agent-poll",
							core: "agent-poll.js",
							tools: "Read",
							failure: "closed",
						},
					],
				}),
				[SELF_PLUGIN_HOOKS]: hooksWiring(dispatcher),
			},
		});
	}

	const pollReprints = (coreText: string) =>
		run(pollFixture(coreText)).json.warnings.filter(
			(w) => w.kind === "REPRINTED",
		);

	it("declares its timing on the core, so the dispatcher draws no REPRINTED warning even where the rule quotes its refusal", () => {
		// The pairing asserts nothing unless the quote is still the core's
		// own wording, so drift in its text fails here rather than going
		// silent.
		expect(coreSource).toContain(quoted.replace(/`/g, "\\`"));
		expect(coreSource).toMatch(/^\s*\/\/\s*deny-timing:\s*delayed\b/m);
		expect(pollReprints(coreSource)).toEqual([]);
	});

	it("would warn on the dispatcher as REPRINTED without the declaration — so the silence above is the declaration's doing", () => {
		const undeclared = coreSource.replace(/^\/\/\s*deny-timing:.*$/m, "//");
		expect(undeclared).not.toMatch(/deny-timing:\s*delayed/);
		const [warning] = pollReprints(undeclared);
		expect(warning?.guard).toBe(dispatcher);
	});
});
