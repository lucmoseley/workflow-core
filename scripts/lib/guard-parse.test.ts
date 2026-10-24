// @vitest-environment node
/*
 * Direct tests for scripts/lib/guard-parse.sh — the verdict emitters (mantahostels#138),
 * the payload seam and the walkers (mantahostels#157): the library's whole
 * public surface.
 *
 * The sentinel marking a blanked quoted span is $'\x01QSTR\x01', not the bare
 * letters, so the cases below interpolate the library's own $QUOTED in bash
 * rather than spelling it out and silently testing nothing.
 *
 * Every shell guard wired as a hook in .claude/settings.json emits its verdict
 * through this library, so a loosened case can let a deny go out as an
 * envelope Claude Code cannot parse — the call then runs unrefused — or a warn
 * read as a deny.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	defineTemplate,
	mkDirOutsideRepo,
	mkScratchDir,
	scratchBase,
	trioTemplate,
} from "./git-fixture";
import { shellConst } from "./shell-const-testkit";

const LIB = path.resolve(__dirname, "guard-parse.sh");

const sh = (snippet: string) =>
	execFileSync("bash", ["-uo", "pipefail", "-c", `source ${LIB}\n${snippet}`], {
		encoding: "utf8",
	});

/** gp_deny/gp_warn exit 0 after printing, so they run in a subshell. */
const emit = (snippet: string) => JSON.parse(sh(`( ${snippet} )`));

describe("gp_deny", () => {
	it("emits the envelope Claude Code parses", () => {
		expect(emit(`gp_deny "just because"`)).toEqual({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: "just because",
			},
		});
	});

	it("splices the segment into @CMD@", () => {
		const out = emit(`gp_deny "no: @CMD@ stop" "git checkout foo"`);
		expect(out.hookSpecificOutput.permissionDecisionReason).toBe(
			"no: git checkout foo stop",
		);
	});

	it("leaves the reason alone when given no segment", () => {
		// guard-last30days.sh calls the one-argument form; its prose carries no
		// @CMD@, so the splice must be a no-op rather than an error under `set -u`.
		const out = emit(`gp_deny "a skill, not a command"`);
		expect(out.hookSpecificOutput.permissionDecisionReason).toBe(
			"a skill, not a command",
		);
	});

	it("trims the one trailing newline a heredoc leaves", () => {
		const out = emit(`gp_deny "$(printf 'line\\n')"`);
		expect(out.hookSpecificOutput.permissionDecisionReason).toBe("line");
	});

	it("keeps an & in the command intact", () => {
		// Bash >= 5.2 has patsub_replacement on, so an unquoted & in a ${//}
		// replacement stands for the matched text: splicing with ${reason//@CMD@/…}
		// renders `foo & bar` as `foo @CMD@ bar`. The splice is jq split/join for
		// this reason.
		const out = emit(`gp_deny "ran: @CMD@" "foo & bar"`);
		expect(out.hookSpecificOutput.permissionDecisionReason).toBe(
			"ran: foo & bar",
		);
	});

	it("keeps a backslash in the command intact", () => {
		const out = emit(`gp_deny "ran: @CMD@" 'a\\b'`);
		expect(out.hookSpecificOutput.permissionDecisionReason).toBe("ran: a\\b");
	});

	it("fills every @CMD@, not just the first", () => {
		const out = emit(`gp_deny "@CMD@ then @CMD@" "x"`);
		expect(out.hookSpecificOutput.permissionDecisionReason).toBe("x then x");
	});

	it("unmasks the segment it splices", () => {
		const out = emit(`gp_deny "ran: @CMD@" "git checkout $QUOTED"`);
		expect(out.hookSpecificOutput.permissionDecisionReason).toBe(
			'ran: git checkout "…"',
		);
	});
});

describe("gp_warn", () => {
	it("emits additionalContext under the same event name", () => {
		// A block missing hookEventName is dropped silently.
		expect(emit(`gp_warn "mind this"`)).toEqual({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				additionalContext: "mind this",
			},
		});
	});

	it("sets no permissionDecision — a warn must not read as a deny", () => {
		const out = emit(`gp_warn "mind this"`);
		expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
	});
});

/* An adopter's guard names the core's files where the plugin installed them
 * (#1010). */
describe("gp_deny and gp_warn in a plugin install", () => {
	const install = () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-install-"));
		fs.mkdirSync(path.join(root, "scripts"));
		fs.mkdirSync(path.join(root, "docs", "agents"), { recursive: true });
		fs.writeFileSync(path.join(root, "scripts", "a.js"), "");
		fs.writeFileSync(path.join(root, "docs", "agents", "t.md"), "");
		return root;
	};
	const emitIn = (root: string, snippet: string) => {
		const r = spawnSync(
			"bash",
			["-uo", "pipefail", "-c", `source ${LIB}\n( ${snippet} )`],
			{ encoding: "utf8", env: { ...process.env, WFC_SCRIPT_ROOT: root } },
		);
		fs.rmSync(root, { recursive: true, force: true });
		return JSON.parse(r.stdout).hookSpecificOutput;
	};

	it("spells a deny's core paths at the plugin root, leaving @CMD@'s as typed", () => {
		const root = install();
		const out = emitIn(
			root,
			`gp_deny "run node scripts/a.js; read docs/agents/t.md. @CMD@" "cat docs/agents/t.md"`,
		);
		expect(out.permissionDecisionReason).toBe(
			`run node ${root}/scripts/a.js; read ${root}/docs/agents/t.md. cat docs/agents/t.md`,
		);
	});

	it("spells a warn's core paths at the plugin root", () => {
		const root = install();
		expect(emitIn(root, `gp_warn "Rules: docs/agents/t.md."`)).toEqual({
			hookEventName: "PreToolUse",
			additionalContext: `Rules: ${root}/docs/agents/t.md.`,
		});
	});

	it("names gp_subagent_wait_text's script at the plugin root, and the emitter does not resolve it a second time (#1758)", () => {
		const root = install();
		const out = emitIn(root, `gp_warn "Instead: $(gp_subagent_wait_text)"`);
		expect(out.additionalContext).toContain(
			`\`${root}/scripts/bg-run.sh wait <name>\``,
		);
	});

	it("names gp_subagent_wait_text's script bare in a checkout", () => {
		const root = install();
		fs.writeFileSync(path.join(root, "package.json"), "{}");
		const out = emitIn(root, `gp_warn "Instead: $(gp_subagent_wait_text)"`);
		expect(out.additionalContext).toContain("`scripts/bg-run.sh wait <name>`");
	});
});

/*
 * gp_rule — the pre-emptive emitter and its latch (mantahostels#1804, spec mantahostels#1762).
 *
 * These run the real library against a throwaway rule store (WFC_RULES_DIR)
 * and a throwaway project root (CLAUDE_PROJECT_DIR, which is where the latch
 * markers land), so no case touches the live store or drops a marker into the
 * shared working tree.
 */
