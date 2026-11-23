// @vitest-environment node

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineTemplate } from "./lib/git-fixture";
import { keptSpawn } from "./lib/kept-spawn.js";
import { runInProcess } from "./lib/run-in-process.js";
import { textModuleSource, writeTextModule } from "./lib/tracker-text-fixture";

const SCRIPT = path.resolve(__dirname, "check-context-budget.js");
const NEW_FAULTS = path.resolve(__dirname, "checker-new-faults.js");
const ROOT = path.resolve(__dirname, "..");

const SESSION_CAP = 34_000;

const RATCHET_CAP = 57_000;

const RULE_CAP = 4000;

const OVER_TARGET = SESSION_CAP + 1300;
const STAGED_FRAGMENT = 3500;
const OVER_N = Math.ceil(OVER_TARGET / (STAGED_FRAGMENT - 500));
const OVER_EACH = Math.ceil(OVER_TARGET / OVER_N);
const OVER_TOTAL = OVER_N * OVER_EACH;

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctxbudget-session-"));
	pool();
	injector();
	ruleCap(RULE_CAP);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const write = (rel: string, body: string) => {
	const abs = path.join(dir, rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, body);
	return abs;
};

function pool() {
	for (const rel of [
		"CLAUDE.md",
		"AGENTS.md",
		"docs/working-contract.md",
		".claude/output-styles/core-voice.md",
	])
		write(rel, "x\n");
}

function injector() {
	vi.stubEnv(
		"WFC_TRACKER_TEXT_FILE",
		writeTextModule(dir, textModuleSource("fixture.")),
	);
}

const ruleCap = (bytes: number) => {
	vi.stubEnv(
		"WFC_CAP_FILE",
		write("scripts/lib/hook-limits.js", `const RULE_CAP = ${bytes};\n`),
	);
};

const fragment = (id: string, bytes: number) =>
	write(`docs/agents/rules/${id}.txt`, "x".repeat(bytes));

const guard = (name: string, ids: string[]) =>
	write(
		`scripts/${name}`,
		`module.exports = () => ({ injectRules: [${ids.map((id) => `"${id}"`).join(", ")}] });\n`,
	);

const wiringJson = (wiring: Record<string, string[]>) =>
	JSON.stringify({
		hooks: {
			PreToolUse: Object.entries(wiring).map(([matcher, guards]) => ({
				matcher,
				hooks: guards.map((g) => ({
					command: `"$CLAUDE_PROJECT_DIR"/scripts/${g}`,
				})),
			})),
		},
	});

function settings(wiring: Record<string, string[]>, raw?: string) {
	write(".claude/settings.json", raw ?? wiringJson(wiring));
}

function selfPlugin(wiring: Record<string, string[]>) {
	write("self-plugin/hooks/hooks.json", wiringJson(wiring));
}

function group(matcher: string, n: number, bytes: number) {
	const names: string[] = [];
	for (let i = 0; i < n; i++) {
		fragment(`rule-${matcher.toLowerCase()}-${i}`, bytes);
		const name = `guard-${matcher.toLowerCase()}-${i}.js`;
		guard(name, [`rule-${matcher.toLowerCase()}-${i}`]);
		names.push(name);
	}
	return names;
}

function run(...args: string[]) {
	const r = runInProcess(SCRIPT, ["--root", dir, ...args]);
	return { ...r, json: () => JSON.parse(r.stdout) };
}

const tools = () => run("--json").json().session.tools;
const sessionFindings = () =>
	run("--json")
		.json()
		.findings.filter((f: { tag: string }) => f.tag === "OVER-SESSION");
const ratchetFindings = () =>
	run("--json")
		.json()
		.findings.filter((f: { tag: string }) => f.tag === "OVER-RATCHET");

const RATCHET_TOOLS = ["Bash", "Write", "Edit", "NotebookEdit", "Read"];

function ratchetTotal(total: number) {
	const perTool = Math.ceil(total / RATCHET_TOOLS.length);
	if (perTool >= SESSION_CAP)
		throw new Error(
			`ratchetTotal(${total}) puts ${perTool} B on one tool, at or over SESSION_CAP (${SESSION_CAP}) — widen RATCHET_TOOLS`,
		);
	const chunk = Math.floor(RULE_CAP / 2);
	const wire = (matcher: string, bytes: number) => {
		const names: string[] = [];
		for (let i = 0, left = bytes; left > 0; i++) {
			const size = Math.min(chunk, left);
			const id = `rule-${matcher.toLowerCase()}-${i}`;
			fragment(id, size);
			const name = `guard-${matcher.toLowerCase()}-${i}.js`;
			guard(name, [id]);
			names.push(name);
			left -= size;
		}
		return names;
	};
	const wiring: Record<string, string[]> = {};
	let left = total;
	for (const matcher of RATCHET_TOOLS) {
		const share = Math.min(perTool, left);
		wiring[matcher] = wire(matcher, share);
		left -= share;
	}
	settings(wiring);
	return total;
}

function direction(staged: unknown, baseline: unknown) {
	const at = fs.mkdtempSync(path.join(os.tmpdir(), "ctxbudget-direction-"));
	const file = (name: string, body: unknown) => {
		const abs = path.join(at, name);
		fs.writeFileSync(abs, JSON.stringify(body));
		return abs;
	};
	const r = runInProcess(
		NEW_FAULTS,
		[
			"context-budget",
			file("staged.json", staged),
			file("baseline.json", baseline),
		],
		{ cwd: ROOT },
	);
	fs.rmSync(at, { recursive: true, force: true });
	return { code: r.status, out: r.stdout };
}

