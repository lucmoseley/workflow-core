// @vitest-environment node
/*
 * guard-entry.js is every Node PreToolUse guard's prologue and epilogue
 * (#2784): a broken latch hands a session the same rule on every call, a
 * broken cap truncates the harness's per-hook record, and a broken fault arm
 * either refuses calls it should allow or states no rule where the store is
 * broken.
 *
 * Run in process: a fixture entry under a temp dir answers whatever decision
 * WFC_TEST_DECISION names, so each case reaches one arm of the kit without a
 * guard of its own. CLAUDE_PROJECT_DIR and CLAUDE_CONFIG_DIR sit in that temp
 * dir, so no latch or fail-open record lands in the checkout or the founder's
 * log. WFC_RULES_DIR points at a store each case writes.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readGuardErrorsLog } from "./guard-errors-log";
import { runInProcess } from "./run-in-process";

const { readRuleCap } = require("./rule-emission.js") as {
	readRuleCap: () => number;
};
const RULE_CAP = readRuleCap();

const KIT = path.resolve(__dirname, "guard-entry.js");
const EMISSION = path.resolve(__dirname, "rule-emission.js");

let dir: string;
let config: string;
let store: string;
let entry: string;

beforeEach(() => {
	dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "guard-entry-")));
	config = path.join(dir, "config");
	store = path.join(dir, "rules");
	fs.mkdirSync(config);
	fs.mkdirSync(store);
	entry = path.join(dir, "guard-fixture.js");
	fs.writeFileSync(
		entry,
		`if (process.env.WFC_TEST_CAP_BROKEN) require(${JSON.stringify(EMISSION)}).readRuleCap = () => { throw new Error("cap unreadable"); };
require(${JSON.stringify(KIT)}).run({ field: "command", noun: "command",
	event: process.env.WFC_TEST_EVENT || undefined,
	name: process.env.WFC_TEST_NAME || undefined,
	onThrow: process.env.WFC_TEST_ON_THROW || undefined,
	decide: (subject, ctx) => {
		const d = JSON.parse(process.env.WFC_TEST_DECISION || "null");
		if (d === "throw") throw new Error("core broke");
		if (d && d.module) return [ctx.moduleOn(d.module), ctx.moduleOn(d.module)].every(Boolean) ? d.decision : null;
		if (d && d.log) return ctx.log(d.log[0], d.log[1]);
		if (d && d.ruleText) return { deny: ctx.ruleText(d.ruleText) };
		if (d && d.probe) return { injectRules: [], prelude: JSON.stringify({ told: ctx.told(d.probe), latch: ctx.readLatch(d.probe), keyed: ctx.key !== null }) };
		return d;
	} });\n`,
	);
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A fragment of `bytes` bytes under `id` in the case's store. */
const fragment = (id: string, bytes = 20) =>
	fs.writeFileSync(path.join(store, `${id}.txt`), `${id} `.padEnd(bytes, "x"));

const writeConfig = (text: string) => {
	fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
	fs.writeFileSync(path.join(dir, ".claude", "workflow-core.json"), text);
};

/** One run of the fixture: its exit, its stdout parsed, its stderr. */
function call(
	decision: unknown,
	{
		session = "s1" as string | null,
		agent,
		stdin,
		event,
		name,
		capBroken,
		onThrow,
		args = [],
	}: {
		session?: string | null;
		agent?: string;
		stdin?: string;
		event?: string;
		name?: string;
		capBroken?: boolean;
		onThrow?: "refuse";
		args?: string[];
	} = {},
) {
	const payload = {
		...(session === null ? {} : { session_id: session }),
		...(agent ? { agent_id: agent } : {}),
		hook_event_name: "PreToolUse",
		tool_name: "Bash",
		tool_input: { command: "anything" },
		cwd: dir,
	};
	const r = runInProcess(entry, args, {
		cwd: dir,
		stdin: stdin ?? JSON.stringify(payload),
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: dir,
			CLAUDE_CONFIG_DIR: config,
			WFC_RULES_DIR: store,
			WFC_TEST_DECISION: JSON.stringify(decision),
			...(event ? { WFC_TEST_EVENT: event } : {}),
			...(name ? { WFC_TEST_NAME: name } : {}),
			...(capBroken ? { WFC_TEST_CAP_BROKEN: "1" } : {}),
			...(onThrow ? { WFC_TEST_ON_THROW: onThrow } : {}),
		},
	});
	const out = r.stdout.trim();
	return {
		status: r.status,
		stderr: r.stderr,
		out: out ? JSON.parse(out).hookSpecificOutput : null,
	};
}

