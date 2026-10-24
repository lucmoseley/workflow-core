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

const CAP_FILE = path.join(__dirname, "guard-parse.sh");

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
function settingsOf(wiring: Record<string, string[]>) {
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

/** A guard whose only content is its gp_rule calls, one per line. */
function guard(...calls: string[][]): string {
	return `#!/usr/bin/env bash\n${calls
		.map((ids) => `gp_rule ${ids.join(" ")}\n`)
		.join("")}`;
}

/**
 * A guard that reaches its ids through DIRECT accessor calls instead — the
 * shape a guard uses when it splices rule text into wording of its own.
 */
function directGuard(...ids: string[]): string {
	return `#!/usr/bin/env bash\n${ids
		.map((id) => `  ${slot(id)}="$(rule_text ${id} 2>/dev/null)"\n`)
		.join("")}`;
}

/** The variable one id's fetched text lands in, ids carrying hyphens. */
function slot(id: string): string {
	return `text_${id.replace(/-/g, "_")}`;
}

/**
 * The same, with the per-session bound a splicing guard may put on its own
 * repeat (mantahostels#2275) — guard-vitest-wrapper.sh's shape.
 *
 * The emission spends the fetched text rather than a literal: the bound is
 * correlated against the emission (mantahostels#2354), and a guard that fetches
 * without emitting is not the shape being modelled.
 */
function latchedGuard(...ids: string[]): string {
	return `${directGuard(...ids)}${ids
		.map(
			(id) =>
				`if gp_rule_told ${id}; then gp_warn "$${slot(id)}"; fi\ngp_rule_mark_told ${id}\n`,
		)
		.join("")}`;
}

/**
 * A guard that fetches ONCE inside a helper and emits that helper's output from
 * two places, one behind the bound and one not — the shape mantahostels#2354 was raised on,
 * and the one a fetch-site count reads as `bounded`.
 */
function helperTwoPathGuard(id: string): string {
	return [
		"#!/usr/bin/env bash",
		`${id.replace(/-/g, "_")}_rule() {`,
		"  local text",
		`  text="$(rule_text ${id} 2>/dev/null)"`,
		`  printf '%s' "$text"`,
		"}",
		`if gp_rule_told ${id}; then`,
		`  gp_warn "short: $(${id.replace(/-/g, "_")}_rule)"`,
		"fi",
		`gp_context "$(${id.replace(/-/g, "_")}_rule)"`,
		`gp_rule_mark_told ${id}`,
		"",
	].join("\n");
}

/**
 * A guard with TWO emission paths for one id and a bound in front of only one
 * of them — the shape mantahostels#2283 was raised on.
 */
function twoPathGuard(id: string): string {
	return [
		"#!/usr/bin/env bash",
		`if gp_rule_told ${id}; then`,
		`  gp_warn "short: $(rule_text ${id} 2>/dev/null)"`,
		"fi",
		`gp_deny "$(rule_text ${id} 2>/dev/null)"`,
		`gp_rule_mark_told ${id}`,
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
		settings: settingsOf(wiring),
		sources,
		rulesDir: store(fragments),
		capFile,
	});
}

const ALONE = "scripts/guard-alone.sh";

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