describe("the per-session rule-emission cap", () => {
	it("prints the figure and passes while every group is under cap", () => {
		settings({ Bash: group("Bash", 2, 1000) });
		const r = run();
		expect(r.status).toBe(0);
		expect(r.stderr).toContain(
			"REACHABLE RULE TEXT PER SESSION, PER PreToolUse TOOL",
		);
		expect(r.stderr).toContain("2000 B  Bash");
		expect(r.stderr).toContain(
			"scripts/guard-bash-0.js (1 id over 1 injection)",
		);
	});

	it("carries the per-tool figures in --json", () => {
		settings({ Bash: group("Bash", 2, 1000) });
		const t = tools();
		expect(t.Bash.bytes).toBe(2000);
		expect(t.Bash.guards.map((g: { file: string }) => g.file)).toEqual([
			"scripts/guard-bash-0.js",
			"scripts/guard-bash-1.js",
		]);
		expect(run("--json").json().session.cap).toBe(SESSION_CAP);
	});

	it("warns, and only warns, on a group at or over the cap, recording the surface, its total and the cap", () => {
		settings({ Bash: group("Bash", OVER_N, OVER_EACH) });
		const [finding] = sessionFindings();
		expect(finding.severity).toBe("WARN");
		expect(finding.surface).toBe("session:Bash");
		expect(finding.total).toBe(OVER_TOTAL);
		expect(finding.cap).toBe(SESSION_CAP);
		expect(finding.message).toContain(`${OVER_TOTAL} B`);
	});

	it("headlines a group exactly on the cap as AT CAP, not OVER CAP", () => {
		ruleCap(SESSION_CAP + 1);
		fragment("rule-exact", SESSION_CAP);
		guard("guard-exact.js", ["rule-exact"]);
		settings({ Bash: ["guard-exact.js"] });
		const r = run("--notify");
		expect(r.stdout).toContain("PreToolUse BASH AT CAP");
		expect(r.stdout).toContain("landing exactly on it");
		expect(r.stdout).not.toContain("PreToolUse BASH OVER CAP");
		expect(sessionFindings()[0].over).toBe(0);
	});

	it("raises one finding per over-cap tool, not one for the worst", () => {
		settings({
			Bash: group("Bash", OVER_N, OVER_EACH),
			Write: group("Write", OVER_N, OVER_EACH),
		});
		expect(
			sessionFindings()
				.map((f: { surface: string }) => f.surface)
				.sort(),
		).toEqual(["session:Bash", "session:Write"]);
	});

	it("reports a matcher group with no emitters as zero, not as absent", () => {
		write("scripts/guard-silent.js", "module.exports = () => ({});\n");
		settings({ Bash: group("Bash", 1, 1000), Read: ["guard-silent.js"] });
		const t = tools();
		expect(Object.keys(t).sort()).toEqual(["Bash", "Read"]);
		expect(t.Read).toEqual({ bytes: 0, ids: [], guards: [] });
	});

	it("reads a core tree's wiring from its self-plugin file, then its settings (#2445, #2572)", () => {
		settings({ Bash: group("Write", 1, 100) });
		selfPlugin({ Bash: group("Bash", 2, 300) });
		expect(tools().Bash.bytes).toBe(700);
	});

	it("picks up a wholly new matcher group without any list being edited", () => {
		settings({ Bash: group("Bash", 1, 1000) });
		expect(Object.keys(tools())).toEqual(["Bash"]);
		settings({
			Bash: group("Bash", 1, 1000),
			NotebookEdit: group("NotebookEdit", 1, 1000),
		});
		expect(Object.keys(tools()).sort()).toEqual(["Bash", "NotebookEdit"]);
	});

	it("stays silent under --notify while every cap holds", () => {
		settings({ Bash: group("Bash", 2, 1000) });
		const r = run("--notify");
		expect(r.stdout.trim()).toBe("");
		expect(r.stderr.trim()).toBe("");
	});

	it("speaks under --notify once a group is over cap", () => {
		settings({ Bash: group("Bash", OVER_N, OVER_EACH) });
		expect(run("--notify").stdout).toContain("PreToolUse BASH OVER CAP");
	});
});

describe("a rule fragment over RULE_CAP on its own", () => {
	const fragmentFindings = () =>
		run("--json")
			.json()
			.findings.filter((f: { tag: string }) => f.tag === "OVER-FRAGMENT");

	it("warns, and only warns, rather than going BROKEN, recording the fragment, its total and the cap, and naming the guard", () => {
		fragment("rule-whale", RULE_CAP + 1);
		guard("guard-whale.js", ["rule-whale"]);
		settings({ Bash: ["guard-whale.js"] });
		const r = run("--json");
		expect(r.json().outcome).toBe("WARN");
		const [finding] = fragmentFindings();
		expect(finding.severity).toBe("WARN");
		expect(finding.surface).toBe("fragment:rule-whale");
		expect(finding.total).toBe(RULE_CAP + 1);
		expect(finding.cap).toBe(RULE_CAP);
		expect(finding.message).toContain("guard-whale.js");
	});

	it("excludes the over-cap fragment from the group it never reaches", () => {
		fragment("rule-whale", RULE_CAP + 1);
		fragment("rule-minnow", 10);
		guard("guard-whale.js", ["rule-whale", "rule-minnow"]);
		settings({ Bash: ["guard-whale.js"] });
		const t = tools();
		expect(t.Bash.bytes).toBe(10);
		expect(t.Bash.ids).toEqual(["rule-minnow"]);
	});

	it("names every guard that reaches the same over-cap fragment", () => {
		fragment("rule-whale", RULE_CAP + 1);
		guard("guard-a.js", ["rule-whale"]);
		guard("guard-b.js", ["rule-whale"]);
		settings({ Bash: ["guard-a.js"], Write: ["guard-b.js"] });
		expect(fragmentFindings()).toHaveLength(1);
		expect(fragmentFindings()[0].message).toContain("guard-a.js");
		expect(fragmentFindings()[0].message).toContain("guard-b.js");
	});

	it("speaks under --notify", () => {
		fragment("rule-whale", RULE_CAP + 1);
		guard("guard-whale.js", ["rule-whale"]);
		settings({ Bash: ["guard-whale.js"] });
		expect(run("--notify").stdout).toContain("RULE FRAGMENT OVER CAP");
	});
});

