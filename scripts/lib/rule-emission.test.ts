// @vitest-environment node
/*
 * Tests for scripts/lib/rule-emission.js — the route (f) bytes ONE SESSION can
 * be made to pay through each PreToolUse tool.
 *
 * Every case points WFC_RULES_DIR at a temporary store, so none reads
 * docs/agents/rules/ and a relocation tranche adding a real fragment can never
 * turn these red.
 *
 * Built at mantahostels#2003; the session unit is mantahostels#2046's. The
 * figures feed `check-context-budget.js` and `check-guard-registry.js`, both
 * refusing gates in `.husky/pre-commit`: loosen a case and a commit can wire
 * rule text past the budget unrefused, or a clean commit is refused on a
 * miscount.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { hookIsWired, readCoreHooks } from "./hook-wiring";

interface CoreRow {
	core: string;
	tools: string;
}
const { dispatchRows, isCoreFor } = require("./guard-cores.js") as {
	dispatchRows: (event: string) => CoreRow[];
	isCoreFor: (row: CoreRow, tool: string) => boolean;
};
const DISPATCH_ENTRY = "scripts/guard-dispatch.js";

/** One contributing guard, as reachableByTool reports it. */
interface Guard {
	file: string;
	bytes: number;
	calls: number;
	/** The distinct rule ids this guard can reach. */
	ids: string[];
}

interface Group {
	bytes: number;
	ids: string[];
	guards: Guard[];
}

interface Figures {
	cap: number;
	tools: Record<string, Group>;
	ratchet: { bytes: number; ids: string[] };
	overCap: { id: string; bytes: number; guards: string[] }[];
	latchFaults: {
		id: string;
		guard: string;
		resolves: boolean;
		bound: boolean;
		marked: boolean;
	}[];
	fragmentBytes: Record<string, number>;
	direct: {
		id: string;
		bytes: number | null;
		guards: string[];
		counted: boolean;
		latched: "none" | "bounded" | "ambiguous";
	}[];
}

// biome-ignore lint/suspicious/noExplicitAny: CommonJS module under test
const lib = require("./rule-emission") as any;

const CAP_FILE = path.join(__dirname, "hook-limits.sh");

const temps: string[] = [];

afterEach(() => {
	for (const t of temps.splice(0))
		fs.rmSync(t, { recursive: true, force: true });
});

/** A throwaway fragment store, id → body, returned as its absolute path. */
function store(fragments: Record<string, string>): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rule-emission-"));
	temps.push(dir);
	for (const [id, body] of Object.entries(fragments))
		fs.writeFileSync(path.join(dir, `${id}.txt`), body);
	return dir;
}

/** A PreToolUse settings object from `matcher → guard paths`. */
function buildSettings(wiring: Record<string, string[]>) {
	return {
		hooks: {
			PreToolUse: Object.entries(wiring).map(([matcher, commands]) => ({
				matcher,
				hooks: commands.map((c) => ({
					type: "command",
					command: `"$CLAUDE_PROJECT_DIR"/${c}`,
				})),
			})),
		},
	};
}

/** A core whose only content is its injections, one decision per line. */
function guard(...calls: string[][]): string {
	return calls
		.map(
			(ids) =>
				`return { injectRules: [${ids.map((id) => `"${id}"`).join(", ")}] };\n`,
		)
		.join("");
}

/**
 * A core that reaches its ids through DIRECT accessor calls instead — the
 * shape a core uses when it splices rule text into wording of its own.
 */
function directGuard(...ids: string[]): string {
	return ids
		.map((id) => `const ${slot(id)} = ctx.ruleText("${id}");\n`)
		.join("");
}

/** The constant one id's fetched text lands in, ids carrying hyphens. */
function slot(id: string): string {
	return `text_${id.replace(/-/g, "_")}`;
}

/**
 * The same, with the per-session bound a splicing guard may put on its own
 * repeat (mantahostels#2275).
 *
 * The emission spends the fetched text rather than a literal: the bound is
 * correlated against the emission (mantahostels#2354), and a guard that fetches
 * without emitting is not the shape being modelled.
 */
function latchedGuard(...ids: string[]): string {
	return `${directGuard(...ids)}${ids
		.map(
			(id) =>
				`if (!ctx.told("${id}")) return { context: ${slot(id)}, latchAfter: "${id}" };\n`,
		)
		.join("")}`;
}

/**
 * A core with TWO fetches for one id and a bound in front of only one of
 * them — the shape mantahostels#2283 was raised on.
 */
function twoPathGuard(id: string): string {
	return [
		`if (!ctx.told("${id}"))`,
		`\treturn { context: ctx.ruleText("${id}"), latchAfter: "${id}" };`,
		`return { deny: ctx.ruleText("${id}") };`,
		"",
	].join("\n");
}

/** The module's answer for a whole synthetic repo. */
function figures(
	wiring: Record<string, string[]>,
	sources: Record<string, string>,
	fragments: Record<string, string>,
	capFile: string = CAP_FILE,
): Figures {
	return lib.reachableByTool({
		settings: buildSettings(wiring),
		sources,
		rulesDir: store(fragments),
		capFile,
	});
}

const ALONE = "scripts/guard-alone.js";

/**
 * The module's answer for `text` wired alone on Bash. The store answers for
 * every id in `ids` — each one a misreading could invent too — so a misread
 * surfaces as an id, not a throw.
 */
const alone = (text: string, ids: string[]): Figures =>
	figures(
		{ Bash: [ALONE] },
		{ [ALONE]: text },
		Object.fromEntries(ids.map((id) => [id, "x"])),
	);

/** What reachableByTool reads off one guard's injections, wired alone. */
function reached(
	text: string,
	ids: string[],
): { calls: number; ids: string[] } {
	const r = alone(text, ids);
	const g = r.tools.Bash.guards[0];
	return g ? { calls: g.calls, ids: g.ids } : { calls: 0, ids: [] };
}

/**
 * The direct census reachableByTool takes of one guard wired alone, as id →
 * how it reads that id's bound.
 */
function census(
	text: string,
	ids: string[],
): Record<string, "none" | "bounded" | "ambiguous"> {
	const r = alone(text, ids);
	return Object.fromEntries(r.direct.map((d) => [d.id, d.latched]));
}

/**
 * How reachableByTool reads the bound on `id` once `text` is told on it and
 * marked once: `bounded` only where the text holds exactly one fetch site
 * (mantahostels#2283), `ambiguous` for any other count.
 */
function boundOf(text: string, id: string) {
	return census(
		`${text}if (ctx.told("${id}")) return null;\nreturn { context: "", latchAfter: "${id}" };\n`,
		[id],
	)[id];
}

