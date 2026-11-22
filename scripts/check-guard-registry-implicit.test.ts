// @vitest-environment node

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderHookShim } from "./lib/adopter-skeleton.js";
import {
	ACTING_ROW,
	ANCHORS,
	build,
	IMPLICIT_MANIFEST,
	implicitRows,
	type Result,
	region,
	removeTemps,
	reviewIn,
	run,
	SELF_PLUGIN_HOOKS,
} from "./lib/guard-registry-testkit";
import { runInProcess } from "./lib/run-in-process";

afterEach(removeTemps);

describe("implicit behaviours — the second assertion (mantahostels#1261)", () => {
	const script = "#!/bin/sh\n# Does a thing.\nexit 0\n";
	const rowFor = (rel: string, row: Record<string, string> = ACTING_ROW) =>
		implicitRows({ [rel]: row });

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

	it("fails a PostToolUse script the manifest holds no row for", () => {
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

	it("fails a script whose row is empty, as UNANNOTATED", () => {
		const root = build({
			claude: rules,
			files: {
				"scripts/post-write.sh": script,
				...implicitRows({ "scripts/post-write.sh": {} }),
				[SELF_PLUGIN_HOOKS]: wiredAt("PostToolUse", "scripts/post-write.sh"),
			},
		});
		expect(run(root).kinds).toEqual(["UNANNOTATED"]);
	});

	it("tells a row whose script is not on disk to restore it, not to wire it", () => {
		const root = build({
			claude: rules,
			files: {
				...rowFor("scripts/gone.sh"),
				[SELF_PLUGIN_HOOKS]: wiredAt("PostToolUse", "scripts/gone.sh"),
			},
		});
		const r = run(root);
		expect(r.kinds).toEqual(["UNWIRED-ROW"]);
		expect(r.json.findings[0].detail).toContain("not on disk");
	});

	it("passes the same script once its row is complete", () => {
		const root = build({
			claude: rules,
			files: {
				"scripts/post-write.sh": script,
				...rowFor("scripts/post-write.sh"),
				[SELF_PLUGIN_HOOKS]: wiredAt("PostToolUse", "scripts/post-write.sh"),
			},
		});
		expect(run(root).code).toBe(0);
	});

	it("fails a row for a script no wiring runs, as UNWIRED-ROW", () => {
		const root = build({
			claude: rules,
			files: {
				"scripts/retired.sh": script,
				...rowFor("scripts/retired.sh"),
			},
		});
		const r = run(root);
		expect(r.code).toBe(1);
		expect(r.kinds).toEqual(["UNWIRED-ROW"]);
		expect(r.json.findings[0]).toMatchObject({ file: IMPLICIT_MANIFEST });
		expect(r.json.findings[0].detail).toContain("scripts/retired.sh");
	});

	it("is BROKEN, not OK, when the manifest is not an object of string rows", () => {
		for (const [body, fault] of [
			["{ not json", "is not JSON"],
			['{"scripts/x.sh": ["a"]}', "is not a JSON object of rows"],
		]) {
			const root = build({
				claude: rules,
				files: { [IMPLICIT_MANIFEST]: body },
			});
			const { status, stdout, stderr } = runInProcess(
				path.join(root, "scripts", "check-guard-registry.js"),
				[],
				{ env: { ...process.env, CLAUDE_PROJECT_DIR: root } },
			);
			expect(status, body).toBe(2);
			expect(`${stdout}${stderr}`).toContain(`${IMPLICIT_MANIFEST} ${fault}`);
		}
	});

	it("reaches all four acting events and no others", () => {
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

	it("takes a PreToolUse guard that ALSO acts, on its own row", () => {
		const root = build({
			claude: rules,
			files: {
				"scripts/guard-file-claim.sh": script,
				...rowFor("scripts/guard-file-claim.sh"),
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
				"scripts/self-plugin-canary.sh": script,
				...rowFor("scripts/self-plugin-canary.sh"),
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

	it("names each missing key rather than the row as a whole", () => {
		const root = build({
			claude: rules,
			files: {
				"scripts/x.sh": script,
				...rowFor("scripts/x.sh", {
					IMPLICIT: ACTING_ROW.IMPLICIT,
					TREE: ACTING_ROW.TREE,
				}),
				[SELF_PLUGIN_HOOKS]: wiredAt("Stop", "scripts/x.sh"),
			},
		});
		const r = run(root);
		expect(r.code).toBe(1);
		expect(r.kinds).toEqual(["INCOMPLETE-ANNOTATION", "INCOMPLETE-ANNOTATION"]);
		const details = r.json.findings.map((f) => f.detail).join("\n");
		expect(details).toContain("`JUSTIFIED`");
		expect(details).toContain("`DEFEAT`");
	});

	it("fails a key that is present and empty", () => {
		const root = build({
			claude: rules,
			files: {
				"scripts/x.sh": script,
				...rowFor("scripts/x.sh", { ...ACTING_ROW, DEFEAT: "" }),
				[SELF_PLUGIN_HOOKS]: wiredAt("Stop", "scripts/x.sh"),
			},
		});
		const r = run(root);
		expect(r.code).toBe(1);
		expect(r.kinds).toEqual(["EMPTY-ANNOTATION"]);
	});

	it("accepts convenience as a verdict, and `none` as a defeat", () => {
		const root = build({
			claude: rules,
			files: {
				"scripts/name-session.sh": script,
				...rowFor("scripts/name-session.sh", {
					IMPLICIT: "renames the session after its issue.",
					JUSTIFIED: "convenience — nothing degrades but legibility.",
					DEFEAT: "none",
					TREE: ACTING_ROW.TREE,
				}),
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
				"scripts/x.sh": script,
				...rowFor("scripts/x.sh", {
					...ACTING_ROW,
					JUSTIFIED: "necessary — obviously.",
				}),
				[SELF_PLUGIN_HOOKS]: wiredAt("Stop", "scripts/x.sh"),
			},
		});
		const r = run(root);
		expect(r.code).toBe(1);
		expect(r.kinds).toEqual(["BAD-JUSTIFICATION"]);
	});

	it("fails a verdict asserted with no reason behind it, as BAD-JUSTIFICATION", () => {
		const root = build({
			claude: rules,
			files: {
				"scripts/x.sh": script,
				...rowFor("scripts/x.sh", { ...ACTING_ROW, JUSTIFIED: "fail-safe" }),
				[SELF_PLUGIN_HOOKS]: wiredAt("Stop", "scripts/x.sh"),
			},
		});
		expect(run(root).kinds).toEqual(["BAD-JUSTIFICATION"]);
	});

	it("owes a hook's row the tree it reads, as NO-TREE (#4243)", () => {
		const { TREE: _, ...treeless } = ACTING_ROW;
		const root = build({
			claude: rules,
			files: {
				"scripts/x.sh": script,
				...rowFor("scripts/x.sh", treeless),
				[SELF_PLUGIN_HOOKS]: wiredAt("Stop", "scripts/x.sh"),
			},
		});
		const r = run(root);
		expect(r.code).toBe(1);
		expect(r.kinds).toEqual(["NO-TREE"]);
	});

	it("fails a tree outside session, host, both and none, or with no reason, as BAD-TREE (#4243)", () => {
		for (const line of ["sometimes — it depends.", "session"]) {
			const root = build({
				claude: rules,
				files: {
					"scripts/x.sh": script,
					...rowFor("scripts/x.sh", { ...ACTING_ROW, TREE: line }),
					[SELF_PLUGIN_HOOKS]: wiredAt("Stop", "scripts/x.sh"),
				},
			});
			expect(run(root).kinds, line).toEqual(["BAD-TREE"]);
		}
	});

	it("owes no tree from the dispatcher, whose cores carry their own (#4242)", () => {
		const { TREE: _, ...treeless } = ACTING_ROW;
		const root = build({
			claude: rules,
			files: {
				"scripts/guard-dispatch.js": "#!/usr/bin/env node\n",
				...rowFor("scripts/guard-dispatch.js", treeless),
				[SELF_PLUGIN_HOOKS]: wiredAt("PreToolUse", "scripts/guard-dispatch.js"),
			},
		});
		expect(run(root).kinds).not.toContain("NO-TREE");
	});

	it("takes a core hook shim's row from the shim it is, with no manifest row (#1839)", () => {
		const root = build({
			claude: rules,
			files: {
				".husky/pre-commit": renderHookShim("pre-commit"),
				".husky/post-merge": renderHookShim("post-merge"),
			},
		});
		const r = run(root);
		expect(r.code).toBe(0);
		expect(implicitOf(r).map((i) => i.annotation?.JUSTIFIED)).toEqual([
			expect.stringMatching(/^fail-safe — \S/),
			expect.stringMatching(/^fail-safe — \S/),
		]);
	});

	it("reaches every husky hook by existence, including one added later", () => {
		const root = build({
			claude: rules,
			files: {
				".husky/pre-commit": "# Gates.\nexit 0\n",
				".husky/post-commit": script,
				".husky/pre-push": script,
				".husky/post-merge": script,
				...implicitRows({
					".husky/post-commit": ACTING_ROW,
					".husky/pre-push": ACTING_ROW,
					".husky/post-merge": ACTING_ROW,
				}),
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
				"scripts/vitest-tree-watch.ts": script,
				"scripts/vitest-pass-reporter.ts": script,
				"scripts/vitest-retired.ts": script,
				...implicitRows({
					"scripts/vitest-tree-watch.ts": ACTING_ROW,
					"scripts/vitest-pass-reporter.ts": ACTING_ROW,
				}),
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
		expect(implicitOf(r).map((i) => i.file)).toEqual([
			"scripts/vitest-pass-reporter.ts",
			"scripts/vitest-tree-watch.ts",
		]);
	});

	it("is BROKEN, not OK, at a core with no self-plugin file (#2442)", () => {
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
		const root = build({ claude: rules });
		const r = run(root);
		expect(r.code).toBe(0);
		expect(implicitOf(r)).toEqual([]);
	});

	it("skips a wired path that does not exist rather than reporting it", () => {
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
				"scripts/both.sh": script,
				...rowFor("scripts/both.sh"),
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
	const script = "#!/bin/sh\nexit 0\n";
	const rows = implicitRows({
		"scripts/act.sh": {
			...ACTING_ROW,
			IMPLICIT: "does a thing to a session that never asked.",
		},
	});

	function postToolUseRepo(): string {
		return build({
			claude: rules,
			files: {
				"scripts/act.sh": script,
				...rows,
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

	it("warns that nobody has read a wired script's row against it, as UNANCHORED, naming the IMPLICIT / JUSTIFIED / DEFEAT row", () => {
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

	it("warns again once the script moves under its row, as STALE-PROSE, naming the IMPLICIT / JUSTIFIED / DEFEAT row", () => {
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
				"scripts/act.sh": script,
				...rows,
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
				"scripts/act.sh": "#!/bin/sh\nexit 0\n",
				...(annotated
					? implicitRows({
							"scripts/act.sh": {
								IMPLICIT: "sweeps every session's expired markers.",
								JUSTIFIED: "fail-safe — an unswept store grows without bound.",
								DEFEAT: "none",
								TREE: "host — reads the host root's stores.",
							},
						})
					: {}),
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
		const out = prose(sessionStartRepo(true));
		expect(out).toContain("1 implicit behaviour(s) — 1 fail-safe");
		expect(out).toContain("scripts/act.sh  [SessionStart]  fail-safe");
	});

	it("holds the DETAIL back until asked, so a clean run stays short", () => {
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
		expect(out).toContain(
			`(no IMPLICIT / JUSTIFIED / DEFEAT row in ${IMPLICIT_MANIFEST})`,
		);
	});
});