describe("a ctx.told that bounds nothing (mantahostels#2283)", () => {
	const latchFindings = () =>
		run("--json")
			.json()
			.findings.filter((f: { tag: string }) => f.tag === "DEAD-LATCH");

	const buildSplicerBody = (id: string, latch: string, mark = true) =>
		`\tconst text = ctx.ruleText("${id}");\n\tif (!ctx.told("${latch}")) return { context: text${mark ? `, latchAfter: "${latch}"` : ""} };\n`;
	const core = (body: string) => `module.exports = (ctx) => {\n${body}};\n`;
	const splicer = (name: string, id: string, latch: string, mark = true) =>
		write(`scripts/${name}`, core(buildSplicerBody(id, latch, mark)));

	it("warns on a latch naming an id no fragment answers to", () => {
		fragment("rule-real", 40);
		splicer("guard-typo.js", "rule-real", "rule-reel");
		settings({ Bash: ["guard-typo.js"] });
		const r = run("--json");
		expect(r.json().outcome).toBe("WARN");
		const [finding] = latchFindings();
		expect(finding.severity).toBe("WARN");
		expect(finding.surface).toBe("latch:scripts/guard-typo.js:rule-reel");
		expect(finding.message).toContain("no fragment answers to that id");
		expect(finding.message).toContain(
			"no direct accessor call on it is visible",
		);
	});

	it("hedges the marked limb the same way as the bound limb (mantahostels#2378)", () => {
		fragment("rule-real", 40);
		splicer("guard-unmarked.js", "rule-real", "rule-real", false);
		settings({ Bash: ["guard-unmarked.js"] });
		const r = run("--json");
		expect(r.json().outcome).toBe("WARN");
		const [finding] = latchFindings();
		expect(finding.severity).toBe("WARN");
		expect(finding.surface).toBe("latch:scripts/guard-unmarked.js:rule-real");
		expect(finding.message).not.toContain(
			"no direct accessor call on it is visible",
		);
		expect(finding.message).toContain(
			"no latchAfter decision on it is visible in that guard or the libs it sources",
		);
	});

	it("speaks under --notify, where the table does not", () => {
		fragment("rule-real", 40);
		splicer("guard-typo.js", "rule-real", "rule-reel");
		settings({ Bash: ["guard-typo.js"] });
		expect(run("--notify").stdout).toContain("DEAD RULE LATCH");
	});

	it("says nothing where the bound covers the guard's own call", () => {
		fragment("rule-real", 40);
		splicer("guard-clean.js", "rule-real", "rule-real");
		settings({ Bash: ["guard-clean.js"] });
		expect(latchFindings()).toEqual([]);
		expect(run("--json").json().session.direct.fragments[0].latched).toBe(
			"bounded",
		);
	});

	it("prices a guard's second, unlatched emission path per firing", () => {
		fragment("rule-split", 900);
		write(
			"scripts/guard-two-paths.js",
			core(
				'\tif (!ctx.told("rule-split"))\n\t\treturn { context: ctx.ruleText("rule-split"), latchAfter: "rule-split" };\n\treturn { deny: ctx.ruleText("rule-split") };\n',
			),
		);
		settings({ Bash: ["guard-two-paths.js"] });
		expect(latchFindings()).toEqual([]);
		expect(run("--json").json().session.direct.fragments[0].latched).toBe(
			"ambiguous",
		);
		expect(run().stderr).toContain("uncorrelatable");
	});

	const buildSelfComposerBody = (latch: string, mark: string) =>
		`\tif (!ctx.told("${latch}"))\n\t\treturn { context: "text this guard wrote itself", latchAfter: "${mark}" };\n`;
	const selfComposer = (name: string, latch: string, mark: string) =>
		write(`scripts/${name}`, core(buildSelfComposerBody(latch, mark)));

	it("says nothing where the guard composes the text it latches (mantahostels#2446)", () => {
		selfComposer("guard-self.js", "self-rule", "self-rule");
		settings({ Bash: ["guard-self.js"] });
		expect(latchFindings()).toEqual([]);
	});

	it("still catches a typo between the latch and its mark when self-composing (mantahostels#2446)", () => {
		selfComposer("guard-self-typo.js", "self-rule", "self-rlue");
		settings({ Bash: ["guard-self-typo.js"] });
		expect(run("--json").json().outcome).toBe("WARN");
		const [finding] = latchFindings();
		expect(finding.severity).toBe("WARN");
		expect(finding.surface).toBe("latch:scripts/guard-self-typo.js:self-rule");
		expect(finding.message).not.toContain("no fragment answers to that id");
		expect(finding.message).not.toContain(
			"no direct accessor call on it is visible",
		);
		expect(finding.message).toContain(
			"no latchAfter decision on it is visible",
		);
		expect(run("--notify").stdout).toContain(
			"the ctx.told id and the latchAfter one",
		);
	});

	it("still catches the mantahostels#2283 typo in a guard that also composes text of its own (mantahostels#2446)", () => {
		fragment("rule-real", 40);
		write(
			"scripts/guard-mixed.js",
			core(
				'\tconst text = ctx.ruleText("rule-real");\n\tif (!ctx.told("rule-reel"))\n\t\treturn { context: text + " and text of its own", latchAfter: "rule-reel" };\n',
			),
		);
		settings({ Bash: ["guard-mixed.js"] });
		expect(run("--json").json().outcome).toBe("WARN");
		const [finding] = latchFindings();
		expect(finding.severity).toBe("WARN");
		expect(finding.surface).toBe("latch:scripts/guard-mixed.js:rule-reel");
		expect(finding.message).toContain("no fragment answers to that id");
	});

	it("still catches that typo where the guard reaches the store through injectRules (mantahostels#2446)", () => {
		fragment("rule-real", 40);
		write(
			"scripts/guard-preemptive.js",
			core(
				'\tif (!ctx.told("rule-reel"))\n\t\treturn { context: "own", latchAfter: "rule-reel" };\n\treturn { injectRules: ["rule-real"] };\n',
			),
		);
		settings({ Bash: ["guard-preemptive.js"] });
		expect(run("--json").json().outcome).toBe("WARN");
		const [finding] = latchFindings();
		expect(finding.severity).toBe("WARN");
		expect(finding.surface).toBe("latch:scripts/guard-preemptive.js:rule-reel");
		expect(finding.message).toContain("no fragment answers to that id");
	});

	it("still catches a latch on a LIVE fragment the guard never fetches (mantahostels#2446)", () => {
		fragment("self-rule", 40);
		selfComposer("guard-forgot.js", "self-rule", "self-rule");
		settings({ Bash: ["guard-forgot.js"] });
		expect(run("--json").json().outcome).toBe("WARN");
		const [finding] = latchFindings();
		expect(finding.severity).toBe("WARN");
		expect(finding.surface).toBe("latch:scripts/guard-forgot.js:self-rule");
		expect(finding.message).toContain(
			"no direct accessor call on it is visible",
		);
	});

	it("passes a splicing guard's own self-composed latch (mantahostels#2470)", () => {
		fragment("rule-real", 40);
		write(
			"scripts/guard-both.js",
			core(
				`${buildSplicerBody("rule-real", "rule-real")}${buildSelfComposerBody("own-warning", "own-warning")}`,
			),
		);
		settings({ Bash: ["guard-both.js"] });
		expect(latchFindings()).toEqual([]);
	});

	it("misses a typo'd latch where the guard latches everything it splices (mantahostels#2470)", () => {
		fragment("rule-real", 40);
		fragment("rule-second", 40);
		write(
			"scripts/guard-gap.js",
			core(
				`${buildSplicerBody("rule-real", "rule-real")}${buildSelfComposerBody("rule-secnd", "rule-secnd")}`,
			),
		);
		settings({ Bash: ["guard-gap.js"] });
		expect(latchFindings()).toEqual([]);
	});

	const libSplicer = (id: string) =>
		write(
			"scripts/lib/splice.js",
			`exports.splice = (ctx) => ctx.ruleText("${id}");\n`,
		);
	const libCaller = (latch: string, lib = "./lib/splice.js") =>
		write(
			"scripts/guard-sourced.js",
			`const { splice } = require("${lib}");\n${core(`\tif (!ctx.told("${latch}"))\n\t\treturn { context: splice(ctx), latchAfter: "${latch}" };\n`)}`,
		);

	it("reports the mantahostels#2283 typo where the accessor sits in a sourced lib (mantahostels#2488)", () => {
		fragment("rule-real", 40);
		libSplicer("rule-real");
		libCaller("rule-reel");
		settings({ Bash: ["guard-sourced.js"] });
		const [finding] = latchFindings();
		expect(finding.severity).toBe("WARN");
		expect(finding.surface).toBe("latch:scripts/guard-sourced.js:rule-reel");
	});

	it("stops calling a lib-side accessor absent where the latch is right (mantahostels#2488)", () => {
		fragment("rule-real", 40);
		libSplicer("rule-real");
		libCaller("rule-real");
		settings({ Bash: ["guard-sourced.js"] });
		expect(latchFindings()).toEqual([]);
	});

	it("still misses the typo where the lib takes its id as an argument (mantahostels#2488)", () => {
		fragment("rule-real", 40);
		write(
			"scripts/lib/splice.js",
			"exports.splice = (ctx, id) => ctx.ruleText(id);\n",
		);
		libCaller("rule-reel");
		settings({ Bash: ["guard-sourced.js"] });
		expect(latchFindings()).toEqual([]);
	});

	it("never opens a lib path that escapes the repo root (mantahostels#2488)", () => {
		fragment("rule-real", 40);
		const outside = path.join(dir, "..", `outside-${path.basename(dir)}.js`);
		fs.writeFileSync(
			outside,
			'exports.splice = (ctx) => ctx.ruleText("rule-real");\n',
		);
		try {
			libCaller("rule-reel", `../../outside-${path.basename(dir)}.js`);
			settings({ Bash: ["guard-sourced.js"] });
			expect(latchFindings()).toEqual([]);
		} finally {
			fs.rmSync(outside, { force: true });
		}
	});

	it("reads a lib the lib it sources sources in turn (mantahostels#2488)", () => {
		fragment("rule-real", 40);
		write(
			"scripts/lib/inner.js",
			'exports.splice = (ctx) => ctx.ruleText("rule-real");\n',
		);
		write(
			"scripts/lib/splice.js",
			'exports.splice = require("./inner.js").splice;\n',
		);
		libCaller("rule-reel");
		settings({ Bash: ["guard-sourced.js"] });
		expect(latchFindings()[0].surface).toBe(
			"latch:scripts/guard-sourced.js:rule-reel",
		);
	});
});

