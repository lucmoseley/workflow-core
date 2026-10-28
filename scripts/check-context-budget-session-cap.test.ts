// @vitest-environment node
/*
 * The session cap — check-context-budget.js's OVER-SESSION assertion (mantahostels#2004
 * built it per event, mantahostels#2046 re-based it on the session), which prices the rule
 * text ONE SESSION can be made to pay through a single PreToolUse tool against
 * docs/doc-map.md §Capture and placement §3 route (f).
 *
 * A FILE OF ITS OWN, and not check-context-budget.test.ts's tail: every fixture
 * here wires hooks, which none of that file's do.
 *
 * Pinned here is the cap's BEHAVIOUR, not its value (mantahostels#1224).
 *
 * The checker runs in process over fabricated settings and guards under a
 * throwaway --root, so a guard edited by anyone moves no case; `--against
 * HEAD` is spawned, since it re-execs itself over two materialised trees.
 *
 * .husky/pre-commit runs it under `--against HEAD`, which refuses a commit
 * raising an over-cap group: loosen a case and a guard can grow the rule text
 * every session pays on one tool past the cap unrefused.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	onTestFinished,
} from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "check-context-budget.js");
const NEW_FAULTS = path.resolve(__dirname, "checker-new-faults.js");
const ROOT = path.resolve(__dirname, "..");

/* Mirrors check-context-budget.js's own constant. Restated rather than
 * imported, so that moving the cap is a visible edit on both sides. */
const SESSION_CAP = 31_500;

/* Route (f)'s second axis — the shared ratchet summed across every tool
 * (mantahostels#1787, mantahostels#2046). Mirrors
 * check-context-budget.js's own constant, for the same reason as SESSION_CAP
 * above. No fixture below writes its VALUE out (mantahostels#2223). */
const RATCHET_CAP = 51_500;

/* The RULE_CAP ceiling the fixtures run under, shared by the beforeEach that
 * writes it and by ratchetTotal's chunking, which must stay under it. */
const RULE_CAP = 4000;

/* An OVER-CAP group, sized off SESSION_CAP rather than written out, so moving
 * the cap cannot leave these fixtures landing UNDER it — where the gate is
 * right to pass and the case silently stops testing anything (mantahostels#2493 found that
 * happening once; mantahostels#2497 moved the cap again and it happened to six cases).
 *
 * 1,300 B clear of the cap: enough that a fixture staging one more fragment
 * (STAGED_FRAGMENT below) is unambiguously over, and little enough that
 * OVER_TOTAL plus the raised envelope's 5,000 B stays UNDER RATCHET_CAP — past
 * that the direction-gate cases would silently start exercising the ratchet as
 * well. */
const OVER_TARGET = SESSION_CAP + 1300;
/* The fragment one case stages over an over-cap group's first fragment, so it
 * must outgrow OVER_EACH; it stays under RULE_CAP, a separate fault. */
const STAGED_FRAGMENT = 3500;
/* The fragment COUNT is sized off the cap too, leaving each fragment at least
 * 500 B under STAGED_FRAGMENT. A fixed count broke when #2023 moved the cap
 * from 24,900 B to 31,500 B. */
const OVER_N = Math.ceil(OVER_TARGET / (STAGED_FRAGMENT - 500));
const OVER_EACH = Math.ceil(OVER_TARGET / OVER_N);
const OVER_TOTAL = OVER_N * OVER_EACH;

let dir: string;

const savedEnv: { capFile?: string; injectorFile?: string } = {};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctxbudget-session-"));
	savedEnv.capFile = process.env.WFC_CAP_FILE;
	savedEnv.injectorFile = process.env.WFC_INJECTOR_FILE;
	pool();
	injector();
	ruleCap(RULE_CAP);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
	if (savedEnv.capFile === undefined) delete process.env.WFC_CAP_FILE;
	else process.env.WFC_CAP_FILE = savedEnv.capFile;
	if (savedEnv.injectorFile === undefined) delete process.env.WFC_INJECTOR_FILE;
	else process.env.WFC_INJECTOR_FILE = savedEnv.injectorFile;
});

const write = (rel: string, body: string) => {
	const abs = path.join(dir, rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, body);
	return abs;
};

