// @vitest-environment node
/*
 * Tests for scripts/check-guard-registry.js: the second assertion, implicit behaviours (mantahostels#1261).
 *
 * The checker is a hard gate in .husky/pre-commit and roadmap-digest.yml:
 * loosen a case and a rule can claim **Enforced** while its guard is missing
 * or unwired.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ANCHORS,
	build,
	type Result,
	region,
	removeTemps,
	reviewIn,
	run,
	SELF_PLUGIN_HOOKS,
} from "./lib/guard-registry-testkit";
import { runInProcess } from "./lib/run-in-process";

afterEach(removeTemps);

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
		// The file-claim guard's shape: it refuses a write to a
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

	function postToolUseRepo(): string {
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
		const r = run(postToolUseRepo());
		expect(r.code).toBe(0);
		expect(r.json.warnings.map((w) => w.kind)).toEqual(["UNANCHORED"]);
		expect(r.json.warnings[0].detail).toContain(
			"IMPLICIT / JUSTIFIED / DEFEAT",
		);
	});

	it("--review clears it, and prints what the re-anchor is asserting", () => {
		const root = postToolUseRepo();
		const out = reviewIn(root);
		expect(out).toContain("anchored scripts/act.sh");
		expect(out).toContain("[PostToolUse]");
		expect(out).toContain("does a thing to a session that never asked");
		expect(run(root).json.warnings).toEqual([]);
	});

	it("warns again once the script moves under its annotation, as STALE-PROSE, naming the IMPLICIT / JUSTIFIED / DEFEAT annotation", () => {
		const root = postToolUseRepo();
		reviewIn(root);
		fs.appendFileSync(path.join(root, "scripts", "act.sh"), "echo drift\n");
		const w = run(root).json.warnings;
		expect(w.map((x) => x.kind)).toEqual(["STALE-PROSE"]);
		expect(w[0].detail).toContain("IMPLICIT / JUSTIFIED / DEFEAT");
	});

	it("is not an orphan anchor — the wiring reaching it is what keeps it", () => {
		const root = postToolUseRepo();
		reviewIn(root);
		expect(run(root).json.warnings.map((w) => w.kind)).not.toContain(
			"ORPHAN-ANCHOR",
		);
	});

	it("still orphans an anchor nothing reaches at all", () => {
		const root = postToolUseRepo();
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

	function sessionStartRepo(annotated: boolean): string {
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
		const out = prose(sessionStartRepo(true));
		expect(out).toContain("1 implicit behaviour(s) — 1 fail-safe");
		expect(out).toContain("scripts/act.sh  [SessionStart]  fail-safe");
	});

	it("holds the DETAIL back until asked, so a clean run stays short", () => {
		// This check runs in .husky/pre-commit on every commit touching docs/,
		// .claude/, scripts/ or .husky/, so the roster's unchanging prose on each
		// is the unclearable wallpaper mantahostels#109 ruled against.
		expect(prose(sessionStartRepo(true))).not.toContain(
			"sweeps every session's expired markers",
		);
		expect(prose(sessionStartRepo(true), ["--roster"])).toContain(
			"sweeps every session's expired markers",
		);
	});

	it("prints the detail unasked when something in the set is unannotated", () => {
		const out = prose(sessionStartRepo(false));
		expect(out).toContain("scripts/act.sh  [SessionStart]  unannotated");
		expect(out).toContain("(no IMPLICIT / JUSTIFIED / DEFEAT annotation)");
	});
});