describe("BROKEN, never a vacuous pass", () => {
	it("is BROKEN when a wired guard will not read, naming the guard", () => {
		settings({ Bash: ["guard-absent.js"] });
		const r = run("--json");
		expect(r.json().outcome).toBe("BROKEN");
		expect(r.json().summary).toContain("guard-absent.js");
	});

	it("is BROKEN when an injection names a fragment the store lacks", () => {
		guard("guard-bash-0.js", ["rule-missing"]);
		settings({ Bash: ["guard-bash-0.js"] });
		expect(run("--json").json().outcome).toBe("BROKEN");
	});

	it("is BROKEN when RULE_CAP cannot be read", () => {
		settings({ Bash: group("Bash", 1, 1000) });
		fs.rmSync(path.join(dir, "scripts", "lib", "hook-limits.js"));
		const r = run("--json");
		expect(r.json().outcome).toBe("BROKEN");
		expect(r.json().summary).toContain("RULE_CAP");
	});

	it("is BROKEN when .claude/settings.json will not parse, naming the file", () => {
		settings({}, "{ this is not json");
		const r = run("--json");
		expect(r.json().outcome).toBe("BROKEN");
		expect(r.json().summary).toContain(".claude/settings.json");
	});

	it("is BROKEN when the PreToolUse key is not a list, naming the key", () => {
		settings(
			{},
			JSON.stringify({ hooks: { PreToolUse: { matcher: "Bash" } } }),
		);
		const r = run("--json");
		expect(r.json().outcome).toBe("BROKEN");
		expect(r.json().summary).toContain("PreToolUse");
	});

	it("names the guard whose injection cannot be resolved", () => {
		guard("guard-bash-0.js", ["rule-missing"]);
		settings({ Bash: ["guard-bash-0.js"] });
		expect(run("--json").json().summary).toContain("scripts/guard-bash-0.js");
	});

	it("is not BROKEN when there is no settings file at all", () => {
		const r = run("--json");
		expect(r.json().outcome).toBe("OK");
		expect(r.json().session.tools).toEqual({});
	});

	it("needs no RULE_CAP source when nothing is wired on PreToolUse", () => {
		fs.rmSync(path.join(dir, "scripts", "lib", "hook-limits.js"));
		settings({});
		expect(run("--json").json().outcome).toBe("OK");
	});
});