/** The four always-loaded pool files, small enough that the pool cap is silent. */
function pool() {
	for (const rel of [
		"CLAUDE.md",
		"AGENTS.md",
		"docs/working-contract.md",
		".claude/output-styles/core-voice.md",
	])
		write(rel, "x\n");
}

/*
 * check-context-budget.js reads the injector and the RULE_CAP file off the
 * core's own location, never off --root (#36), so a fixture copy has to be
 * pointed at through the WFC_INJECTOR_FILE / WFC_CAP_FILE test-injection seams
 * (`lib/host-root.js`'s header convention) rather than written under `dir`
 * where nothing reads it any more.
 */

/** An injector the injection cap reads as near-empty, so only the session cap speaks. */
function injector() {
	process.env.WFC_INJECTOR_FILE = write(
		"scripts/inject-tracker-docs.sh",
		'#!/usr/bin/env bash\nDOCS=()\nmatched=""\nheader="fixture."\n',
	);
}

/** The file the ceiling is read out of, never defaulted (rule-emission.js). */
const ruleCap = (bytes: number) => {
	process.env.WFC_CAP_FILE = write(
		"scripts/lib/hook-limits.sh",
		`RULE_CAP=${bytes}\n`,
	);
};

/** A rule fragment of exactly `bytes`, as a guard entry would resolve it. */
const fragment = (id: string, bytes: number) =>
	write(`docs/agents/rules/${id}.txt`, "x".repeat(bytes));

/** A core whose single injection names `ids`. */
const guard = (name: string, ids: string[]) =>
	write(
		`scripts/${name}`,
		`module.exports = () => ({ injectRules: [${ids.map((id) => `"${id}"`).join(", ")}] });\n`,
	);

/** A hooks file wiring each matcher to its guards, PreToolUse. */
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

/** `.claude/settings.json` wiring each matcher to its guards: an adopter's tree. */
function settings(wiring: Record<string, string[]>, raw?: string) {
	write(".claude/settings.json", raw ?? wiringJson(wiring));
}

/** The self-plugin's file wiring each matcher to its guards: a core tree (#2445). */
function selfPlugin(wiring: Record<string, string[]>) {
	write("self-plugin/hooks/hooks.json", wiringJson(wiring));
}

/**
 * `n` guards on one matcher, each emitting `bytes`, so a group's total is
 * `n * bytes` and the fixture can be aimed at either side of the cap.
 */
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

/* The tools ratchetTotal spreads a total across. Five rather than two so the
 * helper's own ceiling — SESSION_CAP per tool — sits far above any figure
 * mantahostels#2223 could re-seed to. */
const RATCHET_TOOLS = ["Bash", "Write", "Edit", "NotebookEdit", "Read"];

/**
 * Wire `total` bytes of distinct ids spread across RATCHET_TOOLS, so the shared
 * ratchet sees the whole figure while no single tool approaches SESSION_CAP and
 * no id de-duplicates against another. Returns `total` unchanged, so a caller
 * can assert the checker's own figure against the one it asked for.
 */
function ratchetTotal(total: number) {
	const perTool = Math.ceil(total / RATCHET_TOOLS.length);
	if (perTool >= SESSION_CAP)
		throw new Error(
			`ratchetTotal(${total}) puts ${perTool} B on one tool, at or over SESSION_CAP (${SESSION_CAP}) — widen RATCHET_TOOLS`,
		);
	/* Chunked under RULE_CAP, which truncates a single injection: one
	 * fragment carrying a whole tool's share would be counted at the ceiling
	 * instead, and the union would come in short of the figure asked for. */
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

/* A real spawn: what is under test is checker-new-faults.js's CLI entry, which
 * reads two envelope FILES off argv — the shape lib/check.js invokes. Its
 * PROFILES export is exercised in-process where that suffices instead. Shared
 * by both direction-gate describes below, over the session surface and the
 * ratchet surface, so there is one spawn site to justify rather than two. */
function direction(staged: unknown, baseline: unknown) {
	const at = fs.mkdtempSync(path.join(os.tmpdir(), "ctxbudget-direction-"));
	const file = (name: string, body: unknown) => {
		const abs = path.join(at, name);
		fs.writeFileSync(abs, JSON.stringify(body));
		return abs;
	};
	const r = spawnSync(
		"node",
		[
			NEW_FAULTS,
			"context-budget",
			file("staged.json", staged),
			file("baseline.json", baseline),
		],
		{ encoding: "utf8", cwd: ROOT },
	);
	fs.rmSync(at, { recursive: true, force: true });
	return { code: r.status ?? -1, out: r.stdout ?? "" };
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

	/* "0 B over" would read as a rounding artefact (mantahostels#1940), and a cap the gate
	 * misses by one byte never fires on the commit that lands on it. */
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

	/* Spec mantahostels#1932's story 23: a group that has lost its last emitter is a fact
	 * worth seeing,
	 * and an absent key reads as "no such tool" rather than "nothing left". */
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

	/* Derived, not declared: nothing in the checker lists the tools. */
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
		/* stdout under --notify: the SessionStart hook reads that stream (mantahostels#1834). */
		expect(run("--notify").stdout).toContain("PreToolUse BASH OVER CAP");
	});
});

