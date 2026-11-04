// @vitest-environment node
/*
 * Tests for scripts/check-guard-registry.js: the rule-text store (mantahostels#1644).
 *
 * The checker is a hard gate in .husky/pre-commit and roadmap-digest.yml:
 * loosen a case and a rule can claim **Enforced** while its guard is missing
 * or unwired.
 *
 * Over the run-cost budget (base §X8 (5)) by inheritance: its cases moved
 * unchanged from check-guard-registry.test.ts, whose cost was pre-existing (#4294).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	build,
	committedRepo,
	hooksWiring,
	REAL_SCRIPT,
	type Result,
	region,
	removeTemps,
	run,
	SELF_PLUGIN_HOOKS,
	temps,
} from "./lib/guard-registry-testkit";
import { runInProcess } from "./lib/run-in-process";
import { shellQuote } from "./lib/sh-quote.js";

afterEach(removeTemps);

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
		return `#!/usr/bin/env bash\n# shellcheck source=scripts/lib/rule-text.sh\nsource "$here/lib/rule-text.sh"\nrule_text ${shellQuote(id)} >&2\nexit 2\n`;
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
	 * A wired Node guard that hands its rules PRE-EMPTIVELY (mantahostels#1804)
	 * rather than in a refusal: an `injectRules` decision, which
	 * lib/guard-entry.js resolves through readRuleText at run time, so nothing
	 * in this file carries a literal accessor call.
	 */
	function preemptiveEmitter(...ids: string[]): string {
		return `#!/usr/bin/env node\nmodule.exports = () => ({ injectRules: [${ids.map((id) => `"${id}"`).join(", ")}] });\n`;
	}

	it("counts a fragment printed only pre-emptively as printed by a wired emitter", () => {
		const r = run(
			build({
				claude: region(
					triggerRule("commit-pathspec", "scripts/guard-commit.js"),
				),
				files: {
					"docs/agents/rules/commit-pathspec.txt": "Commit by pathspec.\n",
					"scripts/guard-commit.js": preemptiveEmitter("commit-pathspec"),
					[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-commit.js"),
				},
			}),
		);
		expect(r.kinds).toEqual([]);
	});

	it("reads a linked worktree's fragments, not CLAUDE_PROJECT_DIR's tree's (#3386)", () => {
		const shared = committedRepo({
			claude: region(
				triggerRule("worktree-only-rule", "scripts/guard-commit.js"),
			),
			files: {
				"docs/agents/rules/worktree-only-rule.txt": "Only in the worktree.\n",
				"scripts/guard-commit.js": preemptiveEmitter("worktree-only-rule"),
				[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-commit.js"),
			},
		});
		const tree = fs.mkdtempSync(path.join(os.tmpdir(), "guard-registry-wt-"));
		temps.push(tree);
		execFileSync("git", ["worktree", "add", "-q", "--detach", tree], {
			cwd: shared,
		});
		fs.rmSync(path.join(tree, "docs/agents/rules/worktree-only-rule.txt"));
		expect(run(shared).kinds).toEqual([]);
		const r = run(tree, [], { cwd: tree, env: { CLAUDE_PROJECT_DIR: shared } });
		expect(r.kinds).toContain("ORPHAN-TRIGGER");
	});

	it("reads every id in one pre-emptive call, not just the first", () => {
		const r = run(
			build({
				claude: region(
					[
						triggerRule("commit-pathspec", "scripts/guard-commit.js"),
						triggerRule("branch-shared-tree", "scripts/guard-commit.js"),
					].join("\n"),
				),
				files: {
					"docs/agents/rules/commit-pathspec.txt": "Commit by pathspec.\n",
					"docs/agents/rules/branch-shared-tree.txt": "Stay on main.\n",
					"scripts/guard-commit.js": preemptiveEmitter(
						"commit-pathspec",
						"branch-shared-tree",
					),
					[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-commit.js"),
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
					triggerRule("commit-pathspec", "scripts/guard-commit.js"),
				),
				files: {
					"docs/agents/rules/commit-pathspec.txt": "Commit by pathspec.\n",
					"scripts/guard-commit.js": preemptiveEmitter(
						"commit-pathspec",
						"no-such-rule",
					),
					[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-commit.js"),
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
					"scripts/unwired.js": preemptiveEmitter("file-claim"),
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
						'const { readRuleText } = require("./lib/rule-text");\nconsole.log(readRuleText("dirty-turn"));\n',
					[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-dirty.js"),
				},
			}),
		);
		expect(r.kinds).toEqual([]);
	});

	it.each([
		[
			"single-line",
			'console.log(readRuleTextOr("dirty-turn", "Never end a turn dirty.", "guard-dirty"));\n',
		],
		[
			"multi-line",
			'console.log(\n\treadRuleTextOr(\n\t\t"dirty-turn",\n\t\t"Never end a turn dirty.",\n\t\t"guard-dirty",\n\t),\n);\n',
		],
	])("reads a %s readRuleTextOr call as the guard's emitter", (_, call) => {
		const r = run(
			build({
				claude: region(triggerRule("dirty-turn", "scripts/guard-dirty.js")),
				files: {
					"docs/agents/rules/dirty-turn.txt": "Never end a turn dirty.\n",
					"scripts/guard-dirty.js": `const { readRuleTextOr } = require("./lib/rule-text");\n${call}`,
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
			.map(
				(id) =>
					`index=${shellQuote(`- \`rule:${id}\` — before the act it binds on.`)}`,
			)
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
					triggerRule("takes-value-vocabulary", "scripts/guard-label.js"),
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
					"scripts/guard-label.js": preemptiveEmitter("takes-value-vocabulary"),
					[SELF_PLUGIN_HOOKS]: hooksWiring("scripts/guard-label.js"),
				},
			}),
		);
		expect(r.kinds).toEqual([]);
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
						'#!/usr/bin/env bash\n# prints `rule:branch-shared-tree` below\nsource "$here/lib/rule-text.sh"\nrule_text branch-shared-tree >&2\nexit 2\n',
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

	function readFails(root: string, extra: string[] = []) {
		const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: root };
		delete env.WFC_RULES_DIR;
		delete env.WFC_RULES_FALLBACK_DIR;
		const r = runInProcess(REAL_SCRIPT, ["--json", ...extra], {
			cwd: root,
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
		runInProcess(gen, [], { env });
		const check = runInProcess(gen, ["--check"], { env });
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
		expect(readFails(root).kinds).toEqual([]);
		expect(readFails(root, ["--root", root]).kinds).toEqual([]);
	});

	it("--against HEAD judges the commit that first adds the store, not the worktree", () => {
		/* The HEAD side has no store. Read off the worktree instead, it would
		 * see the staged fragment too and call its fault inherited. */
		const root = adopter();
		const gitAsUser = (...a: string[]) =>
			execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], {
				cwd: root,
			});
		gitAsUser("add", "-A");
		gitAsUser("commit", "-q", "-m", "start");
		runInProcess(gen, [], {
			env: { ...process.env, CLAUDE_PROJECT_DIR: root },
		});
		fs.writeFileSync(
			path.join(root, "docs", "agents", "rules", "adopter-only.txt"),
			"Printed by nobody.\n",
		);
		gitAsUser("add", "-A");
		const r = readFails(root, ["--against", "HEAD"]);
		expect(r.status).toBe(1);
		expect(r.messages).toHaveLength(1);
		expect(r.messages[0]).toContain("adopter-only");
	});

	/* The adopter's own fragment, and a guard of its own that prints it —
	 * wired by nothing until a case wires it. */
	function ownGuard(root: string): void {
		runInProcess(gen, [], {
			env: { ...process.env, CLAUDE_PROJECT_DIR: root },
		});
		fs.writeFileSync(
			path.join(root, "docs", "agents", "rules", "adopter-only.txt"),
			"Printed by the adopter's own guard.\n",
		);
		fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
		fs.writeFileSync(
			path.join(root, "scripts", "guard-adopter.sh"),
			'#!/usr/bin/env bash\nsource "$here/lib/rule-text.sh"\nrule_text adopter-only >&2\nexit 2\n',
		);
	}

	it("still reports a fragment of the adopter's own that no wired guard prints, naming its wiring", () => {
		const root = adopter();
		ownGuard(root);
		const r = readFails(root);
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
		expect(readFails(root).kinds).toEqual([]);
	});
});