describe("the direction gate over an over-cap group", () => {
	function envelope(bytes: number) {
		settings({ Bash: group("Bash", OVER_N, Math.round(bytes / OVER_N)) });
		return run("--json").json();
	}

	it("refuses a commit that raises an already-over-cap group, naming the group", () => {
		const baseline = envelope(OVER_TOTAL);
		const staged = envelope(OVER_TOTAL + 5000);
		const r = direction(staged, baseline);
		expect(r.code).toBe(1);
		expect(r.out).toContain("PreToolUse Bash");
	});

	it("passes an over-cap group this commit did not raise", () => {
		const baseline = envelope(OVER_TOTAL);
		const staged = envelope(OVER_TOTAL);
		expect(direction(staged, baseline).code).toBe(0);
	});

	it("passes a commit that sheds from an over-cap group", () => {
		const baseline = envelope(OVER_TOTAL + 5000);
		const staged = envelope(OVER_TOTAL);
		expect(direction(staged, baseline).code).toBe(0);
	});
});

describe("the direction gate over an over-cap fragment", () => {
	function envelope(bytes: number) {
		fragment("rule-whale", bytes);
		guard("guard-whale.js", ["rule-whale"]);
		settings({ Bash: ["guard-whale.js"] });
		return run("--json").json();
	}

	it("refuses a commit that grows an already-over-cap fragment, naming the fragment", () => {
		const baseline = envelope(RULE_CAP + 100);
		const staged = envelope(RULE_CAP + 200);
		const r = direction(staged, baseline);
		expect(r.code).toBe(1);
		expect(r.out).toContain('"rule-whale"');
	});

	it("passes an over-cap fragment this commit did not grow", () => {
		const baseline = envelope(RULE_CAP + 100);
		const staged = envelope(RULE_CAP + 100);
		expect(direction(staged, baseline).code).toBe(0);
	});

	it("passes a commit that shrinks an over-cap fragment", () => {
		const baseline = envelope(RULE_CAP + 200);
		const staged = envelope(RULE_CAP + 100);
		expect(direction(staged, baseline).code).toBe(0);
	});
});

describe("the profile's measurement of a session surface", () => {
	const { PROFILES } = require("./lib/fault-profiles.js") as {
		PROFILES: Record<
			string,
			{ measure: (item: object, key: string, envelope: unknown) => unknown }
		>;
	};

	it("reads the tool's bytes out of the envelope", () => {
		settings({ Bash: group("Bash", OVER_N, OVER_EACH) });
		const envelope = run("--json").json();
		const [finding] = sessionFindings();
		expect(
			PROFILES["context-budget"].measure(finding, "findings", envelope),
		).toBe(OVER_TOTAL);
	});

	it("measures nothing for a surface no envelope key carries", () => {
		settings({ Bash: group("Bash", 1, 1000) });
		const envelope = run("--json").json();
		expect(
			PROFILES["context-budget"].measure(
				{ surface: "session:Nonesuch" },
				"findings",
				envelope,
			),
		).toBeUndefined();
		expect(
			PROFILES["context-budget"].measure(
				{ tag: "UNPARSEABLE-SETTINGS" },
				"findings",
				envelope,
			),
		).toBeUndefined();
	});

	it("reads an over-cap fragment's bytes out of the envelope", () => {
		fragment("rule-whale", RULE_CAP + 1);
		guard("guard-whale.js", ["rule-whale"]);
		settings({ Bash: ["guard-whale.js"] });
		const envelope = run("--json").json();
		expect(
			PROFILES["context-budget"].measure(
				{ surface: "fragment:rule-whale" },
				"findings",
				envelope,
			),
		).toBe(RULE_CAP + 1);
		expect(
			PROFILES["context-budget"].measure(
				{ surface: "fragment:no-such-id" },
				"findings",
				envelope,
			),
		).toBeUndefined();
	});

	it("reads the baseline half for a fragment that has not yet breached", () => {
		fragment("rule-whale", RULE_CAP - 1);
		guard("guard-whale.js", ["rule-whale"]);
		settings({ Bash: ["guard-whale.js"] });
		const before = run("--json").json();
		expect(before.session.overCap).toEqual([]);
		expect(
			PROFILES["context-budget"].measure(
				{ surface: "fragment:rule-whale" },
				"findings",
				before,
			),
		).toBe(RULE_CAP - 1);

		fragment("rule-whale", RULE_CAP + 1);
		const after = run("--json").json();
		expect(
			PROFILES["context-budget"].measure(
				{ surface: "fragment:rule-whale" },
				"findings",
				after,
			),
		).toBe(RULE_CAP + 1);
	});
});

