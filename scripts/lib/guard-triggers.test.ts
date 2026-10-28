// @vitest-environment node
/*
 * The census denominator turns on this file getting two things right: which
 * tool calls settings.json routes to a guard, and saying `unknown` rather than
 * zero where it cannot tell. An under-counted denominator inflates every deny
 * rate derived from it, and a zero denominator reads as "measured, never
 * denies" — the exact failure mantahostels#3261's table names as its own weak limb.
 *
 * The fixtures are settings-shaped objects, not the repo's own settings.json:
 * a test asserting the live wiring would fail on any legitimate rewiring.
 * `docs/data/lost-deny-true-invocations-2026-09-06.csv` carries the reading of
 * the live file that the census actually used.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { firesOn, triggerRows, triggerTable } from "./guard-triggers";

/** One scripts directory holding a deny-capable guard and one that is not. */
let guardDirs: string[];

beforeAll(() => {
	const dir = mkdtempSync(join(tmpdir(), "guard-triggers-"));
	writeFileSync(
		join(dir, "denier.sh"),
		'#!/bin/bash\necho \'{"permissionDecision":"deny"}\'\n',
	);
	writeFileSync(
		join(dir, "warner.sh"),
		'#!/bin/bash\necho \'{"additionalContext":"hm"}\'\n',
	);
	guardDirs = [dir];
});

function settings(hooks: unknown) {
	return { hooks } as Record<string, unknown>;
}

/** One PreToolUse registration, in settings.json's own shape. */
function pre(matcher: string, command: string, ifClause?: string) {
	return {
		matcher,
		hooks: [ifClause ? { command, if: ifClause } : { command }],
	};
}

/** The deny-capable guard's trigger, registered on Bash under one `if`. */
function guardedBy(ifClause: unknown) {
	const row = triggerTable(
		settings({
			PreToolUse: [
				{
					matcher: "Bash",
					hooks: [{ command: "scripts/denier.sh", if: ifClause }],
				},
			],
		}),
		guardDirs,
	).get("denier.sh");
	if (!row) throw new Error("denier.sh got no row");
	return row;
}

/** Does a Bash call running `command` reach a guard whose `if` is `Bash(glob)`? */
const reaches = (glob: string, command: string) =>
	firesOn(guardedBy(`Bash(${glob})`), "Bash", command);

describe("an if clause's glob", () => {
	it("anchors a bare pattern at both ends", () => {
		expect(reaches("git status", "git status")).toBe(true);
		expect(reaches("git status", "git status --short")).toBe(false);
	});

	it("reads a trailing * as a prefix match", () => {
		expect(reaches("git *", "git status")).toBe(true);
		expect(reaches("git *", "gitk")).toBe(false);
		// `git *` needs something after the space: a bare `git` is not a match.
		expect(reaches("git *", "git ")).toBe(true);
		expect(reaches("git *", "git")).toBe(false);
	});

	it("reads a leading * as a substring match", () => {
		expect(reaches("*gh *", "gh issue view 1")).toBe(true);
		expect(reaches("*gh *", "cd x && gh issue view 1")).toBe(true);
		expect(reaches("*gh *", "echo nogh")).toBe(false);
	});

	it("crosses a newline, which `.` would not", () => {
		expect(reaches("*npm *", "cd x\nnpm run test")).toBe(true);
	});

	it("escapes regex metacharacters in the literal parts", () => {
		expect(reaches("a.c*", "a.c and more")).toBe(true);
		expect(reaches("a.c*", "abc and more")).toBe(false);
	});
});

describe("an if clause's shape", () => {
	it("splits Tool(pattern)", () => {
		expect(guardedBy("Bash(git *)").rules[0]).toMatchObject({
			tool: "Bash",
			glob: "git *",
		});
	});

	it("keeps a pattern containing parentheses", () => {
		expect(guardedBy("Bash(echo (x))").rules[0]).toMatchObject({
			tool: "Bash",
			glob: "echo (x)",
		});
	});

	it("marks the guard unknown on anything that is not Tool(pattern)", () => {
		for (const clause of ["Bash git *", "", 42])
			expect(guardedBy(clause).unknown).toContain("is not Tool(pattern)");
	});
});