describe("summing a group", () => {
	it("adds every guard wired on the tool", () => {
		// 10 B + 20 B, each a single-fragment call with no join.
		const r = figures(
			{ Bash: ["scripts/guard-a.js", "scripts/guard-b.js"] },
			{
				"scripts/guard-a.js": guard(["alpha"]),
				"scripts/guard-b.js": guard(["beta"]),
			},
			{ alpha: "a".repeat(10), beta: "b".repeat(20) },
		);
		expect(r.tools.Bash.bytes).toBe(30);
		expect(r.tools.Bash.guards.map((g: Guard) => g.file)).toEqual([
			"scripts/guard-b.js",
			"scripts/guard-a.js",
		]);
	});

	it("reports a tool whose group emits nothing as zero, not as absent", () => {
		const r = figures(
			{ Bash: ["scripts/guard-a.js"], Skill: ["scripts/guard-quiet.js"] },
			{
				"scripts/guard-a.js": guard(["alpha"]),
				"scripts/guard-quiet.js": "return null;\n",
			},
			{ alpha: "a".repeat(10) },
		);
		expect(r.tools.Skill).toEqual({ bytes: 0, ids: [], guards: [] });
	});
});

describe("one guard with more than one call", () => {
	it("counts both branches, never only the larger", () => {
		// Mutually exclusive on ONE event, but a session meets many events and the
		// latch pays each id once: 40, not 30.
		const r = figures(
			{ Bash: ["scripts/guard-two.js"] },
			{ "scripts/guard-two.js": guard(["big"], ["small"]) },
			{ big: "b".repeat(30), small: "s".repeat(10) },
		);
		expect(r.tools.Bash.bytes).toBe(40);
		expect(r.tools.Bash.guards[0].calls).toBe(2);
	});

	it("pays an id named by two calls once, as the latch does", () => {
		const r = figures(
			{ Bash: ["scripts/guard-dup.js"] },
			{ "scripts/guard-dup.js": guard(["shared", "one"], ["shared", "two"]) },
			{
				shared: "s".repeat(50),
				one: "1".repeat(10),
				two: "2".repeat(20),
			},
		);
		expect(r.tools.Bash.bytes).toBe(80);
	});
});

describe("an id two guards both reach", () => {
	it("is paid once by the tool, the latch making the second call a no-op", () => {
		const r = figures(
			{ Bash: ["scripts/guard-a.js", "scripts/guard-b.js"] },
			{
				"scripts/guard-a.js": guard(["shared", "alpha"]),
				"scripts/guard-b.js": guard(["shared", "beta"]),
			},
			{
				shared: "s".repeat(100),
				alpha: "a".repeat(10),
				beta: "b".repeat(20),
			},
		);
		// 100 + 10 + 20, not 110 + 120.
		expect(r.tools.Bash.bytes).toBe(130);
		expect(r.tools.Bash.guards.map((g: Guard) => g.bytes).sort()).toEqual([
			110, 120,
		]);
	});
});

describe("the ratchet's union across tools", () => {
	it("counts a multi-tool guard once, not once per tool", () => {
		const r = figures(
			{
				"Write|Edit": ["scripts/guard-claim.js"],
				Bash: ["scripts/guard-a.js"],
			},
			{
				"scripts/guard-claim.js": guard(["claim"]),
				"scripts/guard-a.js": guard(["alpha"]),
			},
			{ claim: "c".repeat(300), alpha: "a".repeat(10) },
		);
		expect(r.tools.Write.bytes).toBe(300);
		expect(r.tools.Edit.bytes).toBe(300);
		expect(r.ratchet.bytes).toBe(310);
		expect(r.ratchet.ids.sort()).toEqual(["alpha", "claim"]);
	});

	it("counts a match-all matcher, which names no tool and opens no group", () => {
		/* Accumulating the ratchet from the groups would report this guard at
		 * 0 B — the deflation a ceiling must never make. */
		const r = figures(
			{ "": ["scripts/guard-everywhere.js"] },
			{ "scripts/guard-everywhere.js": guard(["everywhere"]) },
			{ everywhere: "e".repeat(700) },
		);
		expect(Object.keys(r.tools)).toEqual([]);
		expect(r.ratchet.bytes).toBe(700);
	});

	it("counts a match-all matcher into every tool a neighbour's matcher names", () => {
		// Claude Code reads "" as match-all; anchoring it literally gives /^()$/,
		// which would drop the guard from every group.
		const r = figures(
			{ "": ["scripts/guard-everywhere.js"], Bash: ["scripts/guard-a.js"] },
			{
				"scripts/guard-everywhere.js": guard(["everywhere"]),
				"scripts/guard-a.js": guard(["alpha"]),
			},
			{ everywhere: "e".repeat(700), alpha: "a".repeat(10) },
		);
		expect(r.tools.Bash.bytes).toBe(710);
	});
});

describe("the cap", () => {
	it("counts a call over RULE_CAP in full, the deferred tail arriving later", () => {
		// 6,000 B offered against a 4,000 B ceiling. On ONE event the entry defers
		// the second fragment whole; unlatched, it lands on the next event, so a
		// session pays both.
		const r = figures(
			{ Bash: ["scripts/guard-fat.js"] },
			{ "scripts/guard-fat.js": guard(["one", "two"]) },
			{ one: "1".repeat(3000), two: "2".repeat(3000) },
		);
		expect(r.cap).toBe(4000);
		expect(r.tools.Bash.bytes).toBe(6000);
	});

	it("reports, rather than throws, a fragment over the cap on its own (mantahostels#2054)", () => {
		// It can never be emitted whole — offered first, it denies
		// the tool call outright — but that is the repo's own rule text, not this
		// module's apparatus, so it is named in `overCap` rather than thrown.
		const r = figures(
			{ Bash: ["scripts/guard-huge.js"] },
			{ "scripts/guard-huge.js": guard(["whale", "minnow"]) },
			{ whale: "w".repeat(4001), minnow: "m".repeat(10) },
		);
		expect(r.overCap).toEqual([
			{ id: "whale", bytes: 4001, guards: ["scripts/guard-huge.js"] },
		]);
		// The unemittable id pays nothing: it is excluded, not silently zeroed —
		// `minnow` alone reaches the group and the ratchet.
		expect(r.tools.Bash.bytes).toBe(10);
		expect(r.tools.Bash.ids).toEqual(["minnow"]);
		expect(r.ratchet.bytes).toBe(10);
	});

	it("carries both sides of the cap in fragmentBytes (mantahostels#2260)", () => {
		// `overCap` answers for `whale` alone, the group's own figures for
		// `minnow` alone; only this record answers for both.
		const r = figures(
			{ Bash: ["scripts/guard-huge.js"] },
			{ "scripts/guard-huge.js": guard(["whale", "minnow"]) },
			{ whale: "w".repeat(4001), minnow: "m".repeat(10) },
		);
		expect(r.fragmentBytes).toEqual({ whale: 4001, minnow: 10 });
	});

	it("reports an over-cap fragment behind a full call, not just a leading one", () => {
		// This module resolves every id in the call regardless of position, so a
		// lazy resolution that stopped at the first over-cap id would still have
		// to report this one.
		const r = figures(
			{ Bash: ["scripts/guard-late.js"] },
			{ "scripts/guard-late.js": guard(["first", "whale"]) },
			{ first: "f".repeat(3900), whale: "w".repeat(4001) },
		);
		expect(r.overCap).toEqual([
			{ id: "whale", bytes: 4001, guards: ["scripts/guard-late.js"] },
		]);
		expect(r.tools.Bash.bytes).toBe(3900);
		expect(r.tools.Bash.ids).toEqual(["first"]);
	});

	it("names every guard that reaches one over-cap fragment, once", () => {
		const r = figures(
			{ Bash: ["scripts/guard-a.js"], Write: ["scripts/guard-b.js"] },
			{
				"scripts/guard-a.js": guard(["whale"]),
				"scripts/guard-b.js": guard(["whale"]),
			},
			{ whale: "w".repeat(4001) },
		);
		expect(r.overCap).toEqual([
			{
				id: "whale",
				bytes: 4001,
				guards: ["scripts/guard-a.js", "scripts/guard-b.js"],
			},
		]);
	});

	it("resolves every id in a call, so a missing fragment anywhere throws, naming the id", () => {
		expect(() =>
			figures(
				{ Bash: ["scripts/guard-deferred.js"] },
				{ "scripts/guard-deferred.js": guard(["first", "nosuchrule"]) },
				{ first: "f".repeat(3900) },
			),
		).toThrow(/no fragment for rule id "nosuchrule"/);
	});

	it("reads RULE_CAP from lib/hook-limits.sh rather than restating it", () => {
		const src = fs.readFileSync(CAP_FILE, "utf8");
		expect(lib.readRuleCap(CAP_FILE)).toBe(
			Number(/^[ \t]*RULE_CAP=(\d+)[ \t]*$/m.exec(src)?.[1]),
		);
	});

	it("throws rather than defaulting where the assignment is missing", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rule-emission-cap-"));
		temps.push(dir);
		const file = path.join(dir, "hook-limits.sh");
		fs.writeFileSync(file, "#!/usr/bin/env bash\n# no cap here\n");
		expect(() => lib.readRuleCap(file)).toThrow(
			/^rule-emission: no anchored RULE_CAP=<digits> assignment/,
		);
	});

	it("throws where the cap source cannot be read at all, naming the path", () => {
		expect(() => lib.readRuleCap("/nonexistent/hook-limits.sh")).toThrow(
			/^rule-emission: cannot read \/nonexistent\/hook-limits\.sh/,
		);
	});
});

