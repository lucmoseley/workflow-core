// @vitest-environment node
/*
 * guard-dispatch.js runs every always-on guard of an event as a core of one
 * hook entry (#2786). Break the merge and a deny is lost behind another
 * core's allow or a context behind another's; break the gating and a
 * disabled or off-module core speaks; break the failure policy and one broken
 * advisory core silences or blocks the rest.
 *
 * This is the dispatcher's module test, run in process: fixture cores
 * stand in for real ones, over a real rule store, latch directory and git in
 * the case's temp dir. The log is a recorder passed in place of the port.
 * Each real core's branches are its own module test's.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readGuardErrorsLog } from "./guard-errors-log";
import { runInProcess } from "./run-in-process";
import { shellQuote } from "./sh-quote.js";

type Decision = Record<string, unknown> | null;
interface Core {
	name: string;
	core: string;
	tools: string;
	failure: "open" | "closed";
	module?: string;
	field: string | string[];
	noun: string;
	top?: boolean;
	if?: string[];
	loadFault?: string;
	decide: (subject: string, ctx: Record<string, unknown>) => Decision;
}
const { loadCores } = require("./guard-core-load.js") as {
	loadCores: (event: string, keep?: (row: Core) => boolean) => Core[];
};
const { dispatch, merge } = require("./guard-dispatch.js") as {
	dispatch: (
		cores: Core[],
		env: Record<string, unknown>,
	) => {
		output: Record<string, unknown> | null;
		latches: { latches: { name: string }[]; log: (what: string) => void }[];
	};
	merge: (
		parts: {
			permissionDecision?: string;
			reason?: string;
			context?: string;
			updatedInput?: Record<string, unknown>;
		}[],
	) => Record<string, unknown> | null;
};

const { hostAdapters } = require("./guard-host-ports.js") as {
	hostAdapters: (
		root: string,
		log: (what: string) => void,
	) => Record<string, (...a: never[]) => unknown> & {
		git: (args: string[], noMatch: number[]) => { ok: boolean; out?: string };
	};
};

const { writeLatches } = require("./guard-entry.js") as {
	writeLatches: (
		env: {
			root: string;
			payload: Record<string, unknown>;
			log: (what: string) => void;
		},
		latches: { name: string }[],
	) => void;
};

let dir: string;
let store: string;
let logs: string[];

beforeEach(() => {
	dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-")));
	store = path.join(dir, "rules");
	fs.mkdirSync(store);
	vi.stubEnv("WFC_RULES_DIR", store);
	logs = [];
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const fragment = (id: string, size = 20) =>
	fs.writeFileSync(path.join(store, `${id}.txt`), `${id} `.padEnd(size, "x"));
const readText = (id: string) =>
	fs.readFileSync(path.join(store, `${id}.txt`), "utf8");

const core = (
	name: string,
	decide: Core["decide"],
	over: Partial<Core> = {},
): Core => ({
	name,
	core: `${name}.js`,
	tools: "Bash",
	failure: "open",
	field: "command",
	noun: "command",
	decide,
	...over,
});

const answers = (d: Decision) => () => d;

/** Over the over-room notice's own length, which a drop still has to fit. */
const tightCap = 300;

const payload = (over: Record<string, unknown> = {}) => ({
	session_id: "s1",
	tool_name: "Bash",
	tool_input: { command: "ls" },
	...over,
});

function run(
	cores: Core[],
	{ p = payload(), disabled = [] as string[], persistChars = 10_000 } = {},
) {
	const r = dispatch(cores, {
		payload: p,
		root: dir,
		adapters: {
			...hostAdapters(dir, (w) => logs.push(`entry\t${w}`)),
			fallbackCwd: dir,
		},
		logFor: (name: string) => (what: string) => logs.push(`${name}\t${what}`),
		disabled: (name: string) => disabled.includes(name),
		persistChars: () => persistChars,
	});
	for (const set of r.latches)
		writeLatches({ root: dir, payload: p, log: set.log }, set.latches);
	return r.output;
}