/*
 * A fragment over RULE_CAP on its own (mantahostels#2054): the repo's own
 * rule text, not this checker's apparatus, so it is a finding rather than
 * BROKEN.
 */
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

	/** A guard splicing `id` itself, latched on `latch`, marking told unless `mark` is false. */
	/* The fetch is EMITTED, not merely made: the bound is correlated against
	 * the emission that spends the bytes (mantahostels#2354), so a guard that fetches and
	 * says nothing has no bound to credit. */
	const buildSplicerBody = (id: string, latch: string, mark = true) =>
		`\tconst text = ctx.ruleText("${id}");\n\tif (!ctx.told("${latch}")) return { context: text${mark ? `, latchAfter: "${latch}"` : ""} };\n`;
	/** A core whose handler body is `body`. */
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
		// Every failing limb, never the first: naming one of two repairs sends the
		// reader to fix half of it.
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
		// The bound limb resolves clean here (a direct ctx.ruleText call on the
		// same id), so only the marked limb's hedge should show.
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

	/** A guard composing its own warning and latching THAT — no fragment, no
	 * accessor — latched on `latch` and marked on `mark` (mantahostels#2446). */
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
		// The two store-facing limbs are inapplicable here and must not send the
		// reader after a fragment the guard is right not to have.
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
		// One accessor call is enough to keep the store-facing limbs live.
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
		// No direct accessor call anywhere, so the direct census is empty — but
		// injectRules reaches the store.
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
		// Byte for byte the self-composing guard above, but a fragment now answers
		// to its latch id — the "meant to splice it, forgot the accessor call"
		// fault, where the fragment is never emitted. This is the case the
		// `!resolves` conjunct keeps reported.
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

	/*
	 * THE ORPHAN-SPLICE SIGNAL, which decides per id whether a latch that
	 * resolves to nothing and binds to nothing is a typo or self-composed text
	 * (mantahostels#2470). Its own gap is pinned below.
	 */

	it("passes a splicing guard's own self-composed latch (mantahostels#2470)", () => {
		fragment("rule-real", 40);
		/* One guard doing both: it splices `rule-real` under a latch that covers
		 * it, and separately latches `own-warning`, text it composes itself. Every
		 * id it fetches is latched, so there is no orphan splice for `own-warning`
		 * to be a typo of and the second latch is left alone. */
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
		// The live fragment the misspelt latch below was meant for, and which this
		// guard never fetches — what makes it a typo rather than a chosen name.
		fragment("rule-second", 40);
		/* The gap taken in exchange for the test above: with no orphan splice,
		 * `rule-secnd` reads as self-composed and its stranded fragment is never
		 * reported. Closing it needs the latch to declare what it bounds. */
		write(
			"scripts/guard-gap.js",
			core(
				`${buildSplicerBody("rule-real", "rule-real")}${buildSelfComposerBody("rule-secnd", "rule-secnd")}`,
			),
		);
		settings({ Bash: ["guard-gap.js"] });
		expect(latchFindings()).toEqual([]);
	});

	/* THE SOURCED-LIB SHAPE (mantahostels#2488). The relative `require` below is the
	 * real cores' spelling, so these fixtures exercise the resolution the repo
	 * actually needs rather than a shorthand of it. */

	/** A lib whose one function fetches `id` for its caller to emit. */
	const libSplicer = (id: string) =>
		write(
			"scripts/lib/splice.js",
			`exports.splice = (ctx) => ctx.ruleText("${id}");\n`,
		);
	/** A guard that requires `lib` and gates its call on `latch`. */
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
		/* The residual left standing: nothing lexical can say which id
		 * `ctx.ruleText(id)` fetches, so the guard splices nothing this can see
		 * and its misspelt latch reads as self-composed. */
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
		/* Unread, so the latch reads as self-composed and nothing is reported. */
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
			// Outside `dir`, so afterEach's rm never reaches it.
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
		fs.rmSync(path.join(dir, "scripts", "lib", "hook-limits.sh"));
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

	/* The short-circuit that lets an UNWIRED settings file report zero must not
	 * reach a wiring of the wrong shape: rule-emission.js throws on it, and a
	 * zero here would swallow that throw. */
	it("is BROKEN when the PreToolUse key is not a list, naming the key", () => {
		settings(
			{},
			JSON.stringify({ hooks: { PreToolUse: { matcher: "Bash" } } }),
		);
		const r = run("--json");
		expect(r.json().outcome).toBe("BROKEN");
		expect(r.json().summary).toContain("PreToolUse");
	});

	/* The message names the guard, not the id alone: the id says what is missing
	 * and the guard says which file to open. */
	it("names the guard whose injection cannot be resolved", () => {
		guard("guard-bash-0.js", ["rule-missing"]);
		settings({ Bash: ["guard-bash-0.js"] });
		expect(run("--json").json().summary).toContain("scripts/guard-bash-0.js");
	});

	/* An absent settings file is a different fact: no file is no wiring, so
	 * every group is genuinely empty and the zero is the truth. */
	it("is not BROKEN when there is no settings file at all", () => {
		const r = run("--json");
		expect(r.json().outcome).toBe("OK");
		expect(r.json().session.tools).toEqual({});
	});

	/* The short-circuit above must not become a way past the cap: settings that
	 * parse and wire nothing still need no RULE_CAP, and settings that wire
	 * something still do. */
	it("needs no RULE_CAP source when nothing is wired on PreToolUse", () => {
		fs.rmSync(path.join(dir, "scripts", "lib", "hook-limits.sh"));
		settings({});
		expect(run("--json").json().outcome).toBe("OK");
	});
});