describe("a decision's skip", () => {
	/** A core whose skip sits behind a condition. */
	function scoped(emitted: string[], skipped: string[]): string {
		const list = (ids: string[]) => ids.map((id) => `"${id}"`).join(", ");
		return `return { injectRules: [${list(emitted)}], skip: docsOnly ? [${list(skipped)}] : [] };\n`;
	}

	it("never lowers the figure: a skip sits behind a condition that may not fire", () => {
		// A ceiling assumes every skip stays quiet, so all three ids are reachable.
		const r = figures(
			{ Bash: ["scripts/guard-free.js"] },
			{ "scripts/guard-free.js": scoped(["lead", "mid", "tail"], ["mid"]) },
			{ lead: "l".repeat(500), mid: "m".repeat(900), tail: "t".repeat(3000) },
		);
		expect(r.tools.Bash.bytes).toBe(4400);
	});

	it("is not read as an injection", () => {
		expect(reached(scoped(["beta"], ["alpha"]), ["alpha", "beta"])).toEqual({
			calls: 1,
			ids: ["beta"],
		});
	});
});

describe("ruleModule (#449) and ruleUnlessModule (#2409, #2785)", () => {
	const src = [
		"return { injectRules: [",
		'\t"lead", "mid", "old",',
		"], skip: [",
		'\t...ruleModule(ctx, "governance", [',
		'\t\t"mid",',
		"\t]),",
		"\t...ruleUnlessModule(ctx, 'governance', ['old']),",
		"] };",
	].join("\n");
	const reach = (modules: string) => {
		const before = process.env.WFC_MODULES;
		process.env.WFC_MODULES = modules;
		try {
			return figures(
				{ Bash: ["scripts/guard-mod.js"] },
				{ "scripts/guard-mod.js": src },
				{ lead: "l".repeat(100), mid: "m".repeat(200), old: "o".repeat(400) },
			);
		} finally {
			if (before === undefined) delete process.env.WFC_MODULES;
			else process.env.WFC_MODULES = before;
		}
	};

	it("charges the module's ids and leaves out its unless-ids where the host has it on", () => {
		const r = reach("governance");
		expect(r.tools.Bash.bytes).toBe(300);
		expect(r.ratchet.ids).not.toContain("old");
	});

	it("leaves out the module's ids and charges its unless-ids where it is off", () => {
		const r = reach("roadmap");
		expect(r.tools.Bash.bytes).toBe(500);
		expect(r.ratchet.ids).not.toContain("mid");
	});

	it("throws on a module the core does not know, naming the guard and the module", () => {
		expect(() =>
			figures(
				{ Bash: ["scripts/guard-bad.js"] },
				{
					"scripts/guard-bad.js":
						'return { injectRules: ["mid"], skip: [\n\t...ruleModule(ctx, "nosuch", ["mid"]),\n] };\n',
				},
				{ mid: "m" },
			),
		).toThrow(/guard-bad\.js: no module "nosuch"/);
	});
});

describe("the join", () => {
	it("is not counted: how ids fall across deliveries is not statically known", () => {
		// Three fragments, 60 B — never 64. The 2 B separator is per
		// delivery, and a session's deliveries are not fixed.
		const r = figures(
			{ Bash: ["scripts/guard-three.js"] },
			{ "scripts/guard-three.js": guard(["a", "b", "c"]) },
			{ a: "a".repeat(10), b: "b".repeat(20), c: "c".repeat(30) },
		);
		expect(r.tools.Bash.bytes).toBe(60);
	});
});

describe("byte length, not character length", () => {
	it("counts a multibyte fragment at its byte size", () => {
		// Eight em dashes, 3 B each in UTF-8: 24 B, not 8.
		const body = "—".repeat(8);
		expect(body.length).toBe(8);
		const r = figures(
			{ Bash: ["scripts/guard-utf8.js"] },
			{ "scripts/guard-utf8.js": guard(["dashes"]) },
			{ dashes: body },
		);
		expect(r.tools.Bash.bytes).toBe(24);
	});
});