const inject = (...ids: string[]) => ({ injectRules: ids });

describe("injecting a rule", () => {
	it("hands the fragment once per session, latched under the markers dir", () => {
		fragment("alpha");
		const first = call(inject("alpha"));
		expect(first.status).toBe(0);
		expect(first.out).toEqual({
			hookEventName: "PreToolUse",
			additionalContext: fs.readFileSync(path.join(store, "alpha.txt"), "utf8"),
		});
		expect(
			fs.existsSync(
				path.join(dir, ".claude/tmp/markers/.rule-injected-alpha-main-s1"),
			),
		).toBe(true);
		expect(call(inject("alpha")).out).toBeNull();
	});

	it("tells a subagent apart from its parent (mantahostels#1804)", () => {
		fragment("alpha");
		expect(call(inject("alpha")).out).not.toBeNull();
		expect(call(inject("alpha"), { agent: "x/1" }).out).not.toBeNull();
		expect(
			fs.existsSync(
				path.join(dir, ".claude/tmp/markers/.rule-injected-alpha-ax_1-s1"),
			),
		).toBe(true);
		expect(call(inject("alpha"), { agent: "x/1" }).out).toBeNull();
	});

	it("bares one `rule:` and says a twice-named id once (mantahostels#2719)", () => {
		fragment("alpha");
		const { out } = call(inject("rule:alpha", "alpha"));
		expect(out.additionalContext).toBe(
			fs.readFileSync(path.join(store, "alpha.txt"), "utf8"),
		);
	});

	it("joins fragments in priority order and defers, unlatched, what the cap leaves out", () => {
		fragment("alpha", 30);
		fragment("beta", RULE_CAP - 20);
		fragment("gamma", 30);
		const first = call(inject("alpha", "beta", "gamma"));
		expect(first.out.additionalContext).toMatch(/^alpha x+$/);
		const second = call(inject("alpha", "beta", "gamma"));
		expect(second.out.additionalContext).toMatch(/^beta x+$/);
		const third = call(inject("alpha", "beta", "gamma"));
		expect(third.out.additionalContext).toMatch(/^gamma x+$/);
	});

	it("counts the cap in bytes, not characters", () => {
		fs.writeFileSync(path.join(store, "wide.txt"), "é".repeat(RULE_CAP / 2));
		fragment("tail", 2);
		expect(call(inject("wide", "tail")).out.additionalContext).toBe(
			"é".repeat(RULE_CAP / 2),
		);
	});

	it("emits nothing where every id is latched", () => {
		fragment("alpha");
		call(inject("alpha"));
		const r = call(inject("alpha"));
		expect(r.status).toBe(0);
		expect(r.out).toBeNull();
	});
});