describe("the merge (vendor §PreToolUse decision control)", () => {
	it.each([
		[["allow", "ask", "defer", "deny"], "deny"],
		[["allow", "ask", "defer"], "defer"],
		[["allow", "ask"], "ask"],
		[["allow"], "allow"],
	])("%j merges to %s, with every reason at that strength", (given, top) => {
		const out = merge([
			...given.map((d) => ({ permissionDecision: d, reason: `why ${d}` })),
			{ permissionDecision: top, reason: "and again" },
		]);
		expect(out).toEqual({
			permissionDecision: top,
			permissionDecisionReason: `why ${top}\n\nand again`,
		});
	});

	it("carries every context beside the permission, and says nothing of nothing", () => {
		expect(
			merge([
				{ context: "one" },
				{ permissionDecision: "deny", reason: "no" },
				{ context: "two" },
			]),
		).toEqual({
			permissionDecision: "deny",
			permissionDecisionReason: "no",
			additionalContext: "one\n\ntwo",
		});
		expect(merge([])).toBeNull();
	});

	it("carries a core's updatedInput on a merged allow, and drops it under any stronger answer", () => {
		const rewrite = {
			permissionDecision: "allow",
			updatedInput: { prompt: "rewritten" },
		};
		expect(merge([{ context: "note" }, rewrite])).toEqual({
			permissionDecision: "allow",
			updatedInput: { prompt: "rewritten" },
			additionalContext: "note",
		});
		for (const stronger of ["ask", "defer", "deny"])
			expect(
				merge([rewrite, { permissionDecision: stronger, reason: "no" }]),
			).toEqual({
				permissionDecision: stronger,
				permissionDecisionReason: "no",
			});
	});
});

describe("a context's and a deny's own latches", () => {
	const readLatched = () => {
		const markers = path.join(dir, ".claude/tmp/markers");
		return fs.existsSync(markers)
			? fs.readdirSync(markers).filter((f) => f.includes("mine"))
			: [];
	};

	it.each([
		[{ context: "said" }, { additionalContext: "said" }],
		[
			{ deny: "no" },
			{ permissionDecision: "deny", permissionDecisionReason: "no" },
		],
	])("writes %j's latches once it is out", (said, out) => {
		const latchWrites = [{ name: "warn.mine", text: "" }];
		expect(run([core("a", answers({ ...said, latchWrites }))])).toEqual(out);
		expect(readLatched()).toEqual([".rule-injected-warn.mine-main-s1"]);
	});

	it("writes no latch for a context the room drops", () => {
		const latchWrites = [{ name: "warn.mine", text: "" }];
		run([core("a", answers({ context: "x".repeat(500), latchWrites }))], {
			persistChars: tightCap,
		});
		expect(readLatched()).toEqual([]);
	});

	it("writes no latch for a prelude the room drops", () => {
		const latchWrites = [{ name: "warn.mine", text: "" }];
		run(
			[
				core(
					"a",
					answers({
						injectRules: [],
						prelude: "p".repeat(500),
						latchAfter: "mine",
						latchWrites,
					}),
				),
			],
			{ persistChars: tightCap },
		);
		expect(readLatched()).toEqual([]);
	});
});

describe("every enabled core runs, none stopping the rest", () => {
	it("hands one core's deny and the next core's rule in one output", () => {
		fragment("alpha");
		expect(
			run([
				core("a", answers({ deny: "refused by a" })),
				core("b", answers({ injectRules: ["alpha"] })),
			]),
		).toEqual({
			permissionDecision: "deny",
			permissionDecisionReason: "refused by a",
			additionalContext: readText("alpha"),
		});
	});

	it("joins the cores' contexts in manifest order, each latched as its own", () => {
		fragment("alpha");
		fragment("beta");
		const cores = [
			core("a", answers({ injectRules: ["alpha"], prelude: "a says" })),
			core("b", answers({ injectRules: ["beta"] })),
		];
		expect(run(cores)?.additionalContext).toBe(
			`a says\n\n${readText("alpha")}\n\n${readText("beta")}`,
		);
		expect(run(cores)?.additionalContext).toBe("a says");
	});

	it("runs a core narrowed by `if` only on a call a clause admits (#3224)", () => {
		const narrowed = [
			core("a", answers({ deny: "refused by a" }), { if: ["Bash(git *)"] }),
		];
		expect(run(narrowed)).toBeNull();
		expect(
			run(narrowed, {
				p: payload({ tool_input: { command: "cd x && git status" } }),
			})?.permissionDecision,
		).toBe("deny");
	});

	it("fits a later core's rules into what the entry has left, deferring them unlatched", () => {
		fragment("alpha", 60);
		fragment("beta", 60);
		const cores = [
			core("a", answers({ injectRules: ["alpha"] })),
			core("b", answers({ injectRules: ["beta"] })),
		];
		expect(run(cores, { persistChars: 100 })?.additionalContext).toBe(
			readText("alpha"),
		);
		expect(run(cores, { persistChars: 100 })?.additionalContext).toBe(
			readText("beta"),
		);
	});

	it.each([
		[36, true],
		[37, false],
	])(
		"counts each join's two characters against the room: a third rule of %i fits: %s",
		(size, fits) => {
			fragment("alpha", 30);
			fragment("beta", 30);
			fragment("gamma", size);
			const out = run(
				["alpha", "beta", "gamma"].map((id) =>
					core(id, answers({ injectRules: [id] })),
				),
				{ persistChars: 100 },
			);
			expect(out?.additionalContext).toBe(
				[
					readText("alpha"),
					readText("beta"),
					...(fits ? [readText("gamma")] : []),
				].join("\n\n"),
			);
		},
	);

	it("hands a core's updatedInput on as an allow, beside its context and its rules", () => {
		fragment("r1");
		const rewritten = { command: "ls -1" };
		expect(
			run([core("a", answers({ context: "said", updatedInput: rewritten }))]),
		).toEqual({
			permissionDecision: "allow",
			updatedInput: rewritten,
			additionalContext: "said",
		});
		expect(
			run([
				core(
					"b",
					answers({
						injectRules: ["r1"],
						prelude: "p",
						updatedInput: rewritten,
					}),
				),
			]),
		).toEqual({
			permissionDecision: "allow",
			updatedInput: rewritten,
			additionalContext: `p\n\n${readText("r1")}`,
		});
	});

	it("drops a core's launch answer, logged, as the dispatcher launches nothing", () => {
		expect(run([core("a", answers({ launch: ["x"] }))])).toBeNull();
		expect(logs).toEqual(["a\ta dispatcher core answered a launch — dropped"]);
	});
});

