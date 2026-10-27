// @vitest-environment node
/*
 * Pins that check-instruction-surface.js warns when the census's counts — hook
 * entries and their command text, skill directories, the always-loaded pool —
 * drift from the baseline, and names each guard whose behavioural verdict has
 * lost its evidence (mantahostels#1716, mantahostels#1771).
 *
 * The checker reads HEAD and ignores an uncommitted edit, falling back to disk
 * where git cannot answer: no repo, or a file not yet in HEAD — never a skill
 * or the settings file, read at the revision alone (#1977, #2052). So every fixture
 * is a bare directory except the "reading git rather than the working tree"
 * block's.
 *
 * It reports, never gates, in the daily repo-checks run. Loosen a case and a
 * new hook or a changed guard goes unreported, so nobody re-measures it.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFaultyGit } from "./lib/git-fault-fake";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "check-instruction-surface.js");

let dir: string;

const write = (p: string, body: string) => {
	fs.mkdirSync(path.join(dir, path.dirname(p)), { recursive: true });
	fs.writeFileSync(path.join(dir, p), body);
};

/** A settings.json carrying `n` hook entries under one event. */
const settings = (byEvent: Record<string, number>) => {
	const hooks: Record<string, unknown[]> = {};
	for (const [event, n] of Object.entries(byEvent))
		hooks[event] = [
			{
				matcher: "Bash",
				hooks: Array.from({ length: n }, (_, i) => ({
					type: "command",
					command: `scripts/h${i}.sh`,
				})),
			},
		];
	return JSON.stringify({ hooks }, null, "\t");
};

const skill = (name: string, disabled = false) =>
	write(
		`.claude/skills/${name}/SKILL.md`,
		`---\nname: ${name}\ndescription: does ${name}\n${disabled ? "disable-model-invocation: true\n" : ""}---\n\nbody\n`,
	);

/** The tree the default baseline below describes. */
const buildTree = () => {
	write("CLAUDE.md", "x".repeat(1000));
	write("AGENTS.md", "y".repeat(500));
	write("docs/working-contract.md", "z".repeat(100));
	write(".claude/output-styles/core-voice.md", "w".repeat(200));
	write(".claude/settings.json", settings({ PreToolUse: 2, Stop: 1 }));
	skill("alpha");
	skill("beta", true);
	write("scripts/guard-one.sh", "#!/bin/sh\necho rule one\n");
	write("scripts/guard-two.sh", "#!/bin/sh\necho rule two\n");
};

const BASELINE = "scripts/instruction-surface-anchors.json";

const baseline = (over: Record<string, unknown> = {}) => ({
	measuredAt: { date: "2026-08-28", census: "#1716", standing: "#1771" },
	poolFiles: {
		"CLAUDE.md": 1000,
		"AGENTS.md": 500,
		"docs/working-contract.md": 100,
		".claude/output-styles/core-voice.md": 200,
	},
	poolRules: { total: 123, noRetrieval: 74 },
	hooks: { total: 3, byEvent: { PreToolUse: 2, Stop: 1 } },
	hookCommands: {},
	skills: { distinct: 2, own: 2, vendored: 0, disabled: 1 },
	guards: {
		"scripts/guard-one.sh": {
			digest: "",
			verdict: "at need",
			selfSufficient: "yes",
		},
		"scripts/guard-two.sh": {
			digest: "",
			verdict: "too late",
			selfSufficient: "no",
		},
	},
	...over,
});

/** Writes the baseline, filling in the digests the tree currently has. */
const writeBaseline = (over: Record<string, unknown> = {}) => {
	write(BASELINE, JSON.stringify(baseline(over), null, "\t"));
	run("--rebaseline", "--no-claim");
	if (Object.keys(over).length > 0) {
		const live = JSON.parse(fs.readFileSync(path.join(dir, BASELINE), "utf8"));
		write(BASELINE, JSON.stringify({ ...live, ...over }, null, "\t"));
	}
};

const run = (...args: string[]) => {
	// Off, not inherited: a real Actions run sets it globally, and this
	// suite runs inside one — runCheck's ::error:: annotation, added off
	// this flag, would otherwise leak into `out` (mantahostels#2427).
	const r = runInProcess(SCRIPT, ["--root", dir, ...args], {
		env: { ...process.env, GITHUB_ACTIONS: "" },
	});
	return {
		status: r.status,
		stdout: r.stdout,
		out: `${r.stdout}${r.stderr}`,
		json: () => JSON.parse(r.stdout),
	};
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "instr-surface-"));
	buildTree();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("a tree that still matches its baseline", () => {
	it("is OK, and says what it counted", () => {
		writeBaseline();
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toMatch(/OK/);
		expect(r.out).toMatch(/3 hook entries/);
	});
});

