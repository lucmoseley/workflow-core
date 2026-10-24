// @vitest-environment node
/*
 * guard-agent-poll.sh stops a session waiting by looking (mantahostels#627, widened at
 * mantahostels#659; why, at #845, which overturned mantahostels#2516).
 * The routes into that wait are counted — a ListAgents call, a Read of a
 * background job's output file, a Bash call whose whole command is inert, and the
 * two timed watches that open with a sleep — each with its own allowance inside
 * one rolling five-minute window.
 *
 * Its verdict depends on ACCUMULATED STATE — the third call in five minutes is
 * the one that denies — so it cannot use guard-log-fixture.ts, whose `denied`
 * control is a single stateless payload. The fail-open record cases are carried
 * here instead.
 *
 * Every case drives the guard with its own TMPDIR, because that is where the
 * per-session state lives, and its own CLAUDE_CONFIG_DIR, because since mantahostels#147 a
 * fail-open is recorded and an unset config dir would append to the founder's
 * real log.
 *
 * It is a `PreToolUse` hook in `self-plugin/hooks/hooks.json`: loosen a case
 * and a session polls a background job at a full-context turn per look, or a
 * guard that cannot judge starts denying instead of getting out of the way.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** Ask for a payload with no session_id at all — `undefined` would hit the
 * default parameter below and silently send an ordinary session instead. */
const OMIT = Symbol("omit");

const GUARD = path.resolve(__dirname, "guard-agent-poll.sh");
const LIB_DIR = path.resolve(__dirname, "lib");

let dir: string;
let tmp: string;
let config: string;

const run = (
	session: unknown = "s1",
	opts: { guard?: string; pathPrefix?: string } = {},
) => {
	const payload = session === OMIT ? {} : { session_id: session };
	const r = spawnSync(opts.guard ?? GUARD, [], {
		encoding: "utf8",
		input: JSON.stringify(payload),
		env: {
			...process.env,
			TMPDIR: tmp,
			CLAUDE_CONFIG_DIR: config,
			...(opts.pathPrefix
				? { PATH: `${opts.pathPrefix}:${process.env.PATH}` }
				: {}),
		},
	});
	if (r.status === null) throw new Error(`guard did not run: ${r.error}`);
	return r;
};

/*
 * A guard that CRASHES also emits no verdict, so an allow alone would pass
 * whether the line failed open or the script died.
 */
const expectSilentAllow = (r: ReturnType<typeof run>) => {
	expect(r.status).toBe(0);
	expect(r.stdout ?? "").toBe("");
	expect(r.stderr ?? "").toBe("");
};

const expectDeny = (r: ReturnType<typeof run>) => {
	const out = JSON.parse(r.stdout);
	expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
	expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
	return out.hookSpecificOutput.permissionDecisionReason as string;
};

/** An allowed call carrying a warning, and nothing else. */
const expectWarn = (r: ReturnType<typeof run>) => {
	expect(r.status).toBe(0);
	const out = JSON.parse(r.stdout);
	expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
	expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
	return out.hookSpecificOutput.additionalContext as string;
};

const firstLine = (text: string) => text.split("\n")[0];

const stateFile = (session = "s1") => path.join(tmp, "wfc-agent-poll", session);

/** A copy of the guard whose lib/ can be tampered with: guard-parse.sh and
 * atomic-write.sh, which it records polls through, plus `extraLibs`. */
const detach = (...extraLibs: string[]) => {
	const at = path.join(dir, "detached");
	fs.mkdirSync(path.join(at, "lib"), { recursive: true });
	const guard = path.join(at, path.basename(GUARD));
	fs.copyFileSync(GUARD, guard);
	fs.chmodSync(guard, 0o755);
	for (const lib of ["guard-parse.sh", "atomic-write.sh", ...extraLibs])
		fs.copyFileSync(path.join(LIB_DIR, lib), path.join(at, "lib", lib));
	return { at, guard };
};

/** A stub binary earlier on PATH than the real one. */
const stub = (name: string, body: string) => {
	const at = path.join(dir, `stub-${name}`);
	fs.mkdirSync(at, { recursive: true });
	fs.writeFileSync(path.join(at, name), `#!/bin/sh\n${body}\n`);
	fs.chmodSync(path.join(at, name), 0o755);
	return at;
};