/* #2733 story 39: no guard's advice is dropped in silence. */
describe("the persist cap", () => {
	const notice = (...names: string[]) =>
		`Over the hook context cap, these guards' advice was dropped unread: ${names.join(", ")}.`;
	const said = (cores: Core[], persistChars = tightCap) =>
		String(run(cores, { persistChars })?.additionalContext ?? "");
	const context = (name: string, size: number) =>
		core(name, answers({ context: name.repeat(size) }));
	const prelude = (name: string, size: number) =>
		core(name, answers({ injectRules: [], prelude: name.repeat(size) }));

	it("names each core whose context did not fit, within the cap, carrying the ones that did", () => {
		const out = said([
			context("big", 400),
			context("kept", 10),
			context("huge", 1000),
		]);
		expect(out).toBe(`${"kept".repeat(10)}\n\n${notice("big", "huge")}`);
		expect(out.length).toBeLessThanOrEqual(tightCap);
	});

	it("drops a context whole, never cutting it to the room", () => {
		expect(said([context("big", 400)])).toBe(notice("big"));
	});

	it("holds the total to the cap with a fitting prelude and an oversized context", () => {
		const out = said([prelude("p", 150), context("big", 280)]);
		expect(out).toBe(`${"p".repeat(150)}\n\n${notice("big")}`);
		expect(out.length).toBeLessThanOrEqual(tightCap);
	});

	it("names a prelude that did not fit, and its fragments still get their say", () => {
		fragment("alpha");
		const out = said([
			core("a", answers({ injectRules: ["alpha"], prelude: "p".repeat(400) })),
		]);
		expect(out).toBe(`${readText("alpha")}\n\n${notice("a")}`);
		expect(out.length).toBeLessThanOrEqual(tightCap);
	});

	it("names a prelude that did not fit when the payload carries no session", () => {
		const out = run([prelude("a", 400)], {
			p: payload({ session_id: undefined }),
			persistChars: tightCap,
		});
		expect(out?.additionalContext).toBe(notice("a"));
	});

	it("holds a later core's rules to the room the notice leaves", () => {
		fragment("alpha", 200);
		const out = said([
			context("big", 400),
			core("b", answers({ injectRules: ["alpha"] })),
		]);
		expect(out).toBe(`${readText("alpha")}\n\n${notice("big")}`);
		expect(out.length).toBeLessThanOrEqual(tightCap);
	});

	it("names a dropped core beside a deny, which it does not soften", () => {
		expect(
			run([context("big", 400), core("b", answers({ deny: "no" }))], {
				persistChars: tightCap,
			}),
		).toEqual({
			permissionDecision: "deny",
			permissionDecisionReason: "no",
			additionalContext: notice("big"),
		});
	});

	it("defers a later core's rules that would fit but for the notice", () => {
		fragment("alpha", tightCap - 20);
		expect(
			said([
				context("big", 400),
				core("b", answers({ injectRules: ["alpha"] })),
			]),
		).toBe(notice("big"));
	});

	it("names a core the notice's own room pushes out", () => {
		const out = said([context("big", 400), context("snug", 70)]);
		expect(out).toBe(notice("big", "snug"));
		expect(out.length).toBeLessThanOrEqual(tightCap);
	});

	it("carries text that fits, setting no room aside where nothing drops", () => {
		const text = "x".repeat(tightCap);
		expect(said([core("a", answers({ context: text }))])).toBe(text);
		expect(said([core("a", answers({ injectRules: [], prelude: text }))])).toBe(
			text,
		);
		expect(logs).toEqual([]);
	});

	it("holds the notice naming every core to the real cap", () => {
		const { readDispatchRows } = require("./guard-cores.js") as {
			readDispatchRows: (event: string) => Core[];
		};
		const { readHookPersistChars } = require("./rule-emission.js") as {
			readHookPersistChars: () => number;
		};
		const cap = readHookPersistChars();
		const names = readDispatchRows("PreToolUse").map((row) => row.name);
		const out = said(
			names.map((name) =>
				core(name, answers({ context: "x".repeat(cap + 1) })),
			),
			cap,
		);
		expect(out).toBe(notice(...names));
		expect(out.length).toBeLessThanOrEqual(cap);
	});

	it("carries a dropped prelude in a refusal, whose reason the room does not bind", () => {
		const long = "p".repeat(400);
		const out = run(
			[core("a", answers({ injectRules: ["absent"], prelude: long }))],
			{ persistChars: tightCap },
		);
		expect(out?.permissionDecision).toBe("deny");
		expect(out?.permissionDecisionReason).toContain(long);
		expect(out?.additionalContext).toBeUndefined();
	});

	it("sets no room aside on a call whose cores carry only rules", () => {
		fragment("alpha", tightCap - 1);
		expect(said([core("a", answers({ injectRules: ["alpha"] }))])).toBe(
			readText("alpha"),
		);
	});

	it("logs each drop under its core's name", () => {
		said([context("big", 400), prelude("p", 400)]);
		expect(logs).toEqual([
			"big\ta core's context overran the persist room — dropped",
			"p\ta core's prelude overran the persist room",
		]);
	});
});