describe("--against HEAD over a guard's own bytes", () => {
	function git(...args: string[]) {
		const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
		if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
		return r.stdout;
	}

	function gate(...args: string[]) {
		const r = keptSpawn("fd").spawnSync(
			"node",
			[SCRIPT, "--against", "HEAD", ...args],
			{
				cwd: dir,
				encoding: "utf8",
				env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
			},
		);
		return { ...r, json: () => JSON.parse(r.stdout) };
	}

	const mainRepo = defineTemplate((at) => {
		for (const args of [
			["init", "-q", "-b", "main"],
			["config", "user.email", "t@example.invalid"],
			["config", "user.name", "t"],
		])
			execFileSync("git", args, { cwd: at });
	});

	beforeEach(() => {
		mainRepo.instantiate(dir);
	});

	function baseline() {
		git("add", "-A");
		git("commit", "-q", "--no-verify", "-m", "baseline");
	}

	function stageFragment(id: string, bytes: number) {
		fragment(id, bytes);
		git("add", "--", `docs/agents/rules/${id}.txt`);
	}

	it("passes a rise that leaves the group inside its cap", () => {
		settings({ Bash: group("Bash", 2, 500) });
		baseline();
		stageFragment("rule-bash-0", 1200);
		const r = gate("--json");
		expect(r.json().added).toEqual([]);
		expect(r.status).toBe(0);
	});

	it("refuses a commit that grows an already-over-cap group, naming the group, its size at HEAD and the bytes added", () => {
		settings({ Bash: group("Bash", OVER_N, OVER_EACH) });
		baseline();
		stageFragment("rule-bash-0", STAGED_FRAGMENT);
		const r = gate("--json");
		expect(r.status).not.toBe(0);
		expect(JSON.stringify(r.json().added)).toContain("PreToolUse Bash");
		expect(gate().stderr).toContain(
			`HEAD had ${OVER_TOTAL} B, so this commit adds ${STAGED_FRAGMENT - OVER_EACH} B.`,
		);
	});

	it("refuses a growth a core tree wires from its self-plugin file (#2445)", () => {
		settings({});
		selfPlugin({ Bash: group("Bash", OVER_N, OVER_EACH) });
		baseline();
		stageFragment("rule-bash-0", STAGED_FRAGMENT);
		const r = gate("--json");
		expect(r.status).not.toBe(0);
		expect(JSON.stringify(r.json().added)).toContain("PreToolUse Bash");
	});

	it("refuses a commit whose group first crosses SESSION_CAP, naming the group, its size at HEAD and the bytes added", () => {
		const n = Math.ceil((SESSION_CAP - 200) / (RULE_CAP - 750 - 1));
		const each = Math.floor((SESSION_CAP - 200) / n);
		const staged = each + 750;
		expect(staged, "the staged fragment must stay under RULE_CAP").toBeLessThan(
			RULE_CAP,
		);
		expect(n * each, "HEAD's group must start UNDER the cap").toBeLessThan(
			SESSION_CAP,
		);
		expect(n * each + 750, "the commit must cross it").toBeGreaterThan(
			SESSION_CAP,
		);
		settings({ Bash: group("Bash", n, each) });
		baseline();
		stageFragment("rule-bash-0", staged);
		const r = gate("--json");
		expect(r.status).toBe(1);
		expect(JSON.stringify(r.json().added)).toContain("PreToolUse Bash");
		expect(gate().stderr).toContain(
			`HEAD had ${n * each} B, so this commit adds ${staged - each} B.`,
		);
	});

	function gatedCrossing(modules: string[]) {
		vi.stubEnv("WFC_MODULES", undefined);
		const gated = 3000;
		const plainTotal = SESSION_CAP - 13 - gated;
		const n = Math.ceil(plainTotal / (RULE_CAP - 26 - 1));
		const each = Math.floor(plainTotal / n);
		const base = n * each + gated;
		expect(
			each + 26,
			"the staged fragment must stay under RULE_CAP",
		).toBeLessThan(RULE_CAP);
		expect(base, "HEAD's group must start UNDER the cap").toBeLessThan(
			SESSION_CAP,
		);
		expect(base + 26, "the commit must cross it").toBeGreaterThan(SESSION_CAP);
		const plain = group("Bash", n, each);
		fragment("rule-gated", gated);
		write(
			"scripts/guard-gated.js",
			'module.exports = (ctx) => ({\n\tinjectRules: ["rule-gated"],\n\tskip: [\n\t\t...ruleModule(ctx, "site", ["rule-gated"]),\n\t],\n});\n',
		);
		write(
			".claude/workflow-core.json",
			JSON.stringify({ contract: 1, modules }),
		);
		settings({ Bash: [...plain, "guard-gated.js"] });
		baseline();
		stageFragment("rule-bash-0", each + 26);
		return base;
	}

	it("refuses a crossing whose bytes include a module-gated id, naming the group, its size at HEAD and the bytes added", () => {
		const base = gatedCrossing(["site"]);
		expect(
			sessionFindings().map((f: { total: number }) => f.total),
			"the level run must see the crossing",
		).toEqual([base + 26]);
		const r = gate("--json");
		expect(r.status).toBe(1);
		expect(JSON.stringify(r.json().added)).toContain("PreToolUse Bash");
		expect(gate().stderr).toContain(
			`HEAD had ${base} B, so this commit adds 26 B.`,
		);
	});

	it("passes the same commit where the config has the module off", () => {
		gatedCrossing([]);
		expect(sessionFindings()).toEqual([]);
		const r = gate("--json");
		expect(r.json().added).toEqual([]);
		expect(r.status).toBe(0);
	});

	it("refuses a commit whose fragment first crosses RULE_CAP, naming the fragment, its size at HEAD and the bytes added", () => {
		fragment("rule-whale", RULE_CAP - 100);
		guard("guard-whale.js", ["rule-whale"]);
		fragment("rule-dummy", 200);
		guard("guard-dummy.js", ["rule-dummy"]);
		settings({ Bash: ["guard-whale.js", "guard-dummy.js"] });
		baseline();
		stageFragment("rule-whale", RULE_CAP + 100);
		const r = gate("--json");
		expect(r.status).toBe(1);
		expect(JSON.stringify(r.json().added)).toContain("rule-whale");
		expect(gate().stderr).toContain(
			`HEAD had ${RULE_CAP - 100} B, so this commit adds 200 B.`,
		);
	});

	it("passes a fragment this commit leaves under RULE_CAP", () => {
		fragment("rule-whale", RULE_CAP - 100);
		guard("guard-whale.js", ["rule-whale"]);
		settings({ Bash: ["guard-whale.js"] });
		baseline();
		stageFragment("rule-whale", RULE_CAP - 50);
		const r = gate("--json");
		expect(r.status).toBe(0);
		expect(r.json().added).toEqual([]);
	});

	it("refuses a commit that wires another guard onto an over-cap group, naming the new total", () => {
		const wired = group("Bash", OVER_N, OVER_EACH);
		settings({ Bash: wired });
		baseline();
		fragment("rule-extra", 2000);
		guard("guard-extra.js", ["rule-extra"]);
		settings({ Bash: [...wired, "guard-extra.js"] });
		git("add", "--", ".claude/settings.json");
		git("add", "--", "scripts/guard-extra.js");
		git("add", "--", "docs/agents/rules/rule-extra.txt");
		const r = gate("--json");
		expect(r.status).not.toBe(0);
		expect(JSON.stringify(r.json().added)).toContain(`${OVER_TOTAL + 2000} B`);
	});

	it("passes an over-cap group the commit leaves alone", () => {
		settings({ Bash: group("Bash", OVER_N, OVER_EACH) });
		baseline();
		fs.writeFileSync(path.join(dir, "CLAUDE.md"), "xx\n");
		git("add", "--", "CLAUDE.md");
		const r = gate("--json");
		expect(r.json().added).toEqual([]);
		expect(r.status).toBe(0);
	});

	it("passes a commit that sheds from an over-cap group", () => {
		settings({ Bash: group("Bash", OVER_N, OVER_EACH) });
		baseline();
		stageFragment("rule-bash-0", 500);
		const r = gate("--json");
		expect(r.json().added).toEqual([]);
		expect(r.status).toBe(0);
	});

	it("reads each side's dispatcher cores from that side's own manifest (#2924)", () => {
		const manifest = (cores: string[]) =>
			write(
				"scripts/lib/guard-cores.json",
				JSON.stringify({
					PreToolUse: cores.map((core) => ({
						name: core,
						core,
						tools: "Bash",
						failure: "open",
					})),
				}),
			);
		settings({ Bash: ["guard-dispatch.js"] });
		write("scripts/guard-dispatch.js", "");
		fragment("rule-bash-0", 500);
		write("scripts/lib/core-a.js", 'ctx.ruleText("rule-bash-0");\n');
		manifest(["core-a.js"]);
		baseline();
		manifest(["core-a.js", "core-unwritten.js"]);
		stageFragment("rule-bash-0", 600);
		const r = gate("--json");
		expect(r.stderr).not.toContain("BROKEN");
		expect(r.status).toBe(0);
	});
});