describe("a guard's own text and latches beside the rules (#2785)", () => {
	const marker = (name: string) =>
		path.join(dir, ".claude/tmp/markers", `.rule-injected-${name}-main-s1`);

	it("leaves a skipped id out, unlatched, so a later call hands it", () => {
		fragment("alpha");
		fragment("beta");
		expect(
			call({ injectRules: ["alpha", "beta"], skip: ["beta"] }).out
				.additionalContext,
		).toMatch(/^alpha x+$/);
		expect(fs.existsSync(marker("beta"))).toBe(false);
		expect(call(inject("alpha", "beta")).out.additionalContext).toMatch(
			/^beta x+$/,
		);
	});

	it("still resolves a skipped id, so one naming nothing refuses (mantahostels#1805)", () => {
		fragment("alpha");
		expect(
			call({ injectRules: ["alpha", "ghost"], skip: ["ghost"] }).out
				.permissionDecision,
		).toBe("deny");
	});

	it("puts the prelude ahead of the fragments, in one envelope, spending the cap", () => {
		fragment("alpha", 30);
		fragment("beta", RULE_CAP - 30);
		const { out } = call({ injectRules: ["alpha", "beta"], prelude: "P" });
		expect(out.additionalContext).toMatch(/^P\n\nalpha x+$/);
		expect(fs.existsSync(marker("beta"))).toBe(false);
	});

	it("emits a prelude whole, over the cap, with every id latched", () => {
		fragment("alpha");
		call(inject("alpha"));
		const long = "p".repeat(RULE_CAP + 10);
		expect(call({ injectRules: ["alpha"], prelude: long }).out).toEqual({
			hookEventName: "PreToolUse",
			additionalContext: long,
		});
	});

	it("emits the prelude where the payload has no session, logged and latching nothing", () => {
		fragment("alpha");
		const { out } = call(
			{ injectRules: ["alpha"], prelude: "P", latchAfter: "w" },
			{ session: null },
		);
		expect(out.additionalContext).toBe("P");
		expect(readGuardErrorsLog(config)).toContain("no session_id in payload");
		expect(fs.existsSync(path.join(dir, ".claude/tmp/markers"))).toBe(false);
	});

	it("rides a held prelude in the over-cap refusal too", () => {
		fragment("huge", RULE_CAP + 1);
		expect(
			call({ injectRules: ["huge"], prelude: "P" }).out
				.permissionDecisionReason,
		).toMatch(/\n\nThe guard also had this to say:\nP$/);
	});

	it("emits a prelude naming no rule where the cap is unreadable, and refuses one naming a rule", () => {
		fragment("a");
		const warn = call({ injectRules: [], prelude: "P" }, { capBroken: true });
		expect(warn.out).toEqual({
			hookEventName: "PreToolUse",
			additionalContext: "P",
		});
		const rule = call(inject("a"), { capBroken: true });
		expect(rule.out.permissionDecision).toBe("deny");
		expect(rule.out.permissionDecisionReason).toContain("cap unreadable");
	});

	it("rides a held prelude in the store fault's refusal", () => {
		const { out } = call({ injectRules: ["ghost"], prelude: "P" });
		expect(out.permissionDecisionReason).toMatch(
			/\n\nThe guard also had this to say:\nP$/,
		);
	});

	it("marks the prelude's latch told once the envelope is out, which told() then reads", () => {
		expect(JSON.parse(call({ probe: "w" }).out.additionalContext).told).toBe(
			false,
		);
		call({ injectRules: [], prelude: "P", latchAfter: "w" });
		expect(fs.existsSync(marker("warn.w"))).toBe(true);
		expect(JSON.parse(call({ probe: "w" }).out.additionalContext).told).toBe(
			true,
		);
	});

	it("writes the guard's own latches with the envelope, which readLatch() reads back", () => {
		expect(
			JSON.parse(call({ probe: "sum.x" }).out.additionalContext).latch,
		).toBeNull();
		call({
			injectRules: [],
			prelude: "P",
			latchWrites: [{ name: "sum.x", text: "abc" }],
		});
		expect(
			JSON.parse(call({ probe: "sum.x" }).out.additionalContext).latch,
		).toBe("abc");
	});

	it("tells an unkeyed session from a keyed one, where both read no latch (#3018)", () => {
		const probe = (session: string | null) =>
			JSON.parse(call({ probe: "sum.x" }, { session }).out.additionalContext);
		expect(probe("s1")).toEqual({ told: false, latch: null, keyed: true });
		expect(probe(null)).toEqual({ told: false, latch: null, keyed: false });
	});
});