const logged = () => {
	const hits: string[] = [];
	const walk = (at: string) => {
		if (!fs.existsSync(at)) return;
		for (const e of fs.readdirSync(at, { withFileTypes: true })) {
			const full = path.join(at, e.name);
			if (e.isDirectory()) walk(full);
			else hits.push(fs.readFileSync(full, "utf8"));
		}
	};
	walk(config);
	return hits.join("\n");
};

/**
 * The payload carries a tool_name and a tool_input; the `run` helper above
 * deliberately sends neither, pinning the shape this guard was originally built
 * against.
 */
const runTool = (
	tool: string,
	input: Record<string, unknown>,
	session = "s1",
	{ agent, guard = GUARD }: { agent?: string; guard?: string } = {},
) => {
	const r = spawnSync(guard, [], {
		encoding: "utf8",
		input: JSON.stringify({
			session_id: session,
			...(agent ? { agent_id: agent } : {}),
			tool_name: tool,
			tool_input: input,
		}),
		env: { ...process.env, TMPDIR: tmp, CLAUDE_CONFIG_DIR: config },
	});
	if (r.status === null) throw new Error(`guard did not run: ${r.error}`);
	return r;
};

/** A background job's output file, in the shape the harness writes. */
const OUT = "/tmp/claude-1000/proj/sess/tasks/bw0192d7i.output";

const readOf = (file: string, session = "s1") =>
	runTool("Read", { file_path: file }, session);

const bash = (command: string, session = "s1") =>
	runTool("Bash", { command }, session);