/* The store read is the host's own, under the root the entry resolved: the
 * declared project dir holds no store, so a read that resolved its own root
 * would find no fragment and refuse. */
describe("the rule store under the entry's root (#3142)", () => {
	it.each([
		["an injecting decision", () => ({ injectRules: ["alpha"] })],
		[
			"the ruleText port",
			(_: string, ctx: Record<string, unknown>) => ({
				deny: (ctx.ruleText as (id: string) => string)("alpha"),
			}),
		],
	])("reads it through %s", (_, decide) => {
		vi.stubEnv("WFC_RULES_DIR", "");
		vi.stubEnv(
			"CLAUDE_PROJECT_DIR",
			fs.mkdtempSync(path.join(dir, "elsewhere-")),
		);
		const own = path.join(dir, "docs", "agents", "rules");
		fs.mkdirSync(own, { recursive: true });
		fs.writeFileSync(path.join(own, "alpha.txt"), "alpha rule");
		expect(JSON.stringify(run([core("a", decide as Core["decide"])]))).toMatch(
			/alpha rule/,
		);
	});
});

describe("gating", () => {
	it("runs a core only on the tools its row names, matched whole", () => {
		const seen: string[] = [];
		const cores = [
			core("bash", () => {
				seen.push("bash");
				return null;
			}),
			core(
				"write",
				() => {
					seen.push("write");
					return null;
				},
				{
					tools: "Write|Edit",
					field: "file_path",
				},
			),
		];
		run(cores, { p: payload({ tool_name: "Bash" }) });
		run(cores, {
			p: payload({ tool_name: "Write", tool_input: { file_path: "/x" } }),
		});
		run(cores, {
			p: payload({ tool_name: "WriteX", tool_input: { file_path: "/x" } }),
		});
		expect(seen).toEqual(["bash", "write"]);
	});

	it("stands a core the host lists under disabled down, and only that one (#2786)", () => {
		fragment("alpha");
		fragment("beta");
		expect(
			run(
				[
					core("a", answers({ injectRules: ["alpha"] })),
					core("b", answers({ injectRules: ["beta"] })),
				],
				{ disabled: ["a"] },
			)?.additionalContext,
		).toBe(readText("beta"));
	});

	it("runs a module-gated core only where .claude/workflow-core.json lists the module", () => {
		fragment("alpha");
		const cores = [
			core("a", answers({ injectRules: ["alpha"] }), { module: "suites" }),
		];
		/* The suite injects its module list through WFC_MODULES, which replaces
		 * the file's; this case reads the file. */
		vi.stubEnv("WFC_MODULES", undefined);
		fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
		const config = path.join(dir, ".claude", "workflow-core.json");
		fs.writeFileSync(config, JSON.stringify({ modules: [] }));
		expect(run(cores)).toBeNull();
		fs.writeFileSync(config, JSON.stringify({ modules: ["suites"] }));
		expect(run(cores)?.additionalContext).toBe(readText("alpha"));
	});

	it("records a payload missing a core's field and runs the rest", () => {
		fragment("alpha");
		expect(
			run(
				[
					core("a", answers({ deny: "no" }), { field: ["file_path", "path"] }),
					core("b", answers({ injectRules: ["alpha"] })),
				],
				{ p: payload({ tool_input: { command: "ls" } }) },
			),
		).toEqual({ additionalContext: readText("alpha") });
		expect(logs).toContain(
			"a\tno file_path or path in payload — command allowed unchecked",
		);
	});

	it("hands a core the payload's agent label and permission mode", () => {
		const seen: unknown[] = [];
		const said = (_s: string, ctx: Record<string, unknown>) => {
			seen.push([ctx.agentLabel, ctx.permissionMode]);
			return null;
		};
		run([core("a", said)]);
		run([core("a", said)], {
			p: payload({ agent_id: "x/1", permission_mode: "auto" }),
		});
		expect(seen).toEqual([
			["main", undefined],
			["ax_1", "auto"],
		]);
	});

	it("hands a `top` core the payload's own field, never tool_input's", () => {
		const seen: string[] = [];
		const said = (subject: string) => {
			seen.push(subject);
			return null;
		};
		run([
			core("a", said, { field: "session_id", top: true }),
			core("b", said, { field: "session_id" }),
		]);
		expect(seen).toEqual(["s1"]);
	});
});