describe("triggerTable — which guards get a row", () => {
	it("keeps deny-capable PreToolUse guards and drops the rest", () => {
		const table = triggerTable(
			settings({
				PreToolUse: [
					pre("Bash", "scripts/denier.sh"),
					pre("Bash", "scripts/warner.sh"),
				],
				PostToolUse: [pre("Bash", "scripts/denier.sh")],
				Stop: [pre("", "scripts/denier.sh")],
			}),
			guardDirs,
		);
		expect([...table.keys()]).toEqual(["denier.sh"]);
		// Only the PreToolUse registration: a deny is issued on that event alone,
		// and the same script wired on PostToolUse or Stop adds no invocation the
		// census can lose a deny on.
		expect(table.get("denier.sh")?.rules).toHaveLength(1);
	});

	it("merges two registrations of one script into one row", () => {
		const table = triggerTable(
			settings({
				PreToolUse: [
					pre("Bash", "scripts/denier.sh", "Bash(npm *)"),
					pre("Read", "scripts/denier.sh"),
				],
			}),
			guardDirs,
		);
		expect(table.size).toBe(1);
		expect(table.get("denier.sh")?.rules).toHaveLength(2);
	});

	it("returns an empty table on settings with no hooks at all", () => {
		expect(triggerTable(settings(undefined), guardDirs).size).toBe(0);
	});
});

describe("triggerTable — scope (mantahostels#3350)", () => {
	const both = settings({
		PreToolUse: [
			pre("Bash", "scripts/denier.sh", "Bash(git *)"),
			pre("Bash", "scripts/warner.sh", "Bash(npm *)"),
		],
	});

	it("keeps the deny-capable guards alone by default", () => {
		expect([...triggerTable(both, guardDirs).keys()]).toEqual(["denier.sh"]);
	});

	it("swaps in the guards that cannot deny under `nondeny`", () => {
		const table = triggerTable(both, guardDirs, { scope: "nondeny" });
		expect([...table.keys()]).toEqual(["warner.sh"]);
		expect(table.get("warner.sh")?.denyCapable).toBe(false);
	});

	it("carries both under `all`, each labelled", () => {
		const table = triggerTable(both, guardDirs, { scope: "all" });
		expect([...table.keys()].sort()).toEqual(["denier.sh", "warner.sh"]);
		expect(table.get("denier.sh")?.denyCapable).toBe(true);
	});

	it("derives a non-deny guard's routes exactly as a deny-capable one's", () => {
		// The point of the extension: only the population moves, so a nondeny
		// denominator is comparable with a deny one.
		const warner = triggerTable(both, guardDirs, { scope: "nondeny" }).get(
			"warner.sh",
		);
		if (!warner) throw new Error("no warner.sh row");
		expect(warner.conditions).toEqual(["Bash(npm *)"]);
		expect(warner.unknown).toBeNull();
		expect(firesOn(warner, "Bash", "npm test")).toBe(true);
		expect(firesOn(warner, "Bash", "git status")).toBe(false);
	});

	it("marks a non-deny guard unknown on an unreadable `if`, never zero", () => {
		const table = triggerTable(
			settings({ PreToolUse: [pre("Bash", "scripts/warner.sh", "nonsense")] }),
			guardDirs,
			{ scope: "nondeny" },
		);
		expect(table.get("warner.sh")?.unknown).toBe(
			'if clause "nonsense" is not Tool(pattern)',
		);
	});

	it("refuses an unknown scope rather than narrowing to the default", () => {
		expect(() =>
			// @ts-expect-error — the refusal is for a caller that got it wrong.
			triggerTable(both, guardDirs, { scope: "warn" }),
		).toThrow(/unknown scope/);
	});
});