describe("overlapping matchers", () => {
	it("counts a guard into every tool its matcher covers, once each", () => {
		const r = figures(
			{
				Bash: ["scripts/guard-a.js"],
				"Bash|Read|ListAgents": ["scripts/guard-poll.js"],
			},
			{
				"scripts/guard-a.js": guard(["alpha"]),
				"scripts/guard-poll.js": guard(["poll"]),
			},
			{ alpha: "a".repeat(10), poll: "p".repeat(40) },
		);
		expect(r.tools.Bash.bytes).toBe(50);
		expect(r.tools.Bash.guards).toHaveLength(2);
		expect(r.tools.Read.bytes).toBe(40);
		expect(r.tools.ListAgents.bytes).toBe(40);
	});

	it("counts a guard wired twice on the same tool once", () => {
		const r = figures(
			{
				Bash: ["scripts/guard-poll.js"],
				"Bash|Read": ["scripts/guard-poll.js"],
			},
			{ "scripts/guard-poll.js": guard(["poll"]) },
			{ poll: "p".repeat(40) },
		);
		expect(r.tools.Bash.bytes).toBe(40);
		expect(r.tools.Bash.guards).toHaveLength(1);
	});

	it("keeps a `Bash` guard out of the `BashOutput` group", () => {
		// An unanchored matcher test would charge BashOutput for every Bash guard.
		const r = figures(
			{ Bash: ["scripts/guard-a.js"], BashOutput: ["scripts/guard-out.js"] },
			{
				"scripts/guard-a.js": guard(["alpha"]),
				"scripts/guard-out.js": guard(["out"]),
			},
			{ alpha: "a".repeat(10), out: "o".repeat(7) },
		);
		expect(r.tools.Bash.bytes).toBe(10);
		expect(r.tools.BashOutput.bytes).toBe(7);
	});

	it("anchors the matcher, so Write does not answer for WriteFile", () => {
		const settings = buildSettings({
			Write: ["scripts/guard-w.js"],
			"Write|Edit": ["scripts/guard-we.js"],
			WriteFile: ["scripts/guard-wf.js"],
		});
		/* No matcher at all — the settings shape of an event that takes none —
		 * covers every tool. */
		settings.hooks.PreToolUse.push({
			hooks: [
				{
					type: "command",
					command: '"$CLAUDE_PROJECT_DIR"/scripts/guard-any.js',
				},
			],
		} as (typeof settings.hooks.PreToolUse)[number]);
		const r = lib.reachableByTool({
			settings,
			sources: {
				"scripts/guard-w.js": guard(["w"]),
				"scripts/guard-we.js": guard(["we"]),
				"scripts/guard-wf.js": guard(["wf"]),
				"scripts/guard-any.js": guard(["any"]),
			},
			rulesDir: store({ w: "w", we: "we", wf: "wf", any: "any" }),
			capFile: CAP_FILE,
		}) as Figures;
		const files = (tool: string) =>
			r.tools[tool].guards.map((g: Guard) => g.file).sort();
		expect(files("Write")).toEqual([
			"scripts/guard-any.js",
			"scripts/guard-w.js",
			"scripts/guard-we.js",
		]);
		expect(files("Edit")).toEqual([
			"scripts/guard-any.js",
			"scripts/guard-we.js",
		]);
		expect(files("WriteFile")).toEqual([
			"scripts/guard-any.js",
			"scripts/guard-wf.js",
		]);
	});
});

describe("an unwired guard", () => {
	it("is excluded from every group", () => {
		const r = figures(
			{ Bash: ["scripts/guard-a.js"] },
			{
				"scripts/guard-a.js": guard(["alpha"]),
				"scripts/guard-unwired.js": guard(["huge"]),
			},
			{ alpha: "a".repeat(10), huge: "h".repeat(900) },
		);
		expect(r.tools.Bash.bytes).toBe(10);
		expect(
			r.tools.Bash.guards.some((g: Guard) => g.file.includes("unwired")),
		).toBe(false);
	});
});

describe("an input that cannot be read", () => {
	it("throws where the wiring names a guard the sources do not carry", () => {
		expect(() =>
			figures(
				{ Bash: ["scripts/guard-a.js", "scripts/guard-absent.js"] },
				{ "scripts/guard-a.js": guard(["alpha"]) },
				{ alpha: "a" },
			),
		).toThrow(
			/^rule-emission: the wiring names scripts\/guard-absent\.js, which the supplied sources do not carry/,
		);
	});

	it("throws where a wired guard is missing from disk, naming the guard", () => {
		expect(() =>
			lib.reachableByTool({
				settings: buildSettings({ Bash: ["scripts/guard-not-there.js"] }),
				capFile: CAP_FILE,
			}),
		).toThrow(/cannot read scripts\/guard-not-there\.js/);
	});
});

describe("the default wiring", () => {
	it("is the self-plugin's file then its settings at a materialised core tree (#2456, #2572)", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "rule-emission-tree-"));
		temps.push(root);
		const files: [string, Record<string, string[]>][] = [
			["self-plugin/hooks/hooks.json", { Bash: ["scripts/guard-self.js"] }],
			[".claude/settings.json", { Edit: ["scripts/guard-settings.js"] }],
		];
		for (const [rel, wiring] of files) {
			fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
			fs.writeFileSync(
				path.join(root, rel),
				JSON.stringify(buildSettings(wiring)),
			);
		}
		const out: Figures = lib.reachableByTool({
			root,
			sources: {
				"scripts/guard-self.js": guard(["alpha"]),
				"scripts/guard-settings.js": guard(["beta"]),
			},
			rulesDir: store({ alpha: "a", beta: "b" }),
			capFile: CAP_FILE,
		});
		expect(Object.keys(out.tools)).toEqual(["Bash", "Edit"]);
		expect(out.ratchet.ids).toEqual(["alpha", "beta"]);
	});
});

describe("the wired-script pattern", () => {
	it("reads the house command spelling, and `command -v node` is not a path", () => {
		const paths = (cmd: string) =>
			[...cmd.matchAll(lib.WIRED_SCRIPT_RE)].map((m: RegExpMatchArray) => m[1]);
		expect(paths('"$CLAUDE_PROJECT_DIR"/scripts/guard-branch.sh')).toEqual([
			"scripts/guard-branch.sh",
		]);
		expect(paths("node scripts/lib/rule-text.js")).toEqual([
			"scripts/lib/rule-text.js",
		]);
		expect(paths("command -v node")).toEqual([]);
	});
});

describe("the exec form's args (mantahostels#2266)", () => {
	/* `command` is the bare interpreter and the script path sits in `args`, so a
	 * reader taking `command` alone counts the guard's fragments into no group
	 * at all — the byte census then reads under the cap because it never saw the
	 * guard. */
	const execFormSettings = {
		hooks: {
			PreToolUse: [
				{
					matcher: "Bash",
					hooks: [
						{ command: "node", args: ["scripts/guard-a.js", "--strict"] },
					],
				},
			],
		},
	};

	it("joins command and args into the one line the transcript records", () => {
		expect(
			lib.buildHookCommandLine({ command: "node", args: ["a.js", "x"] }),
		).toBe("node a.js x");
	});

	it("contributes nothing for an args that is not an array of strings", () => {
		expect(lib.buildHookCommandLine({ command: "node", args: "a.js" })).toBe(
			"node",
		);
		expect(lib.buildHookCommandLine({ command: "node", args: [3] })).toBe(
			"node",
		);
	});

	it("counts a guard whose path is held in args into its tool's group", () => {
		const r = lib.reachableByTool({
			settings: execFormSettings,
			sources: { "scripts/guard-a.js": guard(["alpha"]) },
			rulesDir: store({ alpha: "a".repeat(10) }),
			capFile: CAP_FILE,
		}) as Figures;
		expect(r.tools.Bash.bytes).toBe(10);
		expect(r.tools.Bash.guards.map((g: Guard) => g.file)).toEqual([
			"scripts/guard-a.js",
		]);
	});

	it("flattens the registration onto a commandLine field", () => {
		expect(lib.registrationsOn(execFormSettings, "PreToolUse")).toEqual([
			{ matcher: "Bash", commandLine: "node scripts/guard-a.js --strict" },
		]);
	});
});