describe("gp_rule", () => {
	let root: string;
	let rules: string;
	let proj: string;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-rule-"));
		rules = path.join(root, "rules");
		proj = path.join(root, "proj");
		fs.mkdirSync(rules);
		fs.mkdirSync(proj);
	});
	afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

	const fragment = (id: string, body: string) =>
		fs.writeFileSync(path.join(rules, `${id}.txt`), `${body}\n`);

	/** n characters of fragment body, so a case can sit either side of the cap. */
	const bulk = (n: number) => "x".repeat(n);

	/**
	 * Drive gp_rule the way a guard does: gp_begin first, on a field that is NOT
	 * .session_id, so gp_rule's own payload limbs are the ones under test rather
	 * than gp_begin's.
	 */
	const run = (
		snippet: string,
		payload: string | null = '{"tool_name":"Bash","session_id":"sid-1"}',
		opts: Record<string, unknown> = {},
	) =>
		spawnSync(
			"bash",
			[
				"-uo",
				"pipefail",
				"-c",
				`source ${LIB}\n${payload === null ? "" : "gp_begin '.tool_name' 'call'\n"}${snippet}\nexit 0`,
			],
			{
				input: payload ?? "",
				encoding: "utf8",
				env: {
					...process.env,
					CLAUDE_PROJECT_DIR: proj,
					WFC_RULES_DIR: rules,
					// gl_open's fail-open record, kept out of the real log.
					CLAUDE_CONFIG_DIR: path.join(root, "config"),
				},
				...opts,
			},
		);

	const context = (r: { stdout: string }) =>
		JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string;

	/**
	 * Every fail-open reason guard-log.sh recorded for this case. Its own
	 * `logged()` helper is keyed to the shared fixture's project dir, so this
	 * block reads the log under its own throwaway root instead.
	 */
	const faults = () => {
		const dir = path.join(root, "config", "projects");
		if (!fs.existsSync(dir)) return "";
		// Every project directory, this fixture's own and the fixed
		// `unresolved-root` one gl_log files under when it can resolve no root
		// (mantahostels#2438) — which is the arm the fault sentences below are recorded on.
		return fs
			.readdirSync(dir)
			.map((d) => path.join(dir, d, "guard-errors.log"))
			.filter((f) => fs.existsSync(f))
			.map((f) => fs.readFileSync(f, "utf8"))
			.join("\n");
	};

	const marker = (id: string, sid = "sid-1", agent = "main") =>
		path.join(
			proj,
			".claude",
			"tmp",
			"markers",
			`.rule-injected-${id}-${agent}-${sid}`,
		);

	it("emits the fragment through the additionalContext envelope", () => {
		fragment("one", "Rule one, in full.");
		const r = run("gp_rule one");
		expect(r.status).toBe(0);
		expect(JSON.parse(r.stdout)).toEqual({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				additionalContext: "Rule one, in full.",
			},
		});
	});

	it("sets no permissionDecision — an injection is not a refusal", () => {
		fragment("one", "Rule one.");
		const out = JSON.parse(run("gp_rule one").stdout);
		expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
	});

	it("concatenates several ids in the order given", () => {
		fragment("one", "First.");
		fragment("two", "Second.");
		expect(context(run("gp_rule one two"))).toBe("First.\n\nSecond.");
	});

	it("emits nothing at all when given no ids", () => {
		expect(run("gp_rule").stdout).toBe("");
	});

	// --- store faults: fail CLOSED ---

	it("refuses with exit 2 on an id no fragment answers to", () => {
		const r = run("gp_rule no-such-rule");
		expect(r.status).toBe(2);
		expect(r.stdout).toBe("");
		expect(r.stderr).toMatch(/no fragment for rule id "no-such-rule"/);
		// stderr reaches only the session refused; the log reaches the next
		// session start, which is where a store this broken has to surface.
		expect(faults()).toMatch(/rule fragment unreadable/);
	});

	it("refuses with exit 2 on an empty fragment", () => {
		fs.writeFileSync(path.join(rules, "hollow.txt"), "   \n");
		const r = run("gp_rule hollow");
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/is empty/);
	});

	it("refuses the whole call when one of several ids is unknown", () => {
		fragment("one", "First.");
		// exempt (mantahostels#2082): stderr message pinned by "refuses with exit 2 on an id no fragment
		// answers to" above — same "no fragment for rule id" path, reached
		// here on the first unknown id in a multi-id call.
		const r = run("gp_rule one no-such-rule");
		expect(r.status).toBe(2);
		expect(r.stdout).toBe("");
		expect(fs.existsSync(marker("one"))).toBe(false);
	});

	it("refuses with exit 2 when the store directory cannot be read", () => {
		const r = run("gp_rule one", '{"tool_name":"Bash","session_id":"sid-1"}', {
			env: {
				...process.env,
				CLAUDE_PROJECT_DIR: proj,
				WFC_RULES_DIR: path.join(root, "no-such-store"),
				CLAUDE_CONFIG_DIR: path.join(root, "config"),
			},
		});
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/no fragment for rule id "one"/);
		expect(r.stderr).toContain("no-such-store");
		expect(r.stderr).toContain("The store holds no fragments.");
	});

	// --- payload faults: fail OPEN, the house rule (mantahostels#103) ---

	it("allows and emits nothing when the payload carries no session_id", () => {
		fragment("one", "First.");
		const r = run("gp_rule one", '{"tool_name":"Bash"}');
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
		// Recorded, not merely allowed (mantahostels#147).
		expect(faults()).toMatch(/no session_id in payload/);
	});

	it("allows and emits nothing on a payload that does not parse", () => {
		// Set directly: gp_begin catches unparseable JSON first, so driving it
		// through the guard path would test gp_begin rather than gp_rule.
		fragment("one", "First.");
		const r = run(`_gp_payload='not json'\ngp_rule one`, null);
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
		expect(faults()).toMatch(/did not parse as JSON/);
	});

	it("allows and emits nothing when there is no payload at all", () => {
		fragment("one", "First.");
		const r = run(`_gp_payload=''\ngp_rule one`, null);
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
		expect(faults()).toMatch(/no payload/);
	});

	it("allows and emits nothing when jq is missing", () => {
		// A PATH holding everything the fail-open record needs and no jq — not an
		// empty PATH, which would also take `mkdir` away and so leave the record
		// unwritten for a reason that has nothing to do with jq.
		const bin = path.join(root, "bin");
		fs.mkdirSync(bin);
		for (const tool of ["mkdir", "git", "cat", "date", "rm"]) {
			const real = spawnSync("which", [tool], {
				encoding: "utf8",
			}).stdout.trim();
			if (real) fs.symlinkSync(real, path.join(bin, tool));
		}
		fragment("one", "First.");
		const r = run(
			`PATH='${bin}'\n_gp_payload='{"session_id":"sid-1"}'\ngp_rule one`,
			null,
		);
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
		expect(faults()).toMatch(/jq not found/);
	});

	// --- the latch ---

	it("emits once per session per rule", () => {
		fragment("one", "First.");
		expect(context(run("gp_rule one"))).toBe("First.");
		expect(fs.existsSync(marker("one"))).toBe(true);
		const second = run("gp_rule one");
		expect(second.status).toBe(0);
		expect(second.stdout).toBe("");
	});

	it("emits again for a different session id", () => {
		fragment("one", "First.");
		run("gp_rule one");
		const other = run(
			"gp_rule one",
			'{"tool_name":"Bash","session_id":"sid-2"}',
		);
		expect(context(other)).toBe("First.");
	});

	it("shares one latch between `rule:x` and `x`", () => {
		fragment("one", "First.");
		expect(context(run("gp_rule rule:one"))).toBe("First.");
		expect(fs.existsSync(marker("one"))).toBe(true);
		expect(run("gp_rule one").stdout).toBe("");
	});

	it("shares that latch in the other order too", () => {
		fragment("one", "First.");
		expect(context(run("gp_rule one"))).toBe("First.");
		expect(run("gp_rule rule:one").stdout).toBe("");
	});

	it("emits a prefixed id once when a call names both spellings", () => {
		fragment("one", "First.");
		expect(context(run("gp_rule rule:one one"))).toBe("First.");
	});

	// The SKIP carries the prefix, gp_rule's argument does not: gp_rule bares its
	// own ids, so a scoping spelled bare would match either way and pin nothing.
	it("scopes an id away when the skip carries the prefix", () => {
		fragment("one", "First.");
		fragment("two", "Second.");
		expect(context(run("gp_rule_skip rule:one\ngp_rule one two"))).toBe(
			"Second.",
		);
	});

	// gp_rule hands the store's accessor the caller's spelling and bares only for
	// the latch key, so the one strip is the store's.
	it("refuses a doubly-prefixed id, as the store does, saying it is not a rule id and writing no marker", () => {
		fragment("one", "First.");
		const r = run("gp_rule rule:rule:one");
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/not a rule id/);
		expect(fs.existsSync(marker("rule:one"))).toBe(false);
		expect(fs.existsSync(marker("one"))).toBe(false);
	});

	it("shares one gp_rule_told latch between `rule:x` and `x`", () => {
		expect(run("gp_rule_told rule:one; echo $?").stdout.trim()).toBe("1");
		run("gp_rule_mark_told rule:one");
		expect(run("gp_rule_told one; echo $?").stdout.trim()).toBe("0");
	});

	it("drops only the latched ids, emitting the rest", () => {
		fragment("one", "First.");
		fragment("two", "Second.");
		run("gp_rule one");
		expect(context(run("gp_rule one two"))).toBe("Second.");
	});

	/*
	 * A PreToolUse hook killed at its 10 s ceiling has its stdout discarded, so
	 * latching after leaves a cancelled hook's id free to arrive on the next
	 * trigger — mantahostels#2261, which reversed the order.
	 */
	it("writes no marker when the emission itself dies", () => {
		fragment("one", "First.");
		const r = run("_gp_emit_context() { exit 3; }\ngp_rule one");
		expect(r.status).toBe(3);
		expect(r.stdout).toBe("");
		expect(fs.existsSync(marker("one"))).toBe(false);
	});

	it("leaves the rule deliverable on the next call after a killed emission", () => {
		fragment("one", "First.");
		run("_gp_emit_context() { exit 3; }\ngp_rule one");
		expect(context(run("gp_rule one"))).toBe("First.");
	});

	it("records a fail-open and latches nothing when the envelope will not render", () => {
		fragment("one", "First.");
		const r = run("_gp_emit_context() { return 1; }\ngp_rule one");
		expect(r.status).toBe(0);
		expect(fs.existsSync(marker("one"))).toBe(false);
		expect(faults()).toMatch(/rule envelope did not render/);
	});

	it("sanitises a session id before it becomes a path segment", () => {
		fragment("one", "First.");
		run("gp_rule one", '{"tool_name":"Bash","session_id":"../escape"}');
		expect(
			fs.existsSync(path.join(root, ".rule-injected-one-main-../escape")),
		).toBe(false);
		expect(
			fs.readdirSync(path.join(proj, ".claude", "tmp", "markers")),
		).toEqual([".rule-injected-one-main-___escape"]);
	});

	/*
	 * The subagent discriminator (mantahostels#1804). A dispatched subagent's PreToolUse
	 * payload carries its PARENT's session_id, and differs only by an `agent_id`
	 * the parent's own calls do not carry.
	 */
	describe("the subagent discriminator", () => {
		const child = (agent = "ac7cb4a45383cc850") =>
			`{"tool_name":"Bash","session_id":"sid-1","agent_id":"${agent}"}`;

		it("emits to a subagent whose parent has already been told", () => {
			fragment("one", "First.");
			expect(context(run("gp_rule one"))).toBe("First.");
			expect(context(run("gp_rule one", child()))).toBe("First.");
		});

		it("emits once per subagent, not once per call", () => {
			fragment("one", "First.");
			run("gp_rule one", child());
			expect(run("gp_rule one", child()).stdout).toBe("");
		});

		it("tells two subagents of the same parent apart", () => {
			fragment("one", "First.");
			run("gp_rule one", child("aaa1"));
			expect(context(run("gp_rule one", child("bbb2")))).toBe("First.");
		});

		it("keys the marker so the session id stays its suffix", () => {
			// pruneMarkers matches a live session's id as a SUFFIX, so a marker
			// ending in the agent id would outlive its parent by a full day.
			fragment("one", "First.");
			run("gp_rule one", child("aaa1"));
			expect(
				fs.readdirSync(path.join(proj, ".claude", "tmp", "markers")),
			).toEqual([".rule-injected-one-aaaa1-sid-1"]);
		});

		it("reads a payload with no agent_id as the parent", () => {
			fragment("one", "First.");
			run("gp_rule one");
			expect(fs.existsSync(marker("one"))).toBe(true);
		});
	});

	// --- the cap ---

	it("defers the ids that do not fit rather than truncating them", () => {
		fragment("big", bulk(3000));
		fragment("also", bulk(3000));
		const first = run("gp_rule big also");
		expect(context(first)).toBe(bulk(3000));
		expect(context(first).length).toBe(3000);
		expect(fs.existsSync(marker("big"))).toBe(true);
		expect(fs.existsSync(marker("also"))).toBe(false);
	});

	it("delivers a deferred rule whole on the next trigger", () => {
		fragment("big", bulk(3000));
		fragment("also", bulk(3000));
		run("gp_rule big also");
		expect(context(run("gp_rule big also"))).toBe(bulk(3000));
	});

	it("stops at the first id that does not fit rather than promoting a smaller one", () => {
		// Priority order is the caller's statement of which rule matters most.
		fragment("big", bulk(3000));
		fragment("huge", bulk(3000));
		fragment("tiny", "Small.");
		const r = run("gp_rule big huge tiny");
		expect(context(r)).toBe(bulk(3000));
		expect(fs.existsSync(marker("tiny"))).toBe(false);
	});

	it("fills the ceiling exactly when the pair plus its separator reaches it", () => {
		fragment("a", bulk(2000));
		fragment("b", bulk(1998));
		const r = run("gp_rule a b");
		expect(context(r).length).toBe(4000);
		expect(fs.existsSync(marker("b"))).toBe(true);
	});

	it("counts the separator against the ceiling", () => {
		// 2000 + 2 for the blank line + 1999 is 4001, one over — so `b` defers.
		fragment("a", bulk(2000));
		fragment("b", bulk(1999));
		const r = run("gp_rule a b");
		expect(context(r)).toBe(bulk(2000));
		expect(fs.existsSync(marker("b"))).toBe(false);
	});

	it("measures the ceiling in bytes, whatever locale the hook inherits", () => {
		// An em dash is one character and three bytes, so 1,500 of them is 4,500
		// bytes — over the ceiling.
		fragment("wide", "—".repeat(1500));
		const utf8 = run("gp_rule wide", undefined, {
			env: {
				...process.env,
				CLAUDE_PROJECT_DIR: proj,
				WFC_RULES_DIR: rules,
				CLAUDE_CONFIG_DIR: path.join(root, "config"),
				LC_ALL: "C.UTF-8",
			},
		});
		expect(utf8.status).toBe(2);
		expect(utf8.stderr).toMatch(/4500 bytes/);
	});

	it("emits a repeated id once", () => {
		fragment("one", "First.");
		expect(context(run("gp_rule one one"))).toBe("First.");
	});

	it("refuses with exit 2 on a single fragment too large to emit at all", () => {
		fragment("whale", bulk(4001));
		const r = run("gp_rule whale");
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/over the 4000-byte emission ceiling/);
		expect(faults()).toMatch(/over the emission ceiling/);
	});

	/*
	 * gp_rule_told / gp_rule_mark_told — the bound on a fragment a guard splices
	 * into text it composes itself (mantahostels#2275). They share gp_rule's marker root and
	 * key, and nothing else: their own `warn.` namespace is the whole point.
	 */
	describe("the composed-text latch", () => {
		const told = (id: string) =>
			run(`gp_rule_told ${id} && echo TOLD || echo UNTOLD`);

		it("reports a fragment untold until it is marked", () => {
			expect(told("vitest-wrapper").stdout.trim()).toBe("UNTOLD");
			run("gp_rule_mark_told vitest-wrapper");
			expect(told("vitest-wrapper").stdout.trim()).toBe("TOLD");
		});

		it("keys the marker on the session, so a second session is told afresh", () => {
			run("gp_rule_mark_told vitest-wrapper");
			expect(
				run(
					"gp_rule_told vitest-wrapper && echo TOLD || echo UNTOLD",
					'{"tool_name":"Bash","session_id":"sid-2"}',
				).stdout.trim(),
			).toBe("UNTOLD");
		});

		it("keys it on the agent too, so a subagent is told afresh", () => {
			run("gp_rule_mark_told vitest-wrapper");
			expect(
				run(
					"gp_rule_told vitest-wrapper && echo TOLD || echo UNTOLD",
					'{"tool_name":"Bash","session_id":"sid-1","agent_id":"aa1"}',
				).stdout.trim(),
			).toBe("UNTOLD");
		});

		/* The namespace: a marker scripts/clear-rule-latch.sh's
		 * `.rule-injected-*-<sid>` glob still clears at a compaction, and
		 * arbiter-markers.js still sweeps. */
		it("writes its marker under gp_rule's prefix and its own namespace", () => {
			run("gp_rule_mark_told vitest-wrapper");
			expect(
				fs.readdirSync(path.join(proj, ".claude", "tmp", "markers")),
			).toEqual([".rule-injected-warn.vitest-wrapper-main-sid-1"]);
		});

		/* A composed splice must never silence the same rule stated pre-emptively,
		 * nor the other way about: a REFUSAL states the rule it refuses on
		 * whatever the session was handed earlier. */
		it("does not answer for gp_rule's own latch, in either direction", () => {
			fragment("one", "First.");
			run("gp_rule_mark_told one");
			expect(context(run("gp_rule one"))).toBe("First.");

			fragment("two", "Second.");
			run("gp_rule two");
			expect(
				run("gp_rule_told two && echo TOLD || echo UNTOLD").stdout.trim(),
			).toBe("UNTOLD");
		});

		it("reports untold where the payload carries no session id", () => {
			expect(
				run(
					"gp_rule_told vitest-wrapper && echo TOLD || echo UNTOLD",
					'{"tool_name":"Bash"}',
				).stdout.trim(),
			).toBe("UNTOLD");
		});

		it("marks nothing where the payload carries no session id", () => {
			run("gp_rule_mark_told vitest-wrapper", '{"tool_name":"Bash"}');
			expect(fs.readdirSync(proj)).toEqual([]);
		});

		/* A guard calls this for its side effect and reads nothing back, so a
		 * non-zero here would reach the session only as a hook exiting non-zero —
		 * which Claude Code reads as the hook being broken, not as a latch that
		 * could not be written. */
		it("still exits 0 when it cannot latch at all", () => {
			expect(
				run(
					'gp_rule_mark_told vitest-wrapper; echo "rc=$?"',
					'{"tool_name":"Bash"}',
				).stdout.trim(),
			).toBe("rc=0");
		});

		/* Both wordings in full — a pattern matching only the fault's name would
		 * pass a merge that collapsed them (mantahostels#2423). */
		it("records every unlatchable firing, so a silent repeat is visible", () => {
			run("gp_rule_told vitest-wrapper", '{"tool_name":"Bash"}');
			run("gp_rule_mark_told vitest-wrapper", '{"tool_name":"Bash"}');
			expect(faults()).toMatch(
				/no session key — rule vitest-wrapper unlatchable, delivered again/,
			);
			expect(faults()).toMatch(
				/no session key — rule vitest-wrapper left unlatched/,
			);
		});

		it("records a marker it could not write", () => {
			fs.chmodSync(proj, 0o500);
			try {
				run("gp_rule_mark_told vitest-wrapper");
				expect(faults()).toMatch(/latch marker unwritable/);
			} finally {
				fs.chmodSync(proj, 0o700);
			}
		});

		it("reports untold and records why, where the repo root does not resolve", () => {
			expect(
				run(
					"gr_root() { :; }\ngp_rule_told vitest-wrapper && echo TOLD || echo UNTOLD",
				).stdout.trim(),
			).toBe("UNTOLD");
			expect(faults()).toMatch(
				/repo root unresolved — rule vitest-wrapper unlatchable, delivered again/,
			);
		});

		it("writes no marker outside a repo, and records that it left the rule unlatched", () => {
			run("gr_root() { :; }\ngp_rule_mark_told vitest-wrapper");
			expect(
				fs.existsSync("/.rule-injected-warn.vitest-wrapper-main-sid-1"),
			).toBe(false);
			expect(faults()).toMatch(
				/repo root unresolved — rule vitest-wrapper left unlatched/,
			);
		});
	});

	/*
	 * gp_rule_latch_after — the prelude's own latch, DEFERRED into gp_rule so it
	 * is written after the emission rather than before it (mantahostels#2528, on mantahostels#2261's
	 * order). A caller cannot write it itself: gp_rule exits.
	 */
	describe("the deferred prelude latch", () => {
		const preludeMarker = () => marker("warn.prelude-key");

		it("marks the key after the envelope renders", () => {
			fragment("one", "First.");
			const r = run(
				'gp_rule_prelude "A notice."\ngp_rule_latch_after prelude-key\ngp_rule one',
			);
			expect(context(r)).toBe("A notice.\n\nFirst.");
			expect(fs.existsSync(preludeMarker())).toBe(true);
		});

		it("marks it on the prelude-only path, where every id is already latched", () => {
			fragment("one", "First.");
			run("gp_rule one");
			const r = run(
				'gp_rule_prelude "A notice."\ngp_rule_latch_after prelude-key\ngp_rule one',
			);
			expect(context(r)).toBe("A notice.");
			expect(fs.existsSync(preludeMarker())).toBe(true);
		});

		it("writes no marker when the emission itself dies", () => {
			fragment("one", "First.");
			const r = run(
				'_gp_emit_context() { exit 3; }\ngp_rule_prelude "A notice."\ngp_rule_latch_after prelude-key\ngp_rule one',
			);
			expect(r.status).toBe(3);
			expect(fs.existsSync(preludeMarker())).toBe(false);
		});

		it("writes no marker when the envelope will not render, and says so", () => {
			fragment("one", "First.");
			run(
				'_gp_emit_context() { return 1; }\ngp_rule_prelude "A notice."\ngp_rule_latch_after prelude-key\ngp_rule one',
			);
			expect(fs.existsSync(preludeMarker())).toBe(false);
			// An arm that swallowed the failure would pass the line above.
			expect(faults()).toMatch(/the rule envelope did not render/);
		});

		/* The prelude-only branch is a SECOND emission site with a mark of its
		 * own, so it needs the order pinned separately. */
		it("writes no marker on the prelude-only path either, and says so", () => {
			fragment("one", "First.");
			run("gp_rule one");
			run(
				'_gp_emit_context() { return 1; }\ngp_rule_prelude "A notice."\ngp_rule_latch_after prelude-key\ngp_rule one',
			);
			expect(fs.existsSync(preludeMarker())).toBe(false);
			expect(faults()).toMatch(/the prelude envelope did not render/);
		});

		/* The fail-OPEN arms DO emit the prelude, and are still left unlatched:
		 * gp_rule_told's bias is to fail towards telling, and re-saying a notice
		 * costs a session far less than losing one. */
		it("leaves it unlatched on a payload fail-open that still emits the prelude", () => {
			fragment("one", "First.");
			const r = run(
				"_gp_payload=''\ngp_rule_prelude \"A notice.\"\ngp_rule_latch_after prelude-key\ngp_rule one",
				null,
			);
			expect(context(r)).toBe("A notice.");
			expect(fs.existsSync(preludeMarker())).toBe(false);
		});

		it("marks nothing where no key was handed over", () => {
			fragment("one", "First.");
			run('gp_rule_prelude "A notice."\ngp_rule one');
			expect(
				fs.readdirSync(path.join(proj, ".claude", "tmp", "markers")),
			).toEqual([".rule-injected-one-main-sid-1"]);
		});
	});

	/*
	 * gp_latch_path — the same marker path, handed to a caller keeping something
	 * of its own beside the latches (mantahostels#2411). guard-claimed-bash-write.sh's
	 * session ledger is the one caller.
	 */
	describe("gp_latch_path", () => {
		const latch = (snippet = "gp_latch_path led.x", payload?: string) =>
			run(`out="$(${snippet})"; echo "rc=$? out=$out"`, payload).stdout.trim();

		it("hands back the path gp_rule's own latch would write", () => {
			expect(latch()).toBe(`rc=0 out=${marker("led.x")}`);
		});

		it("keys it on the agent too, so a subagent gets its own", () => {
			expect(
				latch(
					"gp_latch_path led.x",
					'{"tool_name":"Bash","session_id":"sid-1","agent_id":"sub"}',
				),
			).toBe(`rc=0 out=${marker("led.x", "sid-1", "asub")}`);
		});

		it("agrees with _gp_rule_marker itself", () => {
			expect(latch()).toBe(
				`rc=0 out=${run("_gp_rule_marker led.x main sid-1").stdout}`,
			);
		});

		/* A `/` would put the marker in another directory, outside the glob
		 * clear-rule-latch.sh clears at a compaction. Public, the id is no longer
		 * bounded by rule-text.sh's pattern. */
		it("replaces anything in the id that would move the marker", () => {
			expect(latch("gp_latch_path ../led.x")).toBe(
				`rc=0 out=${marker(".._led.x")}`,
			);
		});

		/* An empty root is guard-root.sh's disarm signal. Building on it would
		 * put the marker at `/.rule-injected-…`. */
		it("fails with 1 and prints nothing where the root does not resolve", () => {
			expect(latch("gr_root() { :; }; gp_latch_path led.x")).toBe("rc=1 out=");
		});

		/* 3, not 2: gp_agent_key's codes pass through, so a caller can tell an
		 * unparsed payload (2) from a payload carrying no session id (3). */
		it("fails with 3 and prints nothing where the payload carries no session", () => {
			expect(latch("gp_latch_path led.x", '{"tool_name":"Bash"}')).toBe(
				"rc=3 out=",
			);
		});

		/* The other half of that pair. Unpinned, the two could be renumbered and
		 * guard-claimed-bash-write.sh would log the wrong sentence with both
		 * suites still green (mantahostels#2420). */
		it("fails with 2 and prints nothing where the payload does not parse", () => {
			// Staged on the payload itself: an unparseable one handed to gp_begin
			// exits before any snippet runs.
			expect(latch("_gp_payload='not json at all'; gp_latch_path led.x")).toBe(
				"rc=2 out=",
			);
		});
	});

	// #1735
	describe("gp_agent_label", () => {
		const agent = (snippet: string, payload?: string) =>
			run(`echo "[$(${snippet})]"`, payload).stdout.trim();

		it("reads the parent's own call as main", () => {
			expect(agent("gp_agent_label x")).toBe("[main]");
		});

		it("reads a subagent's call as a<agent_id>, sanitised", () => {
			expect(
				agent(
					"gp_agent_label x",
					'{"tool_name":"Bash","session_id":"sid-1","agent_id":"x/y"}',
				),
			).toBe("[ax_y]");
		});

		it("reads a payload with no session as main and logs the caller's consequence", () => {
			expect(
				agent('gp_agent_label "counted as the parent"', '{"tool_name":"Bash"}'),
			).toBe("[main]");
			expect(faults()).toContain(
				"could not tell a subagent from its parent — counted as the parent",
			);
		});
	});
});