/** What reachableByTool reads off one guard's gp_rule calls, wired alone. */
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
 * How reachableByTool reads the bound on `id` once `text` is told and marked
 * on it: `bounded` only where the text holds exactly one fetch site and
 * exactly one emission site that can spend the fragment (mantahostels#2354),
 * `ambiguous` for any other count of either.
 */
function boundOf(text: string, id: string) {
	return census(`${text}\ngp_rule_told ${id}\ngp_rule_mark_told ${id}\n`, [id])[
		id
	];
}

describe("summing a group", () => {
	it("adds every guard wired on the tool", () => {
		// 10 B + 20 B, each a single-fragment call with no join.
		const r = figures(
			{ Bash: ["scripts/guard-a.sh", "scripts/guard-b.sh"] },
			{
				"scripts/guard-a.sh": guard(["alpha"]),
				"scripts/guard-b.sh": guard(["beta"]),
			},
			{ alpha: "a".repeat(10), beta: "b".repeat(20) },
		);
		expect(r.tools.Bash.bytes).toBe(30);
		expect(r.tools.Bash.guards.map((g: Guard) => g.file)).toEqual([
			"scripts/guard-b.sh",
			"scripts/guard-a.sh",
		]);
	});

	it("reports a tool whose group emits nothing as zero, not as absent", () => {
		const r = figures(
			{ Bash: ["scripts/guard-a.sh"], Skill: ["scripts/guard-quiet.sh"] },
			{
				"scripts/guard-a.sh": guard(["alpha"]),
				"scripts/guard-quiet.sh": "#!/usr/bin/env bash\nexit 0\n",
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
			{ Bash: ["scripts/guard-two.sh"] },
			{ "scripts/guard-two.sh": guard(["big"], ["small"]) },
			{ big: "b".repeat(30), small: "s".repeat(10) },
		);
		expect(r.tools.Bash.bytes).toBe(40);
		expect(r.tools.Bash.guards[0].calls).toBe(2);
	});

	it("pays an id named by two calls once, as the latch does", () => {
		const r = figures(
			{ Bash: ["scripts/guard-dup.sh"] },
			{ "scripts/guard-dup.sh": guard(["shared", "one"], ["shared", "two"]) },
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
			{ Bash: ["scripts/guard-a.sh", "scripts/guard-b.sh"] },
			{
				"scripts/guard-a.sh": guard(["shared", "alpha"]),
				"scripts/guard-b.sh": guard(["shared", "beta"]),
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
				"Write|Edit": ["scripts/guard-claim.sh"],
				Bash: ["scripts/guard-a.sh"],
			},
			{
				"scripts/guard-claim.sh": guard(["claim"]),
				"scripts/guard-a.sh": guard(["alpha"]),
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
			{ "": ["scripts/guard-everywhere.sh"] },
			{ "scripts/guard-everywhere.sh": guard(["everywhere"]) },
			{ everywhere: "e".repeat(700) },
		);
		expect(Object.keys(r.tools)).toEqual([]);
		expect(r.ratchet.bytes).toBe(700);
	});

	it("counts a match-all matcher into every tool a neighbour's matcher names", () => {
		// Claude Code reads "" as match-all; anchoring it literally gives /^()$/,
		// which would drop the guard from every group.
		const r = figures(
			{ "": ["scripts/guard-everywhere.sh"], Bash: ["scripts/guard-a.sh"] },
			{
				"scripts/guard-everywhere.sh": guard(["everywhere"]),
				"scripts/guard-a.sh": guard(["alpha"]),
			},
			{ everywhere: "e".repeat(700), alpha: "a".repeat(10) },
		);
		expect(r.tools.Bash.bytes).toBe(710);
	});
});

describe("the cap", () => {
	it("counts a call over GP_RULE_CAP in full, the deferred tail arriving later", () => {
		// 6,000 B offered against a 4,000 B ceiling. On ONE event gp_rule defers
		// the second fragment whole; unlatched, it lands on the next event, so a
		// session pays both.
		const r = figures(
			{ Bash: ["scripts/guard-fat.sh"] },
			{ "scripts/guard-fat.sh": guard(["one", "two"]) },
			{ one: "1".repeat(3000), two: "2".repeat(3000) },
		);
		expect(r.cap).toBe(4000);
		expect(r.tools.Bash.bytes).toBe(6000);
	});

	it("reports, rather than throws, a fragment over the cap on its own (mantahostels#2054)", () => {
		// gp_rule can never emit it whole — offered first, it exits 2 and denies
		// the tool call outright — but that is the repo's own rule text, not this
		// module's apparatus, so it is named in `overCap` rather than thrown.
		const r = figures(
			{ Bash: ["scripts/guard-huge.sh"] },
			{ "scripts/guard-huge.sh": guard(["whale", "minnow"]) },
			{ whale: "w".repeat(4001), minnow: "m".repeat(10) },
		);
		expect(r.overCap).toEqual([
			{ id: "whale", bytes: 4001, guards: ["scripts/guard-huge.sh"] },
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
			{ Bash: ["scripts/guard-huge.sh"] },
			{ "scripts/guard-huge.sh": guard(["whale", "minnow"]) },
			{ whale: "w".repeat(4001), minnow: "m".repeat(10) },
		);
		expect(r.fragmentBytes).toEqual({ whale: 4001, minnow: 10 });
	});

	it("reports an over-cap fragment behind a full call, not just a leading one", () => {
		// This module resolves every id in the call regardless of position, so a
		// lazy resolution that stopped at the first over-cap id would still have
		// to report this one.
		const r = figures(
			{ Bash: ["scripts/guard-late.sh"] },
			{ "scripts/guard-late.sh": guard(["first", "whale"]) },
			{ first: "f".repeat(3900), whale: "w".repeat(4001) },
		);
		expect(r.overCap).toEqual([
			{ id: "whale", bytes: 4001, guards: ["scripts/guard-late.sh"] },
		]);
		expect(r.tools.Bash.bytes).toBe(3900);
		expect(r.tools.Bash.ids).toEqual(["first"]);
	});

	it("names every guard that reaches one over-cap fragment, once", () => {
		const r = figures(
			{ Bash: ["scripts/guard-a.sh"], Write: ["scripts/guard-b.sh"] },
			{
				"scripts/guard-a.sh": guard(["whale"]),
				"scripts/guard-b.sh": guard(["whale"]),
			},
			{ whale: "w".repeat(4001) },
		);
		expect(r.overCap).toEqual([
			{
				id: "whale",
				bytes: 4001,
				guards: ["scripts/guard-a.sh", "scripts/guard-b.sh"],
			},
		]);
	});

	it("resolves every id in a call, so a missing fragment anywhere throws, naming the id", () => {
		expect(() =>
			figures(
				{ Bash: ["scripts/guard-deferred.sh"] },
				{ "scripts/guard-deferred.sh": guard(["first", "nosuchrule"]) },
				{ first: "f".repeat(3900) },
			),
		).toThrow(/no fragment for rule id "nosuchrule"/);
	});

	it("reads GP_RULE_CAP from the bash library rather than restating it", () => {
		const src = fs.readFileSync(CAP_FILE, "utf8");
		expect(lib.gpRuleCap(CAP_FILE)).toBe(
			Number(/^[ \t]*GP_RULE_CAP=(\d+)[ \t]*$/m.exec(src)?.[1]),
		);
	});

	it("throws rather than defaulting where the assignment is missing", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rule-emission-cap-"));
		temps.push(dir);
		const file = path.join(dir, "guard-parse.sh");
		fs.writeFileSync(file, "#!/usr/bin/env bash\n# no cap here\n");
		expect(() => lib.gpRuleCap(file)).toThrow(
			/^rule-emission: no anchored GP_RULE_CAP=<digits> assignment/,
		);
	});

	it("throws where the cap source cannot be read at all, naming the path", () => {
		expect(() => lib.gpRuleCap("/nonexistent/guard-parse.sh")).toThrow(
			/^rule-emission: cannot read \/nonexistent\/guard-parse\.sh/,
		);
	});
});

describe("gp_rule_skip", () => {
	/** A guard whose skips sit behind conditions. */
	function scoped(emitted: string[], skipped: string[]): string {
		return (
			"#!/usr/bin/env bash\n" +
			skipped
				.map(
					(id) => `if ! paths_match '^docs/'; then\n  gp_rule_skip ${id}\nfi\n`,
				)
				.join("") +
			`gp_rule ${emitted.join(" ")}\n`
		);
	}

	it("never lowers the figure: a skip sits behind a condition that may not fire", () => {
		// A ceiling assumes every skip stays quiet, so all three ids are reachable.
		const r = figures(
			{ Bash: ["scripts/guard-free.sh"] },
			{ "scripts/guard-free.sh": scoped(["lead", "mid", "tail"], ["mid"]) },
			{ lead: "l".repeat(500), mid: "m".repeat(900), tail: "t".repeat(3000) },
		);
		expect(r.tools.Bash.bytes).toBe(4400);
	});

	it("never raises the figure either", () => {
		// The session unit sums every reachable id, skipped or not, so the guard
		// with skips and the guard without them agree.
		const withSkip = figures(
			{ Bash: ["scripts/guard-both.sh"] },
			{
				"scripts/guard-both.sh": scoped(["lead", "a", "b", "tail"], ["a", "b"]),
			},
			{
				lead: "l".repeat(400),
				a: "a".repeat(500),
				b: "b".repeat(500),
				tail: "t".repeat(3500),
			},
		);
		const without = figures(
			{ Bash: ["scripts/guard-plain.sh"] },
			{ "scripts/guard-plain.sh": guard(["lead", "a", "b", "tail"]) },
			{
				lead: "l".repeat(400),
				a: "a".repeat(500),
				b: "b".repeat(500),
				tail: "t".repeat(3500),
			},
		);
		expect(withSkip.tools.Bash.bytes).toBe(4900);
		expect(without.tools.Bash.bytes).toBe(4900);
	});

	it("is not read as a gp_rule call", () => {
		expect(
			reached("#!/usr/bin/env bash\ngp_rule_skip alpha\ngp_rule beta\n", [
				"alpha",
				"beta",
			]),
		).toEqual({ calls: 1, ids: ["beta"] });
	});
});

describe("gp_rule_module (#449) and gp_rule_unless_module (#2409)", () => {
	const src =
		"#!/usr/bin/env bash\ngp_rule_module governance mid\ngp_rule_unless_module governance old\ngp_rule lead mid old\n";
	const reach = (modules: string) => {
		const before = process.env.WFC_MODULES;
		process.env.WFC_MODULES = modules;
		try {
			return figures(
				{ Bash: ["scripts/guard-mod.sh"] },
				{ "scripts/guard-mod.sh": src },
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
				{ Bash: ["scripts/guard-bad.sh"] },
				{ "scripts/guard-bad.sh": "gp_rule_module nosuch mid\ngp_rule mid\n" },
				{ mid: "m" },
			),
		).toThrow(/guard-bad\.sh: no module "nosuch"/);
	});
});

/** A gp_rule call's expansion of table `name`, as the guard spells it. */
const idsOf = (name: string) => `"$\{${name}[@]%% *}"`;

describe("a gp_rule_path_rows table (#2302)", () => {
	const src = [
		"#!/usr/bin/env bash",
		"rows=(",
		"  # A comment between rows (#1).",
		'  "gated docs/a.md governance"',
		'  "plain docs/b.md"',
		")",
		'gp_rule_path_rows "$rel" rows',
		`gp_rule lead ${idsOf("rows")} tail`,
		"",
	].join("\n");
	const reach = (modules: string, text = src) => {
		const before = process.env.WFC_MODULES;
		process.env.WFC_MODULES = modules;
		try {
			return figures(
				{ Bash: ["scripts/guard-tab.sh"] },
				{ "scripts/guard-tab.sh": text },
				{
					lead: "l".repeat(100),
					gated: "g".repeat(200),
					plain: "p".repeat(400),
					tail: "t".repeat(800),
				},
			);
		} finally {
			if (before === undefined) delete process.env.WFC_MODULES;
			else process.env.WFC_MODULES = before;
		}
	};

	it("charges every row's id and the ids after the expansion", () => {
		expect(reach("governance").tools.Bash.bytes).toBe(1500);
	});

	it("leaves out a row whose module the host has off", () => {
		const r = reach("roadmap");
		expect(r.tools.Bash.bytes).toBe(1300);
		expect(r.ratchet.ids).not.toContain("gated");
	});

	it("throws, naming the guard, where the expansion names no table", () => {
		expect(() =>
			reach("governance", `gp_rule lead ${idsOf("nope")} tail\n`),
		).toThrow(/guard-tab\.sh: no literal nope=\(/);
	});
});

describe("the join", () => {
	it("is not counted: how ids fall across deliveries is not statically known", () => {
		// Three fragments, 60 B — never 64. gp_rule's 2 B separator is per
		// delivery, and a session's deliveries are not fixed.
		const r = figures(
			{ Bash: ["scripts/guard-three.sh"] },
			{ "scripts/guard-three.sh": guard(["a", "b", "c"]) },
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
			{ Bash: ["scripts/guard-utf8.sh"] },
			{ "scripts/guard-utf8.sh": guard(["dashes"]) },
			{ dashes: body },
		);
		expect(r.tools.Bash.bytes).toBe(24);
	});
});

describe("overlapping matchers", () => {
	it("counts a guard into every tool its matcher covers, once each", () => {
		const r = figures(
			{
				Bash: ["scripts/guard-a.sh"],
				"Bash|Read|ListAgents": ["scripts/guard-poll.sh"],
			},
			{
				"scripts/guard-a.sh": guard(["alpha"]),
				"scripts/guard-poll.sh": guard(["poll"]),
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
				Bash: ["scripts/guard-poll.sh"],
				"Bash|Read": ["scripts/guard-poll.sh"],
			},
			{ "scripts/guard-poll.sh": guard(["poll"]) },
			{ poll: "p".repeat(40) },
		);
		expect(r.tools.Bash.bytes).toBe(40);
		expect(r.tools.Bash.guards).toHaveLength(1);
	});

	it("keeps a `Bash` guard out of the `BashOutput` group", () => {
		// An unanchored matcher test would charge BashOutput for every Bash guard.
		const r = figures(
			{ Bash: ["scripts/guard-a.sh"], BashOutput: ["scripts/guard-out.sh"] },
			{
				"scripts/guard-a.sh": guard(["alpha"]),
				"scripts/guard-out.sh": guard(["out"]),
			},
			{ alpha: "a".repeat(10), out: "o".repeat(7) },
		);
		expect(r.tools.Bash.bytes).toBe(10);
		expect(r.tools.BashOutput.bytes).toBe(7);
	});

	it("anchors the matcher, so Write does not answer for WriteFile", () => {
		const settings = settingsOf({
			Write: ["scripts/guard-w.sh"],
			"Write|Edit": ["scripts/guard-we.sh"],
			WriteFile: ["scripts/guard-wf.sh"],
		});
		/* No matcher at all — the settings shape of an event that takes none —
		 * covers every tool. */
		settings.hooks.PreToolUse.push({
			hooks: [
				{
					type: "command",
					command: '"$CLAUDE_PROJECT_DIR"/scripts/guard-any.sh',
				},
			],
		} as (typeof settings.hooks.PreToolUse)[number]);
		const r = lib.reachableByTool({
			settings,
			sources: {
				"scripts/guard-w.sh": guard(["w"]),
				"scripts/guard-we.sh": guard(["we"]),
				"scripts/guard-wf.sh": guard(["wf"]),
				"scripts/guard-any.sh": guard(["any"]),
			},
			rulesDir: store({ w: "w", we: "we", wf: "wf", any: "any" }),
			capFile: CAP_FILE,
		}) as Figures;
		const files = (tool: string) =>
			r.tools[tool].guards.map((g: Guard) => g.file).sort();
		expect(files("Write")).toEqual([
			"scripts/guard-any.sh",
			"scripts/guard-w.sh",
			"scripts/guard-we.sh",
		]);
		expect(files("Edit")).toEqual([
			"scripts/guard-any.sh",
			"scripts/guard-we.sh",
		]);
		expect(files("WriteFile")).toEqual([
			"scripts/guard-any.sh",
			"scripts/guard-wf.sh",
		]);
	});
});

describe("an unwired guard", () => {
	it("is excluded from every group", () => {
		const r = figures(
			{ Bash: ["scripts/guard-a.sh"] },
			{
				"scripts/guard-a.sh": guard(["alpha"]),
				"scripts/guard-unwired.sh": guard(["huge"]),
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
				{ Bash: ["scripts/guard-a.sh", "scripts/guard-absent.sh"] },
				{ "scripts/guard-a.sh": guard(["alpha"]) },
				{ alpha: "a" },
			),
		).toThrow(
			/^rule-emission: the wiring names scripts\/guard-absent\.sh, which the supplied sources do not carry/,
		);
	});

	it("throws where a wired guard is missing from disk, naming the guard", () => {
		expect(() =>
			lib.reachableByTool({
				settings: settingsOf({ Bash: ["scripts/guard-not-there.sh"] }),
				capFile: CAP_FILE,
			}),
		).toThrow(/cannot read scripts\/guard-not-there\.sh/);
	});
});

describe("the default wiring", () => {
	it("is the self-plugin's file then its settings at a materialised core tree (#2456, #2572)", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "rule-emission-tree-"));
		temps.push(root);
		const files: [string, Record<string, string[]>][] = [
			["self-plugin/hooks/hooks.json", { Bash: ["scripts/guard-self.sh"] }],
			[".claude/settings.json", { Edit: ["scripts/guard-settings.sh"] }],
		];
		for (const [rel, wiring] of files) {
			fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
			fs.writeFileSync(
				path.join(root, rel),
				JSON.stringify(settingsOf(wiring)),
			);
		}
		const out: Figures = lib.reachableByTool({
			root,
			sources: {
				"scripts/guard-self.sh": guard(["alpha"]),
				"scripts/guard-settings.sh": guard(["beta"]),
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
						{ command: "node", args: ["scripts/guard-a.sh", "--strict"] },
					],
				},
			],
		},
	};

	it("joins command and args into the one line the transcript records", () => {
		expect(lib.hookCommandLine({ command: "node", args: ["a.js", "x"] })).toBe(
			"node a.js x",
		);
	});

	it("contributes nothing for an args that is not an array of strings", () => {
		expect(lib.hookCommandLine({ command: "node", args: "a.js" })).toBe("node");
		expect(lib.hookCommandLine({ command: "node", args: [3] })).toBe("node");
	});

	it("counts a guard whose path is held in args into its tool's group", () => {
		const r = lib.reachableByTool({
			settings: execFormSettings,
			sources: { "scripts/guard-a.sh": guard(["alpha"]) },
			rulesDir: store({ alpha: "a".repeat(10) }),
			capFile: CAP_FILE,
		}) as Figures;
		expect(r.tools.Bash.bytes).toBe(10);
		expect(r.tools.Bash.guards.map((g: Guard) => g.file)).toEqual([
			"scripts/guard-a.sh",
		]);
	});

	it("flattens the registration onto a commandLine field", () => {
		expect(lib.registrationsOn(execFormSettings, "PreToolUse")).toEqual([
			{ matcher: "Bash", commandLine: "node scripts/guard-a.sh --strict" },
		]);
	});
});