describe("a call naming an id with no fragment", () => {
	it("throws through rule-text rather than counting as zero, naming the unknown rule id", () => {
		expect(() =>
			figures(
				{ Bash: ["scripts/guard-typo.js"] },
				{ "scripts/guard-typo.js": guard(["nosuchrule"]) },
				{ alpha: "a" },
			),
		).toThrow(/no fragment for rule id "nosuchrule"/);
	});
});

describe("reading the injections", () => {
	it("takes ids double- or single-quoted, across lines", () => {
		expect(
			reached(`return { injectRules: [\n\t"real-one",\n\t'quoted',\n] };\n`, [
				"real-one",
				"quoted",
			]),
		).toEqual({ calls: 1, ids: ["real-one", "quoted"] });
	});

	it("yields a repeated id once, as the latch does", () => {
		expect(
			reached(guard(["same", "same", "other"]), ["same", "other"]),
		).toEqual({
			calls: 1,
			ids: ["same", "other"],
		});
	});

	// Without the prefix in the id run, a prefixed id would end the run and
	// every id after it would vanish (mantahostels#2719).
	it("bares a `rule:` prefix and does not let it truncate the run", () => {
		expect(
			reached(guard(["rule:alpha", "beta"]), ["alpha", "beta", "rule"]),
		).toEqual({ calls: 1, ids: ["alpha", "beta"] });
	});

	it("yields one id where an injection names both spellings", () => {
		expect(reached(guard(["rule:same", "same"]), ["same", "rule"])).toEqual({
			calls: 1,
			ids: ["same"],
		});
	});

	/*
	 * The optional prefix would otherwise backtrack: on a token the id grammar
	 * cannot follow, RULE_ARG_RE falls back to matching `rule` alone. The run
	 * spells the grammar out so such a token never reaches it.
	 */
	it("invents no `rule` id from a token the grammar cannot follow", () => {
		expect(reached(guard(["rule:-x"]), ["rule", "x"])).toEqual({
			calls: 0,
			ids: [],
		});
	});

	it("bares a `rule:` prefix on a direct rule_text call", () => {
		expect(census("rule_text rule:alpha", ["alpha", "rule"])).toEqual({
			alpha: "none",
		});
		expect(census(`rule_text "rule:alpha"`, ["alpha", "rule"])).toEqual({
			alpha: "none",
		});
	});

	it("bares a `rule:` prefix on both halves of the told bound", () => {
		const text = `${directGuard("alpha")}if (!ctx.told("rule:alpha")) return { context: ${slot("alpha")}, latchAfter: "rule:alpha" };\n`;
		const r = alone(text, ["alpha", "rule"]);
		expect(r.direct.map((d) => [d.id, d.latched])).toEqual([
			["alpha", "bounded"],
		]);
		expect(r.latchFaults).toEqual([]);
	});
});

describe("agreement with scripts/lib/hook-wiring.ts", () => {
	/* The settings are this repo's real ones; the guard sources and the fragment
	 * store are not. */
	/* A dispatcher core is wired where its entry is and its row names the
	 * tool (lib/guard-cores.js). */
	const rows = new Map(
		dispatchRows("PreToolUse").map((r) => [
			path.join("scripts", "lib", r.core),
			r,
		]),
	);
	const wiredOn = (
		rel: string,
		tool: string,
		settings: ReturnType<typeof readCoreHooks>,
	) => {
		const row = rows.get(rel);
		return row === undefined
			? hookIsWired("PreToolUse", path.basename(rel), tool, settings)
			: isCoreFor(row, tool) &&
					hookIsWired(
						"PreToolUse",
						path.basename(DISPATCH_ENTRY),
						tool,
						settings,
					);
	};

	function liveSettingsFigures() {
		const settings = readCoreHooks();
		const wired = new Set(
			(settings.hooks?.PreToolUse ?? [])
				.flatMap((entry) => entry.hooks ?? [])
				.flatMap((h) => [...(h.command ?? "").matchAll(lib.WIRED_SCRIPT_RE)])
				.flatMap((m) => (m[1] === DISPATCH_ENTRY ? [...rows.keys()] : [m[1]])),
		);
		const sources: Record<string, string> = {};
		for (const rel of wired) sources[rel] = guard(["stub"]);
		return {
			settings,
			wired,
			figures: lib.reachableByTool({
				settings,
				sources,
				rulesDir: store({ stub: "s".repeat(11) }),
				capFile: CAP_FILE,
			}) as Figures,
		};
	}

	it("counts a guard into a tool only where hookIsWired agrees it is wired", () => {
		const { settings, figures: liveFigures } = liveSettingsFigures();
		for (const [tool, group] of Object.entries(liveFigures.tools))
			for (const g of group.guards)
				expect(
					wiredOn(g.file, tool, settings),
					`${g.file} counted into ${tool}`,
				).toBe(true);
	});

	it("counts a guard into every tool hookIsWired says it is wired on", () => {
		/* A group silently dropped is the under-report a gate exists to catch. */
		const { settings, wired, figures: liveFigures } = liveSettingsFigures();
		for (const tool of Object.keys(liveFigures.tools))
			for (const rel of wired) {
				if (!wiredOn(rel, tool, settings)) continue;
				expect(
					liveFigures.tools[tool].guards.map((g) => g.file),
					`${rel} missing from ${tool}`,
				).toContain(rel);
			}
	});

	it("names every tool any PreToolUse matcher mentions", () => {
		const { figures: liveFigures } = liveSettingsFigures();
		expect(Object.keys(liveFigures.tools)).toContain("Bash");
		expect(Object.keys(liveFigures.tools)).toContain("Write");
		expect(Object.keys(liveFigures.tools)).toContain("NotebookEdit");
	});
});

describe("a matcher that is not a plain alternation", () => {
	it("throws, naming the matcher, where it is not a valid regex", () => {
		expect(() =>
			figures(
				{ "*": ["scripts/guard-star.js"], Bash: ["scripts/guard-a.js"] },
				{
					"scripts/guard-star.js": guard(["alpha"]),
					"scripts/guard-a.js": guard(["alpha"]),
				},
				{ alpha: "a" },
			),
		).toThrow(
			/^rule-emission: the PreToolUse matcher "\*" is not a valid regular expression/,
		);
	});
});