describe("gp_unmask", () => {
	it("puts a readable placeholder where a quoted span was", () => {
		expect(sh(`gp_unmask "git checkout $QUOTED"`)).toBe('git checkout "…"');
	});

	it("replaces every span, not just the first", () => {
		expect(sh(`gp_unmask "a $QUOTED b $QUOTED"`)).toBe('a "…" b "…"');
	});

	it("drops the leading whitespace the segment flattening leaves", () => {
		expect(sh(`gp_unmask '   git status'`)).toBe("git status");
	});

	it("leaves a segment with no quoted span alone", () => {
		expect(sh(`gp_unmask 'git status'`)).toBe("git status");
	});

	it("eats the index the masker glues on, so no sentinel byte reaches a human", () => {
		// A span is blanked to $QUOTED<index>\x01 since mantahostels#183. Rendering only the
		// $QUOTED prefix would print the index and a raw \x01 into the deny text.
		const out = sh(`gp_unmask "cd \${QUOTED}12"$'\\x01'" && git commit"`);
		expect(out).toBe('cd "…" && git commit');
		expect(out.includes("\u0001")).toBe(false);
	});

	it("emits no trailing newline of its own", () => {
		expect(sh(`gp_unmask 'x'`)).toBe("x");
	});
});

describe("gp_norm_abs (mantahostels#3315)", () => {
	it("drops a `.` segment", () => {
		expect(sh("gp_norm_abs /repo/./docs/a.md")).toBe("/repo/docs/a.md");
	});

	it("collapses a doubled slash", () => {
		expect(sh("gp_norm_abs /repo//docs///a.md")).toBe("/repo/docs/a.md");
	});

	it("pops the previous segment on `..`", () => {
		expect(sh("gp_norm_abs /repo/sub/../docs/a.md")).toBe("/repo/docs/a.md");
	});

	it("does not walk above the root", () => {
		expect(sh("gp_norm_abs /../../a.md")).toBe("/a.md");
	});

	it("strips a trailing slash", () => {
		expect(sh("gp_norm_abs /repo/docs/")).toBe("/repo/docs");
	});

	it("answers `/` for the root itself", () => {
		expect(sh("gp_norm_abs /")).toBe("/");
	});

	it("does not glob a segment named `*`", () => {
		// `for part in $1` would expand it against the caller's cwd.
		expect(sh(`gp_norm_abs "/repo/*/a.md"`)).toBe("/repo/*/a.md");
	});

	it("keeps a segment holding a space", () => {
		expect(sh(`gp_norm_abs "/repo/my docs/./a.md"`)).toBe("/repo/my docs/a.md");
	});

	it("is textual — the path need not exist", () => {
		expect(sh("gp_norm_abs /nowhere/./x")).toBe("/nowhere/x");
	});

	it("emits no trailing newline of its own", () => {
		expect(sh("gp_norm_abs /a")).toBe("/a");
	});
});

describe("gp_repo_rel (#2546)", () => {
	const rel = (args: string) => sh(`gp_repo_rel ${args}; printf '|%s' "$?"`);

	it("strips the root from a path inside it", () => {
		expect(rel("/repo/docs/a.md /repo")).toBe("docs/a.md|0");
	});

	it("resolves a mid-path `..` that stays inside", () => {
		expect(rel("/repo/sub/../docs/a.md /repo")).toBe("docs/a.md|0");
	});

	it.each([
		"/repo/../tests/a.md",
		"/repo/sub/../../tests/a.md",
		"/repository/a.md",
		"/repo",
		"repo/a.md",
	])("refuses %s, outside /repo", (outside) => {
		expect(rel(`${outside} /repo`)).toBe("|1");
	});

	it("takes every absolute path under a root of `/`", () => {
		expect(rel("/a/../b.md /")).toBe("b.md|0");
	});

	describe("through a symlink to the root (#2553)", () => {
		let dir: string;
		let real: string;
		let link: string;

		beforeEach(() => {
			dir = mkScratchDir("gp-repo-rel-");
			real = fs.realpathSync(dir);
			fs.mkdirSync(path.join(real, "repo", "sub"), { recursive: true });
			link = path.join(real, "link");
			fs.symlinkSync(path.join(real, "repo"), link);
		});

		afterEach(() => {
			fs.rmSync(dir, { recursive: true, force: true });
		});

		it.each([
			["sub/a.ts", "sub/a.ts"],
			["new/deep/a.ts", "new/deep/a.ts"],
			["nope/../a.ts", "a.ts"],
		])("strips the root from link/%s", (file, want) => {
			expect(rel(`${link}/${file} ${real}/repo`)).toBe(`${want}|0`);
		});

		it.each(["", "/", "/../x.ts"])(
			"refuses link%s, the root itself or outside it",
			(tail) => {
				expect(rel(`${link}${tail} ${real}/repo`)).toBe("|1");
			},
		);
	});
});

describe("gp_literal", () => {
	/*
	 * Reads a blanked span back out of $_gp_spans (mantahostels#284), so guard-issue-body.sh
	 * can judge the GraphQL query text a mask would otherwise have hidden.
	 */
	const literal = (word: string, spans = "") =>
		sh(
			`${spans}\n_gp_masked=""\n${word}\nout="$(gp_literal "$_gp_masked")"; rc=$?\nprintf '%s|%s' "$rc" "$out"`,
		);

	it("puts a single-quoted span back verbatim", () => {
		expect(literal(`_gp_mask_both "-f query='mutation{updateIssue}'"`)).toBe(
			"0|-f query=mutation{updateIssue}",
		);
	});

	it("reads a word with no span at all straight through", () => {
		expect(literal(`_gp_masked="-f state=closed"`)).toBe("0|-f state=closed");
	});

	it("keeps a $ inside a single-quoted span, which the shell would not expand", () => {
		expect(literal(`_gp_mask_both "-f query='a \\$b c'"`)).toBe(
			"0|-f query=a $b c",
		);
	});

	it("reports a double-quoted span carrying an expansion as only partly read", () => {
		expect(literal(`_gp_mask_both '-f query="updateIssue($BODY)"'`)).toBe(
			"1|-f query=updateIssue($BODY)",
		);
	});

	it("reports an unmasked $VAR as only partly read", () => {
		expect(literal(`_gp_masked='-f query=$Q'`)).toBe("1|-f query=$Q");
	});

	it("reports a sentinel naming a span that was never recorded", () => {
		expect(
			sh(`gp_literal "x\${QUOTED}9"$'\\x01' >/dev/null; printf '%s' "$?"`),
		).toBe("1");
	});

	it("is safe in a command substitution", () => {
		// Unlike the maskers, which append to $_gp_spans and so lose their work
		// in a subshell. This is why it prints rather than taking an out-param.
		expect(
			sh(
				`_gp_mask_both "-f query='a b'"\nout="$(gp_literal "$_gp_masked")"\nprintf '%s|%s' "$out" "\${#_gp_spans[@]}"`,
			),
		).toBe("-f query=a b|1");
	});
});

/*
 * ---------------------------------------------------------------------------
 * The payload seam and the walkers (mantahostels#157).
 * ---------------------------------------------------------------------------
 */

let dir: string;
let config: string;
let shared: string;
let worktree: string;
let elsewhere: string;

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" });

/*
 * THE FIXTURE IS BUILT ONCE AND COPIED (mantahostels#2016), not rebuilt per test, via
 * scripts/lib/git-fixture.ts (mantahostels#2068) — its own header explains what a
 * naive copy breaks and why.
 */
const template = defineTemplate(trioTemplate());

interface DriveOpts {
	/** The hook payload. A string is sent raw, for the malformed-JSON cases. */
	payload?: unknown;
	cwd?: string;
	/** PATH for the run, for the missing-binary fail-opens. */
	pathEnv?: string;
	/** CLAUDE_PROJECT_DIR; "" removes it, leaving the library to fall back to $PWD. */
	projectDir?: string;
	/** Extra variables for the run, for the path-expansion cases (mantahostels#183). */
	env?: Record<string, string>;
}

/*
 * Absolute, because a case that narrows PATH to prove a missing binary would
 * otherwise leave spawnSync unable to find bash itself.
 */
const BASH = execFileSync("bash", ["-c", "command -v bash"], {
	encoding: "utf8",
}).trim();