describe("triggerTable — event (mantahostels#3356)", () => {
	/** One PostToolUse registration, in settings.json's own shape. */
	function post(matcher: string, command: string, ifClause?: string) {
		return {
			matcher,
			hooks: [ifClause ? { command, if: ifClause } : { command }],
		};
	}

	const mixed = settings({
		PreToolUse: [pre("Bash", "scripts/denier.sh", "Bash(git *)")],
		PostToolUse: [post("Bash", "scripts/warner.sh", "Bash(gh *)")],
	});

	it("reads PreToolUse alone by default", () => {
		expect([...triggerTable(mixed, guardDirs).keys()]).toEqual(["denier.sh"]);
	});

	it("swaps the table for the PostToolUse registrations", () => {
		const table = triggerTable(mixed, guardDirs, {
			scope: "all",
			event: "PostToolUse",
		});
		expect([...table.keys()]).toEqual(["warner.sh"]);
	});

	it("derives a PostToolUse guard's routes exactly as a PreToolUse one's", () => {
		const row = triggerTable(mixed, guardDirs, {
			scope: "all",
			event: "PostToolUse",
		}).get("warner.sh");
		if (!row) throw new Error("no warner.sh row");
		expect(row.conditions).toEqual(["Bash(gh *)"]);
		expect(row.unknown).toBeNull();
		expect(firesOn(row, "Bash", "gh issue view 1")).toBe(true);
		expect(firesOn(row, "Bash", "git status")).toBe(false);
	});

	it("marks a PostToolUse guard unknown on an unreadable `if`, never zero", () => {
		const table = triggerTable(
			settings({
				PostToolUse: [post("Bash", "scripts/warner.sh", "nonsense")],
			}),
			guardDirs,
			{ scope: "all", event: "PostToolUse" },
		);
		expect(table.get("warner.sh")?.unknown).toBe(
			'if clause "nonsense" is not Tool(pattern)',
		);
	});

	it("calls no PostToolUse guard deny-capable, whatever its source says", () => {
		// `denier.sh` spells a deny verdict; registered after the call has
		// already run, it can deny nothing, and a true reading there would put it
		// in `lib/guard-deny-rates.js`'s staleness report as an unpinned denier.
		const table = triggerTable(
			settings({ PostToolUse: [post("Bash", "scripts/denier.sh")] }),
			guardDirs,
			{ scope: "all", event: "PostToolUse" },
		);
		expect(table.get("denier.sh")?.denyCapable).toBe(false);
	});

	it("refuses an event that fires on no tool call", () => {
		expect(() =>
			// @ts-expect-error — the refusal is for a caller that got it wrong.
			triggerTable(mixed, guardDirs, { event: "Stop", scope: "all" }),
		).toThrow(/unknown event/);
	});

	it("refuses a deny scope on PostToolUse rather than reporting an empty table", () => {
		expect(() =>
			triggerTable(mixed, guardDirs, { event: "PostToolUse", scope: "deny" }),
		).toThrow(/meaningless on PostToolUse/);
		expect(() =>
			triggerTable(mixed, guardDirs, {
				event: "PostToolUse",
				scope: "nondeny",
			}),
		).toThrow(/meaningless on PostToolUse/);
	});
});