/** Nothing recorded at all — the guard left without touching its state. */
const expectNotCounted = (r: ReturnType<typeof run>) => {
	expectSilentAllow(r);
	expect(fs.existsSync(stateFile())).toBe(false);
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-agent-poll-"));
	tmp = path.join(dir, "tmp");
	config = path.join(dir, "claude-config");
	fs.mkdirSync(tmp);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("the allowance", () => {
	it("passes the first two calls, then denies", () => {
		expectSilentAllow(run());
		expectSilentAllow(run());
		expectDeny(run());
	});

	it("keeps denying while the window holds", () => {
		run();
		run();
		expectDeny(run());
		expectDeny(run());
	});

	it("opens with the corrected move — the artefact watcher (#545)", () => {
		run();
		run();
		const reason = expectDeny(run());
		expect(firstLine(reason)).toMatch(/^Instead: /);
		expect(firstLine(reason)).toContain(
			"node scripts/watch-artefact.js <artefact> 120",
		);
		expect(firstLine(reason)).toContain("end the turn");
		expect(reason).toContain("notification");
	});

	it("does not record a denied call, so a retry loop cannot pin the window open", () => {
		run();
		run();
		run();
		run();
		const stamps = fs
			.readFileSync(stateFile(), "utf8")
			.trim()
			.split("\n")
			.filter(Boolean);
		expect(stamps).toHaveLength(2);
	});
});

describe("the window is rolling", () => {
	it("drops stamps older than five minutes, so the allowance recovers", () => {
		run();
		run();
		expectDeny(run());

		const old = Math.floor(Date.now() / 1000) - 400;
		fs.writeFileSync(stateFile(), `${old}\tagents\n${old + 50}\tagents\n`);
		expectSilentAllow(run());
	});

	it("ignores a corrupt line rather than counting it", () => {
		fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
		fs.writeFileSync(stateFile(), "not-a-stamp\nalso-not\n");
		expectSilentAllow(run());
		expectSilentAllow(run());
		expectDeny(run());
	});
});

describe("sessions are independent", () => {
	it("one session's loop does not refuse another's first look", () => {
		run("s1");
		run("s1");
		expectDeny(run("s1"));
		expectSilentAllow(run("other"));
	});

	it("flattens a traversal attempt in the session id to one filename", () => {
		run("../../etc/pwned");
		const held = fs.readdirSync(path.join(tmp, "wfc-agent-poll"));
		expect(held).toEqual(["______etc_pwned"]);
	});
});

describe("it fails open, and says so (mantahostels#103 §6, mantahostels#147)", () => {
	it("allows when the clock will not answer — never denies on doubt", () => {
		const at = stub("date", "echo notanumber");
		expectSilentAllow(run("s1", { pathPrefix: at }));
		expect(logged()).toContain("could not read the clock");
	});

	it("allows when the state dir cannot be created", () => {
		// A file where the directory should go: mkdir -p cannot win.
		fs.writeFileSync(path.join(tmp, "wfc-agent-poll"), "");
		expectSilentAllow(run());
		expect(logged()).toContain("could not create");
	});

	it("allows when the payload carries no session_id", () => {
		expectSilentAllow(run(OMIT));
		expect(logged()).toContain("session_id");
	});

	it("allows on a payload that is not JSON at all", () => {
		const r = spawnSync(GUARD, [], {
			encoding: "utf8",
			input: "not json",
			env: { ...process.env, TMPDIR: tmp, CLAUDE_CONFIG_DIR: config },
		});
		expect(r.status).toBe(0);
		expect(r.stdout ?? "").toBe("");
	});

	it("allows when lib/guard-parse.sh will not load", () => {
		const { at, guard } = detach();
		fs.writeFileSync(path.join(at, "lib", "guard-parse.sh"), "return 1\n");
		expectSilentAllow(run("s1", { guard }));
	});

	it("the detached copy still denies — the control that the cases above are armed", () => {
		const { guard } = detach();
		run("s1", { guard });
		run("s1", { guard });
		expectDeny(run("s1", { guard }));
	});
});

describe("re-reading a background job's output file (mantahostels#659)", () => {
	it("passes the first two reads, then denies the third", () => {
		expectSilentAllow(readOf(OUT));
		expectSilentAllow(readOf(OUT));
		expectDeny(readOf(OUT));
	});

	it("opens with all three one-call waits, before the why (#545)", () => {
		readOf(OUT);
		readOf(OUT);
		const reason = expectDeny(readOf(OUT));
		const first = firstLine(reason);
		expect(first).toMatch(/^Instead: /);
		expect(first).toContain("node scripts/watch-artefact.js <artefact> 120");
		expect(first).toContain("foreground with `timeout: 600000`");
		expect(first).toContain("scripts/bg-run.sh wait <name>");
		expect(first).toContain("end the turn");
		expect(reason).toContain("notification");
	});

	it("counts each output file separately — two jobs are not a loop", () => {
		const other = "/tmp/claude-1000/proj/sess/tasks/b59vv44s7.output";
		expectSilentAllow(readOf(OUT));
		expectSilentAllow(readOf(other));
		expectSilentAllow(readOf(OUT));
		expectSilentAllow(readOf(other));
		expectDeny(readOf(OUT));
	});

	it("ignores an ordinary Read, however often it repeats", () => {
		const src = "/home/lucmo/mantahostels/scripts/pick-next.js";
		expectNotCounted(readOf(src));
		expectNotCounted(readOf(src));
		expectNotCounted(readOf(src));
	});

	it("ignores a file that merely ends .output outside a tasks/ directory", () => {
		const stray = "/home/lucmo/mantahostels/build/report.output";
		expectNotCounted(readOf(stray));
		expectNotCounted(readOf(stray));
		expectNotCounted(readOf(stray));
	});
});

describe("a no-op Bash call is not a way to end a turn (mantahostels#659)", () => {
	it("passes one, then denies — an inert command has no legitimate repeat", () => {
		expectSilentAllow(bash("true"));
		expectDeny(bash("true"));
	});

	it("says that ending a turn is not a tool call", () => {
		bash("true");
		const reason = expectDeny(bash("true"));
		expect(reason).toContain("NO tool call");
		expect(reason).toContain("notification");
	});

	it.each([
		"true",
		":",
		"exit 0",
		"exit",
		"  true  ",
		"true;",
		"true # end turn",
	])("reads %j as inert", (spelling) => {
		expectSilentAllow(bash(spelling));
		expectDeny(bash(spelling));
	});

	it.each([
		"make || true",
		"grep -q x file && true",
		"echo true",
		"truex",
		"exit 1",
		":; npm run build",
	])("leaves %j alone — it does real work", (command) => {
		expectNotCounted(bash(command));
		expectNotCounted(bash(command));
		expectNotCounted(bash(command));
	});
});

describe("the timed artefact check is warned, never refused (#482)", () => {
	const check = "sleep 120; wc -c $CLAUDE_JOB_DIR/tmp/concision-pick.md";

	it("lets the prescribed cadence through — three checks, silent", () => {
		expectSilentAllow(bash(check));
		expectSilentAllow(bash(check));
		expectSilentAllow(bash(check));
	});

	it("allows the fourth inside five minutes, warning that the cadence is under two minutes", () => {
		bash(check);
		bash(check);
		bash(check);
		expect(expectWarn(bash(check))).toContain("under two minutes");
	});

	it("keeps warning, never denying, while the cadence stays fast", () => {
		for (let i = 0; i < 3; i++) bash(check);
		for (let i = 0; i < 3; i++) expectWarn(bash(check));
	});

	it("warns a one-second cadence rather than refusing it", () => {
		const spam = "sleep 1; wc -c /tmp/claude-1000/proj/sess/tasks/x.output";
		for (let i = 0; i < 3; i++) expectSilentAllow(bash(spam));
		expectWarn(bash(spam));
	});

	it("says what to do with the reading", () => {
		for (let i = 0; i < 3; i++) bash(check);
		const warning = expectWarn(bash(check));
		expect(warning).toContain("no growth");
		expect(warning).toContain("node scripts/watch-artefact.js <artefact> 120");
		expect(warning).toMatch(/end the turn/i);
	});

	it("counts any leading sleep, whatever follows it", () => {
		for (let i = 0; i < 3; i++) bash("sleep 30; ls -l out/");
		expectWarn(bash("sleep 5; cat log.txt"));
	});

	it("leaves a sleep that is not the command's opening word alone", () => {
		expectNotCounted(bash("npm run build && sleep 5"));
		expectNotCounted(bash("for i in 1 2 3; do sleep 1; done"));
		expectNotCounted(bash("sleep_until_ready.sh"));
	});

	it("spends its own allowance, not the inert command's", () => {
		for (let i = 0; i < 3; i++) bash(check);
		expectWarn(bash(check));
		expectSilentAllow(bash("true"));
	});
});

describe("the routes share a window but not an allowance", () => {
	it("a spent ListAgents allowance does not refuse a first no-op or read", () => {
		run();
		run();
		expectDeny(run());
		expectSilentAllow(bash("true"));
		expectSilentAllow(readOf(OUT));
	});

	it("a spent no-op allowance does not refuse a ListAgents look", () => {
		bash("true");
		expectDeny(bash("true"));
		expectSilentAllow(run());
		expectSilentAllow(run());
	});

	it("ignores a tool it does not classify", () => {
		expectNotCounted(runTool("Write", { file_path: OUT }));
		expectNotCounted(runTool("Glob", { pattern: "**/*.output" }));
	});

	it("counts a ListAgents payload that names itself, not only one with no tool_name", () => {
		expectSilentAllow(runTool("ListAgents", {}));
		expectSilentAllow(runTool("ListAgents", {}));
		expectDeny(runTool("ListAgents", {}));
	});

	it("does not read a Bash or Read payload with no tool_name as ListAgents", () => {
		// Folding one into the agents bucket would eventually deny an ordinary
		// call, quoting a reason about polling at a session that never polled.
		for (let i = 0; i < 4; i++) {
			expectNotCounted(runTool("", { command: "npm run build" }));
			expectNotCounted(runTool("", { file_path: "/etc/hosts" }));
		}
	});

	it("counts an output filename carrying characters the key sanitiser rewrites", () => {
		const odd = "/tmp/claude-1000/proj/sess/tasks/job id (2).output";
		expectSilentAllow(readOf(odd));
		expectSilentAllow(readOf(odd));
		expectDeny(readOf(odd));
	});

	it("keeps one session's reads off another's count", () => {
		readOf(OUT, "s1");
		readOf(OUT, "s1");
		expectDeny(readOf(OUT, "s1"));
		expectSilentAllow(readOf(OUT, "other"));
	});
});

/*
 * mantahostels#2590. docs/agents/guard-registry.md §Subagent dispatch and docs/agents/rules/killed-background-job.txt
 * each prescribe a two-minute timed watch, and both open with a sleep.
 */
describe("the two timed watches do not spend each other's allowance (mantahostels#2590)", () => {
	const artefact = "sleep 120; wc -c .claude/tmp/review-standards-abc.md";
	const beat = "sleep 120; scripts/bg-run.sh check suite";

	/** The `allowance=` the guard sets on the sleep route, from its own source. */
	const sleepAllowance = (() => {
		const src = fs.readFileSync(GUARD, "utf8");
		const branch =
			/sleep\[\[:space:\]\]\+\[0-9\][\s\S]*?\ballowance=(\d+)/.exec(src);
		if (!branch)
			throw new Error("no allowance found on the guard's sleep route");
		return Number(branch[1]);
	})();

	it("reads the same allowance the guard's own header states", () => {
		// The extraction throws if it finds nothing, so a bare sanity bound would
		// be dead. Pin it against the prose instead.
		const src = fs.readFileSync(GUARD, "utf8");
		const stated = /check:job\b[\s\S]*?Allowance (\d+)\./.exec(src);
		expect(stated?.[1]).toBe(String(sleepAllowance));
	});

	it("lets both watches run their full cadence, interleaved", () => {
		for (let i = 0; i < sleepAllowance; i++) {
			expectSilentAllow(bash(artefact));
			expectSilentAllow(bash(beat));
		}
	});

	it("warns each watch on its own over-cadence, saying it is under two minutes, never denying (#482)", () => {
		for (let i = 0; i < sleepAllowance; i++) bash(beat);
		expect(expectWarn(bash(beat))).toContain("under two minutes");
		expectSilentAllow(bash(artefact));
	});

	it("keeps the job beat allowed past its allowance, however often", () => {
		for (let i = 0; i < sleepAllowance; i++) bash(beat);
		for (let i = 0; i < 3; i++) expectWarn(bash(beat));
	});

	it("spends the job key only where the command names bg-run check", () => {
		for (let i = 0; i < sleepAllowance; i++) bash(artefact);
		expectWarn(bash(artefact));
		expectSilentAllow(bash(beat));
	});

	it("tells the beat its own stall ceiling in the warning", () => {
		for (let i = 0; i < sleepAllowance; i++) bash(beat);
		const warning = expectWarn(bash(beat));
		expect(warning).toContain("Timed job beats under two minutes apart");
		expect(warning).toContain("KILLED or UNKNOWN twice");
		expect(warning).toMatch(/end the turn/i);
	});

	it("reads a bg-run beat spelled without the scripts/ prefix as the job key", () => {
		for (let i = 0; i < sleepAllowance; i++) bash(artefact);
		expectWarn(bash(artefact));
		expectSilentAllow(bash("sleep 90; bg-run.sh check suite"));
	});

	it("does not read a longer word starting `check` as the beat", () => {
		for (let i = 0; i < sleepAllowance; i++) {
			bash("sleep 90; scripts/bg-run.sh checkpoint suite");
		}
		expectWarn(bash(artefact));
	});

	it("leaves a bg-run RUN — which starts work, not a watch — on the artefact key", () => {
		for (let i = 0; i < sleepAllowance; i++) {
			bash("sleep 5; scripts/bg-run.sh run suite npm test");
		}
		expectWarn(bash(artefact));
		expectSilentAllow(bash(beat));
	});
});

/*
 * #1169. A subagent's payload carries its parent's session_id, so one shared
 * window refused a fork for its siblings' checks; and every text told it to end
 * the turn, which for a subagent ends its work.
 */
describe("a subagent is counted, and told, as itself (#1169)", () => {
	const lock = "sleep 5; ls .git/index.lock";
	const sub = (agent: string) => (command: string) =>
		runTool("Bash", { command }, "s1", { agent });

	it("two subagents under one session each start their allowance without a warning", () => {
		const a = sub("a1");
		const b = sub("b2");
		for (let i = 0; i < 3; i++) {
			expectSilentAllow(a(lock));
			expectSilentAllow(b(lock));
		}
	});

	it("keeps a subagent's count off its parent's, and the parent's off it", () => {
		for (let i = 0; i < 3; i++) bash(lock);
		expectWarn(bash(lock));
		expectSilentAllow(sub("a1")(lock));
		run();
		run();
		expectDeny(run());
		expectSilentAllow(runTool("ListAgents", {}, "s1", { agent: "a1" }));
	});

	it("still warns one subagent past its own allowance, saying its timed checks are under two minutes apart", () => {
		const a = sub("a1");
		for (let i = 0; i < 3; i++) a(lock);
		expect(expectWarn(a(lock))).toContain(
			"Timed checks under two minutes apart",
		);
	});

	it("still refuses one subagent past its own allowance", () => {
		const a = sub("a1");
		expectSilentAllow(a("true"));
		expectDeny(a("true"));
	});

	it("keeps the parent's file where it was, so its window survives the change", () => {
		bash(lock);
		sub("a1")(lock);
		const held = fs.readdirSync(path.join(tmp, "wfc-agent-poll")).sort();
		expect(held).toEqual(["s1", "s1.aa1"]);
	});

	/** #1486: the key is guard-parse.sh's public gp_agent_key, and a call to it
	 * that fails counts the subagent as the parent and logs. Each half is the
	 * other's control: the empty log means nothing unless the fallback logs. */
	it("keys a subagent by gp_agent_key, and logs where it cannot", () => {
		const held = () => fs.readdirSync(path.join(tmp, "wfc-agent-poll"));
		expectSilentAllow(sub("x/y")(lock));
		expect(held()).toEqual(["s1.ax_y"]);
		expect(logged()).toBe("");

		// Without guard-log.sh and guard-root.sh gl_log is a no-op stub and the
		// fallback's line is never written.
		const { at, guard } = detach("guard-log.sh", "guard-root.sh");
		fs.appendFileSync(
			path.join(at, "lib", "guard-parse.sh"),
			"gp_agent_key() { return 2; }\n",
		);
		expectSilentAllow(
			runTool("Bash", { command: lock }, "s2", { agent: "x/y", guard }),
		);
		expect(held()).toContain("s2");
		expect(logged()).toContain("could not tell a subagent from its parent");
	});

	/** Each branch's text on the call one past its allowance — the parent's
	 * where `agent` is absent. */
	const texts = (agent?: string) => {
		const call = (tool: string, input: Record<string, unknown>) =>
			runTool(tool, input, agent ? `s-${agent}` : "s1", { agent });
		const over = (n: number, tool: string, input: Record<string, unknown>) => {
			for (let i = 0; i < n; i++) call(tool, input);
			return call(tool, input);
		};
		return {
			check: expectWarn(over(3, "Bash", { command: lock })),
			beat: expectWarn(
				over(3, "Bash", { command: "sleep 120; scripts/bg-run.sh check s" }),
			),
			noop: expectDeny(over(1, "Bash", { command: "true" })),
			read: expectDeny(over(2, "Read", { file_path: OUT })),
			agents: expectDeny(over(2, "ListAgents", {})),
		};
	};

	it("never tells a subagent to end the turn, and says ending it ends its work", () => {
		for (const [branch, text] of Object.entries(texts("a1"))) {
			expect(text, branch).not.toMatch(/end the turn/i);
			expect(text, branch).toContain("ending your turn ends your work");
			expect(text, branch).toContain("timeout: 600000");
			expect(text, branch).toContain("scripts/bg-run.sh wait <name>");
			expect(text, branch).toContain("retried directly");
		}
	});

	it("opens each subagent refusal with the in-turn wait (#482)", () => {
		const { noop, read, agents } = texts("a1");
		for (const reason of [noop, read, agents])
			expect(firstLine(reason)).toMatch(/^Instead: wait inside the turn/);
	});

	it("leaves the parent's texts telling it to end the turn", () => {
		for (const [branch, text] of Object.entries(texts())) {
			expect(text, branch).toMatch(/end the turn/i);
			expect(text, branch).not.toContain("subagent: ending");
		}
	});

	it("gives each parent refusal the shared end-the-turn sentence (#1779)", () => {
		const { noop, read, agents } = texts();
		for (const reason of [noop, read, agents]) {
			expect(reason).toContain(
				"the completion notification wakes the session or, arriving mid-call, is folded into the next tool result (97%, #845), so each ",
			);
			expect(reason).not.toContain("@NOTIFIED@");
		}
	});
});