describe("the mechanical counts", () => {
	it("warns HOOK-COUNT when a hook entry appears, naming the event, and exits 0", () => {
		writeBaseline();
		write(".claude/settings.json", settings({ PreToolUse: 3, Stop: 1 }));
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toMatch(/WARN/);
		expect(r.out).toMatch(/HOOK-COUNT/);
		expect(r.out).toMatch(/PreToolUse/);
	});

	it("names the census edition the baseline was measured for, not a fixed one (#1604)", () => {
		writeBaseline({
			measuredAt: {
				date: "2026-10-15",
				document: "docs/research/edition-2.md",
			},
		});
		write(".claude/settings.json", settings({ PreToolUse: 3, Stop: 1 }));
		expect(run().out).toMatch(
			/against docs\/research\/edition-2\.md as anchored/,
		);
	});

	it("says so where the baseline names no census edition", () => {
		writeBaseline();
		write(".claude/settings.json", settings({ PreToolUse: 3, Stop: 1 }));
		expect(run().out).toMatch(
			/against the instruction-surface census as anchored/,
		);
	});

	describe("hook command text (mantahostels#1923)", () => {
		it("stays quiet when no hook command's text has moved", () => {
			writeBaseline();
			write(".claude/settings.json", settings({ PreToolUse: 2, Stop: 1 }));
			expect(run().out).not.toMatch(/HOOK-COMMAND\b/);
		});

		it("warns, on tag and subject together, when a hook command's text changes at an unchanged count, quoting the new text and raising no other tag — mantahostels#1899 (a --detach flag added to a live hook command)", () => {
			writeBaseline();
			write(
				".claude/settings.json",
				settings({ PreToolUse: 2, Stop: 1 }).replace(
					'"command": "scripts/h0.sh"',
					'"command": "scripts/h0.sh --detach"',
				),
			);
			const r = run();
			expect(r.status).toBe(0);
			expect(r.out).toMatch(
				/HOOK-COMMAND\s+PreToolUse scripts\/h0\.sh's live hook command has changed.*--detach/,
			);
			expect(r.out).not.toMatch(/HOOK-COMMAND-GONE/);
			expect(r.out).not.toMatch(/HOOK-COUNT/);
		});

		it("warns HOOK-COMMAND-GONE when a hook command's script disappears entirely, naming the event and script", () => {
			writeBaseline();
			write(".claude/settings.json", settings({ PreToolUse: 1, Stop: 1 }));
			const r = run();
			expect(r.out).toMatch(/HOOK-COMMAND-GONE\s+PreToolUse scripts\/h1\.sh/);
			expect(r.out).not.toMatch(/moved from/);
		});

		it("reports a hook that moved event honestly, not as gone", () => {
			writeBaseline();
			write(
				".claude/settings.json",
				JSON.stringify(
					{
						hooks: {
							PreToolUse: [
								{
									matcher: "Bash",
									hooks: [{ type: "command", command: "scripts/h1.sh" }],
								},
							],
							Stop: [
								{
									matcher: "Bash",
									hooks: [{ type: "command", command: "scripts/h0.sh" }],
								},
							],
						},
					},
					null,
					"\t",
				),
			);
			const r = run();
			expect(r.out).toMatch(
				/HOOK-COMMAND-GONE\s+scripts\/h0\.sh moved from PreToolUse to Stop/,
			);
		});

		it("warns HOOK-COMMAND-NEW for a live command with no baseline row, naming the event and script (mantahostels#2648)", () => {
			writeBaseline();
			write(
				".claude/settings.json",
				JSON.stringify(
					{
						hooks: {
							PreToolUse: [
								{
									matcher: "Bash",
									hooks: [
										{ type: "command", command: "scripts/h0.sh" },
										{ type: "command", command: "scripts/newcomer.sh" },
									],
								},
							],
							Stop: [
								{
									matcher: "Bash",
									hooks: [{ type: "command", command: "scripts/h0.sh" }],
								},
							],
						},
					},
					null,
					"\t",
				),
			);
			const r = run();
			expect(r.status).toBe(0);
			expect(r.out).toMatch(
				/HOOK-COMMAND-NEW\s+PreToolUse scripts\/newcomer\.sh runs as a hook command with no row/,
			);
			expect(r.out).not.toMatch(/HOOK-COMMAND-COUNT/);
		});

		it("stays quiet on HOOK-COMMAND-NEW where the key is only a moved event", () => {
			writeBaseline();
			/* h1.sh moves PreToolUse → SessionStart, an event the baseline holds
			 * no row for. */
			write(
				".claude/settings.json",
				JSON.stringify(
					{
						hooks: {
							PreToolUse: [
								{
									matcher: "Bash",
									hooks: [{ type: "command", command: "scripts/h0.sh" }],
								},
							],
							Stop: [
								{
									matcher: "Bash",
									hooks: [{ type: "command", command: "scripts/h0.sh" }],
								},
							],
							SessionStart: [
								{
									matcher: "startup",
									hooks: [{ type: "command", command: "scripts/h1.sh" }],
								},
							],
						},
					},
					null,
					"\t",
				),
			);
			const r = run();
			expect(r.out).toMatch(
				/HOOK-COMMAND-GONE\s+scripts\/h1\.sh moved from PreToolUse to SessionStart/,
			);
			expect(r.out).not.toMatch(/HOOK-COMMAND-NEW/);
		});

		it("reports a second wiring of an already-anchored script as new", () => {
			writeBaseline();
			write(
				".claude/settings.json",
				JSON.stringify(
					{
						hooks: {
							PreToolUse: [
								{
									matcher: "Bash",
									hooks: [
										{ type: "command", command: "scripts/h0.sh" },
										{ type: "command", command: "scripts/h1.sh" },
									],
								},
							],
							Stop: [
								{
									matcher: "Bash",
									hooks: [{ type: "command", command: "scripts/h0.sh" }],
								},
							],
							SessionStart: [
								{
									matcher: "startup",
									hooks: [{ type: "command", command: "scripts/h1.sh" }],
								},
							],
						},
					},
					null,
					"\t",
				),
			);
			const r = run();
			expect(r.status).toBe(0);
			expect(r.out).toMatch(/HOOK-COMMAND-NEW\s+SessionStart scripts\/h1\.sh/);
			expect(r.out).not.toMatch(/HOOK-COMMAND-GONE/);
		});

		it("reports the extra wiring where a script both moves and gains one", () => {
			writeBaseline();
			/* h1.sh leaves PreToolUse for SessionStart AND picks up a Notification
			 * entry. */
			write(
				".claude/settings.json",
				JSON.stringify(
					{
						hooks: {
							PreToolUse: [
								{
									matcher: "Bash",
									hooks: [{ type: "command", command: "scripts/h0.sh" }],
								},
							],
							Stop: [
								{
									matcher: "Bash",
									hooks: [{ type: "command", command: "scripts/h0.sh" }],
								},
							],
							SessionStart: [
								{
									matcher: "startup",
									hooks: [{ type: "command", command: "scripts/h1.sh" }],
								},
							],
							Notification: [
								{
									matcher: "*",
									hooks: [{ type: "command", command: "scripts/h1.sh" }],
								},
							],
						},
					},
					null,
					"\t",
				),
			);
			const r = run();
			expect(r.status).toBe(0);
			expect(r.out).toMatch(/HOOK-COMMAND-GONE\s+scripts\/h1\.sh moved from/);
			expect(r.out).toMatch(/HOOK-COMMAND-NEW\s+Notification scripts\/h1\.sh/);
		});

		/** One PreToolUse Bash group holding `pre`, and a Stop group of one. */
		const bashSettings = (pre: Record<string, unknown>[]) =>
			JSON.stringify(
				{
					hooks: {
						PreToolUse: [
							{
								matcher: "Bash",
								hooks: pre.map((h) => ({ type: "command", ...h })),
							},
						],
						Stop: [
							{
								matcher: "Bash",
								hooks: [{ type: "command", command: "scripts/h0stop.sh" }],
							},
						],
					},
				},
				null,
				"\t",
			);

		it("warns HOOK-COMMAND-COUNT when two entries collide on one key, giving the key and entry counts", () => {
			writeBaseline();
			write(
				".claude/settings.json",
				bashSettings([
					{ command: "scripts/h0.sh" },
					{ command: "scripts/h0.sh --extra" },
				]),
			);
			const r = run();
			expect(r.out).toMatch(/HOOK-COMMAND-COUNT/);
			expect(r.out).toMatch(
				/2 distinct hook-command keys against 3 hook entries/,
			);
		});

		it("still warns HOOK-COMMAND-COUNT when two entries share a script and an `if` condition", () => {
			writeBaseline();
			const h = { command: "scripts/h0.sh", if: "Bash(*cat *)" };
			write(".claude/settings.json", bashSettings([h, h]));
			expect(run().out).toMatch(
				/2 distinct hook-command keys against 3 hook entries/,
			);
		});

		it("keys one script wired under two `if` conditions as two rows, not a collision (#1604)", () => {
			writeBaseline();
			write(
				".claude/settings.json",
				bashSettings([
					{ command: "scripts/h2.sh", if: "Bash(*cat *)" },
					{ command: "scripts/h2.sh", if: "Bash(*sed *)" },
				]),
			);
			const r = run();
			expect(r.out).not.toMatch(/HOOK-COMMAND-COUNT/);
			expect(r.out).toMatch(
				/HOOK-COMMAND-NEW\s+PreToolUse scripts\/h2\.sh if Bash\(\*cat \*\)/,
			);
			expect(r.out).toMatch(
				/HOOK-COMMAND-NEW\s+PreToolUse scripts\/h2\.sh if Bash\(\*sed \*\)/,
			);
			run("--rebaseline", "--no-claim");
			expect(run().out).not.toMatch(/HOOK-COMMAND/);
		});

		it("reports an anchored hook that gained an `if` condition as a condition change, not as gone", () => {
			writeBaseline();
			write(
				".claude/settings.json",
				bashSettings([
					{ command: "scripts/h0.sh", if: "Bash(git *)" },
					{ command: "scripts/h1.sh" },
				]),
			);
			const r = run();
			expect(r.out).toMatch(
				/HOOK-COMMAND-GONE\s+PreToolUse scripts\/h0\.sh now runs under another condition, as `PreToolUse scripts\/h0\.sh if Bash\(git \*\)`/,
			);
			expect(r.out).not.toMatch(
				/PreToolUse scripts\/h0\.sh no longer runs as a hook command/,
			);
			expect(r.out).not.toMatch(/HOOK-COMMAND-NEW\s+PreToolUse scripts\/h0/);
		});

		it("--only names a conditioned hook by its whole key", () => {
			writeBaseline();
			write(
				".claude/settings.json",
				bashSettings([
					{ command: "scripts/h0.sh", if: "Bash(*cat *)" },
					{ command: "scripts/h1.sh" },
				]),
			);
			const r = run(
				"--rebaseline",
				"--no-claim",
				"--only",
				"PreToolUse scripts/h0.sh if Bash(*cat *)",
			);
			expect(r.status).toBe(0);
			expect(r.out).toMatch(/1 of 1 named row/);
		});

		it("--only drops a named hook row gone from the live tree, as it reports (#1661)", () => {
			writeBaseline();
			write(
				".claude/settings.json",
				bashSettings([
					{ command: "scripts/h0.sh", if: "Bash(*cat *)" },
					{ command: "scripts/h1.sh" },
				]),
			);
			const r = run(
				"--rebaseline",
				"--no-claim",
				"--only",
				"PreToolUse scripts/h0.sh,PreToolUse scripts/h0.sh if Bash(*cat *)",
			);
			expect(r.status).toBe(0);
			expect(r.out).toMatch(/1 named row\(s\) dropped/);
			expect(run().out).not.toMatch(
				/HOOK-COMMAND-GONE\s+PreToolUse scripts\/h0/,
			);
		});

		it("counts an exec-form entry by its args, not just command (mantahostels#2301)", () => {
			writeBaseline();
			write(
				".claude/settings.json",
				JSON.stringify(
					{
						hooks: {
							PreToolUse: [
								{
									matcher: "Bash",
									hooks: [
										{ type: "command", command: "scripts/h0.sh" },
										{
											type: "command",
											command: "node",
											args: ["scripts/h1.sh"],
										},
									],
								},
							],
							Stop: [
								{
									matcher: "Bash",
									hooks: [{ type: "command", command: "scripts/h0.sh" }],
								},
							],
						},
					},
					null,
					"\t",
				),
			);
			const r = run();
			// Without buildHookCommandLine() joining `command` and `args`,
			// `readHookCommands` finds no `scripts/…` text in the bare `"node"`
			// command, drops the entry, and liveCommandCount falls short of
			// hooks.total.
			expect(r.out).not.toMatch(/HOOK-COMMAND-COUNT/);
			// The anchored text for h1 was `scripts/h1.sh`, so the now-joined
			// `node scripts/h1.sh` reads as a live text change.
			expect(r.out).toMatch(
				/PreToolUse scripts\/h1\.sh.*was `scripts\/h1\.sh`, now `node scripts\/h1\.sh`/,
			);
		});
	});

	it("warns SKILL-COUNT when a skill directory appears, giving the new count", () => {
		writeBaseline();
		skill("gamma");
		const r = run();
		expect(r.out).toMatch(/SKILL-COUNT/);
		expect(r.out).toMatch(/3/);
	});

	it("counts a symlinked skill as vendored", () => {
		fs.mkdirSync(path.join(dir, ".agents/skills"), { recursive: true });
		fs.renameSync(
			path.join(dir, ".claude/skills/alpha"),
			path.join(dir, ".agents/skills/alpha"),
		);
		fs.symlinkSync(
			path.join(dir, ".agents/skills/alpha"),
			path.join(dir, ".claude/skills/alpha"),
		);
		/* Two own against one vendored, deliberately: a one-of-each tree cannot
		 * tell the split from its own mirror image. */
		skill("gamma");
		writeBaseline();
		const r = run("--json");
		expect(r.json().skills.live).toMatchObject({
			vendored: 1,
			own: 2,
			distinct: 3,
		});
	});
});