describe("the direct-call census (mantahostels#2055)", () => {
	it("censuses a fragment only a direct call reaches, and counts none of it", () => {
		// Route (e), not route (f): the guard composes the text itself, on the
		// branch where it has already fired, so only the session that erred pays
		// it and the caps are silent about it.
		const r = figures(
			{ Bash: ["scripts/guard-refuser.js"] },
			{ "scripts/guard-refuser.js": directGuard("spliced") },
			{ spliced: "s".repeat(700) },
		);
		expect(r.direct).toEqual([
			{
				id: "spliced",
				bytes: 700,
				guards: ["scripts/guard-refuser.js"],
				counted: false,
				latched: "none",
			},
		]);
		expect(r.tools.Bash.bytes).toBe(0);
		expect(r.ratchet.bytes).toBe(0);
		// Still in fragmentBytes, though no cap prices it: an id can move between
		// the routes, and a commit adding an injection of this one would
		// otherwise have no baseline reading to be measured against (mantahostels#2260).
		expect(r.fragmentBytes).toEqual({ spliced: 700 });
	});

	it("still lists an id an injection also reaches, flagged rather than dropped", () => {
		// A core that injects a fragment pre-emptively AND splices the same
		// fragment into its denial. The figures
		// buy the once-a-session pre-emission and never the per-denial repeats.
		const g = `${guard(["both"])}${directGuard("both")}`;
		const r = figures(
			{ Bash: ["scripts/guard-two-routes.js"] },
			{ "scripts/guard-two-routes.js": g },
			{ both: "b".repeat(50) },
		);
		expect(r.direct).toEqual([
			{
				id: "both",
				bytes: 50,
				guards: ["scripts/guard-two-routes.js"],
				counted: true,
				latched: "none",
			},
		]);
		expect(r.tools.Bash.bytes).toBe(50);
	});

	it("flags on the global union, so a neighbour's pre-emission marks it", () => {
		// `counted` answers "do the figures above already carry these bytes",
		// which the ratchet's union settles across every guard and tool — not
		// this guard alone.
		const r = figures(
			{
				Bash: ["scripts/guard-emitter.js"],
				Write: ["scripts/guard-splicer.js"],
			},
			{
				"scripts/guard-emitter.js": guard(["wandering"]),
				"scripts/guard-splicer.js": directGuard("wandering"),
			},
			{ wandering: "w".repeat(40) },
		);
		expect(r.direct).toEqual([
			{
				id: "wandering",
				bytes: 40,
				guards: ["scripts/guard-splicer.js"],
				counted: true,
				latched: "none",
			},
		]);
		// The splicer contributes nothing to its OWN tool's figure: a direct call
		// is not route (f) emission, however another tool's guard reaches the id.
		expect(r.tools.Write.bytes).toBe(0);
		expect(r.tools.Bash.bytes).toBe(40);
	});

	it("names every guard reaching one fragment, once and in order", () => {
		const r = figures(
			{ Bash: ["scripts/guard-b.js", "scripts/guard-a.js"] },
			{
				"scripts/guard-b.js": directGuard("shared"),
				"scripts/guard-a.js": directGuard("shared"),
			},
			{ shared: "x".repeat(9) },
		);
		expect(r.direct).toEqual([
			{
				id: "shared",
				bytes: 9,
				guards: ["scripts/guard-a.js", "scripts/guard-b.js"],
				counted: false,
				latched: "none",
			},
		]);
	});

	it("reports an unresolvable id at null bytes rather than throwing", () => {
		// An injection naming a missing fragment denies the tool call, so this module throws on one. A direct call falls back to the
		// guard's own hardcoded sentence and still fires, so the same id is a
		// census entry.
		const r = figures(
			{ Bash: ["scripts/guard-fallback.js"] },
			{ "scripts/guard-fallback.js": directGuard("absent") },
			{},
		);
		expect(r.direct).toEqual([
			{
				id: "absent",
				bytes: null,
				guards: ["scripts/guard-fallback.js"],
				counted: false,
				latched: "none",
			},
		]);
	});

	it("lists a fragment over RULE_CAP that a direct call still delivers", () => {
		// The one id in two blocks: overCap says it can never be injected, and
		// the census says the guard's own wording does anyway.
		const r = figures(
			{ Bash: ["scripts/guard-huge-both.js"] },
			{
				"scripts/guard-huge-both.js": `${guard(["whale"])}${directGuard("whale")}`,
			},
			{ whale: "w".repeat(4001) },
		);
		expect(r.overCap).toEqual([
			{ id: "whale", bytes: 4001, guards: ["scripts/guard-huge-both.js"] },
		]);
		expect(r.direct).toEqual([
			{
				id: "whale",
				bytes: 4001,
				guards: ["scripts/guard-huge-both.js"],
				counted: false,
				latched: "none",
			},
		]);
	});

	it("sorts by bytes descending, an unresolvable id reading as zero", () => {
		const r = figures(
			{ Bash: ["scripts/guard-many.js"] },
			{ "scripts/guard-many.js": directGuard("small", "gone", "big") },
			{ small: "s".repeat(10), big: "b".repeat(100) },
		);
		expect(r.direct.map((d) => d.id)).toEqual(["big", "small", "gone"]);
	});

	it("flags a fragment whose caller bounds its own repeat (mantahostels#2275)", () => {
		const r = figures(
			{ Bash: ["scripts/guard-warner.js"] },
			{ "scripts/guard-warner.js": latchedGuard("bounded") },
			{ bounded: "b".repeat(1227) },
		);
		expect(r.direct).toEqual([
			{
				id: "bounded",
				bytes: 1227,
				guards: ["scripts/guard-warner.js"],
				counted: false,
				latched: "bounded",
			},
		]);
		// Still route (e): a bound on the repeat moves no figure.
		expect(r.tools.Bash.bytes).toBe(0);
		expect(r.ratchet.bytes).toBe(0);
	});

	it("flags an id latched only where EVERY caller latches it", () => {
		// One guard's bound says nothing about a neighbour's own firings.
		const r = figures(
			{ Bash: ["scripts/guard-bounded.js", "scripts/guard-loose.js"] },
			{
				"scripts/guard-bounded.js": latchedGuard("shared"),
				"scripts/guard-loose.js": directGuard("shared"),
			},
			{ shared: "s".repeat(30) },
		);
		expect(r.direct[0].latched).toBe("none");
	});

	it("censuses a direct call in a lib the wired guard sources (mantahostels#2488)", () => {
		// The call is the sourcing guard's to make, so it is the sourcing guard the
		// census names — a relocation into a helper moves no figure.
		const r = figures(
			{ Bash: ["scripts/guard-thin.sh"] },
			{
				"scripts/guard-thin.sh": "#!/usr/bin/env bash\nsource lib/helper.sh\n",
				"scripts/lib/helper.sh": 'text="$(rule_text hidden 2>/dev/null)"\n',
			},
			{ hidden: "h".repeat(500) },
		);
		expect(r.direct).toEqual([
			{
				id: "hidden",
				bytes: 500,
				guards: ["scripts/guard-thin.sh"],
				counted: false,
				latched: "none",
			},
		]);
	});

	it("resolves the REAL libs' own lib-to-lib source spelling (mantahostels#2488)", () => {
		/* Against the real tree: a guard spells the directory `$here`, a lib
		 * spells it `${BASH_SOURCE[0]%/*}` or
		 * `$(dirname "${BASH_SOURCE[0]}")`. */
		const closure = (rel: string) => {
			const text = fs.readFileSync(
				path.join(__dirname, "..", "..", rel),
				"utf8",
			);
			// Every lib read as empty, so the walk stops at the libs this one names.
			return [...lib.readSourcedClosure(rel, text, () => "").keys()];
		};
		expect(closure("scripts/lib/guard-log.sh")).toEqual([
			"scripts/lib/guard-root.sh",
		]);
		expect(closure("scripts/lib/review-standards.sh")).toEqual([
			"scripts/lib/guard-root.sh",
			"scripts/lib/script-path.sh",
			"scripts/lib/guard-log.sh",
		]);
	});

	it("censuses nothing from a lib the supplied sources do not carry (mantahostels#2488)", () => {
		const r = figures(
			{ Bash: ["scripts/guard-thin.sh"] },
			{ "scripts/guard-thin.sh": "#!/usr/bin/env bash\nsource lib/gone.sh\n" },
			{ hidden: "h".repeat(500) },
		);
		expect(r.direct).toEqual([]);
	});
});