/** Source the library, run `snippet`, and report what the run did. */
const drive = (snippet: string, opts: DriveOpts = {}) => {
	let payload: string;
	if ("payload" in opts)
		payload =
			typeof opts.payload === "string"
				? opts.payload
				: JSON.stringify(opts.payload);
	else
		payload = JSON.stringify({
			session_id: "test",
			tool_name: "Bash",
			tool_input: { command: "true" },
		});
	const env: typeof process.env = {
		...process.env,
		CLAUDE_PROJECT_DIR: opts.projectDir ?? shared,
		// Unset, a run appends to the founder's own record and manufactures the
		// very entries check-guard-errors.js exists to report.
		CLAUDE_CONFIG_DIR: config,
		...(opts.pathEnv === undefined ? {} : { PATH: opts.pathEnv }),
		...(opts.env ?? {}),
	};
	if (opts.projectDir === "") delete env.CLAUDE_PROJECT_DIR;
	const r = spawnSync(
		BASH,
		["-uo", "pipefail", "-c", `source ${LIB}\n${snippet}`],
		{ cwd: opts.cwd ?? shared, encoding: "utf8", input: payload, env },
	);
	if (r.status === null) throw new Error(`bash did not run: ${r.error}`);
	return { status: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
};

/** A PATH holding everything the library reaches for except one tool. */
const pathWithout = (missing: string) => {
	const at = fs.mkdtempSync(path.join(dir, `bin-no-${missing}-`));
	for (const tool of [
		"bash",
		"cat",
		"date",
		"mkdir",
		"dirname",
		"git",
		"realpath",
		"sed",
		"jq",
	]) {
		if (tool === missing) continue;
		try {
			const real = execFileSync("bash", ["-c", `command -v ${tool}`], {
				encoding: "utf8",
			}).trim();
			if (real) fs.symlinkSync(real, path.join(at, tool));
		} catch {
			// Absent from this machine too, which is the state the test wants.
		}
	}
	return at;
};

/**
 * One field of each fail-open record, one per line (lib/guard-log.sh): the
 * third unless told, "" where a line has none. The record lands under a slug
 * of CLAUDE_PROJECT_DIR, so a case that removes that variable has to say where
 * it expects the record instead.
 */
const logged = (under = shared, field = 2) => {
	const at = path.join(
		config,
		"projects",
		under.replace(/[^a-zA-Z0-9]/g, "-"),
		"guard-errors.log",
	);
	if (!fs.existsSync(at)) return [];
	return fs
		.readFileSync(at, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => l.split("\t")[field] ?? "");
};

/*
 * A callback that prints each argument bracketed, one call per line, so both the
 * number of calls and the exact argument boundaries are visible.
 */
const SHOW = `show() { printf '[%s]' "$@"; printf '\\n'; }`;

/** Every call gp_walk_commands made, for the command in the payload. */
const walkCommands = (command: string, cwd?: string) =>
	drive(
		`${SHOW}\ngp_begin '.tool_input.command' command\ngp_walk_commands show`,
		{ payload: { tool_input: { command } }, cwd },
	);

/** Every call gp_walk_shared_git made, for the command in the payload. */
const walkGit = (
	command: string,
	subs = "checkout switch",
	cwd?: string,
	env?: Record<string, string>,
) =>
	drive(
		`${SHOW}\ngp_begin '.tool_input.command' command\ngp_walk_shared_git show "branch move" ${subs}`,
		{ payload: { tool_input: { command } }, cwd, env },
	);

/** The same, through the strict walker, which judges the unresolved tree (#301). */
const walkGitStrict = (
	command: string,
	subs = "checkout switch",
	cwd?: string,
) =>
	drive(
		`${SHOW}\ngp_begin '.tool_input.command' command\ngp_walk_shared_git_strict show "branch move" ${subs}`,
		{ payload: { tool_input: { command } }, cwd },
	);

/** The same, through the repo-wide walker (mantahostels#1213). */
const walkRepoGit = (command: string, subs = "checkout switch", cwd?: string) =>
	drive(
		`${SHOW}\ngp_begin '.tool_input.command' command\ngp_walk_repo_git show "branch move" ${subs}`,
		{ payload: { tool_input: { command } }, cwd },
	);

/** The same, through the repo-wide strict walker (#311). */
const walkRepoGitStrict = (
	command: string,
	subs = "checkout switch",
	cwd?: string,
) =>
	drive(
		`${SHOW}\ngp_begin '.tool_input.command' command\ngp_walk_repo_git_strict show "branch move" ${subs}`,
		{ payload: { tool_input: { command } }, cwd },
	);

beforeEach(() => {
	dir = mkScratchDir("guard-parse-");
	config = path.join(dir, "claude-config");
	shared = path.join(dir, "shared");
	worktree = path.join(dir, "wt");
	elsewhere = path.join(dir, "elsewhere");
	template.instantiate(dir);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("gp_begin", () => {
	it("keeps the field it was pointed at, for gp_subject to hand back", () => {
		const r = drive(`gp_begin '.tool_input.command' command\ngp_subject`, {
			payload: { tool_input: { command: "git status" } },
		});
		expect(r.out).toBe("git status");
	});

	it("reads whichever field it is given — a Skill payload, not only Bash", () => {
		// guard-last30days.sh judges .tool_input.skill through this same seam.
		const r = drive(`gp_begin '.tool_input.skill' "skill call"\ngp_subject`, {
			payload: { tool_input: { skill: "last30days" } },
		});
		expect(r.out).toBe("last30days");
	});

	it("allows silently on an empty payload, and records nothing", () => {
		// The one case that is not a fault: there is nothing to check.
		const r = drive(`gp_begin '.tool_input.command' command\necho REACHED`, {
			payload: "",
		});
		expect(r.status).toBe(0);
		expect(r.out).toBe("");
		expect(logged()).toEqual([]);
	});

	it("records and allows when the payload is not JSON", () => {
		const r = drive(`gp_begin '.tool_input.command' command\necho REACHED`, {
			payload: "{not json",
		});
		expect(r.status).toBe(0);
		expect(r.out).toBe("");
		expect(logged()).toEqual([
			"payload did not parse as JSON — command allowed unchecked",
		]);
	});

	it("records and allows when the field it was pointed at is absent", () => {
		// A payload matching the guard's tool always carries the field today, so an
		// extraction that comes back empty means the shape has changed underneath.
		const r = drive(`gp_begin '.tool_input.command' command\necho REACHED`, {
			payload: { tool_input: {} },
		});
		expect(r.status).toBe(0);
		expect(r.out).toBe("");
		expect(logged()).toEqual([
			"no command in payload — command allowed unchecked",
		]);
	});

	it("names the missing field from the jq path, not from the noun", () => {
		const r = drive(`gp_begin '.tool_input.skill' "skill call"`, {
			payload: { tool_input: {} },
		});
		expect(r.status).toBe(0);
		expect(logged()).toEqual([
			"no skill in payload — skill call allowed unchecked",
		]);
	});

	it("records and allows when jq is missing", () => {
		// Everything else the library reaches for stays on PATH — dirname and mkdir
		// included, or the record itself could not be written and the case would
		// pass for the wrong reason.
		const r = drive(`gp_begin '.tool_input.command' command\necho REACHED`, {
			pathEnv: pathWithout("jq"),
		});
		expect(r.status).toBe(0);
		expect(r.out).toBe("");
		expect(logged()).toEqual(["jq not found — command allowed unchecked"]);
	});
});

describe("gp_payload_field", () => {
	it("reads another field of the same payload", () => {
		// guard-commit-form.sh takes .session_id this way.
		const r = drive(
			`gp_begin '.tool_input.command' command\ngp_payload_field '.session_id'`,
			{ payload: { session_id: "abc123", tool_input: { command: "true" } } },
		);
		expect(r.out).toBe("abc123");
	});

	it("prints empty and succeeds for a field that is absent", () => {
		// Absent is a legitimate answer — guard-last30days.sh reads a missing
		// .agent_id as "main session" and denies on it. Only jq failing is an error.
		const r = drive(
			`gp_begin '.tool_input.command' command\ngp_payload_field '.agent_id' && echo OK`,
			{ payload: { tool_input: { command: "true" } } },
		);
		expect(r.out).toBe("OK\n");
	});
});

describe("gp_walk_commands", () => {
	it("hands the callback the segment, then the command's own words", () => {
		expect(walkCommands("gh issue edit 12").out).toBe(
			"[gh issue edit 12][gh][issue][edit][12]\n",
		);
	});

	it.each([
		["a && b", "&&"],
		["a || b", "||"],
		["a ; b", ";"],
		["a | b", "a pipe"],
		["a & b", "a background &"],
		["(a) (b)", "parentheses, so a subshell cannot hide a command"],
	])("splits %s on %s", (command) => {
		const calls = walkCommands(command).out.trim().split("\n");
		expect(calls.map((c) => c.split("][")[1]?.replace("]", ""))).toEqual([
			"a",
			"b",
		]);
	});

	it("strips leading environment assignments from the words", () => {
		// FOO=bar gh … runs gh; the assignment is not the command. The segment
		// itself still carries it, because that is what a deny quotes back.
		expect(walkCommands("FOO=bar gh issue edit 12").out).toBe(
			"[FOO=bar gh issue edit 12][gh][issue][edit][12]\n",
		);
	});

	it.each([
		["{ FOO=1 gh x; }", "{"],
		["! FOO=1 gh x", "!"],
		["if FOO=1 gh x; then :; fi", "if"],
		["if :; then FOO=1 gh x; fi", "then"],
		["if :; then :; else FOO=1 gh x; fi", "else"],
		["if :; then :; elif FOO=1 gh x; then :; fi", "elif"],
		["while FOO=1 gh x; do :; done", "while"],
		["until FOO=1 gh x; do :; done", "until"],
		["for i in 1; do FOO=1 gh x; done", "do"],
		["time FOO=1 gh x", "time"],
		["time -p FOO=1 gh x", "time -p"],
		["time -- FOO=1 gh x", "time --"],
		["coproc FOO=1 gh x", "coproc"],
		["FOO=1 exec gh x", "exec"],
		["FOO=1 exec -a name gh x", "exec -a"],
		["! { if FOO=1 gh x; then :; fi; }", "a run of them"],
	])(
		"hands over the command behind a leading reserved word or exec: %s (%s, #1013)",
		(command) => {
			// The assignment must come through as well as the command.
			const r = drive(
				`show() { printf '[%s]' "\${@:2}"; printf '\\n'; }
harvested() { [[ "$(gp_resolve_word '$FOO')" == 1 ]] && echo HARVESTED; }
both() { show "$@"; [[ "$2" == gh ]] && harvested; }
gp_begin '.tool_input.command' command
gp_walk_commands both`,
				{ payload: { tool_input: { command } } },
			);
			expect(r.out).toContain("[gh][x]\nHARVESTED\n");
		},
	);

	it("runs nothing for an exec with no command", () => {
		expect(walkCommands("exec").out).toBe("");
	});

	it("harvests no assignment from an exec -a name", () => {
		// `-a` names argv[0], not a variable.
		const r = drive(
			`seen() { gp_resolve_word '$FOO' || echo UNSET; }
gp_begin '.tool_input.command' command
gp_walk_commands seen`,
			{ payload: { tool_input: { command: "exec -a FOO=1 gh x" } } },
		);
		expect(r.out).toBe("UNSET\n");
	});

	it("skips a segment that runs nothing", () => {
		expect(
			walkCommands("gh api ;  ; gh api").out.trim().split("\n"),
		).toHaveLength(2);
	});

	it("skips a segment that is only an assignment", () => {
		expect(walkCommands("FOO=bar").out).toBe("");
	});

	it("blanks a quoted span before the callback sees it", () => {
		// The blanking is what stops `echo "git checkout x"` reading as a checkout.
		const r = drive(
			`${SHOW}\ngp_begin '.tool_input.command' command\ngp_walk_commands show`,
			{
				payload: { tool_input: { command: `gh issue close 3 -c "hi there"` } },
			},
		);
		expect(r.out).not.toContain("hi there");
		expect(r.out).toContain("[-c]");
	});

	it("treats a heredoc body as data, not as commands", () => {
		const r = walkCommands(
			"gh api <<'EOF'\ngit checkout evil\nEOF\ngh issue list",
		);
		expect(r.out).not.toContain("[evil]");
		expect(r.out).toContain("[list]");
	});

	it("lets a callback accumulate across segments — no subshell on this path", () => {
		// guard-commit-form.sh holds the first warn back in case a later segment
		// denies; a walker that piped its segments would lose every assignment.
		const r = drive(
			`n=0\nbump() { n=$((n + 1)); }\ngp_begin '.tool_input.command' command\ngp_walk_commands bump\necho "$n"`,
			{ payload: { tool_input: { command: "a && b && c" } } },
		);
		expect(r.out.trim()).toBe("3");
	});
});

/** What gp_gh_words answered for each command the payload runs, each word
 * read back through gp_literal; `none` where it returned non-zero. */
const ghWords = (command: string) =>
	drive(
		`gh_show() {
  gp_gh_words "\${@:2}" || { echo none; return 0; }
  local w
  for w in \${_gp_gh_args+"\${_gp_gh_args[@]}"}; do printf '[%s]' "$(gp_literal "$w")"; done
  echo
}
gp_begin '.tool_input.command' command
gp_walk_commands gh_show`,
		{ payload: { tool_input: { command } } },
	).out;

describe("gp_gh_words (#772)", () => {
	it.each([
		["gh pr create", "[pr][create]"],
		["/usr/bin/gh pr create", "[pr][create]"],
		[`"gh" "pr" create`, "[pr][create]"],
		["gh -R o/r pr create", "[pr][create]"],
		["gh --repo o/r workflow run ci.yml", "[workflow][run][ci.yml]"],
		["timeout 60 gh workflow run ci.yml", "[workflow][run][ci.yml]"],
		["env A=1 nohup gh api /x", "[api][/x]"],
		// An expansion in a flag leaves gp_literal non-zero; it is still a flag.
		["gh --repo=$R workflow run ci.yml", "[workflow][run][ci.yml]"],
		["gh -R$R pr create", "[pr][create]"],
	])("reads %s from its command word on", (command, words) => {
		expect(ghWords(command)).toBe(`${words}\n`);
	});

	it.each([
		"gh pr create --help",
		"gh pr create -h",
		"gh --help pr create",
		`gh pr create "--help"`,
	])("answers nothing for %s, which only prints usage", (command) => {
		expect(ghWords(command)).toBe("none\n");
	});

	it("answers nothing for a command that is not gh", () => {
		expect(ghWords("git push origin main")).toBe("none\n");
	});

	it("answers each segment on its own", () => {
		expect(ghWords("gh pr create && gh issue list")).toBe(
			"[pr][create]\n[issue][list]\n",
		);
	});
});

/** What gp_git_words answered for each command the payload runs: the
 * subcommand, then each word after it read back through gp_literal; `none`
 * where it returned non-zero. */
const gitWords = (command: string) =>
	drive(
		`git_show() {
  gp_git_words "\${@:2}" || { echo none; return 0; }
  printf '%s:' "$_gp_git_sub"
  local w
  for w in \${_gp_git_args+"\${_gp_git_args[@]}"}; do printf '[%s]' "$(gp_literal "$w")"; done
  echo
}
gp_begin '.tool_input.command' command
gp_walk_commands git_show`,
		{ payload: { tool_input: { command } } },
	).out;

describe("gp_git_words (#2383)", () => {
	it.each([
		["git commit -m x", "commit:[-m][x]"],
		["/usr/bin/git commit -m x", "commit:[-m][x]"],
		["git -C /r -c a.b=1 --no-pager commit -m x", "commit:[-m][x]"],
		["git --git-dir=/r/.git commit", "commit:"],
		["timeout 60 git commit -m x", "commit:[-m][x]"],
		["env A=1 git commit -m 'a b'", "commit:[-m][a b]"],
	])("reads %s from its subcommand on", (command, words) => {
		expect(gitWords(command)).toBe(`${words}\n`);
	});

	it.each(["git", "git -C /r", "gh pr create"])(
		"answers nothing for %s, which runs no git subcommand",
		(command) => {
			expect(gitWords(command)).toBe("none\n");
		},
	);
});

/** What gp_carries_var answered for FOO on each command the payload runs. */
const carriesFoo = (command: string) =>
	drive(
		`seen() { gp_carries_var FOO "\${@:2}" && echo yes || echo no; }
gp_begin '.tool_input.command' command
gp_walk_commands seen`,
		{ payload: { tool_input: { command } } },
	).out;

describe("gp_carries_var (#1499)", () => {
	it.each([
		["FOO=1 npm run test", "a leading assignment"],
		["env FOO=1 npm run test", "an assignment an env carried"],
		["env A=/x/y FOO=1 npm run test", "env with a /-valued earlier assignment"],
		["time FOO=1 npm run test", "a keyword-led command (#1013)"],
	])("answers yes for %s (%s)", (command) => {
		expect(carriesFoo(command)).toBe("yes\n");
	});

	it.each([
		["FOO= npm run test", "an empty value"],
		["npm run test -- FOO=1", "a NAME after the command word"],
		["BAR=1 npm run test", "a different NAME"],
		["env BAR=1 npm run test", "a different NAME through env"],
	])("answers no for %s (%s)", (command) => {
		expect(carriesFoo(command)).toBe("no\n");
	});

	it("answers each segment on its own", () => {
		expect(carriesFoo("FOO=1 npm run test && npm run test")).toBe("yes\nno\n");
	});

	it("leaves gp_unwrap's answer set over the words it was handed", () => {
		const r = drive(
			`seen() { gp_carries_var FOO "\${@:2}"; printf '[%s]' "\${_gp_unwrapped[@]}" "\${_gp_wrapper_words[@]}"; echo; }
gp_begin '.tool_input.command' command
gp_walk_commands seen`,
			{ payload: { tool_input: { command: "env FOO=1 nohup npm test" } } },
		);
		expect(r.out).toBe("[npm][test][FOO=1]\n");
	});
});

describe("gp_rule_text (#772)", () => {
	let rules: string;
	beforeEach(() => {
		rules = fs.mkdtempSync(path.join(os.tmpdir(), "gp-rule-text-"));
		fs.writeFileSync(path.join(rules, "known.txt"), "The known rule.\n");
	});
	afterEach(() => fs.rmSync(rules, { recursive: true, force: true }));

	const ruleText = (args: string, store = rules) =>
		spawnSync(
			"bash",
			["-uo", "pipefail", "-c", `source ${LIB}\ngp_rule_text ${args}`],
			{ encoding: "utf8", env: { ...process.env, WFC_RULES_DIR: store } },
		);

	it("prints the fragment where the store has it", () => {
		const r = ruleText(`known "the fallback"`);
		expect(r.stdout).toBe("The known rule.");
		expect(r.stderr).toBe("");
	});

	it("prints the fallback, and nothing on stderr, for an id the store lacks", () => {
		const r = ruleText(`unknown "the fallback"`);
		expect(r.stdout).toBe("the fallback");
		expect(r.stderr).toBe("");
	});

	it("prints the fallback where the store cannot be read at all", () => {
		const r = ruleText(`known "the fallback"`, path.join(rules, "gone"));
		expect(r.stdout).toBe("the fallback");
	});
});

describe("gp_cwd — the directory gp_walk_commands's command runs in (mantahostels#3453)", () => {
	const showCwd = `at() { printf '%s=%s\\n' "$2" "$(gp_cwd)"; }`;

	/** `<command word>=<gp_cwd>` per call, for a payload whose cwd is `from`. */
	const cwds = (
		command: string,
		from: string | null = "/start",
		env?: Record<string, string>,
	) =>
		drive(
			`${showCwd}\ngp_begin '.tool_input.command' command\ngp_walk_commands at`,
			{ payload: { tool_input: { command }, cwd: from ?? undefined }, env },
		)
			.out.trim()
			.split("\n");

	it("seeds from the payload's cwd, else this process's own", () => {
		expect(cwds("gh x")).toEqual(["gh=/start"]);
		expect(cwds("gh x", null)).toEqual([`gh=${shared}`]);
	});

	it("moves after a cd, absolute or relative, and not before the cd's own callback", () => {
		expect(cwds("cd /a && cd b/c && gh x")).toEqual([
			"cd=/start",
			"cd=/a",
			"gh=/a/b/c",
		]);
	});

	it("resolves a target through the command's own assignment, and a leading ~", () => {
		expect(cwds('D=/x; cd "$D" && gh x')).toEqual(["cd=/start", "gh=/x"]);
		expect(cwds("cd ~/n && gh x", "/start", { HOME: "/home/u" })).toEqual([
			"cd=/start",
			"gh=/home/u/n",
		]);
		// Quoted, the ~ is a directory of that name.
		expect(cwds("cd '~' && gh x").at(-1)).toBe("gh=/start/~");
	});

	it("ends a subshell's cd at its closing bracket", () => {
		expect(cwds("(cd /a && gh x); gh y")).toEqual([
			"cd=/start",
			"gh=/a",
			"gh=/start",
		]);
		expect(cwds("cd /a && echo $(cd /b) && gh y").at(-1)).toBe("gh=/a");
	});

	it.each([
		"cd -",
		"cd",
		"cd -P /a",
		"cd ~other",
		"pushd /a",
		"popd",
		"builtin cd /a",
		"command cd /a",
		'cd "$UNSET_3453"',
	])("makes the directory unknown after %s", (lead) => {
		expect(cwds(`${lead}; gh x`).at(-1)).toBe("gh=");
	});

	it('keeps the directory through cd "", which stays put', () => {
		// Measured on bash 5.2: `cd ""` exits 0 and leaves $PWD alone, exactly as
		// `git -C ""` does (#301).
		expect(cwds('cd ""; gh x').at(-1)).toBe("gh=/start");
	});

	it("keeps the directory through a case pattern's unopened )", () => {
		expect(cwds("cd /a; case x in x) true;; esac; gh x").at(-1)).toBe("gh=/a");
	});

	it("keeps an unknown directory unknown through a relative cd", () => {
		expect(cwds("cd -; cd b; gh x").at(-1)).toBe("gh=");
	});

	it("hands a nested walk's caller back its own cwd and assignments", () => {
		// guard-commit-form.sh re-enters gp_walk_commands from gp_walk_repo_git's loop.
		const r = drive(
			`${showCwd}
inner() { :; }
outer() { gp_walk_commands inner; at "$@"; }
gp_begin '.tool_input.command' command
gp_walk_commands outer`,
			{
				payload: {
					tool_input: { command: 'D=/x; cd /a; gh x; cd "$D"; gh y' },
					cwd: "/start",
				},
			},
		);
		expect(r.out.trim().split("\n")).toEqual([
			"cd=/start",
			"gh=/a",
			"cd=/a",
			"gh=/x",
		]);
	});
});

describe("gp_redirects — redirections out of the words and into a lookup (#1488)", () => {
	/** Per command: its words, then one `fd kind target path` line per
	 * redirection, the target read back through gp_literal. */
	const showRedirs = `show() {
  printf '[%s]' "\${@:2}"; printf '\\n'
  gp_redirects
  local i
  for i in "\${!_gp_redir_kind[@]}"; do
    printf '  %s %s %s %s\\n' "\${_gp_redir_fd[i]}" "\${_gp_redir_kind[i]}" "$(gp_literal "\${_gp_redir_target[i]}")" "\${_gp_redir_path[i]:-<none>}"
  done
}`;

	const redirs = (command: string, bare = false, from = "/start") =>
		drive(
			`${showRedirs}\ngp_begin '.tool_input.command' command\ngp_walk_commands ${bare ? "--bare-redirects " : ""}show`,
			{ payload: { tool_input: { command }, cwd: from } },
		).out;

	it.each([
		[
			"git push origin main 2>&1",
			"[git][push][origin][main]\n  2 copy 1 <none>\n",
		],
		["echo hi >| out.txt", "[echo][hi]\n  1 clobber out.txt /start/out.txt\n"],
		[
			"npm test &> log.txt",
			"[npm][test]\n  & truncate log.txt /start/log.txt\n",
		],
		["echo x 1>&2", "[echo][x]\n  1 copy 2 <none>\n"],
	])(
		"reads %s as one command, where the old split made a fake second one",
		(command, expected) => {
			expect(redirs(command)).toBe(expected);
		},
	);

	it.each([
		["cat > o", "1 truncate o /start/o"],
		["cat >> o", "1 append o /start/o"],
		["cat >| o", "1 clobber o /start/o"],
		["cat < i", "0 read i /start/i"],
		["cat 3<> f", "3 read-write f /start/f"],
		["cat &> o", "& truncate o /start/o"],
		["cat &>> o", "& append o /start/o"],
		["cat >&o", "& truncate o /start/o"],
		["cat 2>&1", "2 copy 1 <none>"],
		["cat 0<&3", "0 copy 3 <none>"],
		["cat 3>&-", "3 close - <none>"],
		["cat 4<&-", "4 close - <none>"],
		["cat 6>&3-", "6 copy 3- <none>"],
		["cat {fd}> o", "{fd} truncate o /start/o"],
		['cat <<< "a b"', "0 here-string a b <none>"],
		["cat <<'EOF'\nbody\nEOF", "0 heredoc EOF <none>"],
		["cat <<-EOF\nbody\nEOF", "0 heredoc EOF <none>"],
	])("takes %s out of the words and reports it", (command, line) => {
		expect(redirs(command)).toBe(`[cat]\n  ${line}\n`);
	});

	it("cuts a word an operator sits inside, as bash does", () => {
		expect(redirs("echo hi>out 2>/dev/null")).toBe(
			"[echo][hi]\n  1 truncate out /start/out\n  2 truncate /dev/null /dev/null\n",
		);
	});

	it("takes a redirection off before the command word", () => {
		expect(redirs("2>/dev/null FOO=1 gh x")).toBe(
			"[gh][x]\n  2 truncate /dev/null /dev/null\n",
		);
	});

	it("resolves a target through the cwd and the command's own assignments, and leaves an unknown one empty", () => {
		expect(redirs("cd sub && echo > x")).toContain("1 truncate x /start/sub/x");
		expect(redirs('D=/d; echo > "$D/x"')).toContain("1 truncate $D/x /d/x");
		expect(redirs("echo > $(mktemp)", true)).toContain("1 truncate $ <none>");
		expect(redirs("echo > $UNSET_FOR_TEST/x")).toContain(
			"1 truncate $UNSET_FOR_TEST/x <none>",
		);
	});

	it("reads >&$fd through the value it was given", () => {
		expect(redirs("F=3; echo >&$F")).toContain("1 copy $F <none>");
		expect(redirs("F=f; echo >&$F")).toContain("& truncate $F /start/f");
	});

	it("leaves a > or < inside [[ … ]] and arithmetic as words", () => {
		expect(redirs("[[ a > b ]] > out")).toBe(
			"[[[][a][>][b][]]]\n  1 truncate out /start/out\n",
		);
		expect(redirs("[[ a > b && c < d ]]")).toBe(
			"[[[][a][>][b]\n[c][<][d][]]]\n",
		);
		expect(redirs("echo $((x>5))")).toBe("[echo][$]\n[x>5]\n");
	});

	it("redirects an unescaped > in [ and test, as bash does, and keeps an escaped one a word", () => {
		expect(redirs("[ a > b ]")).toBe("[[][a][]]\n  1 truncate b /start/b\n");
		expect(redirs("test a \\> b")).toBe("[test][a][\\>][b]\n");
	});

	it("keeps a process substitution's split, dropping its bare operator", () => {
		expect(redirs("diff <(a) <(b)")).toBe("[diff]\n[a]\n[b]\n");
		expect(redirs("cmd 2> >(tee e)")).toBe("[cmd]\n[tee][e]\n");
		expect(redirs("done < <(ls)", true)).toBe("[done]\n[ls]\n");
	});

	it("reads a spaced nested subshell as commands, and a command substitution inside arithmetic as one", () => {
		expect(redirs("( (echo hi > out) )")).toBe(
			"[echo][hi]\n  1 truncate out /start/out\n",
		);
		expect(redirs("echo $(( $(wc -l < f) > 5 ))", true)).toBe(
			"[echo][$]\n[$]\n[wc][-l]\n  0 read f /start/f\n[>][5]\n",
		);
	});

	it("hands a command of redirections alone only to a walk asking for it", () => {
		expect(redirs("> o; exec 3> log")).toBe("");
		expect(redirs("> o; exec 3> log", true)).toBe(
			"[]\n  1 truncate o /start/o\n[]\n  3 truncate log /start/log\n",
		);
	});

	it("reads #1007's --queue behind a 2>&1 as the same command's word", () => {
		expect(redirs("npm run test 2>&1 -- --queue | tail -5")).toBe(
			"[npm][run][test][--][--queue]\n  2 copy 1 <none>\n[tail][-5]\n",
		);
	});

	it("hands the git walkers their arguments without redirections, and answers the lookup there (#764)", () => {
		const r = drive(
			`${showRedirs}\ngp_begin '.tool_input.command' command\ngp_walk_shared_git show "push" push`,
			{
				payload: {
					tool_input: { command: "git push origin main 2>&1 >| log" },
				},
			},
		);
		expect(r.out).toBe(
			`[push][${shared}][origin][main]\n  2 copy 1 <none>\n  1 clobber log ${shared}/log\n`,
		);
	});
});

describe("gp_write_targets — every write spelling the guard tier reads (#1827)", () => {
	/** What `print` writes after gp_write_targets answers each command of
	 * `command`, run from /start. */
	const answer = (print: string, command: string) =>
		drive(
			`show() {
  shift
  gp_write_targets "$@"
${print}
}
gp_begin '.tool_input.command' command
gp_walk_commands --bare-redirects show`,
			{ payload: { tool_input: { command }, cwd: "/start" } },
		).out;

	/** One `mode target path` line per target, the target read back through
	 * gp_literal. */
	const targets = (command: string) =>
		answer(
			`  local i
  for i in "\${!_gp_wt_mode[@]}"; do
    printf '%s %s %s\\n' "\${_gp_wt_mode[i]}" "$(gp_literal "\${_gp_wt_target[i]}")" "\${_gp_wt_path[i]:-<none>}"
  done`,
			command,
		);

	it.each([
		["echo x > o", "write o /start/o\n"],
		["tee -a o p", "write o /start/o\nwrite p /start/p\n"],
		["cp a b", "write b /start/b\n"],
		["mv a b", "move-source a /start/a\nwrite b /start/b\n"],
		["mv -S .bak a b", "move-source a /start/a\nwrite b /start/b\n"],
		["cp a b /d", "write /d/a /d/a\nwrite /d/b /d/b\n"],
		["cp a ./", "write ./a /start/a\n"],
		["cp $UNSET_FOR_TEST/a.md /d/", "write /d/a.md /d/a.md\n"],
		["cp a b /d/", "write /d/a /d/a\nwrite /d/b /d/b\n"],
		["cp -t /d a", "write /d/a /d/a\n"],
		["sed -i -e s/a/b/ f", "write f /start/f\n"],
		["sed -e s/a/b/ f", ""],
		["perl -Ilib -pe 1 f", ""],
		["truncate -s 0 f", "write f /start/f\n"],
		["git restore f", "write f /start/f\n"],
		["git restore --staged f", ""],
		["git checkout -- f", "write f /start/f\n"],
		["git checkout f", ""],
		["rm -f -- -x", "delete -x /start/-x\n"],
		["git mv a b", "delete a /start/a\ndelete b /start/b\n"],
	])("reads %s as its write and delete targets", (command, expected) => {
		expect(targets(command)).toBe(expected);
	});

	it("resolves a target through the cwd and the command's own assignments, and leaves an unknown one empty", () => {
		expect(targets("cd sub && tee x")).toBe("write x /start/sub/x\n");
		// The slash sits inside the quoted span, out of reach of the join, so the
		// text doubles it; the path folds it.
		expect(targets('D=/d; cp a "$D/"')).toBe("write $D//a /d/a\n");
		expect(targets('cp "$UNSET_FOR_TEST" /d/')).toBe(
			"write /d/$UNSET_FOR_TEST /d/$UNSET_FOR_TEST\n",
		);
		expect(targets("tee $UNSET_FOR_TEST/x")).toBe(
			"write $UNSET_FOR_TEST/x <none>\n",
		);
	});

	it("reads a heredoc's redirect and not its body", () => {
		expect(targets("cat > o <<'EOF'\ntee p\nEOF")).toBe("write o /start/o\n");
	});

	it.each([
		["echo x > o", "redirect"],
		["cp a b > log", "redirect\ncp"],
		["git restore -- f", "git restore"],
		["/usr/bin/git checkout -- f", "git checkout"],
	])(
		"names the route that read each row of %s (#2142)",
		(command, expected) => {
			expect(answer(`  printf '%s\\n' "\${_gp_wt_route[@]}"`, command)).toBe(
				`${expected}\n`,
			);
		},
	);
});

describe("gp_walk_repo_git — the same walk, widened past the shared tree (mantahostels#1213)", () => {
	/*
	 * Built for guard-commit-form.sh's `--no-verify` deny, whose reason is the
	 * pre-commit gates a worktree runs too (mantahostels#344) rather than the shared index.
	 */
	it("calls back in a linked worktree, which gp_walk_shared_git filters out", () => {
		expect(walkGit("git checkout x", "checkout", worktree).out).toBe("");
		expect(walkRepoGit("git checkout x", "checkout", worktree).out).toBe(
			`[git checkout x][checkout][${worktree}][x]\n`,
		);
	});

	it("still calls back in the shared tree", () => {
		expect(walkRepoGit("git checkout x", "checkout", shared).out).toContain(
			`[checkout][${shared}]`,
		);
	});

	it("still filters out an unrelated repository", () => {
		expect(walkRepoGit("git checkout x", "checkout", elsewhere).out).toBe("");
	});

	it("records the same fail-open when the tree cannot be resolved", () => {
		const r = walkRepoGit('cd "$SOMEWHERE" && git checkout x');
		expect(r.out).toBe("");
		expect(logged()).toEqual([
			"could not resolve the working tree for a git checkout — branch move allowed unchecked",
		]);
	});
});

describe("gp_tree_scope", () => {
	/*
	 * Driven the way a guard uses it — from inside a gp_walk_repo_git callback,
	 * which is where the repo has been resolved. The callback is handed the tree
	 * the command runs against, but `ask` names its own, so all four answers are
	 * reachable including the ones the walk itself would have filtered out.
	 */
	const ask = (at: string) =>
		drive(
			`ask() { gp_tree_scope ${at}; }\ngp_begin '.tool_input.command' command\ngp_walk_repo_git ask "branch move" checkout`,
			{ payload: { tool_input: { command: "git checkout x" } }, cwd: shared },
		).out.trim();

	it("separates the shared tree from a linked worktree of the same repo", () => {
		expect(ask(shared)).toBe("shared");
		expect(ask(worktree)).toBe("linked");
	});

	it("calls another repo, and a path in none, `other`", () => {
		expect(ask(elsewhere)).toBe("other");
		expect(ask(path.join(dir, "no-such-dir"))).toBe("other");
	});

	it("calls a tree git cannot answer for `unknown`, not `other`", () => {
		// The distinction the caller logs on: a .git pointing at a gitdir that is
		// gone fails with the same exit 128 as "not a repository", and only this
		// one is a fail-open (mantahostels#147).
		const broken = path.join(dir, "broken-repo");
		fs.mkdirSync(broken, { recursive: true });
		fs.writeFileSync(
			path.join(broken, ".git"),
			`gitdir: ${path.join(dir, "no-such-gitdir")}\n`,
		);
		expect(ask(broken)).toBe("unknown");
	});

	it("calls an empty path `unknown`, not `other` (#311)", () => {
		// A strict walker's unresolved tree. `other` would let a shared-index gate
		// allow it unrecorded, as "not this repo".
		expect(ask('""')).toBe("unknown");
	});
});

describe("gp_walk_shared_git", () => {
	it("hands the callback the segment, subcommand, tree and arguments", () => {
		expect(walkGit("git checkout -b feature").out).toBe(
			`[git checkout -b feature][checkout][${shared}][-b][feature]\n`,
		);
	});

	it("calls back only for the subcommands the guard asked for", () => {
		const r = walkGit("git status && git checkout x && git commit -m y");
		expect(r.out.trim().split("\n")).toHaveLength(1);
		expect(r.out).toContain("[checkout]");
	});

	it("resolves the tree through a cd, and never calls back for the cd", () => {
		const r = walkGit(
			`cd ${worktree} && git checkout x`,
			"checkout",
			elsewhere,
		);
		// The worktree is a linked one, so it is exempt.
		expect(r.out).toBe("");
		expect(logged()).toEqual([]);
	});

	it("judges against the outer tree once a subshell's cd has ended (mantahostels#3453)", () => {
		const r = walkGit(`(cd ${worktree} && true); git checkout x`);
		expect(r.out).toContain(`[checkout][${shared}]`);
		expect(walkGit("case x in x) true;; esac; git checkout x").out).toContain(
			`[checkout][${shared}]`,
		);
	});

	it("expands a leading ~ in git -C (mantahostels#3453)", () => {
		const r = walkGit("git -C ~/shared checkout x", "checkout", elsewhere, {
			HOME: path.dirname(shared),
		});
		expect(r.out).toContain(`[checkout][${path.dirname(shared)}/shared]`);
	});

	it("judges against the tree git -C names", () => {
		const r = walkGit(`git -C ${shared} checkout x`, "checkout", elsewhere);
		expect(r.out).toContain(`[checkout][${shared}]`);
	});

	it("filters out a linked worktree of the same repo", () => {
		expect(walkGit("git checkout x", "checkout", worktree).out).toBe("");
	});

	it("filters out an unrelated repository", () => {
		expect(walkGit("git checkout x", "checkout", elsewhere).out).toBe("");
	});

	it("records a fail-open when the tree cannot be resolved", () => {
		// An unexpanded variable in the cd target: every later segment fails open
		// rather than falling back to $PWD and judging a worktree command against
		// the shared tree.
		const r = walkGit('cd "$SOMEWHERE" && git checkout x');
		expect(r.out).toBe("");
		expect(logged()).toEqual([
			"could not resolve the working tree for a git checkout — branch move allowed unchecked",
		]);
	});

	it("records nothing for a directory that is in no repository (mantahostels#253)", () => {
		// It exists, so git reaches it and refuses — but "not a repository" is a
		// confident answer, not an unknown one: nothing there can move the shared
		// tree. Recorded, the repeats bury every genuine fail-open under them —
		// the run that measured that is on mantahostels#253.
		const opaque = mkDirOutsideRepo("not-a-repo-");
		let r: ReturnType<typeof walkGit>;
		try {
			r = walkGit(`cd ${opaque} && git checkout x`, "checkout", shared);
		} finally {
			fs.rmSync(opaque, { recursive: true, force: true });
		}
		expect(r.out).toBe("");
		expect(logged()).toEqual([]);
	});

	it("still records a git failure that is not 'not a repository' (mantahostels#253)", () => {
		// A `.git` pointing at a gitdir that is gone fails with the same exit 128
		// and the same stderr as the case above.
		const broken = path.join(dir, "broken-repo");
		fs.mkdirSync(broken, { recursive: true });
		fs.writeFileSync(
			path.join(broken, ".git"),
			`gitdir: ${path.join(dir, "no-such-gitdir")}\n`,
		);
		const r = walkGit(`cd ${broken} && git checkout x`, "checkout", shared);
		expect(r.out).toBe("");
		expect(logged()).toEqual([
			`git could not answer for ${broken} — a git checkout there was allowed unchecked`,
		]);
	});

	it("finds the repo marker through a symlinked path (mantahostels#253)", () => {
		// The ancestry walk is lexical and git resolves the physical directory, so
		// the spelling has to be canonicalised before it is stripped: the marker
		// here sits ABOVE what the link points at, and never appears on the link's
		// own path.
		const proj = path.join(dir, "real", "proj");
		fs.mkdirSync(path.join(proj, "sub"), { recursive: true });
		fs.writeFileSync(
			path.join(proj, ".git"),
			`gitdir: ${path.join(dir, "no-such-gitdir")}\n`,
		);
		const link = path.join(dir, "link");
		fs.symlinkSync(path.join(proj, "sub"), link);

		const r = walkGit(`cd ${link} && git checkout x`, "checkout", shared);
		expect(r.out).toBe("");
		expect(logged()).toEqual([
			`git could not answer for ${link} — a git checkout there was allowed unchecked`,
		]);
	});

	it("records nothing for an absolute directory that does not exist", () => {
		// git fails before it moves anything, so a path with nothing at it is no
		// more the shared tree than another repo is (mantahostels#208).
		const r = walkGit(`cd ${path.join(dir, "gone")} && git checkout x`);
		expect(r.out).toBe("");
		expect(logged()).toEqual([]);
	});

	it("records nothing for a subcommand the guard never asked about", () => {
		// The filter runs BEFORE the tree is resolved, on purpose (mantahostels#157). A walker
		// that resolved first would log a fail-open for every `git status` in an
		// unresolvable cwd and bury the ones a guard was actually going to judge.
		const r = walkGit('cd "$SOMEWHERE" && git status');
		expect(r.out).toBe("");
		expect(logged()).toEqual([]);
	});

	it("agrees with gp_walk_commands over one payload — the split is memoised", () => {
		// No guard drives both walkers today, but _gp_split_segments caches its
		// answer and gp_begin never clears it, so a guard that did would silently
		// get the first walk's segments. Both must see the same three commands.
		const r = drive(
			`${SHOW}\ngp_begin '.tool_input.command' command\ngp_walk_shared_git show "branch move" checkout\ngp_walk_commands show`,
			{
				payload: {
					tool_input: { command: "git checkout x && gh issue list && ls" },
				},
			},
		);
		const calls = r.out.trim().split("\n");
		expect(calls[0]).toContain(`[checkout][${shared}]`);
		expect(calls.slice(1)).toEqual([
			"[git checkout x ][git][checkout][x]",
			"[ gh issue list ][gh][issue][list]",
			"[ ls][ls]",
		]);
	});

	it("records and allows when the repo itself cannot be resolved", () => {
		// With the repo unresolved, the shared-tree comparison answers no to
		// everything and the guard reaches a verdict on no command at all — so it
		// stops there and records, rather than walking on saying nothing.
		const bare = path.join(dir, "notarepo");
		fs.mkdirSync(bare);
		const r = drive(
			`${SHOW}\ngp_begin '.tool_input.command' command\ngp_walk_shared_git show "branch move" checkout\necho REACHED`,
			{
				payload: { tool_input: { command: "git checkout x" } },
				cwd: bare,
				projectDir: "",
				// `bare` sits under scratchBase(), which is inside Manta's own
				// repository (mantahostels#3149), so git would otherwise resolve upwards to it.
				// The ceiling stops that walk at the base, leaving the repo
				// genuinely unresolvable as this case requires.
				env: { GIT_CEILING_DIRECTORIES: scratchBase() },
			},
		);
		expect(r.status).toBe(0);
		expect(r.out).toBe("");
		expect(logged(bare)[0]).toMatch(/git could not resolve a git dir for /);
	});
});

/*
 * ---------------------------------------------------------------------------
 * Resolving a path argument through the masking (mantahostels#183).
 *
 * A path argument is masked before anything parses it, so `cd "/abs/path"`
 * arrived as the sentinel alone and was unresolvable for that reason — nothing
 * to do with variables.
 *
 * The `unresolved` cases below are the deliberate residual. They must keep
 * failing open AND keep logging: an unresolvable cd that does land in the shared
 * tree would otherwise go both unwatched and unrecorded.
 * ---------------------------------------------------------------------------
 */
describe("path resolution", () => {
	/** Judged from an unrelated repo, so only the cd/-C can reach the shared tree. */
	const judged = (command: string, env?: Record<string, string>) =>
		walkGit(command, "checkout", elsewhere, env);

	/*
	 * Asserts the REASON, not the number of records. A path that resolves to a
	 * directory that happens not to exist also logs exactly one line — a
	 * different one — so counting alone lets a refusal and a resolution look
	 * identical.
	 */
	const unresolved = (command: string, env?: Record<string, string>) => {
		const r = judged(command, env);
		expect(r.out).toBe("");
		expect(logged()).toEqual([
			"could not resolve the working tree for a git checkout — branch move allowed unchecked",
		]);
	};

	it("resolves a cd target that was quoted but fully literal", () => {
		const r = judged(`cd "${shared}" && git checkout x`);
		expect(r.out).toContain(`[checkout][${shared}]`);
		expect(logged()).toEqual([]);
	});

	it("resolves a single-quoted literal cd target", () => {
		const r = judged(`cd '${shared}' && git checkout x`);
		expect(r.out).toContain(`[checkout][${shared}]`);
	});

	it("expands an environment variable in a cd target", () => {
		const r = judged('cd "$CLAUDE_PROJECT_DIR" && git checkout x');
		expect(r.out).toContain(`[checkout][${shared}]`);
		expect(logged()).toEqual([]);
	});

	it("expands the braced spelling as well as the bare name", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: bash braces, and the point of the case — rewriting them would test the bare form twice.
		const r = judged('cd "${CLAUDE_PROJECT_DIR}" && git checkout x');
		expect(r.out).toContain(`[checkout][${shared}]`);
	});

	it("expands a variable in git -C", () => {
		const r = judged('git -C "$CLAUDE_PROJECT_DIR" checkout x');
		expect(r.out).toContain(`[checkout][${shared}]`);
	});

	it("expands a variable that is only part of the path", () => {
		const r = judged('cd "$WFC_ROOT/shared" && git checkout x', {
			WFC_ROOT: dir,
		});
		expect(r.out).toContain(`[checkout][${shared}]`);
	});

	it("exempts a linked worktree reached through a variable, recording nothing", () => {
		// The ticket's own case: the recipe told a session to work in
		// "$CLAUDE_JOB_DIR/tmp/<name>", and every commit made there logged a
		// fail-open.
		const r = judged('cd "$WFC_WT" && git checkout x', {
			WFC_WT: worktree,
		});
		expect(r.out).toBe("");
		expect(logged()).toEqual([]);
	});

	/*
	 * Variables the command string assigns to ITSELF (mantahostels#208). The assignment
	 * happens inside the Bash call, so the hook's own environment never sees it.
	 */
	it("resolves a variable the command assigned on the same line", () => {
		const r = judged(`WT=${worktree} && git -C "$WT" checkout x`);
		expect(r.out).toBe("");
		expect(logged()).toEqual([]);
	});

	it("denies through an assignment that names the shared tree", () => {
		const r = judged(`WT=${shared} && git -C "$WT" checkout x`);
		expect(r.out).toContain(`[checkout][${shared}]`);
		expect(logged()).toEqual([]);
	});

	it("resolves the sanctioned recipe end to end, recording nothing", () => {
		// CLAUDE.md: add a worktree under a variable and work in it. The add is
		// never matched; the commands after it are. `--detach` because the shared
		// tree already holds `main`, so a plain add exits 128 (mantahostels#301).
		const r = judged(
			`WT=$WFC_ROOT/fresh && git worktree add --detach "$WT" main && git -C "$WT" checkout -b side2`,
			{ WFC_ROOT: dir },
		);
		expect(r.out).toBe("");
		expect(logged()).toEqual([]);
	});

	it("resolves an assignment reached through a cd rather than git -C", () => {
		const r = judged(`WT=${shared} && cd "$WT" && git checkout x`);
		expect(r.out).toContain(`[checkout][${shared}]`);
	});

	it("lets an assignment shadow the environment, as shell does", () => {
		const r = judged(`WFC_WT=${shared} && git -C "$WFC_WT" checkout x`, {
			WFC_WT: worktree,
		});
		expect(r.out).toContain(`[checkout][${shared}]`);
	});

	it("reads an assignment prefixed onto the command itself", () => {
		const r = judged(`WT=${shared} git -C "$WT" checkout x`);
		expect(r.out).toContain(`[checkout][${shared}]`);
	});

	it("sees an assignment only from the commands after it", () => {
		// `git -C "$WT"` runs before WT exists, so it must stay unresolved even
		// though the same string assigns it later.
		unresolved(`git -C "$WT" checkout x && WT=${shared}`);
	});

	it("refuses an assignment from command substitution, so the checkout is logged as allowed unchecked", () => {
		// mantahostels#183's deliberate residual, and the one shape left in the log: nothing
		// here ever runs the text, so `WT=$(mktemp -d)` stays unknown.
		unresolved('WT=$(mktemp -d) && git -C "$WT" checkout x');
	});

	it("refuses a name assigned twice with different values", () => {
		// _gp_flatten throws the operator away, so a second assignment cannot be
		// told from a reassignment. Taking the last would build a verdict on a
		// value the command may never have held at that point.
		unresolved(`WT=${shared}; WT=${worktree}; git -C "$WT" checkout x`);
	});

	it("harvests nothing at or after a string's first ||", () => {
		// One assignment, in an arm that may never have run: `[ -d wt ] || WT=…`
		// leaves WT untouched when the test succeeds, so resolving it would judge
		// — possibly DENY — a command that ran against a different tree.
		unresolved(`[ -d ${worktree} ] || WT=${shared}; git -C "$WT" checkout x`);
	});

	it("kills a name reassigned after a ||, rather than keeping the first value", () => {
		unresolved(
			`WT=${worktree}; false || WT=${shared}; git -C "$WT" checkout x`,
		);
	});

	it("harvests an assignment before the first ||, which a || cannot skip (#328)", () => {
		const r = judged(
			`WT=${shared} && [ -d "$WT" ] || exit 1; git -C "$WT" checkout x`,
		);
		expect(r.out).toContain(`[checkout][${shared}]`);
		expect(logged()).toEqual([]);
	});

	it("counts the segments a subshell and a case arm add ahead of the || (#319's shape)", () => {
		const r = judged(
			`WT=${shared} && S=m && (true) && case "$S" in *) [ -n "$S" ] || exit 1;; esac && git -C $WT checkout x`,
		);
		expect(r.out).toContain(`[checkout][${shared}]`);
		expect(logged()).toEqual([]);
	});

	it("ignores a || inside a quoted span when counting", () => {
		const r = judged(
			`WT=${shared}; echo "a || b"; X=1 || true; git -C "$WT" checkout x`,
		);
		expect(r.out).toContain(`[checkout][${shared}]`);
	});

	it("does not fall back to the environment for a name it refused", () => {
		unresolved('WFC_WT=$(mktemp -d) && git -C "$WFC_WT" checkout x', {
			WFC_WT: worktree,
		});
	});

	it("does not expand a variable inside single quotes", () => {
		// '$CLAUDE_PROJECT_DIR' names a directory with a dollar in it, so treating
		// it as the shared tree would be a verdict on a path the command never
		// visits.
		unresolved(`cd '$CLAUDE_PROJECT_DIR' && git checkout x`);
	});

	it("refuses command substitution rather than resolving it, so the checkout is logged as allowed unchecked", () => {
		unresolved('cd "$(mktemp -d)" && git checkout x');
	});

	it("refuses a brace-operator form even when the variable is set, so the checkout is logged as allowed unchecked", () => {
		// Only a bare name is expanded. Every operator — :- , # , ! , [] — is a
		// rule this parser does not implement, so it declines instead of guessing.
		// biome-ignore lint/suspicious/noTemplateCurlyInString: bash braces, and the operator inside them is exactly what must not be expanded.
		unresolved('cd "${CLAUDE_PROJECT_DIR:-/tmp}" && git checkout x');
	});

	it("refuses a variable whose value carries whitespace", () => {
		unresolved('cd "$WFC_ODD" && git checkout x', {
			WFC_ODD: `${dir} spaced`,
		});
	});

	it("refuses a variable whose value carries a shell metacharacter", () => {
		unresolved('cd "$WFC_ODD" && git checkout x', {
			WFC_ODD: `${dir}/$(id)`,
		});
	});

	it("refuses a variable that is set but empty, so the checkout is logged as allowed unchecked", () => {
		unresolved('cd "$WFC_EMPTY" && git checkout x', { WFC_EMPTY: "" });
	});

	describe("the strict walkers hand the unresolved tree over (#301, #311)", () => {
		it("calls back with an empty tree instead of logging and skipping", () => {
			const r = walkGitStrict('git -C "$UNSET_301" checkout x', "checkout");
			expect(r.out).toContain("[checkout][]");
			// Nothing logged: the callback owns the record now.
			expect(logged()).toEqual([]);
		});

		it("leaves the ordinary walker failing open and recording, as before", () => {
			const r = walkGit('git -C "$UNSET_301" checkout x', "checkout");
			expect(r.out).toBe("");
			expect(logged()).toEqual([
				"could not resolve the working tree for a git checkout — branch move allowed unchecked",
			]);
		});

		it("a tree it CAN resolve reaches the callback unchanged", () => {
			const r = walkGitStrict("git checkout x", "checkout", shared);
			expect(r.out).toContain(`[checkout][${shared}]`);
		});

		it("the repo-wide strict walker hands it over too (#311)", () => {
			const r = walkRepoGitStrict('git -C "$UNSET_311" checkout x', "checkout");
			expect(r.out).toContain("[checkout][]");
			expect(logged()).toEqual([]);
		});

		it("the repo-wide strict walker still reaches a linked worktree", () => {
			const r = walkRepoGitStrict("git checkout x", "checkout", worktree);
			expect(r.out).toContain(`[checkout][${worktree}]`);
		});

		it.each(["gp_walk_shared_git", "gp_walk_repo_git"])(
			"%s inside a strict walker's callback does not inherit strict mode",
			(walker) => {
				// The flag reaches _gp_walk_git by dynamic scope, so a non-strict walk
				// nested in a strict callback would judge the unresolved tree unasked.
				const r = drive(
					`${SHOW}\nnested() { ${walker} show "branch move" checkout; }\ngp_begin '.tool_input.command' command\ngp_walk_repo_git_strict nested "branch move" checkout`,
					{
						payload: {
							tool_input: { command: 'git -C "$UNSET_311" checkout x' },
						},
					},
				);
				expect(r.out).toBe("");
				expect(logged()).toEqual([
					"could not resolve the working tree for a git checkout — branch move allowed unchecked",
				]);
			},
		);
	});

	it("reads an empty path as the cwd, which is where the shell leaves it", () => {
		// Judged from `elsewhere`, so staying put means no verdict — and no
		// fail-open record either, which is the half that matters (#301).
		expect(judged('cd "" && git checkout x').out).toBe("");
		expect(judged('git -C "" checkout x').out).toBe("");
		expect(logged()).toEqual([]);
		expect(judged(`cd "${shared}" && cd "" && git checkout x`).out).toContain(
			`[checkout][${shared}]`,
		);
	});

	it("reads a quote nested in the other kind as literal, as shell does (#490)", () => {
		// `"'a'"` is one double-quoted span holding two apostrophes, so the cd
		// target is a directory named with them — never the shared tree.
		expect(judged(`cd "'${shared}'" && git checkout x`).out).toBe("");
	});

	it("leaves an unterminated quote alone", () => {
		// A lone quote is not a span; every guard must see the same command shape.
		const r = walkCommands(`git commit -m "unterminated`);
		expect(r.out).toContain('["unterminated]');
	});
});

/*
 * ---------------------------------------------------------------------------
 * Logical lines (mantahostels#182).
 *
 * Physical lines are still the unit for heredoc detection; only the masking and
 * the segment split moved to logical ones.
 * ---------------------------------------------------------------------------
 */
describe("logical lines", () => {
	it("keeps a multi-line quoted argument on one segment with what follows it", () => {
		const r = walkCommands('git commit -m "Subject line\n\nBody." -- a.md');
		expect(r.out.trim().split("\n")).toHaveLength(1);
		expect(r.out).toContain("[--][a.md]");
	});

	it("joins on a single-quoted argument too, not only a double-quoted one", () => {
		const r = walkCommands("git commit -m 'Subject line\n\nBody.' -- a.md");
		expect(r.out.trim().split("\n")).toHaveLength(1);
		expect(r.out).toContain("[--][a.md]");
	});

	it("blanks a metacharacter inside a multi-line quoted argument", () => {
		const r = walkCommands('git commit -m "Subject\n\nBody (x); y." -- a.md');
		expect(r.out.trim().split("\n")).toHaveLength(1);
		expect(r.out).not.toContain("[y.]");
	});

	it("joins across a heredoc body, which is not part of the command", () => {
		// `-m "$(cat <<'EOF'` leaves the double quote open; its partner is on the
		// line after the terminator, with the pathspec.
		const r = walkCommands(
			"git commit -m \"$(cat <<'EOF'\nSubject\n\nBody.\nEOF\n)\" -- a.md",
		);
		expect(r.out.trim().split("\n")).toHaveLength(1);
		expect(r.out).toContain("[--][a.md]");
		expect(r.out).not.toContain("Subject");
	});

	// #490.
	it("joins a `\\` continuation into one segment", () => {
		const r = walkCommands("git commit \\\n  -m x \\\n  -- a.md");
		expect(r.out.trim().split("\n")).toHaveLength(1);
		expect(r.out).toContain("[--][a.md]");
	});

	it("never continues a comment, so the next line is still a command", () => {
		for (const command of [
			"# see the note \\\ngit checkout -b evil",
			"echo hi # trailing \\\ngit checkout -b evil",
		]) {
			expect(walkCommands(command).out).toContain("[git][checkout]");
		}
	});

	it("reads $$ as the pid, so the quote after it takes no escapes", () => {
		const r = walkCommands("echo $$'a\\' ; git checkout -b evil ; echo 'x'");
		expect(r.out).toContain("[git][checkout]");
	});

	it("keeps one quote kind literal inside the other and honours escapes", () => {
		const r = walkCommands(
			'gh issue create --title "burn mode\'s \\"off\\"" --body "$(cat <<\'EOF\'\nsee "x" (and a stray ) too)\nEOF\n)" --label takes:triage',
		);
		expect(r.out.trim().split("\n")).toHaveLength(1);
		expect(r.out).toContain("[--label][takes:triage]");
	});

	it("leaves a quote that never closes reading line by line", () => {
		// A stray apostrophe — a possessive in a comment is the ordinary case — is
		// not a multi-line string. Gluing the rest of the command onto it would
		// hide every later command behind the first one's head word.
		const r = walkGit("echo it's fine\ngit checkout evil", "checkout");
		expect(r.out).toContain("[checkout]");
		expect(r.out).toContain("[evil]");
	});

	it.each([
		['\\"', "double"],
		["\\'", "single"],
	])(
		"declines to join anything once %s appears — an escaped %s quote",
		(escaped) => {
			// An escaped quote opens no span, so nothing is joined and the line
			// between them stays a command of its own.
			const r = walkGit(
				`echo ${escaped}\ngit checkout -b evil\necho ${escaped}`,
				"checkout",
			);
			expect(r.out).toContain("[evil]");
		},
	);

	it.each([
		["two apostrophes in prose", "echo it's fine", "echo that's all"],
		["ANSI-C quoting", "echo $'a", "echo x'"],
		["an even count of unclosed double quotes", 'echo "a', 'echo x"'],
	])("keeps the command visible through %s", (_label, before, after) => {
		const r = walkGit(`${before}\ngit checkout -b evil\n${after}`, "checkout");
		expect(r.out).toContain("[evil]");
	});

	it("keeps a gh command visible too, not only a git one", () => {
		// guard-issue-body.sh and guard-issue-close.sh judge gh, so a join that
		// swallowed one would hide it just as completely.
		const r = walkCommands(
			"echo it's fine\ngh issue edit 5 --body x\necho that's all",
		);
		const heads = r.out
			.trim()
			.split("\n")
			.map((line) => line.split("][")[1]);
		expect(heads).toContain("gh");
	});

	it("checks every segment of an absorbed line, not just its first word", () => {
		// `foo; git checkout` hides a checkout that the line's head word does not
		// name, so a check reading only the head would let this one through.
		const r = walkGit(
			"echo it's fine\nfoo; git checkout -b evil\necho that's all",
			"checkout",
		);
		expect(r.out).toContain("[evil]");
	});

	it("keeps the join through a message body that reads as a command", () => {
		// mantahostels#232: the message is one argument, so the whole command is one segment.
		const r = walkCommands(
			'git commit -m "Subject\n\ngit add is banned here." -- a.md',
		);
		expect(r.out.trim().split("\n")).toHaveLength(1);
		expect(r.out).toContain("[--][a.md]");
	});

	it.each([
		["-m", 'git commit -m "Subject'],
		["--message", 'git commit --message "Subject'],
		["--message=", 'git commit --message="Subject'],
		["gh --body", 'gh issue comment 1 --body "Subject'],
	])("reads a command named in a %s argument as prose", (_label, opener) => {
		const r = walkGit(
			`${opener}\n\ngit checkout -b x is denied." -- a.md`,
			"checkout",
		);
		expect(r.out.trim()).toBe("");
	});

	it("reads a message opening with an apostrophe in it", () => {
		// The opener is the FIRST unpaired quote, not the last: `-m "It's …` leaves
		// both a double and a single standing, and reading the apostrophe as the
		// opener loses the flag in front of it.
		const r = walkGit(
			'git commit -m "It\'s a subject\n\ngit checkout -b x is denied." -- a.md',
			"checkout",
		);
		expect(r.out.trim()).toBe("");
	});

	it("finds the message flag when the commit is not the first command", () => {
		// The flag sits on the LAST segment before the quote.
		// No `cd` in front: that would move the judged tree and empty the output
		// whatever the join did, hiding the very difference this pins.
		const r = walkGit(
			'echo start && git commit -m "Subject\n\ngit checkout -b x is denied." -- a.md',
			"checkout",
		);
		expect(r.out.trim()).toBe("");
	});

	it("does not treat a CLOSED line as an open message", () => {
		// `-m "don't" 'a'` is a complete line, but pairing quotes by count reads the
		// apostrophe in `don't` as partnered with the one before `a`, leaving a `"`
		// standing. The checkout below then absorbs as prose, and bash really runs
		// it.
		const r = walkGit(
			"git commit -m \"don't\" 'a'\ngit checkout -b evil\necho \"b'c\"",
			"checkout",
		);
		expect(r.out).toContain("[evil]");
	});

	it.each([["if"], ["then"]])(
		"keeps the join through a prose line opening %s git (#1013)",
		(word) => {
			const r = walkCommands(
				`node scripts/issue-body.js comment 1 "first line\n${word} git commit --no-verify is run, the gate fires\nend"`,
			);
			expect(r.out.trim().split("\n")).toHaveLength(1);
		},
	);

	it("reads the message of a commit behind a reserved word as prose (#1013)", () => {
		const r = walkGit(
			'if true; then git commit -m "Subject\n\ngit checkout -b x is denied." -- a.md; fi',
			"checkout",
		);
		expect(r.out.trim()).toBe("");
	});

	it("still gives up the join when the open quote is not a message argument", () => {
		// The narrowing is keyed on the flag, not on the mere presence of a quote:
		// an `echo` opening one is the mantahostels#182 shape and must keep its per-line read.
		const r = walkGit('echo "Subject\n\ngit checkout -b evil\n" ', "checkout");
		expect(r.out).toContain("[evil]");
	});

	it("still gives up the join on a flag that is not a message flag", () => {
		// `git commit --author "…` opens a quote on a git command too, but its
		// argument is not prose, so nothing licenses absorbing a command after it.
		const r = walkGit(
			'git commit --author "Someone\n\ngit checkout -b evil\n" -- a.md',
			"checkout",
		);
		expect(r.out).toContain("[evil]");
	});

	it("denies a real branch move that follows a closed message, naming the branch", () => {
		const r = walkGit(
			'git commit -m "Subject\n\ngit add is banned here." -- a.md\ngit checkout -b real',
			"checkout",
		);
		expect(r.out).toContain("[real]");
	});

	it("falls back to per-line when a message quote never closes", () => {
		// The fail-CLOSED net behind _gp_message_open: believing a message is open
		// forever must not hide the commands inside it.
		const r = walkGit(
			'git commit -m "Subject\n\ngit checkout -b evil',
			"checkout",
		);
		expect(r.out).toContain("[evil]");
	});

	// #510.
	it("keeps a body's join through a phrase it quotes inside `$(cat <<'EOF'`", () => {
		const r = walkGit(
			'gh issue create --title t --body "$(cat <<\'EOF\'\nSee "the phrase" here.\ngit checkout -b evil\nEOF\n)"',
			"checkout",
		);
		expect(r.out).not.toContain("[evil]");
	});

	it("opens no heredoc on a `<<` inside such a body, after a lone quote", () => {
		const r = walkGit(
			'gh issue create --title t --body "$(cat <<\'EOF\'\nA lone " quote.\nThen cat << EOF2 in prose.\nEOF\n)"\ngit checkout -b evil',
			"checkout",
		);
		expect(r.out).toContain("[evil]");
	});

	// #510.
	it("reads a `$'…'` inside a `$(…)` with its escapes", () => {
		const r = walkCommands("git commit -m \"$(printf $'it\\'s')\" -- a.md");
		expect(r.out.trim().split("\n")).toHaveLength(1);
		expect(r.out).toContain("[commit][-m]");
		expect(r.out).toContain("[--][a.md]");
	});

	// #510. Bounded by count, not clock (#1916): the lexer is fed each character
	// once per pass, three passes at most, in pieces of at most 512 (`_gp_lex`
	// in lib/guard-parse.sh). A count
	// needs no long body: 60 lines already put a re-lexed join far over it, and
	// a longer one only makes that mutant hang rather than fail.
	const prose = (n: number, line: (i: number) => string) =>
		Array.from({ length: n }, (_, i) => line(i)).join("\n");
	it.each([
		[
			"a 60-line message body",
			`gh issue create --title t --body "$(cat <<'EOF'\n${prose(60, (i) => (i % 7 ? `Line ${i} of the body.` : `- it's "quoted" (${i})`))}\nEOF\n)" --label takes:triage`,
		],
		[
			"a 60-line body that is no message, each line asked whether it runs a command",
			`echo "${prose(60, (i) => `Line ${i} goes through, high and right enough.`)}" --label takes:triage`,
		],
		[
			"a 40 KB body on one physical line",
			`gh issue create --title t --body "${`it's \\"q\\" line. `.repeat(2500)}" --label takes:triage`,
		],
	])("joins %s inside the bound", (_, command) => {
		const r = drive(
			`${SHOW}\ngp_begin '.tool_input.command' command\ngp_walk_commands show\nprintf '%s %s\\n' "$_gp_lx_lexed" "$_gp_lx_widest"`,
			{ payload: { tool_input: { command } } },
		);
		const lines = r.out.trim().split("\n");
		const [lexed, widest] = (lines.pop() ?? "").split(" ").map(Number);
		expect(lexed).toBeLessThanOrEqual(3 * command.length);
		expect(widest).toBeLessThanOrEqual(512);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("[--label][takes:triage]");
	});

	it("resolves a path argument after a joined line", () => {
		// A join given up re-masks its lines one by one, so the attempt
		// must leave no span behind — an off-by-one in $_gp_spans would make the
		// cd unresolvable and fail open silently.
		const r = walkGit(
			`echo "a\n\nb"\ncd "${shared}" && git checkout x`,
			"checkout",
			elsewhere,
		);
		expect(r.out).toContain(`[checkout][${shared}]`);
		expect(logged()).toEqual([]);
	});
});

/*
 * ---------------------------------------------------------------------------
 * Heredoc openers (mantahostels#201).
 *
 * A heredoc body is dropped as data, so a `<<` read as an opener where the
 * shell reads none takes every command after it out of the sight of every
 * guard that walks a command string.
 * The blanking that decides this carries across physical lines.
 * ---------------------------------------------------------------------------
 */
describe("heredoc openers", () => {
	it.each([
		["a double-quoted string", 'echo "a\nb << EOF\nc"'],
		["a single-quoted string", "echo 'a\nb << EOF\nc'"],
		["the tab-stripping <<- form", 'echo "a\nb <<- EOF\nc"'],
		["a quoted delimiter", "echo \"a\nb <<'EOF'\nc\""],
	])("opens no heredoc from a << inside %s", (_label, prefix) => {
		const r = walkGit(`${prefix}\ngit checkout -b evil`, "checkout");
		expect(r.out).toContain("[evil]");
	});

	it("names each body and terminator line in gp_heredoc_lines (#2384)", () => {
		const lines = (command: string) =>
			drive(
				`gp_begin '.tool_input.command' command\ngp_heredoc_lines\necho "\${_gp_heredoc_lines[*]}"`,
				{ payload: { tool_input: { command } } },
			).out.trim();
		expect(lines("cat <<'EOF'\na & b\nEOF\nnpm test")).toBe("1 2");
		expect(lines("gh api <<EOF\nx\nEOF\ngh api <<E2\ny\nE2")).toBe("1 2 4 5");
		expect(lines('echo "a\nb << EOF\nc"\ntrue')).toBe("");
	});

	it("still opens one from a << outside any string", () => {
		// The control for the four above: suppressing every opener would pass them
		// while reading heredoc bodies as commands.
		const r = walkCommands(
			"gh api <<EOF\ngit checkout evil\nEOF\ngh issue list",
		);
		expect(r.out).not.toContain("[evil]");
		expect(r.out).toContain("[list]");
	});

	it("closes the carried span, so a later heredoc still opens", () => {
		// A carry that opened and never closed would suppress every opener after
		// it, so heredoc BODIES would reach the guards as commands and draw denies
		// on text the shell never runs. Only a string that CLOSES before a genuine
		// heredoc catches it.
		const r = walkGit(
			'echo "a\nb"\ngh api <<EOF\ngit checkout -b evil\nEOF',
			"checkout",
		);
		expect(r.out).toBe("");
	});

	it("ends the carry at an opener, so a quote after the << leaks no further", () => {
		// `gh api <<EOF # don't` is ordinary, and left open the apostrophe hides the
		// SECOND opener, drawing a deny on that heredoc's body.
		const r = walkGit(
			"gh api <<EOF   # don't\nx\nEOF\ngh api <<EOF2\ngit checkout -b evil\nEOF2",
			"checkout",
		);
		expect(r.out).toBe("");
	});

	it("reads a heredoc body's own quotes as data, not as an open string", () => {
		// The body is skipped before the masker sees it. An apostrophe in body prose
		// would otherwise carry an open span past the terminator and suppress every
		// opener after it.
		const r = walkGit(
			"gh api <<EOF\nit's fine\nEOF\ngh api <<EOF\ngit checkout -b evil\nEOF",
			"checkout",
		);
		expect(r.out).toBe("");
	});

	it("invents no opener by closing up the text a span leaves behind", () => {
		// `a<"x"<b` would read as `a<<b` if a blanked span became nothing at all.
		const r = walkGit('echo a<"x"<b\ngit checkout -b evil', "checkout");
		expect(r.out).toContain("[evil]");
	});

	it("leaves an unterminated heredoc swallowing its tail, as the shell does", () => {
		// Bash warns `here-document delimited by end-of-file` and takes the tail as
		// the body — the opener's own command runs, the tail never does. Restoring
		// those lines would deny commands that never run.
		const r = walkGit("gh api <<EOF\ngit checkout -b evil", "checkout");
		expect(r.out).toBe("");
	});
});

/* The shared flag reader (mantahostels#477). */
describe("gp_scan_flags", () => {
	const q = (w: string) => `'${w.replaceAll("'", `'\\''`)}'`;

	/** Every event the scan emits, as `kind|name|value`. */
	const scan = (spec: string, ...words: string[]) =>
		sh(
			`ev() { printf '%s|%s|%s\\n' "$1" "$2" "$3"; }\n` +
				`gp_scan_flags ${q(spec)} ev -- ${words.map(q).join(" ")}`,
		)
			.split("\n")
			.filter(Boolean);

	it("skips a value-taking flag's value in pairs", () => {
		// Without the pair-skip a masked `--comment "…"` has its value read as the
		// next argument, and a guard looking for an issue number judges the wrong
		// word.
		expect(scan("-c --comment", "--comment", "-r", "12")).toEqual([
			"opt|--comment|-r",
			"arg||12",
		]);
	});

	it("reads a long flag's value from an = as well as from the next word", () => {
		expect(scan("--label", "--label=takes:human")).toEqual([
			"opt|--label|takes:human",
		]);
		expect(scan("--label", "--label", "takes:human")).toEqual([
			"opt|--label|takes:human",
		]);
	});

	it("reads a --flag=value whether or not the spec names that flag", () => {
		expect(scan("-c", "--strategy-option=theirs")).toEqual([
			"opt|--strategy-option|theirs",
		]);
	});

	it("reads a short flag's value attached, with or without the =", () => {
		// gh's flag reader (pflag) takes `-l=x` as x, not as =x.
		expect(scan("-l", "-ltakes:human")).toEqual(["opt|-l|takes:human"]);
		expect(scan("-l", "-l=takes:human")).toEqual(["opt|-l|takes:human"]);
		expect(scan("-l", "-l", "takes:human")).toEqual(["opt|-l|takes:human"]);
	});

	it("walks a short-flag bundle letter by letter", () => {
		// `git pull -qr` is a rebase: the r is a flag in its own right.
		expect(scan("-s -X", "-qr")).toEqual(["flag|-q|", "flag|-r|"]);
	});

	it("lets a value-taking letter take the rest of its bundle", () => {
		// This is what stops the r inside `-Xtheirs` reading as `git pull -r`.
		expect(scan("-s -X", "-Xtheirs")).toEqual(["opt|-X|theirs"]);
		expect(scan("-s -X", "-s", "recursive")).toEqual(["opt|-s|recursive"]);
	});

	it("gives an optional-value letter its stuck value and never the next word", () => {
		// `git merge -S --no-verify` signs with the default key AND skips hooks.
		expect(scan("-S?", "-Skey", "--no-verify")).toEqual([
			"opt|-S|key",
			"flag|--no-verify|",
		]);
		expect(scan("-S?", "-S", "--no-verify")).toEqual([
			"flag|-S|",
			"flag|--no-verify|",
		]);
		expect(scan("-S?", "-qShx")).toEqual(["flag|-q|", "opt|-S|hx"]);
	});

	it("reports a value-taking flag with nothing left to take", () => {
		expect(scan("--label -l", "--label")).toEqual(["dangling|--label|"]);
		expect(scan("--label -l", "-l")).toEqual(["dangling|-l|"]);
	});

	it("calls a lone - a flag, not a bare word", () => {
		// `--body-file -` reads the body from stdin. Read as a bare word it would
		// become guard-issue-close.sh's issue number.
		expect(scan("-c", "-", "12")).toEqual(["flag|-|", "arg||12"]);
	});

	it("calls every word after a bare -- an arg, however it is spelled", () => {
		// mantahostels#495. git and gh both stop reading options at `--`, so a flag-shaped
		// word past it is a pathspec. guard-commit-form.sh kept its own walk until
		// this reader could say so.
		expect(scan("-m", "-m", "msg", "--", "-weird-file", "--all")).toEqual([
			"opt|-m|msg",
			"flag|--|",
			"arg||-weird-file",
			"arg||--all",
		]);
	});

	it("does not end the options on a -- that is a flag's value", () => {
		// Both git's parse-options and pflag hand the next word to a value-taking
		// flag whatever it is, so this `--` is the comment, not the separator, and
		// `-x` after it is still an option.
		expect(scan("-c --comment", "--comment", "--", "-x")).toEqual([
			"opt|--comment|--",
			"flag|-x|",
		]);
	});

	it("reports a flag that takes no value, and a bare word", () => {
		expect(scan("-c", "--ff-only", "origin", "-q")).toEqual([
			"flag|--ff-only|",
			"arg||origin",
			"flag|-q|",
		]);
	});

	it("stops where the callback returns non-zero, and says so", () => {
		// How a caller stops at `--help`.
		const out = spawnSync(
			"bash",
			[
				"-uo",
				"pipefail",
				"-c",
				`source ${LIB}\n` +
					`ev() { printf '%s\\n' "$2"; [[ "$2" == --help ]] && return 1; return 0; }\n` +
					`gp_scan_flags "-c" ev -- --title --help --label; echo "rc=$?"`,
			],
			{ encoding: "utf8" },
		);
		expect(out.stdout.split("\n").filter(Boolean)).toEqual([
			"--title",
			"--help",
			"rc=1",
		]);
	});

	it("emits nothing, and succeeds, on no arguments at all", () => {
		const out = spawnSync(
			"bash",
			[
				"-uo",
				"pipefail",
				"-c",
				`source ${LIB}\nev() { echo saw; }\ngp_scan_flags "-c" ev --; echo "rc=$?"`,
			],
			{ encoding: "utf8" },
		);
		expect(out.stdout).toBe("rc=0\n");
	});
});

describe("the library's shape", () => {
	it("defines gp_begin last, which is what makes a one-name load gate safe", () => {
		// Each guard gates on `declare -F gp_begin` alone. That only disarms a
		// damaged library because bash defines everything up to the break and
		// nothing after it, so gp_begin must stay the final definition in the file.
		const src = fs.readFileSync(LIB, "utf8");
		const defs = [...src.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)\(\)/gm)].map(
			(m) => m[1],
		);
		expect(defs.length).toBeGreaterThan(5);
		expect(defs.at(-1)).toBe("gp_begin");
	});

	it("exposes no mutable state across the seam — every global is _gp_ or QUOTED", () => {
		const vars = sh(`compgen -v | grep -E '^(gp_|_gp_|QUOTED)' | sort`)
			.trim()
			.split("\n")
			.filter(Boolean);
		expect(vars.filter((v) => v.startsWith("gp_"))).toEqual([]);
		expect(vars).toContain("QUOTED");
	});

	// Two literals, since check-injector-margin.sh and check-context-budget.js
	// read GP_RULE_CAP as a bare integer.
	it("holds GP_RULE_CAP at 40% of HOOK_PERSIST_CHARS", () => {
		expect(shellConst(LIB, "GP_RULE_CAP")).toBe(
			0.4 *
				shellConst(
					path.join(__dirname, "hook-limits.sh"),
					"HOOK_PERSIST_CHARS",
				),
		);
	});
});

/*
 * The helper leak-checks every instantiate() call itself, so beforeEach
 * already throws before any test body runs were a copy still pointing at the
 * template. What is left to assert here is what that scan cannot see: that
 * relink() wrote THIS instance's own path rather than some third, wrong one,
 * and — the BEHAVIOURAL limb — that a write made in an instantiated copy does
 * not reach a second, independent instantiation of the same template.
 */
describe("the copied fixture is isolated from its template (mantahostels#2087)", () => {
	const freshCopy = () => {
		const fresh = mkScratchDir("guard-parse-fresh-");
		try {
			template.instantiate(fresh);
		} catch (err) {
			fs.rmSync(fresh, { recursive: true, force: true });
			throw err;
		}
		return fresh;
	};

	// A commit made in a copy's own real .git — the shared copy's (dropped
	// here, mantahostels#2178) and the 'elsewhere' copy's (mantahostels#2193) — proves nothing about
	// relinking: nothing that write touches is one of git-fixture's path
	// carriers, so it cannot fail on a relink regression. "points
	// core.hooksPath at THIS instance's own directory" below is the test that
	// actually depends on it, and reads both top-level copies.

	it("a commit made in the copied WORKTREE leaves the template untouched", () => {
		// The worktree shares its parent's object store, so a stale gitdir
		// pointer here writes into the template rather than failing loudly.
		fs.writeFileSync(path.join(worktree, "c.md"), "c\n");
		git(worktree, "add", "c.md");
		git(worktree, "commit", "-qm", "worktree copy only", "--", "c.md");
		expect(git(worktree, "log", "--oneline")).toContain("worktree copy only");

		const fresh = freshCopy();
		try {
			expect(
				git(path.join(fresh, "shared"), "log", "--all", "--oneline"),
			).not.toContain("worktree copy only");
		} finally {
			fs.rmSync(fresh, { recursive: true, force: true });
		}
	});

	it("points core.hooksPath at THIS instance's own directory, relinked off the template", () => {
		// Asserting merely "exists and is empty" would pass even with relink()
		// disabled: the template's own no-hooks dir is exists-and-empty too, so a
		// stale pointer left aimed at the TEMPLATE would read identically.
		// Anchoring on `dir` — this instance's own root — is what tells a
		// relinked path apart from a leaked one. What these assertions catch
		// that checkForLeak() cannot is a relink writing some third, wrong path,
		// which can hit one copy and not the other — hence both (mantahostels#2193 review).
		for (const repo of [shared, elsewhere]) {
			const hooks = git(repo, "config", "core.hooksPath").trim();
			expect(hooks).toBe(path.join(dir, "no-hooks"));
			expect(fs.existsSync(hooks)).toBe(true);
			expect(fs.readdirSync(hooks)).toEqual([]);
		}
	});
});

describe("the unresolved-tree record's fourth field (#320)", () => {
	/** Field 4 of each record, "" where a record has none. */
	const details = () => logged(shared, 3);

	it("carries an unresolved -C value as typed, $W unexpanded, and both cwds", () => {
		walkGit('git -C "$UNSET_320" checkout x', "checkout", elsewhere);
		expect(details()).toEqual([
			`target=-C "$UNSET_320" pwd=${elsewhere} cwd=${elsewhere}`,
		]);
	});

	it("carries an unquoted $W as typed too", () => {
		walkGit("git -C $UNSET_320 checkout x", "checkout", elsewhere);
		expect(details()).toEqual([
			`target=-C $UNSET_320 pwd=${elsewhere} cwd=${elsewhere}`,
		]);
	});

	it("names the cd that lost the cwd, and the cwd as unknown", () => {
		walkGit('cd "$UNSET_320" && git checkout x', "checkout", elsewhere);
		expect(details()).toEqual([
			`target=cd "$UNSET_320" pwd=${elsewhere} cwd=<unknown>`,
		]);
	});

	it("puts back a single-quoted span nested in a double-quoted one", () => {
		walkGit(`git -C "a'b'$UNSET_320" checkout x`, "checkout", elsewhere);
		expect(details()[0]).toMatch(/^target=-C "a'b'\$UNSET_320" /);
	});

	it("collapses a tab in the typed path, so it cannot shift a field", () => {
		walkGit('git -C "a\tb$UNSET_320" checkout x', "checkout", elsewhere);
		expect(details()[0]).toMatch(/^target=-C "a b\$UNSET_320" /);
	});

	// Driven privately because no command reaches it: every sentinel the masker
	// writes has its span recorded. #315 ruled the marker for that case anyway.
	it("writes a fixed <quoted> for a span index never recorded, and no \\x01", () => {
		const r = drive(
			`_gp_spans=(); _gp_as_written "a\${QUOTED}7"$'\\x01'"b"; printf '%s' "$_gp_written"`,
		);
		expect(r.out).toBe("a<quoted>b");
	});

	it("collapses a newline in the typed path, so it cannot forge a record", () => {
		walkGit('git -C "a\nb$UNSET_320" checkout x', "checkout", elsewhere);
		expect(details()).toHaveLength(1);
		expect(details()[0]).toMatch(/^target=-C "a b\$UNSET_320" /);
	});

	it("leaves the walker's other record at three fields", () => {
		// A `.git` naming a gone gitdir: git cannot answer, the other record.
		const broken = path.join(dir, "broken-repo");
		fs.mkdirSync(broken, { recursive: true });
		fs.writeFileSync(
			path.join(broken, ".git"),
			`gitdir: ${path.join(dir, "no-such-gitdir")}\n`,
		);
		walkGit(`cd ${broken} && git checkout x`, "checkout", shared);
		expect(logged()).toHaveLength(1);
		expect(details()).toEqual([""]);
	});
});

describe("--empty-unset reads a provably empty target as the cwd (#310, #325)", () => {
	/** A walk opted in, through either walker, from `cwd`. */
	const walkEmpty = (
		command: string,
		cwd: string,
		walker = "gp_walk_shared_git",
		env?: Record<string, string>,
	) =>
		drive(
			`${SHOW}\ngp_begin '.tool_input.command' command\n${walker} --empty-unset show "branch move" checkout`,
			{ payload: { tool_input: { command } }, cwd, env },
		);

	const failOpen =
		"could not resolve the working tree for a git checkout — branch move allowed unchecked";

	it.each([
		'cd "$UNSET_325" && git checkout x',
		'git -C "$UNSET_325" checkout x',
		// biome-ignore lint/suspicious/noTemplateCurlyInString: bash braces, the braced spelling under test.
		'git -C "${UNSET_325}" checkout x',
		'git -C "$UNSET_325$UNSET_325B" checkout x',
	])("judges %s in the cwd, unlogged", (command) => {
		expect(walkEmpty(command, shared).out).toContain(`[checkout][${shared}]`);
		expect(logged()).toEqual([]);
	});

	it("judges it where the cwd is, not the shared tree", () => {
		expect(walkEmpty('cd "$UNSET_325" && git checkout x', elsewhere).out).toBe(
			"",
		);
		expect(logged()).toEqual([]);
	});

	it("reaches a linked worktree through the repo-wide walker", () => {
		const r = walkEmpty(
			'git -C "$UNSET_325" checkout x',
			worktree,
			"gp_walk_repo_git",
		);
		expect(r.out).toContain(`[checkout][${worktree}]`);
	});

	it.each(['U=""; git -C "$U" checkout x', 'U=; git -C "$U" checkout x'])(
		"reads a name this command set empty the same way: %s",
		(command) => {
			expect(walkEmpty(command, shared).out).toContain(`[checkout][${shared}]`);
			expect(logged()).toEqual([]);
		},
	);

	it.each([
		// Unquoted, an empty expansion drops the word: `cd` alone goes to $HOME.
		["an unquoted reference", "cd $UNSET_325 && git checkout x"],
		["a command substitution", 'cd "$(pwd)" && git checkout x'],
		// biome-ignore lint/suspicious/noTemplateCurlyInString: bash braces, and the operator inside them is what must not be expanded.
		["an operator form", 'git -C "${UNSET_325:-/x}" checkout x'],
		// The harvest sees leading `NAME=` words alone.
		[
			"an assignment it cannot harvest",
			'export UNSET_325=/x; git -C "$UNSET_325" checkout x',
		],
		[
			"a name `read` assigns",
			'read UNSET_325 < f; git -C "$UNSET_325" checkout x',
		],
		[
			"a `||`, which may skip an assignment it cannot see",
			'true || true; git -C "$UNSET_325" checkout x',
		],
		["a name assigned from $(…)", 'U=$(pwd); git -C "$U" checkout x'],
		["a name set empty twice over", 'U=; U=; git -C "$U" checkout x'],
		// Each can assign the name without the command text ever naming it.
		["a `source` before it", 'source ./env.sh; git -C "$UNSET_325" checkout x'],
		["a `.` before it", '. ./env.sh && git -C "$UNSET_325" checkout x'],
		["an `eval` before it", 'eval "$X"; git -C "$UNSET_325" checkout x'],
	])("keeps the logged fail-open for %s", (_, command) => {
		expect(walkEmpty(command, shared).out).toBe("");
		expect(logged()).toEqual([failOpen]);
	});

	it("keeps it for a name the hook's environment sets empty", () => {
		const r = walkEmpty('git -C "$WFC_EMPTY" checkout x', shared, undefined, {
			WFC_EMPTY: "",
		});
		expect(r.out).toBe("");
		expect(logged()).toEqual([failOpen]);
	});

	it("leaves a walk without the opt-in failing open, as before", () => {
		expect(
			walkGit('git -C "$UNSET_325" checkout x', "checkout", shared).out,
		).toBe("");
		expect(logged()).toEqual([failOpen]);
	});

	it("still reads `git add .` as no `.` builtin", () => {
		const r = walkEmpty('git add . && git -C "$UNSET_325" checkout x', shared);
		expect(r.out).toContain(`[checkout][${shared}]`);
	});

	it("takes the opt-in on a strict walker too", () => {
		const r = walkEmpty(
			'git -C "$UNSET_325" checkout x',
			shared,
			"gp_walk_shared_git_strict",
		);
		expect(r.out).toContain(`[checkout][${shared}]`);
	});

	it("names only what led to the judged tree", () => {
		const r = drive(
			`names() { printf '<%s>' $(gp_empty_vars); printf '\\n'; }\ngp_begin '.tool_input.command' command\ngp_walk_shared_git --empty-unset names "branch move" checkout status`,
			{
				payload: {
					tool_input: {
						command:
							'git -C "$UNSET_325" status; (cd "$UNSET_325B"); git checkout x; cd "$UNSET_325C" && git checkout y',
					},
				},
				cwd: shared,
			},
		);
		expect(r.out).toBe("<UNSET_325>\n<>\n<UNSET_325C>\n");
	});

	it("names only the unset ones to gp_empty_vars", () => {
		const r = drive(
			`names() { printf '<%s>' $(gp_empty_vars); printf '\\n'; }\ngp_begin '.tool_input.command' command\ngp_walk_shared_git --empty-unset names "branch move" checkout`,
			{
				payload: {
					tool_input: {
						command: 'U=""; cd "$UNSET_325" && git -C "$U" checkout x',
					},
				},
				cwd: shared,
			},
		);
		expect(r.out).toBe("<UNSET_325>\n");
	});

	it.each(["gp_walk_shared_git", "gp_walk_repo_git"])(
		"%s nested in an opted-in callback does not inherit it",
		(walker) => {
			const r = drive(
				`${SHOW}\nnested() { ${walker} show "branch move" checkout; }\ngp_begin '.tool_input.command' command\ngp_walk_shared_git --empty-unset nested "branch move" checkout`,
				{
					payload: {
						tool_input: { command: 'git -C "$UNSET_325" checkout x' },
					},
					cwd: shared,
				},
			);
			expect(r.out).toBe("");
			expect(logged()).toEqual([failOpen]);
		},
	);
});

// The walker fills _gp_target_names; seeding it directly isolates the wording
// the three guards share (#338). The fill itself is the --empty-unset
// describe's.
describe("gp_unset_text", () => {
	const unsetText = (names: string) =>
		sh(`_gp_target_names="${names}"; gp_unset_text t; printf '%s' "$t"`);

	it("is empty where no name led to the tree", () => {
		expect(unsetText("")).toBe("");
	});

	it("names one variable in the singular, with a blank line after", () => {
		expect(unsetText("A")).toBe(
			"`$A` is unset in this call; shell variables do not carry over between Bash calls.\n\n",
		);
	});

	it("names several once each, in the plural", () => {
		expect(unsetText("A B A")).toBe(
			"`$A`, `$B` are unset in this call; shell variables do not carry over between Bash calls.\n\n",
		);
	});

	it("clears a caller's variable left over from an earlier segment", () => {
		expect(
			sh(`t=stale; _gp_target_names=""; gp_unset_text t; printf '[%s]' "$t"`),
		).toBe("[]");
	});
});