describe("failure policy", () => {
	const broken = () => {
		throw new Error("core broke");
	};

	it("allows past an open core's throw, logged under its name, and runs the rest", () => {
		fragment("alpha");
		expect(
			run([core("a", broken), core("b", answers({ injectRules: ["alpha"] }))]),
		).toEqual({ additionalContext: readText("alpha") });
		expect(logs).toEqual(["a\tcore threw — allowed unchecked: core broke"]);
	});

	it("refuses on a closed core's throw, naming it", () => {
		expect(run([core("a", broken, { failure: "closed" })])).toEqual({
			permissionDecision: "deny",
			permissionDecisionReason:
				"a could not judge this call, and it fails closed: core broke",
		});
		expect(logs).toEqual(["a\tcore threw — refused: core broke"]);
	});

	it("allows past a closed core's throw where the repo does not resolve, logged (mantahostels#147)", () => {
		const repoless = (_s: string, ctx: Record<string, unknown>) => {
			(ctx.treeClass as (dir: string) => string)(path.join(dir, "nowhere"));
			return null;
		};
		expect(
			run([core("a", repoless, { failure: "closed" })], {
				p: payload({ cwd: path.join(dir, "nowhere") }),
			}),
		).toBeNull();
		expect(logs).toEqual([
			expect.stringMatching(/^a\tgit could not resolve a git dir/),
		]);
	});

	describe("a core whose module will not load (#4125)", () => {
		const fault = (name: string) => `${name}.js failed to load`;
		const unloadable = (name: string, failure: Core["failure"]) =>
			core(name, answers(null), { failure, loadFault: fault(name) });

		it("allows past an open core's fault, logged under its name, and the rest still decide", () => {
			fragment("alpha");
			expect(
				run([
					unloadable("a", "open"),
					core("b", answers({ injectRules: ["alpha"] })),
				]),
			).toEqual({ additionalContext: readText("alpha") });
			expect(logs).toEqual([
				`a\tcore threw — allowed unchecked: ${fault("a")}`,
			]);
		});

		it("refuses on a closed core's fault, naming it, and the rest still decide", () => {
			fragment("alpha");
			expect(
				run([
					unloadable("a", "closed"),
					core("b", answers({ injectRules: ["alpha"] })),
				]),
			).toEqual({
				permissionDecision: "deny",
				permissionDecisionReason: `a could not judge this call, and it fails closed: ${fault("a")}`,
				additionalContext: readText("alpha"),
			});
			expect(logs).toEqual([`a\tcore threw — refused: ${fault("a")}`]);
		});

		it("says nothing for a disabled core's fault", () => {
			expect(run([unloadable("a", "closed")], { disabled: ["a"] })).toBeNull();
			expect(logs).toEqual([]);
		});
	});

	it.each(["open", "closed"] as const)(
		"refuses on a %s core's store fault, naming only the missing id and its fix (mantahostels#1762)",
		(failure) => {
			fragment("alpha");
			const out = run([
				core("a", answers({ injectRules: ["ghost"] }), { failure }),
			]);
			expect(out?.permissionDecision).toBe("deny");
			expect(out?.permissionDecisionReason).toMatch(
				/^a: rule-text: no fragment for rule id "ghost" \(looked in [^)]+\)\. This refusal holds whatever the guard's failure policy/,
			);
			expect(out?.permissionDecisionReason).not.toContain("Known ids");
			expect(logs).toEqual([
				expect.stringMatching(
					/^a\trule fragment unreadable — refusing: .*Known ids: alpha\./,
				),
			]);
		},
	);
});