describe("the pool the rule inventory was taken over", () => {
	it("stays quiet on drift under the threshold", () => {
		writeBaseline();
		write("CLAUDE.md", "x".repeat(1050));
		expect(run().status).toBe(0);
		expect(run().out).not.toMatch(/POOL-DRIFT/);
	});

	it("warns POOL-DRIFT once a pool file has moved past it, naming the file and the inventory it puts in doubt", () => {
		writeBaseline();
		write("CLAUDE.md", "x".repeat(1200));
		const r = run();
		expect(r.out).toMatch(/POOL-DRIFT/);
		expect(r.out).toMatch(/CLAUDE\.md/);
		expect(r.out).toMatch(/123/); // the inventory the drift puts in doubt
	});

	it("takes the threshold from the command line", () => {
		writeBaseline();
		write("CLAUDE.md", "x".repeat(1050));
		expect(run("--threshold", "1").out).toMatch(/POOL-DRIFT/);
	});

	it("warns POOL-GONE when a pool file has gone missing", () => {
		writeBaseline();
		fs.rmSync(path.join(dir, "AGENTS.md"));
		expect(run().out).toMatch(/POOL-GONE/);
	});
});

describe("the behavioural verdicts", () => {
	it("warns when a guard's content has moved, naming its verdict", () => {
		writeBaseline();
		write("scripts/guard-two.sh", "#!/bin/sh\necho rule two, reworded\n");
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toMatch(/GUARD-CHANGED/);
		expect(r.out).toMatch(/guard-two\.sh/);
		expect(r.out).toMatch(/too late/);
	});

	it("prints the sufficiency half too, not the timing half alone", () => {
		/* The census confirmed three guards `at need` and downgraded them on
		 * sufficiency in the same table; a message quoting timing alone reads as
		 * a guard that works. */
		writeBaseline();
		write("scripts/guard-one.sh", "#!/bin/sh\necho reworded\n");
		expect(run().out).toMatch(/self-sufficient "yes"/);
	});

	it("says so where an anchor records no sufficiency verdict", () => {
		write(
			BASELINE,
			JSON.stringify(
				baseline({
					guards: {
						"scripts/guard-one.sh": { digest: "0", verdict: "at need" },
					},
				}),
				null,
				"\t",
			),
		);
		expect(run().out).toMatch(/self-sufficient "unrecorded"/);
	});

	it("stays quiet when no guard has moved", () => {
		writeBaseline();
		expect(run().out).not.toMatch(/GUARD-CHANGED/);
	});

	describe("a guard's digest hashes its code, not its comments (#1876)", () => {
		const jsGuard = "scripts/guard-three.js";
		const anchorJs = (body: string) => {
			write(jsGuard, body);
			write(
				BASELINE,
				JSON.stringify(
					baseline({
						guards: {
							[jsGuard]: {
								digest: "",
								verdict: "at need",
								selfSufficient: "yes",
							},
						},
					}),
					null,
					"\t",
				),
			);
			run("--rebaseline", "--no-claim");
		};

		it("stays quiet on a comments-and-blank-lines edit to a shell guard", () => {
			writeBaseline();
			write(
				"scripts/guard-two.sh",
				"#!/bin/sh\n# why it says so\n\necho rule two   # trailing note\n",
			);
			expect(run().out).not.toMatch(/GUARD-CHANGED/);
		});

		it("still expires a shell guard whose heredoc text changed, though its lines start with #", () => {
			write("scripts/guard-two.sh", "#!/bin/sh\ncat <<EOF\n# rule two\nEOF\n");
			writeBaseline();
			write("scripts/guard-two.sh", "#!/bin/sh\ncat <<EOF\n# rule 2\nEOF\n");
			expect(run().out).toMatch(/GUARD-CHANGED\s+scripts\/guard-two\.sh/);
		});

		it("stays quiet on a comments-only edit to a JavaScript guard", () => {
			anchorJs('/* header */\nconsole.log("rule three");\n');
			write(
				jsGuard,
				'/* header, cut */\n\n// a new note\nconsole.log("rule three"); // why\n',
			);
			expect(run().out).not.toMatch(/GUARD-CHANGED/);
		});

		it("still expires a JavaScript guard whose printed string changed, even inside a comment-like literal", () => {
			anchorJs('console.log("see // rule three");\n');
			write(jsGuard, 'console.log("see // rule 3");\n');
			expect(run().out).toMatch(/GUARD-CHANGED\s+scripts\/guard-three\.js/);
		});
	});

	describe("a shell guard's digest hashes the rule files it prints from (#1914)", () => {
		const anchorGuardPrintingRuleTwo = () => {
			write("scripts/guard-two.sh", '#!/bin/sh\necho "$(rule_text two)"\n');
			write("docs/agents/rules/two.txt", "Rule two.\n");
			write("docs/agents/rules/other.txt", "Another rule.\n");
			writeBaseline();
		};

		it("expires the guard whose rule file was reworded, its code untouched", () => {
			anchorGuardPrintingRuleTwo();
			write("docs/agents/rules/two.txt", "Rule two, reworded.\n");
			const r = run();
			expect(r.status).toBe(0);
			expect(r.out).toMatch(/GUARD-CHANGED\s+scripts\/guard-two\.sh/);
			expect(r.out).toContain("--rebaseline --only <key>");
			expect(r.out).not.toMatch(/guard-one\.sh/);
		});

		it("expires nothing on an edit to a rule file no measured guard prints", () => {
			anchorGuardPrintingRuleTwo();
			write("docs/agents/rules/other.txt", "Another rule, reworded.\n");
			expect(run().out).not.toMatch(/GUARD-CHANGED/);
		});

		it("expires nothing on a rule id named only in a comment", () => {
			write(
				"scripts/guard-two.sh",
				"#!/bin/sh\n# see rule_text other\necho rule two\n",
			);
			writeBaseline();
			write("docs/agents/rules/other.txt", "Another rule, reworded.\n");
			expect(run().out).not.toMatch(/GUARD-CHANGED/);
		});
	});

	describe("a Node core's digest hashes the rule files it injects (#3011)", () => {
		const core = "scripts/lib/core-two.js";
		const withCore = (digest: string) =>
			write(
				BASELINE,
				JSON.stringify(
					baseline({
						guards: {
							...baseline().guards,
							[core]: { digest, verdict: "at need", selfSufficient: "yes" },
						},
					}),
					null,
					"\t",
				),
			);
		const anchorCore = (body: string) => {
			write(core, body);
			write("docs/agents/rules/two.txt", "Rule two.\n");
			write("docs/agents/rules/other.txt", "Another rule.\n");
			withCore("");
			run("--rebaseline", "--no-claim");
		};

		it("expires the core whose injected rule file was reworded, its code untouched", () => {
			anchorCore(
				'module.exports = { decide: () => ({\n\tinjectRules: [\n\t\t"one",\n\t\t"two",\n\t],\n}) };\n',
			);
			write("docs/agents/rules/two.txt", "Rule two, reworded.\n");
			const r = run();
			expect(r.status).toBe(0);
			expect(r.out).toMatch(/GUARD-CHANGED\s+scripts\/lib\/core-two\.js/);
			expect(r.out).toContain("--rebaseline --only <key>");
		});

		it("reads a direct readRuleText call's id too", () => {
			anchorCore('console.log(readRuleText("two"));\n');
			write("docs/agents/rules/two.txt", "Rule two, reworded.\n");
			expect(run().out).toMatch(/GUARD-CHANGED\s+scripts\/lib\/core-two\.js/);
		});

		it("expires nothing on an edit to a rule file the core does not inject", () => {
			anchorCore(
				'// injectRules: ["other"]\nmodule.exports = () => ({ injectRules: ["two"] });\n',
			);
			write("docs/agents/rules/other.txt", "Another rule, reworded.\n");
			expect(run().out).not.toMatch(/GUARD-CHANGED/);
		});

		it("passes an empty literal and a `.injectRules` read", () => {
			anchorCore(
				"const d = { injectRules: [], prelude: 'x' };\nconsole.log(d.injectRules.length);\n",
			);
			expect(run().out).not.toMatch(/BROKEN|GUARD-CHANGED/);
		});

		it.each([
			[
				"a variable",
				"const ids = ['two'];\nmodule.exports = () => ({ injectRules: ids });\n",
			],
			["a spread", "module.exports = (x) => ({ injectRules: [...x] });\n"],
			[
				"a shorthand key",
				"module.exports = (injectRules) => ({ injectRules });\n",
			],
		])(
			"is BROKEN on injectRules handed %s, naming the core, never hashing without its ids",
			(_, body) => {
				write(core, body);
				withCore("x");
				const r = run();
				expect(r.status).toBe(2);
				expect(r.out).toMatch(/BROKEN/);
				expect(r.out).toContain(`${core}: \``);
				expect(r.out).toContain("list the ids as quoted literals");
			},
		);
	});

	describe("a guard wrapper's digest folds the core and host ports it composes (#3129)", () => {
		const wrapper = "scripts/guard-three.js";
		const anchorWrapper = () => {
			write(
				wrapper,
				'const { run } = require("./lib/guard-entry.js");\nconst { decide } = require("./lib/three.js");\nconst { buildHostPorts } = require("./lib/three-host.js");\nconst { aside } = require("./lib/aside.js");\nrun({ decide });\n',
			);
			write("scripts/lib/guard-entry.js", "module.exports = { run() {} };\n");
			write(
				"scripts/lib/three.js",
				'module.exports = { decide: () => ({ injectRules: ["two"] }) };\n',
			);
			write(
				"scripts/lib/three-host.js",
				'module.exports = { buildHostPorts: () => readRuleText("other") };\n',
			);
			write("scripts/lib/aside.js", "module.exports = { aside: 1 };\n");
			write("docs/agents/rules/two.txt", "Rule two.\n");
			write("docs/agents/rules/other.txt", "Another rule.\n");
			write(
				BASELINE,
				JSON.stringify(
					baseline({
						guards: {
							...baseline().guards,
							[wrapper]: {
								digest: "",
								verdict: "at need",
								selfSufficient: "yes",
							},
						},
					}),
					null,
					"\t",
				),
			);
			run("--rebaseline", "--no-claim");
		};
		const expectExpired = () => {
			const r = run();
			expect(r.status).toBe(0);
			expect(r.out).toMatch(/GUARD-CHANGED\s+scripts\/guard-three\.js/);
			expect(r.out).toContain("--rebaseline --only <key>");
		};

		it.each([
			["a reworded fragment its core injects", "docs/agents/rules/two.txt"],
			[
				"a reworded fragment its host ports read",
				"docs/agents/rules/other.txt",
			],
		])("expires the wrapper on %s", (_, file) => {
			anchorWrapper();
			write(file, "Reworded.\n");
			expectExpired();
		});

		it.each([
			[
				"its core",
				"scripts/lib/three.js",
				'module.exports = { decide: () => ({ injectRules: ["two"], deny: "x" }) };\n',
			],
			[
				"its host ports",
				"scripts/lib/three-host.js",
				"module.exports = { buildHostPorts: () => 1 };\n",
			],
		])("expires the wrapper on a code edit to %s", (_, file, body) => {
			anchorWrapper();
			write(file, body);
			expectExpired();
		});

		it("expires nothing on a comment-only edit to its core", () => {
			anchorWrapper();
			write(
				"scripts/lib/three.js",
				'// why\nmodule.exports = { decide: () => ({ injectRules: ["two"] }) };\n',
			);
			expect(run().out).not.toMatch(/GUARD-CHANGED/);
		});

		it.each([
			[
				"guard-entry.js, the kit every wrapper runs",
				"scripts/lib/guard-entry.js",
			],
			["a lib it requires for anything else", "scripts/lib/aside.js"],
		])("expires nothing on an edit to %s", (_, file) => {
			anchorWrapper();
			write(file, "module.exports = { changed: true };\n");
			expect(run().out).not.toMatch(/GUARD-CHANGED/);
		});

		it("is BROKEN where its core hands injectRules no literal id array, naming the core", () => {
			anchorWrapper();
			write(
				"scripts/lib/three.js",
				"const ids = ['two'];\nmodule.exports = { decide: () => ({ injectRules: ids }) };\n",
			);
			const r = run();
			expect(r.status).toBe(2);
			expect(r.out).toContain("scripts/lib/three.js: `");
			expect(r.out).toContain("list the ids as quoted literals");
		});

		it("expires the wrapper when its core is deleted", () => {
			anchorWrapper();
			fs.rmSync(path.join(dir, "scripts/lib/three.js"));
			expectExpired();
		});
	});

	it("warns GUARD-GONE when a guard the census measured has gone, naming it", () => {
		writeBaseline();
		fs.rmSync(path.join(dir, "scripts/guard-one.sh"));
		const r = run();
		expect(r.out).toMatch(/GUARD-GONE/);
		expect(r.out).toMatch(/guard-one\.sh/);
	});
});