describe("the shared rule-emission ratchet", () => {
	it("passes and reports the cap and the summed total while under cap", () => {
		const total = ratchetTotal(RATCHET_CAP - 1);
		expect(ratchetFindings()).toEqual([]);
		expect(run("--json").json().session.ratchet).toEqual({
			cap: RATCHET_CAP,
			total,
		});
	});

	it("warns on the union across tools even though no single tool is over SESSION_CAP, recording the ratchet, its total and the cap", () => {
		const total = ratchetTotal(RATCHET_CAP + 2);
		expect(sessionFindings()).toEqual([]);
		const [finding] = ratchetFindings();
		expect(finding.surface).toBe("rule-ratchet");
		expect(finding.total).toBe(total);
		expect(finding.cap).toBe(RATCHET_CAP);
	});

	it("counts an id reachable from several tools once, not once per tool", () => {
		fragment("rule-shared", 1000);
		guard("guard-shared.js", ["rule-shared"]);
		settings({ Write: ["guard-shared.js"], Edit: ["guard-shared.js"] });
		expect(run("--json").json().session.ratchet.total).toBe(1000);
	});

	it("raises exactly one finding for the ratchet, not one per tool", () => {
		ratchetTotal(RATCHET_CAP + 2);
		expect(ratchetFindings()).toHaveLength(1);
	});

	it("headlines a ratchet exactly on the cap as AT CAP, not OVER CAP", () => {
		ratchetTotal(RATCHET_CAP);
		const r = run("--notify");
		expect(r.stdout).toContain("RULE-EMISSION RATCHET AT CAP");
		expect(r.stdout).toContain("landing exactly on it");
		expect(r.stdout).not.toContain("RATCHET OVER CAP");
		expect(ratchetFindings()[0].over).toBe(0);
	});
});