describe("one adapter set a call", () => {
	it("starts one git per distinct argument list, however many cores ask", () => {
		const calls = path.join(dir, "git-calls");
		const stub = path.join(dir, "git");
		fs.writeFileSync(
			stub,
			`#!/usr/bin/env bash\necho "$*" >>${shellQuote(calls)}\necho out\n`,
			{ mode: 0o755 },
		);
		vi.stubEnv("WFC_GIT", stub);
		const ask =
			(args: string[]) => (_: string, ctx: Record<string, unknown>) => {
				(ctx.git as (a: string[], n: number[]) => unknown)(args, []);
				return null;
			};
		run([
			core("a", ask(["rev-parse", "HEAD"])),
			core("b", ask(["rev-parse", "HEAD"])),
			core("c", ask(["status"])),
		]);
		expect(fs.readFileSync(calls, "utf8")).toBe("rev-parse HEAD\nstatus\n");
	});
});

describe("the entry's fail-open record", () => {
	/* Filed under the root the entry resolved under its git timeout: a second
	 * root read would re-run a hung git unbounded. Counted through the stub,
	 * but crossing the real clock: the one read is bounded only by a real
	 * process timeout. */
	it("is written off that one root read (#3038)", () => {
		const calls = path.join(dir, "git-calls");
		const git = path.join(dir, "slow-git");
		fs.writeFileSync(
			git,
			`#!/bin/sh\necho x >> ${shellQuote(calls)}\nexec sleep 30\n`,
			{
				mode: 0o755,
			},
		);
		const config = path.join(dir, "config");
		const env: NodeJS.ProcessEnv = {
			...process.env,
			CLAUDE_CONFIG_DIR: config,
			WFC_GIT: git,
		};
		delete env.CLAUDE_PROJECT_DIR;
		const r = runInProcess(
			path.resolve(__dirname, "..", "guard-dispatch.js"),
			[],
			{ cwd: dir, stdin: "not json", env },
		);
		expect(r.status).toBe(0);
		expect(
			fs.readFileSync(calls, "utf8").split("\n").filter(Boolean),
		).toHaveLength(1);
		expect(readGuardErrorsLog(config)).toMatch(/payload did not parse/);
	}, 40_000);
});

describe("the entry's --only argument", () => {
	const Entry = path.resolve(__dirname, "..", "guard-dispatch.js");
	const entry = (args: string[]) =>
		runInProcess(Entry, args, {
			cwd: dir,
			env: {
				PATH: process.env.PATH,
				CLAUDE_PROJECT_DIR: dir,
				CLAUDE_CONFIG_DIR: dir,
				WFC_RULES_DIR: store,
			},
			stdin: JSON.stringify({
				...payload({
					tool_input: { command: "sleep 1", run_in_background: true },
				}),
				hook_event_name: "PreToolUse",
			}),
		}).stdout;

	it("runs the named core alone, and every core without it", () => {
		fragment("killed-background-job");
		const said = readText("killed-background-job");
		expect(entry(["--only", "guard-scratch-git"])).toBe("");
		expect(JSON.parse(entry(["--only", "guard-bg-job"]))).toEqual({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				additionalContext: said,
			},
		});
		fs.rmSync(path.join(dir, ".claude"), { recursive: true, force: true });
		expect(
			JSON.parse(entry([])).hookSpecificOutput.additionalContext,
		).toContain(said);
	});

	it("refuses an argument it does not know, and runs nothing for a core name no row carries, logged", () => {
		const r = runInProcess(Entry, ["--other", "guard-scratch-git"], {
			cwd: dir,
			env: { PATH: process.env.PATH },
			stdin: "",
		});
		expect(r.status).toBe(2);
		fragment("killed-background-job");
		expect(entry(["--only", "guard-no-such"])).toBe("");
		expect(readGuardErrorsLog(dir)).toContain(
			"--only names no PreToolUse core: guard-no-such — nothing run",
		);
	});
});