describe("a context answer", () => {
	it("hands its text as additionalContext under the entry's event", () => {
		expect(call({ context: "told" }).out).toEqual({
			hookEventName: "PreToolUse",
			additionalContext: "told",
		});
		expect(call({ context: "told" }, { event: "PostToolUse" }).out).toEqual({
			hookEventName: "PostToolUse",
			additionalContext: "told",
		});
	});

	it("answers a UserPromptSubmit entry under its own event (#2792)", () => {
		expect(
			call({ context: "told" }, { event: "UserPromptSubmit" }).out,
		).toEqual({ hookEventName: "UserPromptSubmit", additionalContext: "told" });
	});
});

describe("a PostToolUse guard (#2785)", () => {
	const post = { event: "PostToolUse" };

	it("drops an injection, logged, since only PreToolUse reads one", () => {
		fragment("alpha");
		const r = call(inject("alpha"), post);
		expect(r.out).toBeNull();
		expect(readGuardErrorsLog(config)).toContain(
			"a PostToolUse guard answered a PreToolUse decision",
		);
	});

	it("starts a launch detached, its output appended to its log under the markers dir", async () => {
		const done = path.join(dir, "launched");
		const script = path.join(dir, "launch.js");
		fs.writeFileSync(
			script,
			`console.log("ran"); require("fs").writeFileSync(${JSON.stringify(done)}, "");\n`,
		);
		const rel = path.relative(path.resolve(__dirname, ".."), script);
		const r = call({ launch: { script: rel, log: ".launch.log" } }, post);
		expect(r.status).toBe(0);
		expect(r.out).toBeNull();
		/* Crosses the real clock: the launch is a detached child. */
		for (let waited = 0; waited < 10_000 && !fs.existsSync(done); waited += 50)
			await new Promise((resolve) => setTimeout(resolve, 50));
		expect(
			fs.readFileSync(
				path.join(dir, ".claude/tmp/markers/.launch.log"),
				"utf8",
			),
		).toBe("ran\n");
	});
});

describe("a store fault refuses the call, as JSON on exit 0 (mantahostels#1762)", () => {
	it("refuses an id no fragment answers to", () => {
		const r = call(inject("missing"));
		expect(r.status).toBe(0);
		expect(r.out.permissionDecision).toBe("deny");
		expect(r.out.permissionDecisionReason).toMatch(
			/^guard-fixture\.js: rule-text: no fragment for rule id "missing"/,
		);
		expect(readGuardErrorsLog(config)).toMatch(
			/guard-fixture\.js\trule fragment unreadable — refusing/,
		);
	});

	it("refuses a fragment that alone is over the cap", () => {
		fragment("huge", RULE_CAP + 1);
		const r = call(inject("huge"));
		expect(r.out.permissionDecision).toBe("deny");
		expect(r.out.permissionDecisionReason).toContain(
			`"huge" is ${RULE_CAP + 1} bytes, over the ${RULE_CAP}-byte emission ceiling`,
		);
	});

	it("defers, without refusing, one a higher-priority fragment pushes out", () => {
		fragment("alpha", 30);
		fragment("big", RULE_CAP - 10);
		expect(call(inject("alpha", "big")).out.permissionDecision).toBeUndefined();
	});
});

describe("a decision", () => {
	it("to deny is permissionDecision JSON on exit 0", () => {
		const r = call({ deny: "no" });
		expect(r.status).toBe(0);
		expect(r.out).toEqual({
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
			permissionDecisionReason: "no",
		});
	});

	it("to deny writes its latches once the refusal is out", () => {
		const latch = path.join(
			dir,
			".claude/tmp/markers",
			".rule-injected-once.k-main-s1",
		);
		expect(
			call({ deny: "no", latchWrites: [{ name: "once.k", text: "" }] }).out
				.permissionDecision,
		).toBe("deny");
		expect(fs.existsSync(latch)).toBe(true);
	});

	it("of null allows in silence", () => {
		const r = call(null);
		expect(r).toEqual({ status: 0, stderr: "", out: null });
		expect(readGuardErrorsLog(config)).toBe("");
	});
});