describe("re-baselining", () => {
	it("re-anchors the digests and keeps the authored verdicts", () => {
		writeBaseline();
		write("scripts/guard-two.sh", "#!/bin/sh\necho rule two, reworded\n");
		expect(run().out).toMatch(/GUARD-CHANGED/);

		const r = run("--rebaseline", "--no-claim");
		expect(r.status).toBe(0);
		const next = JSON.parse(fs.readFileSync(path.join(dir, BASELINE), "utf8"));
		expect(next.guards["scripts/guard-two.sh"].verdict).toBe("too late");
		expect(run().out).toMatch(/OK/);
	});

	it("re-anchors the counts too", () => {
		writeBaseline();
		skill("gamma");
		run("--rebaseline", "--no-claim");
		expect(run().out).not.toMatch(/SKILL-COUNT/);
	});

	describe("--only (mantahostels#2105)", () => {
		it("re-anchors a named guard and leaves an unnamed one still expired", () => {
			writeBaseline();
			write("scripts/guard-one.sh", "#!/bin/sh\necho rule one, reworded\n");
			write("scripts/guard-two.sh", "#!/bin/sh\necho rule two, reworded\n");
			const before = run().out;
			expect(before).toMatch(/guard-one\.sh/);
			expect(before).toMatch(/guard-two\.sh/);

			run("--rebaseline", "--no-claim", "--only", "scripts/guard-one.sh");

			const after = run().out;
			expect(after).not.toMatch(/guard-one\.sh/);
			expect(after).toMatch(/GUARD-CHANGED/);
			expect(after).toMatch(/guard-two\.sh/);
		});

		it("leaves the counts untouched even where they have also drifted", () => {
			writeBaseline();
			write("scripts/guard-one.sh", "#!/bin/sh\necho rule one, reworded\n");
			skill("gamma");
			run("--rebaseline", "--no-claim", "--only", "scripts/guard-one.sh");

			const after = run().out;
			expect(after).not.toMatch(/guard-one\.sh/);
			expect(after).toMatch(/SKILL-COUNT/);
		});

		it("re-counts the hook entries alone when named as `hooks` (#1879)", () => {
			writeBaseline();
			write(".claude/settings.json", settings({ PreToolUse: 3, Stop: 1 }));
			write("scripts/guard-one.sh", "#!/bin/sh\necho rule one, reworded\n");
			skill("gamma");
			const before = run().out;
			expect(before).toMatch(/HOOK-COUNT/);
			expect(before).toContain("re-anchors with --only hooks");
			expect(before).toContain("re-anchor with --only skills");

			const r = run("--rebaseline", "--no-claim", "--only", "hooks");
			expect(r.status).toBe(0);
			expect(r.out).toMatch(/1 of 1 named row\(s\) \(hooks\)/);

			const after = run().out;
			expect(after).not.toMatch(/HOOK-COUNT/);
			expect(after).toMatch(/guard-one\.sh/);
			expect(after).toMatch(/SKILL-COUNT/);
		});

		it("re-counts the skill directories alone when named as `skills` (#1879)", () => {
			writeBaseline();
			write(".claude/settings.json", settings({ PreToolUse: 3, Stop: 1 }));
			skill("gamma");

			const r = run("--rebaseline", "--no-claim", "--only", "skills");
			expect(r.status).toBe(0);
			expect(r.out).toMatch(/1 of 1 named row\(s\) \(skills\)/);

			const after = run().out;
			expect(after).not.toMatch(/SKILL-COUNT/);
			expect(after).toMatch(/HOOK-COUNT/);
		});

		it("re-anchors a named hookCommands key and leaves an unnamed one still expired", () => {
			writeBaseline({
				hookCommands: {
					"PreToolUse scripts/h0.sh": "stale",
					"Stop scripts/h0.sh": "also stale",
				},
			});
			const before = run().out;
			expect(before).toMatch(/PreToolUse scripts\/h0\.sh/);
			expect(before).toMatch(/Stop scripts\/h0\.sh/);

			run("--rebaseline", "--no-claim", "--only", "PreToolUse scripts/h0.sh");

			const after = run().out;
			expect(after).not.toMatch(/PreToolUse scripts\/h0\.sh/);
			expect(after).toMatch(/HOOK-COMMAND/);
			expect(after).toMatch(/Stop scripts\/h0\.sh/);
		});

		it("anchors a HOOK-COMMAND-NEW key, which has no baseline row to name (mantahostels#2648)", () => {
			writeBaseline({
				hookCommands: {
					"PreToolUse scripts/h0.sh": "stale",
					"Stop scripts/h0.sh": "scripts/h0.sh",
				},
			});
			expect(run().out).toMatch(
				/HOOK-COMMAND-NEW\s+PreToolUse scripts\/h1\.sh/,
			);

			const r = run(
				"--rebaseline",
				"--no-claim",
				"--only",
				"PreToolUse scripts/h1.sh",
			);
			expect(r.status).toBe(0);

			const after = run().out;
			expect(after).not.toMatch(/HOOK-COMMAND-NEW/);
			/* The unnamed stale row is untouched. */
			expect(after).toMatch(/HOOK-COMMAND\s+PreToolUse scripts\/h0\.sh/);
		});

		it("re-anchors a named poolFiles row and leaves an unnamed one still drifted", () => {
			writeBaseline();
			write("CLAUDE.md", "x".repeat(1200)); // +20%, over the 10% threshold
			write("AGENTS.md", "y".repeat(700)); // +40%, over the 10% threshold
			const before = run().out;
			expect(before).toMatch(/CLAUDE\.md is/);
			expect(before).toMatch(/AGENTS\.md is/);

			run("--rebaseline", "--no-claim", "--only", "CLAUDE.md");

			const after = run().out;
			expect(after).not.toMatch(/CLAUDE\.md is/);
			expect(after).toMatch(/POOL-DRIFT/);
			expect(after).toMatch(/AGENTS\.md is/);
		});

		it("takes a comma-separated list of keys", () => {
			writeBaseline();
			write("scripts/guard-one.sh", "#!/bin/sh\necho one, reworded\n");
			write("scripts/guard-two.sh", "#!/bin/sh\necho two, reworded\n");
			run(
				"--rebaseline",
				"--no-claim",
				"--only",
				"scripts/guard-one.sh,scripts/guard-two.sh",
			);
			expect(run().out).toMatch(/OK/);
		});

		it("is BROKEN on an empty --only", () => {
			writeBaseline();
			const r = run("--rebaseline", "--no-claim", "--only", "");
			expect(r.status).toBe(2);
			expect(r.out).toMatch(/--only named no key/);
		});

		it("is BROKEN on a key naming no row, rather than silently re-anchoring nothing", () => {
			writeBaseline();
			write("scripts/guard-one.sh", "#!/bin/sh\necho rule one, reworded\n");
			const r = run(
				"--rebaseline",
				"--no-claim",
				"--only",
				"scripts/guard-onee.sh",
			);
			expect(r.status).toBe(2);
			expect(r.out).toMatch(/no row in the baseline/);
			expect(r.out).toMatch(/scripts\/guard-onee\.sh/);
			/* Refused before it wrote — the finding it named is still expired. */
			expect(run().out).toMatch(/guard-one\.sh/);
		});
	});
});