describe("correlating a bound with the call it covers (mantahostels#2283)", () => {
	it("reads a guard with one latched and one unlatched path as ambiguous", () => {
		const r = figures(
			{ Bash: ["scripts/guard-two-paths.js"] },
			{ "scripts/guard-two-paths.js": twoPathGuard("split") },
			{ split: "s".repeat(900) },
		);
		expect(r.direct).toEqual([
			{
				id: "split",
				bytes: 900,
				guards: ["scripts/guard-two-paths.js"],
				counted: false,
				latched: "ambiguous",
			},
		]);
		// The bound covers a real call, so it is not a dead latch — just an
		// uncorrelatable one.
		expect(r.latchFaults).toEqual([]);
	});

	it("takes the weakest reading where guards disagree", () => {
		const r = figures(
			{ Bash: ["scripts/guard-clean.js", "scripts/guard-two-paths.js"] },
			{
				"scripts/guard-clean.js": latchedGuard("split"),
				"scripts/guard-two-paths.js": twoPathGuard("split"),
			},
			{ split: "s".repeat(30) },
		);
		expect(r.direct[0].latched).toBe("ambiguous");
	});

	it("prefers an outright unbounded caller to an ambiguous one", () => {
		const r = figures(
			{ Bash: ["scripts/guard-loose.js", "scripts/guard-two-paths.js"] },
			{
				"scripts/guard-loose.js": directGuard("split"),
				"scripts/guard-two-paths.js": twoPathGuard("split"),
			},
			{ split: "s".repeat(30) },
		);
		expect(r.direct[0].latched).toBe("none");
	});
});

describe("a bound that covers nothing (mantahostels#2283)", () => {
	it("names a ctx.told whose id no fragment answers to", () => {
		const r = figures(
			{ Bash: ["scripts/guard-typo.js"] },
			{ "scripts/guard-typo.js": latchedGuard("reel") },
			{ real: "r".repeat(40) },
		);
		expect(r.latchFaults).toEqual([
			{
				id: "reel",
				guard: "scripts/guard-typo.js",
				resolves: false,
				bound: true,
				marked: true,
			},
		]);
	});

	it("names a ctx.told its own guard makes no direct call on", () => {
		const r = figures(
			{ Bash: ["scripts/guard-stray.js"] },
			{
				"scripts/guard-stray.js": `${directGuard("real")}if (!ctx.told("other")) return { context: "", latchAfter: "other" };\n`,
			},
			{ real: "r".repeat(40), other: "o".repeat(40) },
		);
		expect(r.latchFaults).toEqual([
			{
				id: "other",
				guard: "scripts/guard-stray.js",
				resolves: true,
				bound: false,
				marked: true,
			},
		]);
		expect(r.direct[0].latched).toBe("none");
	});

	it("names a ctx.told its guard never marks, and withdraws the bound", () => {
		// The question is asked and never made true, so the fragment is paid on
		// every firing exactly as an unbounded one is.
		const r = figures(
			{ Bash: ["scripts/guard-unmarked.js"] },
			{
				"scripts/guard-unmarked.js": `${directGuard("real")}if (ctx.told("real")) return null;\n`,
			},
			{ real: "r".repeat(40) },
		);
		expect(r.latchFaults).toEqual([
			{
				id: "real",
				guard: "scripts/guard-unmarked.js",
				resolves: true,
				bound: true,
				marked: false,
			},
		]);
		expect(r.direct[0].latched).toBe("none");
	});

	it("says nothing where the bound covers its own call", () => {
		const r = figures(
			{ Bash: ["scripts/guard-warner.js"] },
			{ "scripts/guard-warner.js": latchedGuard("bounded") },
			{ bounded: "b".repeat(40) },
		);
		expect(r.latchFaults).toEqual([]);
	});
});

describe("counting a guard's direct call sites (mantahostels#2283)", () => {
	it("counts sites, not distinct ids", () => {
		// One emission either way, so only the second fetch site withdraws the bound.
		const fetch = 'const text = ctx.ruleText("split");\n';
		expect(boundOf(fetch, "split")).toBe("bounded");
		expect(boundOf(fetch + fetch, "split")).toBe("ambiguous");
	});

	it("dedupes an id two sites name, keeping the count", () => {
		// A neighbour id's site never adds to this one's count.
		expect(census(latchedGuard("one", "two"), ["one", "two"])).toEqual({
			one: "bounded",
			two: "bounded",
		});
	});
});

describe("reading a direct call", () => {
	it("takes the id bare, double-quoted or single-quoted, and dedupes", () => {
		const text = [
			"#!/usr/bin/env bash",
			'  a="$(rule_text plain)"',
			'  b="$(rule_text "quoted")"',
			"  c=\"$(rule_text 'ticked')\"",
			'  d="$(rule_text plain)"',
		].join("\n");
		expect(census(text, ["plain", "quoted", "ticked"])).toEqual({
			plain: "none",
			quoted: "none",
			ticked: "none",
		});
	});

	it("ignores the shapes that name no literal id", () => {
		// `declare -F` tests the function exists; `"$1"` builds the id at run
		// time; `_load_rule_text` and `xrule_text` are different words.
		const text = [
			"#!/usr/bin/env bash",
			"  declare -F rule_text >/dev/null 2>&1",
			'  rule_text "$1"',
			"  _load_rule_text something",
			"  xrule_text something",
		].join("\n");
		expect(census(text, ["something", "1"])).toEqual({});
	});

	it("finds no id where the guard makes no direct call", () => {
		expect(census(guard(["one", "two"]), ["one", "two"])).toEqual({});
	});
});