/*
 * SEVERITY TURNS ON DIRECTION (mantahostels#1224), and the direction is
 * checker-new-faults.js's rather than this checker's. Fed the REAL envelopes so
 * that the profile's own field spellings — `tag`, `surface`, `total`, and the
 * `session:` prefix — are what is exercised, not a hand-built fixture carrying
 * them (mantahostels#1938's reason, applied to the third surface).
 */
describe("the direction gate over an over-cap group", () => {
	/** An over-cap Bash group of `bytes`, as a whole envelope. */
	function envelope(bytes: number) {
		settings({ Bash: group("Bash", OVER_N, Math.round(bytes / OVER_N)) });
		return run("--json").json();
	}

	it("refuses a commit that raises an already-over-cap group, naming the group", () => {
		const baseline = envelope(OVER_TOTAL);
		// +5,000 B: a rise large enough to read past rounding, and the figure
		// OVER_EACH's own headroom is sized against.
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

/* The fragment surface (mantahostels#2054) over the same direction gate: an over-cap
 * fragment's own bytes only move by editing the fragment file, never by
 * wiring, so `envelope` resizes the one fragment rather than a group. */
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

/*
 * `measure` supplies the delta line beside a refusal, and lib/check.js composes
 * that line — the CLI above never prints it — so the resolution of an
 * `session:<tool>` surface is asserted against the profile directly. Without
 * this the whole prefix branch can return `undefined` with every test above
 * green. The composed line itself is pinned end to end in
 * describe("--against HEAD over a guard's own bytes") below (mantahostels#2311).
 */
describe("the profile's measurement of a session surface", () => {
	// biome-ignore lint/suspicious/noExplicitAny: CommonJS module under test
	const { PROFILES } = require("./lib/fault-profiles.js") as any;

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

	/* mantahostels#2260. Both readings are taken rather than one: the fault is invisible in
	 * the after half alone, which `overCap` answers correctly. */
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

/*
 * --against HEAD, the shape .husky/pre-commit runs. It also exercises
 * `readRuleSourcePathspecs()`: the guards are materialised only because settings
 * is read AT the revision to name them, and a narrowing there would BROKEN
 * rather than pass, so a green run here is the pathspec's own assertion.
 *
 * No timeout override: mantahostels#2264 dropped its 20,000 ms one as redundant
 * against mantahostels#2262's 90,000 ms default.
 */
describe("--against HEAD over a guard's own bytes", () => {
	function git(...args: string[]) {
		const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
		if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
		return r.stdout;
	}

	/* A real spawn: --against re-execs itself over two materialised trees. */
	function gate(...args: string[]) {
		const r = spawnSync("node", [SCRIPT, "--against", "HEAD", ...args], {
			cwd: dir,
			encoding: "utf8",
		});
		return { ...r, json: () => JSON.parse(r.stdout) };
	}

	function baseline() {
		git("init", "-q", "-b", "main");
		git("config", "user.email", "t@example.invalid");
		git("config", "user.name", "t");
		git("add", "-A");
		git("commit", "-q", "--no-verify", "-m", "baseline");
	}

	/** Resize one fragment and stage it, as a pathspec commit would. */
	function stageFragment(id: string, bytes: number) {
		fragment(id, bytes);
		git("add", "--", `docs/agents/rules/${id}.txt`);
	}

	it("passes a rise that leaves the group inside its cap", () => {
		/* The group totals 1,000 B, under RATCHET_CAP at its seed and at any
		 * higher one, so this exercises only the per-session axis and not the
		 * shared ratchet's own direction gate. */
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

	/* The materialised revision sits in a temporary directory, so only the
	 * self-plugin file it carries marks it the core's; settings wires nothing. */
	it("refuses a growth a core tree wires from its self-plugin file (#2445)", () => {
		settings({});
		selfPlugin({ Bash: group("Bash", OVER_N, OVER_EACH) });
		baseline();
		stageFragment("rule-bash-0", STAGED_FRAGMENT);
		const r = gate("--json");
		expect(r.status).not.toBe(0);
		expect(JSON.stringify(r.json().added)).toContain("PreToolUse Bash");
	});

	/* mantahostels#2311: the baseline group has no OVER-SESSION finding at all — under
	 * SESSION_CAP, the tool never enters `reachTools`' warn loop — so unlike the
	 * already-over-cap case above, the family this fault belongs to is absent
	 * from the baseline outright. `measuredDelta` still needs both readings to
	 * compose the line, so this pins the composed text rather than `measure()`
	 * called directly. */
	it("refuses a commit whose group first crosses SESSION_CAP, naming the group, its size at HEAD and the bytes added", () => {
		/* Sized off SESSION_CAP rather than written out, so moving the cap
		 * cannot leave this fixture landing UNDER it — where the gate is right to
		 * pass and the case silently stops testing anything (mantahostels#2493). Every fragment stays
		 * under RULE_CAP, which is a separate fault this case must not raise —
		 * so the COUNT is derived too, not written out. The divisor is the largest
		 * a fragment may be and still take the +750 B bump under RULE_CAP. */
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

	/* #1014: the materialised trees carried no `.claude/workflow-core.json` — every module read as off,
	 * so `ruleModule`'s ids dropped out of both sides and neither breached.
	 * The module-gated guard is what puts the group within reach of the cap,
	 * and WFC_MODULES is dropped so both runs read the fixture's config rather
	 * than vitest.setup.ts's every-module default, which masked the fault.
	 *
	 * HEAD sits 13 B under the cap and the commit adds 26 B, landing 13 B over.
	 * The count is derived as the crossing case
	 * above derives its own, so a raised cap cannot push the staged fragment
	 * over RULE_CAP. */
	function gatedCrossing(modules: string[]) {
		const injected = process.env.WFC_MODULES;
		delete process.env.WFC_MODULES;
		onTestFinished(() => {
			if (injected !== undefined) process.env.WFC_MODULES = injected;
		});
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
			'module.exports = (ctx) => ({\n\tinjectRules: ["rule-gated"],\n\tskip: [\n\t\t...ruleModule(ctx, "suites", ["rule-gated"]),\n\t],\n});\n',
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
		const base = gatedCrossing(["suites"]);
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

	/* §X4's pair: the config, not a default, is what decides. */
	it("passes the same commit where the config has the module off", () => {
		gatedCrossing([]);
		expect(sessionFindings()).toEqual([]);
		const r = gate("--json");
		expect(r.json().added).toEqual([]);
		expect(r.status).toBe(0);
	});

	/* mantahostels#2311: the fragment equivalent of the crossing case above. The baseline
	 * fragment is wired and reachable but under RULE_CAP, so `reach.overCap`
	 * carries no entry for it — `session.fragmentBytes` is the only reading that
	 * exists on that side, and it is the one `surfaceTotal`'s `fragment:` prefix
	 * must resolve for `measuredDelta` to print a base figure instead of
	 * silence. A second, untouched guard keeps the group's own total apart from
	 * the fragment's, so the printed base figure can only have come from the
	 * `fragment:` reading. */
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

	/* mantahostels#2311: §X4's pairing half, on the fragment surface specifically — the
	 * four passing cases elsewhere in this block are all group/session-surface,
	 * so a `surfaceTotal` regression that refused every fragment commit outright
	 * would leave every other test in this block green. */
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

	/* The breach arrives through the WIRING rather than through a fragment, which
	 * is the only path where readRuleSourcePathspecs() must resolve the STAGED
	 * side's settings rather than HEAD's (spec mantahostels#1932's story 3). */
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

	/* #2924: a core is read from the manifest the side measured commits, so an
	 * uncommitted row naming a core not yet written breaks no commit. */
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

/*
 * The shared ratchet (mantahostels#1787, docs/doc-map.md §Capture and placement §3 route
 * (f), second axis). Independent of SESSION_CAP: it unions every tool's
 * reachable ids into one figure and compares that against its own, separate
 * cap, rather than bounding one tool at a time.
 */
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
		/* guard-dispatch.js's real shape: one guard, one matcher string naming
		 * several tools. Wired here under two SEPARATE matcher entries instead,
		 * which is how .claude/settings.json's actual JSON array expresses it. */
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
	/** Two over-ratchet envelopes. The gap between them is a whole fragment
	 * rather than a byte, so the rise survives the helper's rounding across
	 * RATCHET_TOOLS. */
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

/*
 * THE LIVE REPO. Two assertions, and they fail for different reasons: the first
 * is a VERDICT — the checker's severity agrees with its own arithmetic, true
 * whichever side of the cap this repo is on — and the second is spec mantahostels#1932's
 * story 27, that the repo is actually under cap, which mantahostels#2046 made writable by
 * re-basing the cap on the unit the injection latch charges.
 */
describe("this repo's own figures", () => {
	// WFC_MODULES dropped, so the figures are the modules this repo declares
	// rather than vitest.setup.ts's every-module default (#449).
	// biome-ignore lint/suspicious/noExplicitAny: envelope is untyped JSON
	const live = (): any =>
		JSON.parse(
			runInProcess(SCRIPT, ["--json"], {
				env: { ...process.env, WFC_MODULES: undefined },
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
		/* A group's bytes are its ids' union, so they can only ever be at or under
		 * its guards' totals summed — equal while no two guards share an id. */
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

	/* Spec mantahostels#1932's story 27. Adding a fragment to any Bash-wired guard spends
	 * the headroom and turns this red, which is the deliberate move §3 route (f)
	 * asks for. */
	it("is under the session cap on every PreToolUse tool", () => {
		const j = live();
		const over = Object.entries(j.session.tools)
			.filter(([, g]) => (g as { bytes: number }).bytes >= SESSION_CAP)
			.map(([tool, g]) => `${tool} at ${(g as { bytes: number }).bytes} B`);
		expect(over).toEqual([]);
	});
});

describe("rule text a hook hands over after its call (#2144)", () => {
	/* A PostToolUse core's shape: a latched fetch returned with its mark. */
	const latched = (id: string) =>
		`module.exports = (ctx) => {\n\tif (ctx.told("${id}")) return {};\n\treturn { context: ctx.ruleText("${id}"), latchAfter: "${id}" };\n};\n`;
	/* guard-failed-call-rules.js's shape: no latch at all. */
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