describe("a call naming an id with no fragment", () => {
	it("throws through rule-text rather than counting as zero, naming the unknown rule id", () => {
		expect(() =>
			figures(
				{ Bash: ["scripts/guard-typo.sh"] },
				{ "scripts/guard-typo.sh": guard(["nosuchrule"]) },
				{ alpha: "a" },
			),
		).toThrow(/no fragment for rule id "nosuchrule"/);
	});
});

describe("reading the calls", () => {
	it("takes ids from a statement-initial call and ignores a commented one", () => {
		expect(
			reached("# gp_rule commented-out\ngp_rule real-one 'quoted'\n", [
				"commented-out",
				"real-one",
				"quoted",
			]),
		).toEqual({ calls: 1, ids: ["real-one", "quoted"] });
	});

	it("yields a repeated id once, as gp_rule's own latch loop does", () => {
		expect(reached("gp_rule same same other\n", ["same", "other"])).toEqual({
			calls: 1,
			ids: ["same", "other"],
		});
	});

	// Without the prefix in the argument run, a prefixed token would end the run
	// and every id after it would vanish (mantahostels#2719).
	it("bares a `rule:` prefix and does not let it truncate the run", () => {
		expect(
			reached("gp_rule rule:alpha beta\n", ["alpha", "beta", "rule"]),
		).toEqual({ calls: 1, ids: ["alpha", "beta"] });
	});

	it("yields one id where a call names both spellings", () => {
		expect(reached("gp_rule rule:same same\n", ["same", "rule"])).toEqual({
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
		expect(reached("gp_rule rule:-x\n", ["rule", "x"])).toEqual({
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
		const told = `${directGuard("alpha")}if gp_rule_told rule:alpha; then gp_warn "$${slot("alpha")}"; fi\n`;
		for (const mark of [
			"gp_rule_mark_told rule:alpha",
			"gp_rule_latch_after rule:alpha",
		]) {
			const r = alone(`${told}${mark}\n`, ["alpha", "rule"]);
			expect(r.direct.map((d) => [d.id, d.latched])).toEqual([
				["alpha", "bounded"],
			]);
			expect(r.latchFaults).toEqual([]);
		}
	});
});

describe("agreement with scripts/lib/hook-wiring.ts", () => {
	/* The settings are this repo's real ones; the guard sources and the fragment
	 * store are not. */
	function liveSettingsFigures() {
		const settings = readCoreHooks();
		const wired = new Set<string>();
		for (const entry of settings.hooks?.PreToolUse ?? [])
			for (const h of entry.hooks ?? [])
				for (const m of (h.command ?? "").matchAll(lib.WIRED_SCRIPT_RE))
					wired.add(m[1]);
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
					hookIsWired("PreToolUse", path.basename(g.file), tool, settings),
					`${g.file} counted into ${tool}`,
				).toBe(true);
	});

	it("counts a guard into every tool hookIsWired says it is wired on", () => {
		/* A group silently dropped is the under-report a gate exists to catch. */
		const { settings, wired, figures: liveFigures } = liveSettingsFigures();
		for (const tool of Object.keys(liveFigures.tools))
			for (const rel of wired) {
				if (!hookIsWired("PreToolUse", path.basename(rel), tool, settings))
					continue;
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
				{ "*": ["scripts/guard-star.sh"], Bash: ["scripts/guard-a.sh"] },
				{
					"scripts/guard-star.sh": guard(["alpha"]),
					"scripts/guard-a.sh": guard(["alpha"]),
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
			{ Bash: ["scripts/guard-refuser.sh"] },
			{ "scripts/guard-refuser.sh": directGuard("spliced") },
			{ spliced: "s".repeat(700) },
		);
		expect(r.direct).toEqual([
			{
				id: "spliced",
				bytes: 700,
				guards: ["scripts/guard-refuser.sh"],
				counted: false,
				latched: "none",
			},
		]);
		expect(r.tools.Bash.bytes).toBe(0);
		expect(r.ratchet.bytes).toBe(0);
		// Still in fragmentBytes, though no cap prices it: an id can move between
		// the routes, and a commit adding a gp_rule call for this one would
		// otherwise have no baseline reading to be measured against (mantahostels#2260).
		expect(r.fragmentBytes).toEqual({ spliced: 700 });
	});

	it("still lists an id gp_rule also reaches, flagged rather than dropped", () => {
		// guard-branch.sh is the live shape: it emits branch-shared-tree
		// pre-emptively AND splices the same fragment into its denial. The figures
		// buy the once-a-session pre-emission and never the per-denial repeats.
		const g = `${guard(["both"])}${directGuard("both")}`;
		const r = figures(
			{ Bash: ["scripts/guard-two-routes.sh"] },
			{ "scripts/guard-two-routes.sh": g },
			{ both: "b".repeat(50) },
		);
		expect(r.direct).toEqual([
			{
				id: "both",
				bytes: 50,
				guards: ["scripts/guard-two-routes.sh"],
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
				Bash: ["scripts/guard-emitter.sh"],
				Write: ["scripts/guard-splicer.sh"],
			},
			{
				"scripts/guard-emitter.sh": guard(["wandering"]),
				"scripts/guard-splicer.sh": directGuard("wandering"),
			},
			{ wandering: "w".repeat(40) },
		);
		expect(r.direct).toEqual([
			{
				id: "wandering",
				bytes: 40,
				guards: ["scripts/guard-splicer.sh"],
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
			{ Bash: ["scripts/guard-b.sh", "scripts/guard-a.sh"] },
			{
				"scripts/guard-b.sh": directGuard("shared"),
				"scripts/guard-a.sh": directGuard("shared"),
			},
			{ shared: "x".repeat(9) },
		);
		expect(r.direct).toEqual([
			{
				id: "shared",
				bytes: 9,
				guards: ["scripts/guard-a.sh", "scripts/guard-b.sh"],
				counted: false,
				latched: "none",
			},
		]);
	});

	it("reports an unresolvable id at null bytes rather than throwing", () => {
		// A gp_rule call naming a missing fragment exits 2 and denies the tool
		// call, so this module throws on one. A direct call falls back to the
		// guard's own hardcoded sentence and still fires, so the same id is a
		// census entry.
		const r = figures(
			{ Bash: ["scripts/guard-fallback.sh"] },
			{ "scripts/guard-fallback.sh": directGuard("absent") },
			{},
		);
		expect(r.direct).toEqual([
			{
				id: "absent",
				bytes: null,
				guards: ["scripts/guard-fallback.sh"],
				counted: false,
				latched: "none",
			},
		]);
	});

	it("lists a fragment over GP_RULE_CAP that a direct call still delivers", () => {
		// The one id in two blocks: overCap says gp_rule can never emit it, and
		// the census says the guard's own wording does anyway.
		const r = figures(
			{ Bash: ["scripts/guard-huge-both.sh"] },
			{
				"scripts/guard-huge-both.sh": `${guard(["whale"])}${directGuard("whale")}`,
			},
			{ whale: "w".repeat(4001) },
		);
		expect(r.overCap).toEqual([
			{ id: "whale", bytes: 4001, guards: ["scripts/guard-huge-both.sh"] },
		]);
		expect(r.direct).toEqual([
			{
				id: "whale",
				bytes: 4001,
				guards: ["scripts/guard-huge-both.sh"],
				counted: false,
				latched: "none",
			},
		]);
	});

	it("sorts by bytes descending, an unresolvable id reading as zero", () => {
		const r = figures(
			{ Bash: ["scripts/guard-many.sh"] },
			{ "scripts/guard-many.sh": directGuard("small", "gone", "big") },
			{ small: "s".repeat(10), big: "b".repeat(100) },
		);
		expect(r.direct.map((d) => d.id)).toEqual(["big", "small", "gone"]);
	});

	it("flags a fragment whose caller bounds its own repeat (mantahostels#2275)", () => {
		const r = figures(
			{ Bash: ["scripts/guard-warner.sh"] },
			{ "scripts/guard-warner.sh": latchedGuard("bounded") },
			{ bounded: "b".repeat(1227) },
		);
		expect(r.direct).toEqual([
			{
				id: "bounded",
				bytes: 1227,
				guards: ["scripts/guard-warner.sh"],
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
			{ Bash: ["scripts/guard-bounded.sh", "scripts/guard-loose.sh"] },
			{
				"scripts/guard-bounded.sh": latchedGuard("shared"),
				"scripts/guard-loose.sh": directGuard("shared"),
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
				"scripts/lib/helper.sh": directGuard("hidden"),
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
		const rel = "scripts/lib/guard-parse.sh";
		const text = fs.readFileSync(path.join(__dirname, "..", "..", rel), "utf8");
		// Every lib read as empty, so the walk stops at the libs this one names.
		expect([...lib.sourcedClosure(rel, text, () => "").keys()]).toEqual([
			"scripts/lib/guard-log.sh",
			"scripts/lib/guard-root.sh",
			"scripts/lib/marker-root.sh",
			"scripts/lib/wfc-config.sh",
			"scripts/lib/script-path.sh",
			"scripts/lib/rule-text.sh",
		]);
	});

	it("reads a bound spent inside a sourced lib as ambiguous (mantahostels#2488)", () => {
		/* The emission census keeps the guard's OWN text, so a fetch it makes and a lib
		 * helper emits is a bound this cannot correlate — `ambiguous`, a bound
		 * withdrawn rather than one invented (rule-emission.js §effectiveSource). */
		const r = figures(
			{ Bash: ["scripts/guard-thin.sh"] },
			{
				"scripts/guard-thin.sh":
					'#!/usr/bin/env bash\nsource lib/helper.sh\ntext="$(rule_text spent 2>/dev/null)"\nif gp_rule_told spent; then emit "$text"; fi\ngp_rule_mark_told spent\n',
				"scripts/lib/helper.sh":
					'#!/usr/bin/env bash\nemit() { gp_warn "$1"; }\n',
			},
			{ spent: "s".repeat(40) },
		);
		expect(r.direct[0].latched).toBe("ambiguous");
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
			{ Bash: ["scripts/guard-two-paths.sh"] },
			{ "scripts/guard-two-paths.sh": twoPathGuard("split") },
			{ split: "s".repeat(900) },
		);
		expect(r.direct).toEqual([
			{
				id: "split",
				bytes: 900,
				guards: ["scripts/guard-two-paths.sh"],
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
			{ Bash: ["scripts/guard-clean.sh", "scripts/guard-two-paths.sh"] },
			{
				"scripts/guard-clean.sh": latchedGuard("split"),
				"scripts/guard-two-paths.sh": twoPathGuard("split"),
			},
			{ split: "s".repeat(30) },
		);
		expect(r.direct[0].latched).toBe("ambiguous");
	});

	it("prefers an outright unbounded caller to an ambiguous one", () => {
		const r = figures(
			{ Bash: ["scripts/guard-loose.sh", "scripts/guard-two-paths.sh"] },
			{
				"scripts/guard-loose.sh": directGuard("split"),
				"scripts/guard-two-paths.sh": twoPathGuard("split"),
			},
			{ split: "s".repeat(30) },
		);
		expect(r.direct[0].latched).toBe("none");
	});
});

describe("correlating a bound with the emission that spends it (mantahostels#2354)", () => {
	it("reads two emission paths behind one helper fetch as ambiguous", () => {
		const r = figures(
			{ Bash: ["scripts/guard-helper.sh"] },
			{ "scripts/guard-helper.sh": helperTwoPathGuard("split") },
			{ split: "s".repeat(900) },
		);
		expect(r.direct).toEqual([
			{
				id: "split",
				bytes: 900,
				guards: ["scripts/guard-helper.sh"],
				counted: false,
				latched: "ambiguous",
			},
		]);
		expect(r.latchFaults).toEqual([]);
	});

	it("follows a fetch through a heredoc-built variable to its emission", () => {
		// scripts/guard-branch.sh's shape: `read` fills the reason from a heredoc
		// that calls the helper, and gp_deny spends it.
		const text = [
			"#!/usr/bin/env bash",
			"rule_of() {",
			`  printf '%s' "$(rule_text shaped 2>/dev/null)"`,
			"}",
			"IFS= read -r -d '' reason <<EOF || :",
			"This is denied: @CMD@",
			"",
			"$(rule_of)",
			"EOF",
			'gp_deny "$reason" "$segment"',
			"",
		].join("\n");
		expect(boundOf(text, "shaped")).toBe("bounded");
	});

	it("credits no bound where it can find no emission at all", () => {
		const r = figures(
			{ Bash: ["scripts/guard-mute.sh"] },
			{
				"scripts/guard-mute.sh": [
					"#!/usr/bin/env bash",
					'  text="$(rule_text quiet 2>/dev/null)"',
					"if gp_rule_told quiet; then gp_warn literal; fi",
					"gp_rule_mark_told quiet",
					"",
				].join("\n"),
			},
			{ quiet: "q".repeat(40) },
		);
		expect(r.direct[0].latched).toBe("ambiguous");
	});

	it("follows a gp_rule_text fetch spliced into a heredoc to its emission (#772)", () => {
		const text = [
			"#!/usr/bin/env bash",
			"refuse() {",
			"  IFS= read -r -d '' reason <<EOF || :",
			"This is denied: @CMD@",
			"",
			'$(gp_rule_text shaped "$SHAPED_FALLBACK")',
			"EOF",
			'  gp_deny "$reason" "$1"',
			"}",
			'refuse "$segment"',
			"",
		].join("\n");
		expect(boundOf(text, "shaped")).toBe("bounded");
	});

	it("counts a shared emitting helper once per caller", () => {
		const text = [
			"#!/usr/bin/env bash",
			'text="$(rule_text shared 2>/dev/null)"',
			"emit() {",
			'  gp_context "$text"',
			"}",
			"if gp_rule_told shared; then emit; fi",
			"emit",
			"gp_rule_mark_told shared",
			"",
		].join("\n");
		expect(boundOf(text, "shared")).toBe("ambiguous");
	});

	it("counts an emitting helper nothing calls, its call site being unfindable", () => {
		const text = [
			"#!/usr/bin/env bash",
			'text="$(rule_text orphan 2>/dev/null)"',
			"emit() {",
			'  gp_context "$text"',
			"}",
			"",
		].join("\n");
		expect(boundOf(text, "orphan")).toBe("bounded");
	});

	it.each([
		["a one-line case arm", 'case "$k" in a) gp_context "$text" ;; esac'],
		["a subshell", '( gp_context "$text" )'],
		["a brace group", '{ gp_context "$text"; }'],
		["a background command", 'true & gp_context "$text"'],
	])("separates an emission behind %s", (_name, second) => {
		// Each of these is a SECOND path the splitter must not swallow into its
		// neighbour: a missed boundary is a bound invented, not withdrawn.
		const text = [
			"#!/usr/bin/env bash",
			'text="$(rule_text sneaky 2>/dev/null)"',
			'if gp_rule_told sneaky; then gp_warn "$text"; fi',
			second,
			"gp_rule_mark_told sneaky",
			"",
		].join("\n");
		expect(boundOf(text, "sneaky")).toBe("ambiguous");
	});

	it("reads a left shift as arithmetic, never as a heredoc", () => {
		// `<<` inside `$(( … ))` naming a variable reads as a heredoc opened on
		// `bits`, whose body then swallows the rest of the file and takes every
		// emission after it to zero.
		const text = [
			"#!/usr/bin/env bash",
			'text="$(rule_text shifty 2>/dev/null)"',
			"n=$(( 1 << bits ))",
			'gp_context "$text $n"',
			"",
		].join("\n");
		expect(boundOf(text, "shifty")).toBe("bounded");
	});

	it("survives a heredoc delimiter carrying regex metacharacters", () => {
		// An unescaped delimiter spliced into a RegExp throws.
		const text = [
			"#!/usr/bin/env bash",
			"cat <<'E(F'",
			"a body",
			"E(F",
			'gp_context "$(rule_text meta 2>/dev/null)"',
			"",
		].join("\n");
		expect(boundOf(text, "meta")).toBe("bounded");
	});

	it.each([
		["bare", "END"],
		["double-quoted", '"END"'],
		["single-quoted", "'END'"],
	])("closes a %s heredoc on its delimiter (#1341)", (_name, spelt) => {
		// A delimiter misread leaves the body open to the end of the file, which
		// swallows the emission after it and withdraws the bound.
		const text = [
			"#!/usr/bin/env bash",
			`cat <<${spelt}`,
			"a body",
			"END",
			'gp_context "$(rule_text spelt 2>/dev/null)"',
			"",
		].join("\n");
		expect(boundOf(text, "spelt")).toBe("bounded");
	});

	it("scopes every name a multi-name `local` declares", () => {
		// The carrier is the SECOND name deliberately: reading one name per
		// declaration passes a case where it is the first.
		const text = [
			"#!/usr/bin/env bash",
			"mine() {",
			"  local other text",
			'  text="$(rule_text multi 2>/dev/null)"',
			`  printf '%s' "$text"`,
			"}",
			"theirs() {",
			"  local other text",
			'  text="something else"',
			`  printf '%s' "$text"`,
			"}",
			'gp_warn "$(theirs)"',
			'gp_context "$(mine)"',
			"",
		].join("\n");
		expect(boundOf(text, "multi")).toBe("bounded");
	});

	it("lets a callee see the local of the function that calls it", () => {
		// bash scopes `local` dynamically, so the helper really can spend it.
		const text = [
			"#!/usr/bin/env bash",
			"show() {",
			'  gp_context "$text"',
			"}",
			"judge() {",
			"  local text",
			'  text="$(rule_text dynamic 2>/dev/null)"',
			"  show",
			"}",
			"judge",
			"",
		].join("\n");
		expect(boundOf(text, "dynamic")).toBe("bounded");
	});

	it("closes a function span at its own brace, not at one inside a heredoc", () => {
		// A `}` at column 0 inside a deny reason ends the span early, so the
		// emission below it reads at top level — counted once where the helper it
		// really sits in has two callers.
		const text = [
			"#!/usr/bin/env bash",
			"judge() {",
			"  IFS= read -r -d '' reason <<EOF || :",
			"a brace on its own line:",
			"}",
			"EOF",
			`  reason="$reason$(rule_text braced 2>/dev/null)"`,
			'  gp_deny "$reason"',
			"}",
			"judge one",
			"judge two",
			"",
		].join("\n");
		expect(boundOf(text, "braced")).toBe("ambiguous");
	});

	it("reads a one-line function body as its own scope", () => {
		const text = [
			"#!/usr/bin/env bash",
			`hold() { local text; text="$(rule_text oneline 2>/dev/null)"; printf '%s' "$text"; }`,
			'gp_context "$(hold)"',
			'gp_warn "$text"',
			"",
		].join("\n");
		// The trailing gp_warn reads a name local to `hold`, so it is not a site.
		expect(boundOf(text, "oneline")).toBe("bounded");
	});

	it("reaches a carrier the fixed point cannot find in one pass", () => {
		// `outer` is assigned from `inner` BEFORE inner is known to carry, so a
		// single pass misses it and credits a bound that covers one of two paths.
		const text = [
			"#!/usr/bin/env bash",
			'outer="$inner"',
			'inner="$(rule_text chained 2>/dev/null)"',
			'if gp_rule_told chained; then gp_warn "$inner"; fi',
			'gp_context "$outer"',
			"gp_rule_mark_told chained",
			"",
		].join("\n");
		expect(boundOf(text, "chained")).toBe("ambiguous");
	});

	it("does not count an emission spending a neighbour function's local", () => {
		const text = [
			"#!/usr/bin/env bash",
			"mine() {",
			"  local text",
			`  text="$(rule_text mine 2>/dev/null)"`,
			`  printf '%s' "$text"`,
			"}",
			"theirs() {",
			"  local text",
			'  text="something else"',
			`  printf '%s' "$text"`,
			"}",
			'gp_warn "$(theirs)"',
			'gp_context "$(mine)"',
			"",
		].join("\n");
		expect(boundOf(text, "mine")).toBe("bounded");
	});
});

describe("a bound that covers nothing (mantahostels#2283)", () => {
	it("names a gp_rule_told whose id no fragment answers to", () => {
		const r = figures(
			{ Bash: ["scripts/guard-typo.sh"] },
			{ "scripts/guard-typo.sh": latchedGuard("reel") },
			{ real: "r".repeat(40) },
		);
		expect(r.latchFaults).toEqual([
			{
				id: "reel",
				guard: "scripts/guard-typo.sh",
				resolves: false,
				bound: true,
				marked: true,
			},
		]);
	});

	it("names a gp_rule_told its own guard makes no direct call on", () => {
		const r = figures(
			{ Bash: ["scripts/guard-stray.sh"] },
			{
				"scripts/guard-stray.sh": `${directGuard("real")}if gp_rule_told other; then :; fi\ngp_rule_mark_told other\n`,
			},
			{ real: "r".repeat(40), other: "o".repeat(40) },
		);
		expect(r.latchFaults).toEqual([
			{
				id: "other",
				guard: "scripts/guard-stray.sh",
				resolves: true,
				bound: false,
				marked: true,
			},
		]);
		expect(r.direct[0].latched).toBe("none");
	});

	it("names a gp_rule_told its guard never marks, and withdraws the bound", () => {
		// The question is asked and never made true, so the fragment is paid on
		// every firing exactly as an unbounded one is.
		const r = figures(
			{ Bash: ["scripts/guard-unmarked.sh"] },
			{
				"scripts/guard-unmarked.sh": `${directGuard("real")}if gp_rule_told real; then :; fi\n`,
			},
			{ real: "r".repeat(40) },
		);
		expect(r.latchFaults).toEqual([
			{
				id: "real",
				guard: "scripts/guard-unmarked.sh",
				resolves: true,
				bound: true,
				marked: false,
			},
		]);
		expect(r.direct[0].latched).toBe("none");
	});

	it("says nothing where the bound covers its own call", () => {
		const r = figures(
			{ Bash: ["scripts/guard-warner.sh"] },
			{ "scripts/guard-warner.sh": latchedGuard("bounded") },
			{ bounded: "b".repeat(40) },
		);
		expect(r.latchFaults).toEqual([]);
	});
});

describe("counting a guard's direct call sites (mantahostels#2283)", () => {
	it("counts sites, not distinct ids", () => {
		// One emission either way, so only the second fetch site withdraws the bound.
		const fetch = '  text="$(rule_text split 2>/dev/null)"';
		const emit = 'gp_warn "$text"';
		expect(
			boundOf(["#!/usr/bin/env bash", fetch, emit].join("\n"), "split"),
		).toBe("bounded");
		expect(
			boundOf(["#!/usr/bin/env bash", fetch, fetch, emit].join("\n"), "split"),
		).toBe("ambiguous");
	});

	it("dedupes an id two sites name, keeping the count", () => {
		// A neighbour id's site never adds to this one's count.
		expect(census(latchedGuard("one", "two"), ["one", "two"])).toEqual({
			one: "bounded",
			two: "bounded",
		});
	});
});

describe("reading a caller's own bound (mantahostels#2275)", () => {
	const ids = ["plain", "quoted", "ticked"];
	const emit = (id: string) => `gp_warn "$${slot(id)}"`;
	const marks = (...told: string[]) =>
		told.map((id) => `gp_rule_mark_told ${id}\n`).join("");

	it("takes the id bare, quoted, and behind the `if` a test carries", () => {
		const text = [
			directGuard(...ids),
			"gp_rule_told plain",
			emit("plain"),
			`if gp_rule_told "quoted"; then ${emit("quoted")}; fi`,
			`if ! gp_rule_told 'ticked'; then ${emit("ticked")}; fi`,
			"gp_rule_told plain",
			marks(...ids),
		].join("\n");
		expect(census(text, ids)).toEqual({
			plain: "bounded",
			quoted: "bounded",
			ticked: "bounded",
		});
	});

	it("reads a mention in a header as no bound, the safe direction", () => {
		// A pattern that cannot see a call under-reports rather than claiming a
		// bound the guard does not have.
		const text = [
			directGuard("discussed", "trailing"),
			"# gp_rule_told discussed — a comment, not a call",
			"case x in y) gp_rule_told trailing ;; esac",
			emit("discussed"),
			emit("trailing"),
			marks("discussed", "trailing"),
		].join("\n");
		expect(census(text, ["discussed", "trailing"])).toEqual({
			discussed: "none",
			trailing: "none",
		});
	});
});

describe("reading the mark, in both its spellings (mantahostels#2528)", () => {
	const told = (id: string) =>
		`if gp_rule_told ${id}; then gp_warn "$${slot(id)}"; fi`;

	it("reads `gp_rule_latch_after` as a mark, as it reads `gp_rule_mark_told`", () => {
		// The same record deferred: gp_rule exits, so a caller whose emission is
		// gp_rule's own hands it the key instead of writing the mark itself.
		const ids = ["written", "deferred", "quoted"];
		const text = [
			directGuard(...ids),
			...ids.map(told),
			"gp_rule_mark_told written",
			"gp_rule_latch_after deferred",
			'gp_rule_latch_after "quoted"',
			"",
		].join("\n");
		expect(census(text, ids)).toEqual({
			deferred: "bounded",
			quoted: "bounded",
			written: "bounded",
		});
	});

	it("reads the function's own definition as no mark", () => {
		// guard-parse.sh is inside every guard's effective source since mantahostels#2488, so
		// `gp_rule_latch_after() { … }` would otherwise mark a rule named for the
		// next word in the file.
		const text = [
			directGuard("discussed"),
			told("discussed"),
			'gp_rule_latch_after() { _gp_rule_prelude_latch="$1"; }',
			"# gp_rule_latch_after discussed — a comment, not a call",
			"",
		].join("\n");
		const r = alone(text, ["discussed"]);
		expect(r.direct.map((d) => [d.id, d.latched])).toEqual([
			["discussed", "none"],
		]);
		expect(r.latchFaults).toEqual([
			{
				id: "discussed",
				guard: ALONE,
				resolves: true,
				bound: true,
				marked: false,
			},
		]);
	});

	it("closes the bound a `gp_rule_told` opens, so no latch fault is raised", () => {
		const r = figures(
			{ Bash: ["scripts/guard-deferred.sh"] },
			{
				"scripts/guard-deferred.sh": `${directGuard("real")}if gp_rule_told real; then :; fi\ngp_rule_latch_after real\n`,
			},
			{ real: "r".repeat(40) },
		);
		expect(r.latchFaults).toEqual([]);
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
		// time; `_gp_load_rule_text` and `xgp_rule_text` are different words.
		const text = [
			"#!/usr/bin/env bash",
			"  declare -F rule_text >/dev/null 2>&1",
			'  rule_text "$1"',
			"  _gp_load_rule_text something",
			"  xgp_rule_text something",
		].join("\n");
		expect(census(text, ["something", "1"])).toEqual({});
	});

	it("reads lib/guard-parse.sh's fallback fetch as a direct call (#772)", () => {
		const text = [
			"#!/usr/bin/env bash",
			'  a="$(gp_rule_text plain "fallback")"',
			'  b="$(gp_rule_text "rule:quoted" "$FALLBACK")"',
		].join("\n");
		expect(census(text, ["plain", "quoted", "fallback", "rule"])).toEqual({
			plain: "none",
			quoted: "none",
		});
	});

	it("finds no id where the guard makes no direct call", () => {
		expect(census(guard(["one", "two"]), ["one", "two"])).toEqual({});
	});
});

describe("the core layer beneath the store (#101)", () => {
	const wiring = { Bash: ["scripts/guard-a.sh"] };
	const sources = { "scripts/guard-a.sh": guard(["core-only"]) };

	it("resolves a core guard's id out of rulesFallbackDir", () => {
		const r = lib.reachableByTool({
			settings: settingsOf(wiring),
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