describe("reading a Node core's direct call, bound and mark (#2905)", () => {
	const entryPath = "scripts/guard-node.js";
	const corePath = "scripts/lib/node-core.js";
	/** A Node entry over a core, wired alone on Bash, read as a census. */
	const nodeCensus = (core: string, ids: string[]) =>
		Object.fromEntries(
			figures(
				{ Bash: [entryPath] },
				{
					[entryPath]: 'const { decide } = require("./lib/node-core.js");\n',
					[corePath]: core,
				},
				Object.fromEntries(ids.map((id) => [id, "x"])),
			).direct.map((d) => [d.id, d.latched]),
		);
	const fetchRule = (id: string) =>
		`const rule = () => ctx.ruleText("${id}");\n`;
	const told = (id: string) =>
		`if (ctx.told("${id}")) return { context: "short" };\n`;
	const marked = (id: string) =>
		`return { injectRules: [], prelude: rule(), latchAfter: "${id}" };\n`;

	it("reads ctx.ruleText as the call, ctx.told as its bound and latchAfter as its mark", () => {
		// The vitest-wrapper shape.
		expect(
			nodeCensus(fetchRule("wrapped") + told("wrapped") + marked("wrapped"), [
				"wrapped",
			]),
		).toEqual({ wrapped: "bounded" });
	});

	it("reads a call with no bound, or a bound never marked, as none", () => {
		expect(
			nodeCensus(fetchRule("bare") + fetchRule("unmarked") + told("unmarked"), [
				"bare",
				"unmarked",
			]),
		).toEqual({ bare: "none", unmarked: "none" });
	});

	it("reads two latched decisions spending one fetch as ambiguous", () => {
		expect(
			nodeCensus(
				fetchRule("twice") + told("twice") + marked("twice") + marked("twice"),
				["twice"],
			),
		).toEqual({ twice: "ambiguous" });
	});

	it("reads a fetch spent in one latched and one unlatched decision as ambiguous (#3051)", () => {
		const unlatched = "if (ctx.cwd) return { prelude: rule() };\n";
		expect(
			nodeCensus(
				fetchRule("leaky") + unlatched + told("leaky") + marked("leaky"),
				["leaky"],
			),
		).toEqual({ leaky: "ambiguous" });
	});

	it("follows the fetch through a name bound to a carrier (#3051)", () => {
		const core = [
			fetchRule("relayed"),
			"function wrapped(ctx) {",
			'\treturn rule() + "\\n\\nmore";',
			"}",
			"if (ctx.cwd) return { context: wrapped(ctx) };",
			told("relayed") + marked("relayed"),
		].join("\n");
		expect(nodeCensus(core, ["relayed"])).toEqual({ relayed: "ambiguous" });
	});

	it.each([
		["a ternary arm", "return ctx.cwd ? { prelude: rule() } : null;\n"],
		[
			"an arrow's object literal",
			"const warn = () => ({ prelude: rule() });\n",
		],
		["a thrown deny", "if (ctx.cwd) deny(rule());\n"],
		["a reassignment", "let said;\nsaid = rule();\n"],
	])(
		"reads the fetch spent unlatched in %s as ambiguous (#3051)",
		(_, spend) => {
			expect(
				nodeCensus(
					fetchRule("shaped") + spend + told("shaped") + marked("shaped"),
					["shaped"],
				),
			).toEqual({ shaped: "ambiguous" });
		},
	);

	it.each([
		["a ternary arm", '...(ctx.cwd ? { latchAfter: "spread" } : {})'],
		["an && operand", '...(ctx.cwd && { latchAfter: "spread" })'],
	])(
		"reads a fetch beside a latch spread in on %s as an unlatched spend, so ambiguous (#3148)",
		(_, spread) => {
			const core = `${fetchRule("spread")}${told("spread")}return { prelude: rule(), ${spread} };\n`;
			expect(nodeCensus(core, ["spread"])).toEqual({ spread: "ambiguous" });
		},
	);

	it("reads a fetch spent inside the latched branch's own literal as bounded (#3148)", () => {
		const core = `${fetchRule("armed")}${told("armed")}return ctx.cwd ? { prelude: rule(), latchAfter: "armed" } : null;\n`;
		expect(nodeCensus(core, ["armed"])).toEqual({ armed: "bounded" });
	});

	it("reads an arrow decide spending the fetch only when latched as bounded (#3051)", () => {
		const core = `${fetchRule("arrowed")}const decide = (ctx) => {\n${told("arrowed")}${marked("arrowed")}};\n`;
		expect(nodeCensus(core, ["arrowed"])).toEqual({ arrowed: "bounded" });
	});

	it("reads a decision that never spends the fetch as no extra site (#3051)", () => {
		const core =
			fetchRule("spared") +
			'if (ctx.cwd) return { context: "short" };\n' +
			told("spared") +
			marked("spared");
		expect(nodeCensus(core, ["spared"])).toEqual({ spared: "bounded" });
	});

	it("reads a decision handed on by the kit as no extra site (#3051)", () => {
		const core = [
			fetchRule("handed"),
			"function decide(ctx) {",
			told("handed") + marked("handed"),
			"}",
			"function run(ctx) {",
			"\tconst out = decide(ctx);",
			"\treturn { context: out };",
			"}",
		].join("\n");
		expect(nodeCensus(core, ["handed"])).toEqual({ handed: "bounded" });
	});

	it("reads a latchAfter inside a comment as no mark (#3051)", () => {
		const core = `${fetchRule("noted")}${told("noted")}// latchAfter: "noted"\n/* latchAfter: "noted" */\nreturn { prelude: rule() };\n`;
		expect(nodeCensus(core, ["noted"])).toEqual({ noted: "none" });
	});

	it("reads an id held in a constant as no bound, the safe direction", () => {
		const core = `const ID = "held";\n${fetchRule("held")}if (ctx.told(ID)) return null;\nreturn { prelude: rule(), latchAfter: ID };\n`;
		expect(nodeCensus(core, ["held"])).toEqual({ held: "none" });
	});

	it("reads readRuleTextOr and a ruleOrFallback call", () => {
		const core = [
			'const a = readRuleTextOr("fallback-taker", "sentence");',
			'const b = ruleOrFallback(run.ctx, "kit-taker", "Lead");',
			"",
		].join("\n");
		expect(nodeCensus(core, ["fallback-taker", "kit-taker"])).toEqual({
			"fallback-taker": "none",
			"kit-taker": "none",
		});
	});
});

describe("the core layer beneath the store (#101)", () => {
	const wiring = { Bash: ["scripts/guard-a.js"] };
	const sources = { "scripts/guard-a.js": guard(["core-only"]) };

	it("resolves a core guard's id out of rulesFallbackDir", () => {
		const r = lib.reachableByTool({
			settings: buildSettings(wiring),
			sources,
			rulesDir: store({}),
			rulesFallbackDir: store({ "core-only": "c".repeat(7) }),
			capFile: CAP_FILE,
		});
		expect(r.tools.Bash.bytes).toBe(7);
	});

	it("inherits no ambient fallback where the option is omitted, and restores it after", () => {
		const ambient = store({ "core-only": "c".repeat(7) });
		process.env.WFC_RULES_FALLBACK_DIR = ambient;
		try {
			expect(() => figures(wiring, sources, {})).toThrow(/core-only/);
			expect(process.env.WFC_RULES_FALLBACK_DIR).toBe(ambient);
		} finally {
			delete process.env.WFC_RULES_FALLBACK_DIR;
		}
	});
});