describe("an entry run by hand (#3556)", () => {
	it("refuses arguments on exit 1 before reading stdin, naming itself and the hook it is", () => {
		fragment("alpha");
		const r = call(inject("alpha"), { args: ["3435"] });
		expect(r.status).toBe(1);
		expect(r.out).toBeNull();
		expect(r.stderr).toBe(
			"guard-fixture.js: a PreToolUse hook, which reads its payload on stdin and takes no arguments — refused before reading stdin, nothing done\n",
		);
		expect(readGuardErrorsLog(config)).toBe("");
	});
});

describe("everything else fails open, on the record (mantahostels#103)", () => {
	it.each([
		["not json", /payload did not parse as JSON — command allowed unchecked/],
		[
			JSON.stringify({ session_id: "s1", tool_input: {} }),
			/no command in payload — command allowed unchecked/,
		],
	])("allows a payload of %s, logged", (stdin, record) => {
		fragment("alpha");
		const r = call(inject("alpha"), { stdin });
		expect(r).toEqual({ status: 0, stderr: "", out: null });
		expect(readGuardErrorsLog(config)).toMatch(record);
	});

	it("allows an empty payload unrecorded", () => {
		const r = call(inject("alpha"), { stdin: "" });
		expect(r.out).toBeNull();
		expect(readGuardErrorsLog(config)).toBe("");
	});

	it("skips injection where the payload has no session id, logged", () => {
		fragment("alpha");
		const r = call(inject("alpha"), { session: null });
		expect(r.out).toBeNull();
		expect(readGuardErrorsLog(config)).toMatch(/no session_id in payload/);
	});

	it("writes a core's detail as the record's own fourth field, as gl_log does (#320)", () => {
		call({ log: ["tree unresolved", "a\tb\x01c"] });
		const record = readGuardErrorsLog(config).trimEnd().split("\n").at(-1);
		expect(record?.split("\t").slice(2)).toEqual(["tree unresolved", "a bc"]);
	});

	it("allows the call where the core throws, logged", () => {
		const r = call("throw");
		expect(r).toEqual({ status: 0, stderr: "", out: null });
		expect(readGuardErrorsLog(config)).toMatch(
			/guard threw — allowed unchecked: core broke/,
		);
	});

	it('refuses, naming the entry, where an `onThrow: "refuse"` core throws (#3018)', () => {
		const r = call("throw", { onThrow: "refuse" });
		expect(r).toEqual({
			status: 0,
			stderr: "",
			out: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason:
					"guard-fixture.js could not judge this command, so it refuses it: core broke",
			},
		});
		expect(readGuardErrorsLog(config)).toMatch(
			/core threw — the command was refused\tcore broke/,
		);
	});
});

describe("the host's config", () => {
	it("stands a guard listed under disabled down unread (#2)", () => {
		writeConfig(
			JSON.stringify({ contract: 1, disabled: ["guard-fixture.js"] }),
		);
		fragment("alpha");
		expect(call(inject("alpha")).out).toBeNull();
	});

	it("stands down under the name it is given, not its file's, where one is (#2792)", () => {
		writeConfig(JSON.stringify({ contract: 1, disabled: ["shared-name"] }));
		expect(call({ context: "told" }, { name: "shared-name" }).out).toBeNull();
		expect(call({ context: "told" }).out).not.toBeNull();
		writeConfig(
			JSON.stringify({ contract: 1, disabled: ["guard-fixture.js"] }),
		);
		expect(
			call({ context: "told" }, { name: "shared-name" }).out,
		).not.toBeNull();
	});

	it("lets a module that is on gate its ids in", () => {
		writeConfig(JSON.stringify({ contract: 1, modules: ["roadmap"] }));
		fragment("alpha");
		expect(
			call({ module: "roadmap", decision: inject("alpha") }).out,
		).not.toBeNull();
	});

	it("reads a module as off on a config fault, logged once a run (#2409)", () => {
		writeConfig("{ broken");
		fragment("alpha");
		expect(
			call({ module: "roadmap", decision: inject("alpha") }).out,
		).toBeNull();
		expect(
			readGuardErrorsLog(config).match(
				/module roadmap read as off on a config fault/g,
			),
		).toHaveLength(1);
	});
});