describe("the entry's core load", () => {
	const skillCall = (args: string[]) =>
		runInProcess(path.resolve(__dirname, "..", "guard-dispatch.js"), args, {
			cwd: dir,
			env: { PATH: process.env.PATH, WFC_RULES_DIR: store },
			stdin: JSON.stringify(
				payload({
					tool_name: "Skill",
					tool_input: { skill: "tdd" },
					hook_event_name: "PreToolUse",
				}),
			),
		});

	it("requires only the cores whose rows match the call's tool (#3141)", () => {
		const { corePath, readDispatchRows, isCoreFor } =
			require("./guard-cores.js") as {
				corePath: (module: string) => string;
				readDispatchRows: (event: string) => Core[];
				isCoreFor: (row: Core, tool: string) => boolean;
			};
		const rows = readDispatchRows("PreToolUse");
		const loaded = (skill: boolean) =>
			rows
				.filter((r) => isCoreFor(r, "Skill") === skill)
				.map((r) => corePath(r.core))
				.filter((file) => file in require.cache);
		expect(skillCall([]).status).toBe(0);
		/* Internal state: no output shows the load cost this pins (#3141). */
		expect(loaded(true)).not.toEqual([]);
		expect(loaded(false)).toEqual([]);
	});

	it("requires no core whose `if` clauses refuse the call's command (#3224)", () => {
		const { isAdmitted, corePath, readDispatchRows } =
			require("./guard-cores.js") as {
				isAdmitted: (row: Core, payload: Record<string, unknown>) => boolean;
				corePath: (module: string) => string;
				readDispatchRows: (event: string) => Core[];
			};
		const call = payload({ tool_input: { command: "ls" } });
		const refused = readDispatchRows("PreToolUse")
			.filter((r) => r.if && !isAdmitted(r, call))
			.map((r) => corePath(r.core));
		for (const file of refused) delete require.cache[file];
		const ran = runInProcess(
			path.resolve(__dirname, "..", "guard-dispatch.js"),
			[],
			{
				cwd: dir,
				env: { PATH: process.env.PATH, WFC_RULES_DIR: store },
				stdin: JSON.stringify({ ...call, hook_event_name: "PreToolUse" }),
			},
		);
		expect(ran.status).toBe(0);
		expect(refused).not.toEqual([]);
		/* Internal state: no output shows the load cost this pins. agent-poll.js
		 * alone is loaded anyway, by guard-echo-call's lib/echo-chain.js. */
		expect(refused.filter((file) => file in require.cache)).toEqual([
			corePath("agent-poll.js"),
		]);
	});

	it("reports no fault for --only naming a real core the call's tool cannot fire", () => {
		expect(skillCall(["--only", "guard-bg-job"]).stdout).toBe("");
		expect(readGuardErrorsLog(dir)).not.toContain("--only names no");
	});
});