describe("triggerTable — unknown, never zero", () => {
	it("marks a guard unknown where its `if` is not Tool(pattern)", () => {
		const table = triggerTable(
			settings({ PreToolUse: [pre("Bash", "scripts/denier.sh", "git *")] }),
			guardDirs,
		);
		expect(table.get("denier.sh")?.unknown).toMatch(/is not Tool\(pattern\)/);
	});

	it("reads `*` and an empty matcher as every tool, not as none", () => {
		for (const wildcard of ["*", ""]) {
			const row = triggerTable(
				settings({ PreToolUse: [pre(wildcard, "scripts/denier.sh")] }),
				guardDirs,
			).get("denier.sh");
			expect(row?.unknown).toBeNull();
			if (!row) throw new Error("fixture has no denier.sh row");
			expect(firesOn(row, "Bash", "anything")).toBe(true);
			expect(firesOn(row, "SomeToolNobodyHasHeardOf", "")).toBe(true);
		}
	});

	it("marks a guard unknown where its `if` names a tool alternation", () => {
		// `firesOn` compares the tool name literally, so `Write|Edit(x)` would
		// match no tool at all and narrow the denominator to nothing in silence.
		const table = triggerTable(
			settings({
				PreToolUse: [pre("Write|Edit", "scripts/denier.sh", "Write|Edit(x)")],
			}),
			guardDirs,
		);
		expect(table.get("denier.sh")?.unknown).toMatch(/is not Tool\(pattern\)/);
	});

	it("marks a guard unknown where its matcher will not compile", () => {
		const table = triggerTable(
			settings({ PreToolUse: [pre("[", "scripts/denier.sh")] }),
			guardDirs,
		);
		expect(table.get("denier.sh")?.unknown).toMatch(/is not a regexp/);
	});

	it("keeps a guard unknown even where another registration of it reads fine", () => {
		const table = triggerTable(
			settings({
				PreToolUse: [
					pre("Bash", "scripts/denier.sh"),
					pre("Bash", "scripts/denier.sh", "not a clause"),
				],
			}),
			guardDirs,
		);
		expect(table.get("denier.sh")?.unknown).not.toBeNull();
	});

	it("names every unreadable registration, not just the last (mantahostels#3310)", () => {
		const table = triggerTable(
			settings({
				PreToolUse: [
					pre("[", "scripts/denier.sh"),
					pre("Bash", "scripts/denier.sh", "not a clause"),
				],
			}),
			guardDirs,
		);
		const why = table.get("denier.sh")?.unknown;
		expect(why).toContain("is not a regexp");
		expect(why).toContain("is not Tool(pattern)");
		expect(why).toMatch(/is not a regexp; .*is not Tool\(pattern\)/);
	});

	it("says one reason once where two registrations are unreadable the same way", () => {
		const table = triggerTable(
			settings({
				PreToolUse: [
					pre("Bash", "scripts/denier.sh", "not a clause"),
					pre("Read", "scripts/denier.sh", "not a clause"),
				],
			}),
			guardDirs,
		);
		const why = table.get("denier.sh")?.unknown ?? "";
		expect(why.match(/is not Tool\(pattern\)/g)).toHaveLength(1);
	});
});

describe("firesOn", () => {
	/** denier.sh's row, or a thrown error: an absent row is a broken fixture. */
	const trigger = (hooks: unknown) => {
		const row = triggerTable(settings(hooks), guardDirs).get("denier.sh");
		if (!row) throw new Error("fixture has no denier.sh row");
		return row;
	};

	it("fires on every call a registration with no `if` matches", () => {
		const t = trigger({ PreToolUse: [pre("Bash", "scripts/denier.sh")] });
		expect(firesOn(t, "Bash", "anything at all")).toBe(true);
		expect(firesOn(t, "Read", "")).toBe(false);
	});

	it("narrows to the `if` glob where there is one", () => {
		const t = trigger({
			PreToolUse: [pre("Bash", "scripts/denier.sh", "Bash(git *)")],
		});
		expect(firesOn(t, "Bash", "git status")).toBe(true);
		expect(firesOn(t, "Bash", "ls")).toBe(false);
	});

	it("fires where ANY of several registrations matches", () => {
		const t = trigger({
			PreToolUse: [
				pre("Bash", "scripts/denier.sh", "Bash(*npm *)"),
				pre("Bash", "scripts/denier.sh", "Bash(*npx *)"),
				pre("Read|ListAgents", "scripts/denier.sh"),
			],
		});
		expect(firesOn(t, "Bash", "npm run test")).toBe(true);
		expect(firesOn(t, "Bash", "npx biome check")).toBe(true);
		expect(firesOn(t, "Bash", "ls")).toBe(false);
		expect(firesOn(t, "ListAgents", "")).toBe(true);
	});

	it("matches the matcher as an anchored alternation, not a substring", () => {
		const t = trigger({
			PreToolUse: [pre("Agent|Task", "scripts/denier.sh")],
		});
		expect(firesOn(t, "Agent", "")).toBe(true);
		expect(firesOn(t, "Task", "")).toBe(true);
		expect(firesOn(t, "TaskCreate", "")).toBe(false);
	});

	it("applies an `if`'s glob only to the tool that `if` names", () => {
		const t = trigger({
			PreToolUse: [pre("Bash|Read", "scripts/denier.sh", "Bash(git *)")],
		});
		expect(firesOn(t, "Bash", "git status")).toBe(true);
		expect(firesOn(t, "Read", "git status")).toBe(false);
	});

	it("never fires for an unknown guard even where one registration reads fine", () => {
		// The dangerous case: the readable registration would match everything, so
		// without the unknown short-circuit the guard reports a full population and
		// a rate computed on a denominator that is missing whatever the unreadable
		// registration would have added.
		const t = trigger({
			PreToolUse: [
				pre("Bash", "scripts/denier.sh"),
				pre("Bash", "scripts/denier.sh", "nonsense"),
			],
		});
		expect(t.unknown).not.toBeNull();
		expect(firesOn(t, "Bash", "anything")).toBe(false);
	});

	it("never fires for an unknown guard — the caller must report it uncounted", () => {
		const t = trigger({
			PreToolUse: [pre("Bash", "scripts/denier.sh", "nonsense")],
		});
		expect(firesOn(t, "Bash", "anything")).toBe(false);
	});
});