describe("reading git rather than the working tree", () => {
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: dir, encoding: "utf8" });

	beforeEach(() => {
		git("init", "-q");
		git("config", "user.email", "t@t");
		git("config", "user.name", "t");
		git("add", "-A");
		git("commit", "-q", "-m", "fixture");
	});

	it("counts the core's self-plugin and settings hooks at HEAD, not its working tree (#2442, #2572)", () => {
		/* WFC_SCRIPT_ROOT makes `dir` the core, as the real checkout is to its
		 * own scripts. */
		const asCore = (...args: string[]) => {
			const r = runInProcess(SCRIPT, ["--root", dir, ...args], {
				env: { ...process.env, GITHUB_ACTIONS: "", WFC_SCRIPT_ROOT: dir },
			});
			return `${r.stdout}${r.stderr}`;
		};
		write("self-plugin/hooks/hooks.json", settings({ PreToolUse: 2, Stop: 1 }));
		write(".claude/settings.json", settings({ PreToolUse: 5 }));
		git("add", "-A");
		git("commit", "-q", "-m", "self-plugin");
		write(BASELINE, JSON.stringify(baseline(), null, "\t"));
		asCore("--rebaseline", "--no-claim");
		write("self-plugin/hooks/hooks.json", settings({ PreToolUse: 3, Stop: 1 }));
		expect(asCore()).not.toMatch(/HOOK-COUNT/);
		git("commit", "-q", "-am", "a fourth hook");
		expect(asCore()).toMatch(
			/HOOK-COUNT\s+9 hook entries in self-plugin\/hooks\/hooks\.json and \.claude\/settings\.json against the census's 8/,
		);
	});

	it("ignores an uncommitted edit to a guard", () => {
		writeBaseline();
		write("scripts/guard-two.sh", "#!/bin/sh\necho reworded but unsaved\n");
		expect(run().out).not.toMatch(/GUARD-CHANGED/);
	});

	it("sees the same edit once it is committed", () => {
		writeBaseline();
		write("scripts/guard-two.sh", "#!/bin/sh\necho reworded\n");
		git("add", "-A");
		git("commit", "-q", "-m", "reword");
		expect(run().out).toMatch(/GUARD-CHANGED/);
	});

	it("--at anchors against the tree the measurement was taken on", () => {
		const measuredAt = git("rev-parse", "HEAD").trim();
		write("scripts/guard-two.sh", "#!/bin/sh\necho reworded\n");
		git("add", "-A");
		git("commit", "-q", "-m", "reword");
		write(BASELINE, JSON.stringify(baseline(), null, "\t"));
		run("--rebaseline", "--no-claim", "--at", measuredAt);
		expect(run().out).toMatch(/GUARD-CHANGED/);
	});

	it("ignores an uncommitted hook entry, in the counts and the command texts (#1879)", () => {
		writeBaseline();
		write(".claude/settings.json", settings({ PreToolUse: 3, Stop: 1 }));
		const out = run().out;
		expect(out).not.toMatch(/HOOK-COUNT/);
		expect(out).not.toMatch(/HOOK-COMMAND/);
	});

	it("--at counts the hook entries at the tree named, not the working tree (#1879)", () => {
		const measuredAt = git("rev-parse", "HEAD").trim();
		writeBaseline();
		write(".claude/settings.json", settings({ PreToolUse: 3, Stop: 1 }));
		git("add", "-A");
		git("commit", "-q", "-m", "hook");
		const r = run(
			"--rebaseline",
			"--no-claim",
			"--only",
			"hooks",
			"--at",
			measuredAt,
		);
		expect(r.status).toBe(0);
		expect(run().out).toMatch(/HOOK-COUNT/);
	});

	it.each(["hooks", "skills"])(
		"refuses a --only %s --at git cannot resolve, before reading anything (#1977, #2052)",
		(key) => {
			writeBaseline();
			const r = run(
				"--rebaseline",
				"--no-claim",
				"--only",
				key,
				"--at",
				"nosuchrev",
			);
			expect(r.status).toBe(2);
			expect(r.out).toMatch(/--at nosuchrev names no commit/);
			expect(r.out).not.toMatch(/unhandled error/);
		},
	);

	it("refuses a settings file git has not been told about, rather than reading it from disk (#2052)", () => {
		writeBaseline();
		git("rm", "-q", "--cached", ".claude/settings.json");
		git("commit", "-q", "-m", "untrack settings");
		const r = run();
		expect(r.status).toBe(2);
		expect(r.out).toMatch(/no \.claude\/settings\.json at HEAD/);
	});

	it("ignores an uncommitted skill directory, in the check and a re-anchor (#1977)", () => {
		writeBaseline();
		skill("gamma");
		expect(run().out).not.toMatch(/SKILL-COUNT/);
		run("--rebaseline", "--no-claim", "--only", "skills");
		git("add", "-A");
		git("commit", "-q", "-m", "skill");
		expect(run().out).toMatch(/SKILL-COUNT/);
	});

	it("--at counts the skill directories at the tree named, not the working tree (#1977)", () => {
		const measuredAt = git("rev-parse", "HEAD").trim();
		writeBaseline();
		skill("gamma");
		git("add", "-A");
		git("commit", "-q", "-m", "skill");
		const r = run(
			"--rebaseline",
			"--no-claim",
			"--only",
			"skills",
			"--at",
			measuredAt,
		);
		expect(r.status).toBe(0);
		expect(run().out).toMatch(/SKILL-COUNT/);
	});

	it("counts no committed directory that holds no SKILL.md (#1977)", () => {
		writeBaseline();
		write(".claude/skills/gamma/notes.md", "not a skill\n");
		git("add", "-A");
		git("commit", "-q", "-m", "stray dir");
		expect(run().out).not.toMatch(/SKILL-COUNT/);
	});

	it("counts at a root below the repository's top (#1977)", () => {
		writeBaseline();
		const sub = path.join(dir, "sub");
		fs.mkdirSync(sub);
		for (const name of fs.readdirSync(dir))
			if (name !== "sub" && name !== ".git")
				fs.renameSync(path.join(dir, name), path.join(sub, name));
		git("add", "-A");
		git("commit", "-q", "-m", "move under sub");
		const r = runInProcess(SCRIPT, ["--root", sub, "--json"], {
			env: { ...process.env, GITHUB_ACTIONS: "" },
		});
		expect(JSON.parse(r.stdout).skills.live).toMatchObject({
			own: 2,
			disabled: 1,
		});
	});

	const betaVendored = { distinct: 2, own: 1, vendored: 1, disabled: 1 };

	it("follows a committed vendored link to its committed SKILL.md (#1977)", () => {
		/* The repo's own shape: a relative link into .agents/skills. */
		fs.mkdirSync(path.join(dir, ".agents/skills"), { recursive: true });
		fs.renameSync(
			path.join(dir, ".claude/skills/beta"),
			path.join(dir, ".agents/skills/beta"),
		);
		fs.symlinkSync(
			"../../.agents/skills/beta",
			path.join(dir, ".claude/skills/beta"),
		);
		git("add", "-A");
		git("commit", "-q", "-m", "vendor beta");
		writeBaseline();
		write(".agents/skills/beta/SKILL.md", "---\nname: beta\n---\n");
		expect(run("--json").json().skills.live).toEqual(betaVendored);
	});

	it("reads a committed SKILL.md link from its committed target, as the disk route does (#2369)", () => {
		fs.mkdirSync(path.join(dir, "shared"));
		fs.renameSync(
			path.join(dir, ".claude/skills/beta/SKILL.md"),
			path.join(dir, "shared/beta.md"),
		);
		fs.symlinkSync(
			"../../../shared/beta.md",
			path.join(dir, ".claude/skills/beta/SKILL.md"),
		);
		git("add", "-A");
		git("commit", "-q", "-m", "link beta's SKILL.md");
		writeBaseline();
		const counts = { distinct: 2, own: 2, vendored: 0, disabled: 1 };
		expect(run("--json").json().skills.live).toEqual(counts);
		fs.rmSync(path.join(dir, ".git"), { recursive: true });
		expect(run("--json").json().skills.live).toEqual(counts);
	});

	it.each([
		[
			"a relative",
			(outside: string) =>
				path.relative(
					path.join(dir, ".claude/skills"),
					path.join(outside, "beta"),
				),
		],
		["an absolute", (outside: string) => path.join(outside, "beta")],
	])(
		"reads %s vendored link leaving the repo from disk, as the disk route does (#2369)",
		(_, target) => {
			const outside = fs.mkdtempSync(path.join(os.tmpdir(), "instr-outside-"));
			try {
				fs.renameSync(
					path.join(dir, ".claude/skills/beta"),
					path.join(outside, "beta"),
				);
				fs.symlinkSync(target(outside), path.join(dir, ".claude/skills/beta"));
				git("add", "-A");
				git("commit", "-q", "-m", "vendor beta from outside");
				writeBaseline();
				expect(run("--json").json().skills.live).toEqual(betaVendored);
				fs.rmSync(path.join(dir, ".git"), { recursive: true });
				expect(run("--json").json().skills.live).toEqual(betaVendored);
			} finally {
				fs.rmSync(outside, { recursive: true, force: true });
			}
		},
	);

	it("follows a vendored link whose target is itself a link (#2369)", () => {
		fs.mkdirSync(path.join(dir, ".agents/skills"), { recursive: true });
		fs.renameSync(
			path.join(dir, ".claude/skills/beta"),
			path.join(dir, ".agents/skills/beta-v1"),
		);
		fs.symlinkSync("beta-v1", path.join(dir, ".agents/skills/beta"));
		fs.symlinkSync(
			"../../.agents/skills/beta",
			path.join(dir, ".claude/skills/beta"),
		);
		git("add", "-A");
		git("commit", "-q", "-m", "vendor beta through a second link");
		writeBaseline();
		expect(run("--json").json().skills.live).toEqual(betaVendored);
	});

	describe("--touched-by, the post-commit notice (#1810)", () => {
		const commit = (msg: string) => {
			git("add", "-A");
			git("commit", "-q", "-m", msg);
		};

		it("names a measured guard the commit changed, and the row to re-anchor", () => {
			writeBaseline();
			commit("anchor");
			write("scripts/guard-two.sh", "#!/bin/sh\necho reworded\n");
			commit("reword");
			const r = run("--touched-by", "HEAD");
			expect(r.status).toBe(0);
			expect(r.out).toMatch(/GUARD-CHANGED\s+scripts\/guard-two\.sh/);
			expect(r.out).toMatch(/too late/);
			expect(r.out).toContain("--rebaseline --only scripts/guard-two.sh");
			expect(r.out).toContain("one aimed at what you changed");
			expect(r.out).not.toMatch(/guard-one\.sh/);
		});

		it("owes every change since the anchor where the row was stale before the commit", () => {
			writeBaseline();
			commit("anchor");
			write("scripts/guard-two.sh", "#!/bin/sh\necho a neighbour's reword\n");
			commit("neighbour");
			write("scripts/guard-two.sh", "#!/bin/sh\necho reworded again\n");
			commit("reword");
			const r = run("--touched-by", "HEAD");
			expect(r.status).toBe(0);
			expect(r.out).toContain(
				"every change since its row was anchored, which was already stale before this commit",
			);
		});

		it("says nothing of a guard another commit left stale", () => {
			writeBaseline();
			commit("anchor");
			write("scripts/guard-two.sh", "#!/bin/sh\necho reworded\n");
			commit("reword");
			write("CLAUDE.md", "x".repeat(5000));
			commit("unrelated");
			const r = run("--touched-by", "HEAD");
			expect(r.out).toMatch(/^OK: /m);
			expect(r.out).not.toMatch(/GUARD-CHANGED/);
		});

		it("says nothing where the commit left a guard's bytes as anchored", () => {
			writeBaseline();
			write("scripts/guard-two.sh", "#!/bin/sh\necho reworded\n");
			commit("reword");
			run("--rebaseline", "--no-claim", "--only", "scripts/guard-two.sh");
			commit("re-anchor");
			expect(run("--touched-by", "HEAD~1").out).toMatch(/^OK: /m);
		});

		it("names a measured guard whose rule file the commit reworded, and through which file (#1914)", () => {
			write("scripts/guard-two.sh", '#!/bin/sh\necho "$(rule_text two)"\n');
			write("docs/agents/rules/two.txt", "Rule two.\n");
			writeBaseline();
			commit("anchor");
			write("docs/agents/rules/two.txt", "Rule two, reworded.\n");
			commit("reword the rule");
			const r = run("--touched-by", "HEAD");
			expect(r.status).toBe(0);
			expect(r.out).toMatch(/GUARD-CHANGED\s+scripts\/guard-two\.sh/);
			expect(r.out).toContain(
				"scripts/guard-two.sh (through docs/agents/rules/two.txt)",
			);
			expect(r.out).toContain("--rebaseline --only scripts/guard-two.sh");
			expect(r.out).not.toMatch(/guard-one\.sh/);
		});

		it("names a measured wrapper whose core the commit changed, and through which file (#3129)", () => {
			write(
				"scripts/guard-three.js",
				'const { decide } = require("./lib/three.js");\nrun({ decide });\n',
			);
			write(
				"scripts/lib/three.js",
				"module.exports = { decide: () => null };\n",
			);
			writeBaseline({
				guards: {
					...baseline().guards,
					"scripts/guard-three.js": {
						digest: "",
						verdict: "at need",
						selfSufficient: "yes",
					},
				},
			});
			run("--rebaseline", "--no-claim");
			commit("anchor");
			write(
				"scripts/lib/three.js",
				'module.exports = { decide: () => ({ deny: "no" }) };\n',
			);
			commit("change the core");
			const r = run("--touched-by", "HEAD");
			expect(r.out).toMatch(/GUARD-CHANGED\s+scripts\/guard-three\.js/);
			expect(r.out).toContain(
				"scripts/guard-three.js (through scripts/lib/three.js)",
			);
			expect(r.out).toContain("--rebaseline --only scripts/guard-three.js");
		});

		it("says nothing where the commit reworded a rule file no measured guard prints (#1914)", () => {
			write("docs/agents/rules/other.txt", "Another rule.\n");
			writeBaseline();
			commit("anchor");
			write("docs/agents/rules/other.txt", "Another rule, reworded.\n");
			commit("reword the rule");
			expect(run("--touched-by", "HEAD").out).toMatch(/^OK: /m);
		});

		it("names a measured guard the commit deleted", () => {
			writeBaseline();
			commit("anchor");
			git("rm", "-q", "scripts/guard-one.sh");
			git("commit", "-q", "-m", "retire");
			const r = run("--touched-by", "HEAD");
			expect(r.status).toBe(0);
			expect(r.out).toMatch(/GUARD-GONE\s+scripts\/guard-one\.sh/);
			expect(r.out).toContain(
				"scripts/guard-one.sh is gone: drop its row with  node scripts/check-instruction-surface.js --rebaseline --only scripts/guard-one.sh",
			);
			expect(r.out).not.toContain("feed it its payload");
		});

		it("is BROKEN beside --rebaseline", () => {
			writeBaseline();
			commit("anchor");
			const r = run("--rebaseline", "--no-claim", "--touched-by", "HEAD");
			expect(r.status).toBe(2);
			expect(r.out).toMatch(/does not combine with --rebaseline/);
		});

		it("is BROKEN past its ceiling, naming the git read it killed (#2210)", () => {
			writeBaseline();
			commit("anchor");
			write("scripts/guard-two.sh", "#!/bin/sh\necho reworded\n");
			commit("reword");
			// Crosses the real clock: the kill is execFileSync's own timeout. A
			// git that hangs on `show` alone lets diff-tree through, so the read
			// killed is one runTouched reaches only through rowsTouched.
			const hung = writeFaultyGit({ words: ["show"] }, { sleep: 30 });
			try {
				const r = runInProcess(
					SCRIPT,
					["--root", dir, "--touched-by", "HEAD"],
					{
						env: {
							...process.env,
							GITHUB_ACTIONS: "",
							WFC_GIT: hung.git,
							WFC_TOUCHED_BY_CEILING_MS: "1500",
						},
					},
				);
				expect(r.status).toBe(2);
				expect(`${r.stdout}${r.stderr}`).toContain(
					"--touched-by passed its 1.5s ceiling waiting on git show HEAD:scripts/guard-two.sh, and killed it",
				);
			} finally {
				fs.rmSync(hung.dir, { recursive: true, force: true });
			}
		});

		it("is BROKEN on a revision git cannot resolve", () => {
			writeBaseline();
			const r = run("--touched-by", "no-such-rev");
			expect(r.status).toBe(2);
			expect(r.out).toMatch(/git cannot list what no-such-rev changed/);
		});
	});
});