describe("the direction gate over the shared ratchet", () => {
	const over = RATCHET_CAP + 1;
	const higher = over + RATCHET_TOOLS.length * Math.floor(RULE_CAP / 2);
	const ratchetEnvelope = (total: number) => {
		ratchetTotal(total);
		return run("--json").json();
	};

	it("refuses a commit that raises an already-over-ratchet total, naming it as the total unioned across every tool", () => {
		const baseline = ratchetEnvelope(over);
		const staged = ratchetEnvelope(higher);
		const r = direction(staged, baseline);
		expect(r.code).toBe(1);
		expect(r.out).toContain("unioned across every tool");
	});

	it("passes an over-ratchet total this commit did not raise", () => {
		const baseline = ratchetEnvelope(over);
		const staged = ratchetEnvelope(over);
		expect(direction(staged, baseline).code).toBe(0);
	});

	it("passes a commit that sheds from an over-ratchet total", () => {
		const baseline = ratchetEnvelope(higher);
		const staged = ratchetEnvelope(over);
		expect(direction(staged, baseline).code).toBe(0);
	});
});

describe("this repo's own figures", () => {
	const live = (): {
		session: { tools: Record<string, unknown> };
		findings: { tag: string; surface: string }[];
	} =>
		JSON.parse(
			runInProcess(SCRIPT, ["--root", ROOT, "--json"], {
				env: {
					...process.env,
					CLAUDE_PROJECT_DIR: ROOT,
					WFC_MODULES: undefined,
				},
			}).stdout,
		);

	it("agrees with its own arithmetic on every group", () => {
		const j = live();
		const over = Object.entries(j.session.tools)
			.filter(([, g]) => (g as { bytes: number }).bytes >= SESSION_CAP)
			.map(([tool]) => `session:${tool}`)
			.sort();
		const raised = j.findings
			.filter((f: { tag: string }) => f.tag === "OVER-SESSION")
			.map((f: { surface: string }) => f.surface)
			.sort();
		expect(raised).toEqual(over);
		for (const g of Object.values(j.session.tools) as {
			bytes: number;
			ids: string[];
			guards: { bytes: number; ids: string[] }[];
		}[]) {
			expect(g.bytes).toBeLessThanOrEqual(
				g.guards.reduce((n, x) => n + x.bytes, 0),
			);
			expect(new Set(g.ids).size).toBe(g.ids.length);
		}
	});

	it("is under the session cap on every PreToolUse tool", () => {
		const j = live();
		const over = Object.entries(j.session.tools)
			.filter(([, g]) => (g as { bytes: number }).bytes >= SESSION_CAP)
			.map(([tool, g]) => `${tool} at ${(g as { bytes: number }).bytes} B`);
		expect(over).toEqual([]);
	});
});

describe("rule text a hook hands over after its call (#2144)", () => {
	const latched = (id: string) =>
		`module.exports = (ctx) => {\n\tif (ctx.told("${id}")) return {};\n\treturn { context: ctx.ruleText("${id}"), latchAfter: "${id}" };\n};\n`;
	const unlatched = (id: string) =>
		`module.exports = (ctx) => ({ context: ctx.ruleText("${id}") });\n`;

	beforeEach(() => {
		fragment("rule-written", 600);
		fragment("rule-failed", 400);
		write("scripts/post-latched.js", latched("rule-written"));
		write("scripts/post-unlatched.js", unlatched("rule-failed"));
		const hook = (matcher: string, script: string) => ({
			matcher,
			hooks: [{ command: `"$CLAUDE_PROJECT_DIR"/scripts/${script}` }],
		});
		settings(
			{},
			JSON.stringify({
				hooks: {
					PostToolUse: [hook("Write|Edit", "post-latched.js")],
					PostToolUseFailure: [hook("Bash", "post-unlatched.js")],
				},
			}),
		);
	});

	it("prices a latched id once a session and an unlatched one per firing", () => {
		const r = run("--json").json();
		expect(r.outcome).toBe("OK");
		expect(r.afterCall.once).toEqual({ bytes: 600, ids: ["rule-written"] });
		expect(r.afterCall.hooks).toEqual([
			{
				event: "PostToolUse",
				matcher: "Write|Edit",
				file: "scripts/post-latched.js",
				once: { bytes: 600, ids: ["rule-written"] },
				perFire: [],
			},
			{
				event: "PostToolUseFailure",
				matcher: "Bash",
				file: "scripts/post-unlatched.js",
				once: { bytes: 0, ids: [] },
				perFire: [{ id: "rule-failed", bytes: 400 }],
			},
		]);
	});

	it("puts none of it on route (f)'s figures", () => {
		const { session } = run("--json").json();
		expect(session.tools).toEqual({});
		expect(session.ratchet.total).toBe(0);
	});

	it("warns on an after-call latch no latchAfter decision sets", () => {
		write(
			"scripts/post-latched.js",
			latched("rule-written").replace(/, latchAfter: "[^"]+"/, ""),
		);
		const dead = run("--json")
			.json()
			.findings.filter((f: { tag: string }) => f.tag === "DEAD-LATCH");
		expect(
			dead.map((f: { message: string }) => f.message).join("\n"),
		).toContain("scripts/post-latched.js");
	});

	it("says in the table that it is uncapped and why", () => {
		const out = run().stderr;
		expect(out).toContain(
			"RULE TEXT AFTER A CALL — 600 B once a session across 1, and 400 B paid on every firing across 1. Uncapped.",
		);
		expect(out).toContain("no cap of its own");
	});
});