describe("triggerRows", () => {
	it("reports each guard's matchers, conditions and unconditional routes (mantahostels#3296)", () => {
		const rows = triggerRows(
			triggerTable(
				settings({
					PreToolUse: [
						pre("Bash", "scripts/denier.sh", "Bash(git *)"),
						pre("Read|ListAgents", "scripts/denier.sh"),
					],
				}),
				guardDirs,
			),
		);
		expect(rows).toEqual([
			{
				guard: "denier.sh",
				via: null,
				denyCapable: true,
				matchers: ["Bash", "Read|ListAgents"],
				conditions: ["Bash(git *)"],
				unconditionalMatchers: ["Read|ListAgents"],
				unknown: null,
			},
		]);
	});

	it("spells every-tool as * however settings.json wrote it (mantahostels#3296)", () => {
		// `*`, `""` and an absent matcher are one route to Claude Code, so they
		// are one spelling here — in both fields.
		for (const reg of [
			pre("*", "scripts/denier.sh"),
			pre("", "scripts/denier.sh"),
			{ hooks: [{ command: "scripts/denier.sh" }] },
		]) {
			const rows = triggerRows(
				triggerTable(settings({ PreToolUse: [reg] }), guardDirs),
			);
			expect(rows[0].matchers).toEqual(["*"]);
			expect(rows[0].unconditionalMatchers).toEqual(["*"]);
		}
	});

	it("reports no routes for an unknown guard, only why it is unknown (mantahostels#3296)", () => {
		const rows = triggerRows(
			triggerTable(
				settings({
					PreToolUse: [
						pre("Bash", "scripts/denier.sh"),
						pre("Bash", "scripts/denier.sh", "nonsense"),
					],
				}),
				guardDirs,
			),
		);
		expect(rows).toEqual([
			{
				guard: "denier.sh",
				via: null,
				denyCapable: true,
				matchers: [],
				conditions: [],
				unconditionalMatchers: [],
				unknown: 'if clause "nonsense" is not Tool(pattern)',
			},
		]);
	});

	it("suppresses the routes whichever way the guard became unknown (mantahostels#3296)", () => {
		// An unreadable MATCHER is the other route to `unknown`, and the
		// suppression must not be keyed to the `if` path alone.
		const rows = triggerRows(
			triggerTable(
				settings({
					PreToolUse: [
						pre("Bash", "scripts/denier.sh"),
						pre("(", "scripts/denier.sh"),
					],
				}),
				guardDirs,
			),
		);
		expect(rows[0].matchers).toEqual([]);
		expect(rows[0].conditions).toEqual([]);
		expect(rows[0].unconditionalMatchers).toEqual([]);
		expect(rows[0].unknown).toMatch(/is not a regexp/);
	});

	it("carries no RegExp, so the rows serialise", () => {
		const rows = triggerRows(
			triggerTable(
				settings({ PreToolUse: [pre("Bash", "scripts/denier.sh")] }),
				guardDirs,
			),
		);
		expect(() => JSON.stringify(rows)).not.toThrow();
	});
});