describe("the root adapter is timed (#2784)", () => {
	/* Crosses the real clock on purpose: what is proved is that the kit's git
	 * read is killed at its timeout, which only a real process timeout shows. */
	it("answers the working directory where git runs past its timeout", () => {
		const git = path.join(dir, "slow-git");
		fs.writeFileSync(git, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
		const env: NodeJS.ProcessEnv = {
			...process.env,
			CLAUDE_CONFIG_DIR: config,
			WFC_GIT: git,
			WFC_TEST_DECISION: "null",
		};
		delete env.CLAUDE_PROJECT_DIR;
		const started = Date.now();
		const r = runInProcess(entry, [], {
			cwd: dir,
			stdin: JSON.stringify({ tool_input: { command: "x" } }),
			env,
		});
		expect(r.status).toBe(0);
		expect(Date.now() - started).toBeLessThan(10_000);
	}, 15_000);

	/* One run with CLAUDE_PROJECT_DIR unset and a git that logs each spawn and
	 * hangs: its result, and how many times the root was read. */
	const underHungGit = (decision: unknown, payload: object) => {
		const calls = path.join(dir, "git-calls");
		const git = path.join(dir, "slow-git");
		fs.writeFileSync(git, `#!/bin/sh\necho x >> '${calls}'\nexec sleep 30\n`, {
			mode: 0o755,
		});
		const env: NodeJS.ProcessEnv = {
			...process.env,
			CLAUDE_CONFIG_DIR: config,
			WFC_GIT: git,
			WFC_TEST_DECISION: JSON.stringify(decision),
		};
		delete env.CLAUDE_PROJECT_DIR;
		delete env.WFC_RULES_DIR;
		const r = runInProcess(entry, [], {
			cwd: dir,
			stdin: JSON.stringify(payload),
			env,
		});
		const spawns = fs
			.readFileSync(calls, "utf8")
			.split("\n")
			.filter(Boolean).length;
		return { r, spawns };
	};

	/* The fail-open record files under the root the entry already resolved: a
	 * second root read would re-run the hung git unbounded. Counted through the
	 * stub, but crossing the real clock: the one read is bounded only by a real
	 * process timeout. */
	it("writes its fail-open record off that one root read (#3038)", () => {
		const { r, spawns } = underHungGit("throw", {
			tool_input: { command: "x" },
		});
		expect(r.status).toBe(0);
		expect(spawns).toBe(1);
		expect(readGuardErrorsLog(config)).toMatch(
			/guard threw — allowed unchecked/,
		);
	}, 40_000);

	/* No WFC_RULES_DIR: the store is the host's own, under the root the timed
	 * read fell back to. Real clock, as above. */
	it.each([
		["an injecting decision", { injectRules: ["alpha"] }],
		["the ruleText port", { ruleText: "alpha" }],
	])(
		"reads the rule store off that one root read through %s (#3142)",
		(_, decision) => {
			const hostStore = path.join(dir, "docs", "agents", "rules");
			fs.mkdirSync(hostStore, { recursive: true });
			fs.writeFileSync(path.join(hostStore, "alpha.txt"), "alpha rule");
			const { r, spawns } = underHungGit(decision, {
				session_id: "s1",
				hook_event_name: "PreToolUse",
				tool_input: { command: "x" },
			});
			expect(r.status).toBe(0);
			expect(r.stdout).toMatch(/alpha rule/);
			expect(spawns).toBe(1);
		},
		40_000,
	);
});