describe("when it cannot run at all", () => {
	it("is BROKEN with no baseline", () => {
		const r = run();
		expect(r.status).toBe(2);
		expect(r.out).toMatch(/BROKEN/);
	});

	it("is BROKEN on an unreadable baseline", () => {
		writeBaseline();
		write(BASELINE, "{ not json");
		expect(run().status).toBe(2);
	});

	it("is BROKEN on a baseline missing a section, and names it", () => {
		write(BASELINE, JSON.stringify({ measuredAt: {} }));
		const r = run();
		expect(r.status).toBe(2);
		expect(r.out).toMatch(
			/missing poolFiles, poolRules, hooks, hookCommands, skills, guards/,
		);
	});
});

describe("the json envelope", () => {
	it("carries the live and baselined figures side by side", () => {
		writeBaseline();
		write(".claude/settings.json", settings({ PreToolUse: 3, Stop: 1 }));
		const j = run("--json").json();
		expect(j.outcome).toBe("WARN");
		expect(j.hooks).toMatchObject({
			live: { total: 4 },
			baseline: { total: 3 },
		});
	});
});

describe("a git that will not answer (#3068)", () => {
	it("is BROKEN, never read as a tree that is no git repo", () => {
		writeBaseline();
		const exitsOne = path.join(dir, "git");
		fs.writeFileSync(exitsOne, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
		const r = runInProcess(SCRIPT, ["--root", dir, "--rebaseline"], {
			env: { ...process.env, GITHUB_ACTIONS: "", WFC_GIT: exitsOne },
		});
		expect(r.status).toBe(2);
		expect(`${r.stdout}${r.stderr}`).toMatch(/BROKEN[\s\S]*--git-dir failed/);
	});
});