describe("the manifest", () => {
	it("loads every PostToolUse row with its core's decide", () => {
		const rows = loadCores("PostToolUse");
		expect(rows).not.toEqual([]);
		expect(
			rows.filter((c) => typeof c.decide !== "function").map((c) => c.name),
		).toEqual([]);
	});

	it("loads each PreToolUse row with its core's field, noun and decide", () => {
		expect(
			loadCores("PreToolUse").map((c) => [
				c.name,
				c.tools,
				c.failure,
				typeof c.decide,
			]),
		).toEqual([
			["guard-bg-job", "Bash", "open", "function"],
			["inject-test-rules", "Write|Edit|NotebookEdit", "open", "function"],
			["guard-citation-tracker", "Write|Edit", "open", "function"],
			["guard-scratch-git", "Bash", "open", "function"],
			[
				"guard-job-dir-scratch",
				"Bash|Write|Edit|NotebookEdit",
				"closed",
				"function",
			],
			[
				"guard-root-scratch",
				"Bash|Write|Edit|NotebookEdit",
				"closed",
				"function",
			],
			["guard-scratch-overwrite", "Write", "closed", "function"],
			["guard-self-match", "Bash", "closed", "function"],
			["guard-wait-loop", "Bash", "closed", "function"],
			["guard-suite-background", "Bash", "closed", "function"],
			["guard-sweep-fire", "Bash", "closed", "function"],
			["guard-claimed-bash-write", "Bash", "open", "function"],
			["guard-file-claim", "Write|Edit|NotebookEdit", "closed", "function"],
			["guard-last30days", "Skill", "closed", "function"],
			["inject-review-tier", "Skill", "open", "function"],
			["guard-review-rules", "Skill", "closed", "function"],
			["inject-founder-wording", "Skill", "open", "function"],
			["guard-tracker-rules", "Bash", "open", "function"],
			["guard-branch-publish", "Bash", "closed", "function"],
			[
				"guard-main-checkout-write",
				"Bash|Write|Edit|NotebookEdit",
				"closed",
				"function",
			],
			["guard-branch", "Bash", "closed", "function"],
			["guard-commit-form", "Bash", "closed", "function"],
			["guard-registry-atomicity", "Bash", "closed", "function"],
			["guard-pull-form", "Bash", "closed", "function"],
			["guard-push-rules", "Bash", "open", "function"],
			["guard-node-heap", "Bash", "open", "function"],
			["guard-round-holds", "Bash", "open", "function"],
			["guard-rm-unchecked", "Bash", "open", "function"],
			["guard-npm-install", "Bash", "closed", "function"],
			["guard-anthropic-report", "Bash", "closed", "function"],
			["guard-cpu-load", "Bash", "closed", "function"],
			["guard-check-sh", "Bash", "open", "function"],
			["guard-issue-body", "Bash", "closed", "function"],
			["guard-issue-close", "Bash", "closed", "function"],
			["guard-issue-create-label", "Bash", "closed", "function"],
			["guard-issue-phase-scope", "Bash", "closed", "function"],
			["guard-headroom-read", "Bash", "open", "function"],
			["guard-hook-escape", "Bash", "closed", "function"],
			["guard-suite-concurrency", "Bash", "closed", "function"],
			["guard-unasked-rerun", "Bash", "closed", "function"],
			["guard-vitest-wrapper", "Bash", "open", "function"],
			["guard-root-find", "Bash", "closed", "function"],
			["guard-ugrep-pattern", "Bash", "open", "function"],
			["guard-recursive-dot-read", "Bash", "open", "function"],
			["guard-wide-read", "Bash|Read", "open", "function"],
			["guard-agent-poll", "Bash|Read|ListAgents", "closed", "function"],
			["guard-echo-call", "Bash|Read", "closed", "function"],
			["guard-dispatch-rewrite", "Agent|Task", "closed", "function"],
			["guard-blind-dispatch", "Agent|Task", "closed", "function"],
		]);
		expect(loadCores("Stop")).toEqual([]);
	});

	it("narrows each row by the `if` clauses its old registrations carried (#3224, #3226)", () => {
		const { readDispatchRows } = require("./guard-cores.js") as {
			readDispatchRows: (event: string) => Core[];
		};
		expect(
			Object.fromEntries(
				readDispatchRows("PreToolUse")
					.filter((r) => r.if)
					.map((r) => [r.name, r.if]),
			),
		).toEqual({
			"guard-branch": ["Bash(git *)"],
			"guard-commit-form": ["Bash(git *)", "Bash(*commit-paths.js*)"],
			"guard-registry-atomicity": ["Bash(git *)", "Bash(*commit-paths.js*)"],
			"guard-pull-form": ["Bash(*git *)"],
			"guard-push-rules": ["Bash(git *)"],
			"guard-node-heap": [
				"Bash(*max-old-space-size*)",
				"Bash(*max_old_space_size*)",
			],
			"guard-round-holds": ["Bash(gh *)"],
			"guard-rm-unchecked": ["Bash(*rm *)"],
			"guard-npm-install": ["Bash(*npm *)", "Bash(*npx *)"],
			"guard-anthropic-report": ["Bash(*gh *)"],
			"guard-cpu-load": [
				"Bash(*yes*)",
				"Bash(*stress*)",
				"Bash(*done*)",
				"Bash(*.sh*)",
				"Bash(*sh -*)",
			],
			"guard-check-sh": ["Bash(*shellcheck *)", "Bash(*npm *)"],
			"guard-issue-body": ["Bash(gh *)"],
			"guard-issue-close": ["Bash(gh *)"],
			"guard-issue-create-label": ["Bash(gh *)"],
			"guard-issue-phase-scope": ["Bash(*gh *)"],
			"guard-headroom-read": ["Bash(*free *)", "Bash(*/proc/meminfo*)"],
			"guard-hook-escape": ["Bash(*WFC_ALLOW_*)"],
			"guard-suite-concurrency": [
				"Bash(*npm *)",
				"Bash(*node *)",
				"Bash(*next *)",
				"Bash(*python*)",
				"Bash(*pytest*)",
				"Bash(*npx *)",
				"Bash(*yarn *)",
				"Bash(*pnpm *)",
				"Bash(*bun *)",
				"Bash(*make *)",
				"Bash(*cargo *)",
				"Bash(*go test*)",
				"Bash(*tsc*)",
			],
			"guard-unasked-rerun": ["Bash(*npm *)"],
			"guard-vitest-wrapper": ["Bash(*vitest *)", "Bash(*npx *)"],
			"guard-root-find": ["Bash(*find *)"],
			"guard-ugrep-pattern": ["Bash(grep *)"],
			"guard-wide-read": ["Bash(*cat *)", "Bash(*sed *)", "Bash(*awk *)"],
			"guard-agent-poll": [
				"Bash(*sleep *)",
				"Bash(true*)",
				"Bash(:*)",
				"Bash(exit*)",
			],
		});
	});

	it("hands the test-write core a NotebookEdit's notebook_path", () => {
		const ids = ["test-run-cost", "test-time-seam", "test-reads-visible"];
		for (const id of ids) fragment(id);
		const out = run(loadCores("PreToolUse"), {
			p: payload({
				tool_name: "NotebookEdit",
				tool_input: { notebook_path: `${dir}/tests/a.ipynb` },
			}),
		});
		expect(out?.additionalContext).toBe(ids.map(readText).join("\n\n"));
	});
});
