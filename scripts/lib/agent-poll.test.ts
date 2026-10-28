// @vitest-environment node
/*
 * lib/agent-poll.js stops a session waiting by looking (mantahostels#627,
 * widened at mantahostels#659; why, at #845, which overturned
 * mantahostels#2516). The routes into that wait are counted — a ListAgents
 * call, a Read of a background job's output file, a Bash call whose whole
 * command is inert, and the two timed watches that open with a sleep — each
 * with its own allowance inside one rolling five-minute window.
 *
 * Its verdict depends on ACCUMULATED STATE — the third call in five minutes is
 * the one that denies — so every case drives the core over its production
 * ports (lib/agent-poll-host.js) with its own TMPDIR, where the window lives.
 *
 * Module cases call `decide` over the context lib/kit-context.js's kitContext
 * builds. The cases through lib/guard-core-testkit.ts prove the dispatcher
 * row; the Bash boundary set is scripts/guard-agent-poll.test.ts's, the hook
 * line's scripts/guard-dispatch.test.ts's.
 *
 * Loosen a case and a session polls a background job at a full-context turn
 * per look, or a guard that cannot judge starts denying instead of getting out
 * of the way.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decide, type PollContext } from "./agent-poll.js";
import { buildHostPorts } from "./agent-poll-host.js";
import { fakeTreeClassifier } from "./git-tree-fake.js";
import { runCore } from "./guard-core-testkit";
import type { CoreDecision } from "./guard-dispatch.js";
import { kitContext } from "./kit-context.js";
import { WAIT_SLOT } from "./wait-text.js";

let dir: string;
let tmp: string;
let logs: string[];

interface Payload {
	session_id?: string;
	agent_id?: string;
	tool_name?: string;
	tool_input?: Record<string, unknown>;
}

type Verdict = { deny: string } | { context: string } | null;

/** `d` as the refusal or the note this core answers, thrown on any other. */
const verdict = (d: CoreDecision): Verdict => {
	if (d === null || "deny" in d || "context" in d) return d;
	throw new Error(`neither a deny nor a context: ${JSON.stringify(d)}`);
};

/** The core's decision on `payload`, over the context lib/guard-entry.js's
 * kitContext builds from it. */
const judge = (payload: Payload, over: Partial<PollContext> = {}): Verdict =>
	verdict(
		decide(payload.session_id ?? "", {
			...kitContext(
				{ root: dir, payload: { ...payload }, log: (what) => logs.push(what) },
				{ moduleOn: () => false, treeClass: fakeTreeClassifier({}) },
			),
			env: { TMPDIR: tmp },
			...buildHostPorts(),
			...over,
		}),
	);

/** The shape the guard was first built against: no tool name, no input. */
const run = (session = "s1") => judge({ session_id: session });

const runTool = (
	tool: string,
	input: Record<string, unknown>,
	session = "s1",
	agent?: string,
) =>
	judge({
		session_id: session,
		...(agent === undefined ? {} : { agent_id: agent }),
		tool_name: tool,
		tool_input: input,
	});

/** A background job's output file, in the shape the harness writes. */
const OUT = "/tmp/claude-1000/proj/sess/tasks/bw0192d7i.output";

const readOf = (file: string, session = "s1") =>
	runTool("Read", { file_path: file }, session);

const bash = (command: string, session = "s1") =>
	runTool("Bash", { command }, session);

const expectSilentAllow = (v: Verdict) => expect(v).toBeNull();

const expectDeny = (v: Verdict) => {
	expect(v).toHaveProperty("deny");
	return (v as { deny: string }).deny;
};

/** An allowed call carrying a warning, and nothing else. */
const expectWarn = (v: Verdict) => {
	expect(v).not.toHaveProperty("deny");
	expect(v).toHaveProperty("context");
	return (v as { context: string }).context;
};

const parseFirstLine = (text: string) => text.split("\n")[0];

const stateDir = () => path.join(tmp, "wfc-agent-poll");
const stateFile = (session = "s1") => path.join(stateDir(), session);

/** Nothing recorded at all — the core left without touching its state. */
const expectNotCounted = (v: Verdict) => {
	expectSilentAllow(v);
	expect(fs.existsSync(stateFile())).toBe(false);
};

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-poll-"));
	tmp = path.join(dir, "tmp");
	fs.mkdirSync(tmp);
	logs = [];
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
		expect(parseFirstLine(reason)).toMatch(/^Instead: /);
		expect(parseFirstLine(reason)).toContain(
			"node scripts/watch-artefact.js <artefact> 120",
		);
		expect(parseFirstLine(reason)).toContain("end the turn");
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
		fs.mkdirSync(stateDir(), { recursive: true });
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
		expect(fs.readdirSync(stateDir())).toEqual(["______etc_pwned"]);
	});
});

describe("it fails open, and says so (mantahostels#103 §6, mantahostels#147)", () => {
	it("allows when the state dir cannot be created", () => {
		// A file where the directory should go: mkdir -p cannot win.
		fs.writeFileSync(stateDir(), "");
		expectSilentAllow(run());
		expect(logs.join("\n")).toContain(
			`could not create ${stateDir()} — poll allowed unchecked`,
		);
	});

	it("allows when the payload carries no session_id, through the dispatcher", () => {
		const r = runCore(
			"guard-agent-poll",
			{ tool_name: "ListAgents", tool_input: {} },
			{ root: dir, env: { TMPDIR: tmp } },
		);
		expect(r.output).toBeNull();
		expect(r.logs.join("\n")).toContain(
			"no session_id in payload — poll check allowed unchecked",
		);
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
		const first = parseFirstLine(reason);
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
 * mantahostels#2590. docs/agents/guard-registry.md §Subagent dispatch and
 * docs/agents/rules/killed-background-job.txt each prescribe a two-minute
 * timed watch, and both open with a sleep.
 */
describe("the two timed watches do not spend each other's allowance (mantahostels#2590)", () => {
	const artefact = "sleep 120; wc -c .claude/tmp/review-standards-abc.md";
	const beat = "sleep 120; scripts/bg-run.sh check suite";

	/** Each timed watch's allowance, as the core's header states it: three
	 * pass silent, the fourth warns. */
	const sleepAllowance = 3;

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
		runTool("Bash", { command }, "s1", agent);

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
		expectSilentAllow(runTool("ListAgents", {}, "s1", "a1"));
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
		expect(fs.readdirSync(stateDir()).sort()).toEqual(["s1", "s1.aa1"]);
	});

	/** #1486: the key is agentKey's agent half, made a path segment. */
	it("keys a subagent by its agent half", () => {
		expectSilentAllow(sub("x/y")(lock));
		expect(fs.readdirSync(stateDir())).toEqual(["s1.ax_y"]);
	});

	/** Each branch's text on the call one past its allowance — the parent's
	 * where `agent` is absent. */
	const texts = (agent?: string) => {
		const call = (tool: string, input: Record<string, unknown>) =>
			runTool(tool, input, agent ? `s-${agent}` : "s1", agent);
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
			expect(parseFirstLine(reason)).toMatch(/^Instead: wait inside the turn/);
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
			expect(reason).not.toContain(WAIT_SLOT);
		}
	});

	/** Each branch's text, verbatim: what a session is told past each
	 * allowance, parent and subagent. */
	it("says every branch's text byte for byte", () => {
		expect({ parent: texts(), subagent: texts("a1") }).toEqual({
			parent: {
				check:
					"Timed checks under two minutes apart: more than 3 inside five minutes. This one runs; replace the next with one backgrounded `node scripts/watch-artefact.js <artefact> 120`. Act on what it says: two consecutive checks with no growth means abandon that agent and proceed without it. Meanwhile end the turn — the backgrounded watch is what wakes this session, and it cannot while a tool call of yours is in flight.",
				beat: "Timed job beats under two minutes apart: more than 3 inside five minutes. This one runs; space the next to `sleep 120` or more. Act on what it says: stop waiting only on a beat no newer than the last landing's, or on KILLED or UNKNOWN twice — then say the job is lost and proceed without it. Meanwhile end the turn — the backgrounded watch is what wakes this session, and it cannot while a tool call of yours is in flight.",
				noop: "Ending a turn is not a tool call. A no-op command like `true` re-invokes this session — which is why the loop it is meant to break keeps going. End the turn by emitting your final text with NO tool call at all, and stop: the completion notification wakes the session or, arriving mid-call, is folded into the next tool result (97%, #845), so each no-op is a full-context turn spent learning nothing.",
				read: "Instead: a subagent, one backgrounded `node scripts/watch-artefact.js <artefact> 120`; your next suite, in the foreground with `timeout: 600000`; a bg-run.sh job, `scripts/bg-run.sh wait <name>`. Then end the turn.\nRe-reading a background job's output file is a wait loop: the completion notification wakes the session or, arriving mid-call, is folded into the next tool result (97%, #845), so each re-read is a full-context turn spent for nothing.",
				agents:
					'Instead: one backgrounded `node scripts/watch-artefact.js <artefact> 120` on the subagent\'s artefact, then end the turn.\nPolling ListAgents. Two calls already in the last five minutes is the shape of a wait loop: the completion notification wakes the session or, arriving mid-call, is folded into the next tool result (97%, #845), so each poll is a full-context turn spent for nothing. Never narrate "waiting". The elapsed-time column is stale, so the poll does not read true either.',
			},
			subagent: {
				check:
					"Timed checks under two minutes apart: more than 3 inside five minutes. This one runs; then wait inside the turn — what you wait on in the foreground with `timeout: 600000`, a bg-run.sh job with `scripts/bg-run.sh wait <name>`, or the blocked operation retried directly. You are a subagent: ending your turn ends your work for good, since nothing wakes you to resume it.",
				beat: "Timed job beats under two minutes apart: more than 3 inside five minutes. This one runs; then wait inside the turn — what you wait on in the foreground with `timeout: 600000`, a bg-run.sh job with `scripts/bg-run.sh wait <name>`, or the blocked operation retried directly. You are a subagent: ending your turn ends your work for good, since nothing wakes you to resume it. Waiting on beats instead, stop waiting only on a beat no newer than the last landing's, or on KILLED or UNKNOWN twice — then say the job is lost and proceed without it.",
				noop: "Instead: wait inside the turn — what you wait on in the foreground with `timeout: 600000`, a bg-run.sh job with `scripts/bg-run.sh wait <name>`, or the blocked operation retried directly. You are a subagent: ending your turn ends your work for good, since nothing wakes you to resume it.\nA no-op like `true` waits on nothing. If your work is done, return your final report.",
				read: "Instead: wait inside the turn — what you wait on in the foreground with `timeout: 600000`, a bg-run.sh job with `scripts/bg-run.sh wait <name>`, or the blocked operation retried directly. You are a subagent: ending your turn ends your work for good, since nothing wakes you to resume it.\nRe-reading a background job's output file is a wait loop, each re-read a full-context call spent for nothing.",
				agents:
					"Instead: wait inside the turn — what you wait on in the foreground with `timeout: 600000`, a bg-run.sh job with `scripts/bg-run.sh wait <name>`, or the blocked operation retried directly. You are a subagent: ending your turn ends your work for good, since nothing wakes you to resume it.\nPolling ListAgents is a wait loop, and its elapsed-time column is stale.",
			},
		});
	});
});

describe("through the dispatcher row (#2791)", () => {
	const listAgents = (session = "s1") =>
		runCore(
			"guard-agent-poll",
			{ session_id: session, tool_name: "ListAgents", tool_input: {} },
			{ root: dir, env: { TMPDIR: tmp } },
		);

	it("counts ListAgents in the window under the env's TMPDIR, and refuses the third", () => {
		expect(listAgents().output).toBeNull();
		expect(listAgents().output).toBeNull();
		expect(listAgents().output?.permissionDecision).toBe("deny");
		expect(fs.readFileSync(stateFile(), "utf8")).toMatch(
			/^\d+\tagents\n\d+\tagents\n$/,
		);
	});

	it("counts a subagent's ListAgents in its own window, keyed by the payload's agent_id (#1169)", () => {
		const sub = () =>
			runCore(
				"guard-agent-poll",
				{
					session_id: "s1",
					agent_id: "a1",
					tool_name: "ListAgents",
					tool_input: {},
				},
				{ root: dir, env: { TMPDIR: tmp } },
			);
		expect(sub().output).toBeNull();
		expect(sub().output).toBeNull();
		const reason = sub().output?.permissionDecisionReason ?? "";
		expect(reason).toContain("You are a subagent");
		expect(fs.readdirSync(stateDir())).toEqual(["s1.aa1"]);
	});

	it("judges a Bash call its `if` clauses admit, refusing the second no-op (#3224)", () => {
		const noop = () =>
			runCore(
				"guard-agent-poll",
				{
					session_id: "s1",
					tool_name: "Bash",
					tool_input: { command: "true" },
				},
				{ root: dir, env: { TMPDIR: tmp } },
			);
		expect(noop().output).toBeNull();
		expect(noop().output?.permissionDecision).toBe("deny");
	});
});

describe("the cases a mutant must not survive (#2791)", () => {
	it("hands the warning over as context, recorded, so a fast cadence keeps warning", () => {
		for (let i = 0; i < 3; i++) bash("sleep 1; ls");
		expectWarn(bash("sleep 1; ls"));
		expect(
			fs.readFileSync(stateFile(), "utf8").trim().split("\n"),
		).toHaveLength(4);
	});

	it("reads any whitespace after `sleep` as a timed watch", () => {
		for (let i = 0; i < 3; i++) bash("sleep\t1; ls");
		expectWarn(bash("sleep\t1; ls"));
	});

	it("counts only a tasks/ directory, never one whose name merely ends in tasks", () => {
		for (let i = 0; i < 3; i++)
			expectSilentAllow(readOf("/tmp/proj/mytasks/b1.output"));
		expect(fs.existsSync(stateFile())).toBe(false);
	});

	it("counts a stamp at 299 seconds and drops one at exactly 300", () => {
		const now = Math.floor(Date.now() / 1000);
		const clock = { now: () => now };
		fs.mkdirSync(stateDir(), { recursive: true });
		fs.writeFileSync(stateFile(), `${now - 299}\tnoop\n`);
		expectDeny(
			judge(
				{
					session_id: "s1",
					tool_name: "Bash",
					tool_input: { command: "true" },
				},
				clock,
			),
		);
		fs.writeFileSync(stateFile(), `${now - 300}\tnoop\n`);
		expectSilentAllow(
			judge(
				{
					session_id: "s1",
					tool_name: "Bash",
					tool_input: { command: "true" },
				},
				clock,
			),
		);
	});

	it("reads only newline-ended lines", () => {
		const now = Math.floor(Date.now() / 1000);
		fs.mkdirSync(stateDir(), { recursive: true });
		fs.writeFileSync(stateFile(), `${now}\tnoop`);
		expectSilentAllow(bash("true"));
		expect(fs.readFileSync(stateFile(), "utf8")).toMatch(/^\d+\tnoop\n$/);
	});

	it("reads a stamp and key split by a run of tabs, tabs at either end trimmed", () => {
		const now = Math.floor(Date.now() / 1000);
		fs.mkdirSync(stateDir(), { recursive: true });
		fs.writeFileSync(stateFile(), `\t${now}\t\tnoop\t\n`);
		expectDeny(bash("true"));
	});

	it("keeps another key's stamps when it rewrites the window", () => {
		readOf(OUT);
		bash("true");
		expect(fs.readFileSync(stateFile(), "utf8")).toMatch(
			/^\d+\tread:bw0192d7i\.output\n\d+\tnoop\n$/,
		);
	});

	it("uses /tmp where TMPDIR is empty", () => {
		const seen: string[] = [];
		judge(
			{ session_id: "s1", tool_name: "ListAgents", tool_input: {} },
			{
				env: { TMPDIR: "" },
				makeDir: (d: string) => {
					seen.push(d);
					return false;
				},
			},
		);
		expect(seen).toEqual(["/tmp/wfc-agent-poll"]);
	});

	it("spells a refusal's and a warning's core paths through corePaths", () => {
		const corePaths = (t: string) => t.replaceAll("scripts/", "ROOT/");
		run();
		run();
		expect(expectDeny(judge({ session_id: "s1" }, { corePaths }))).toContain(
			"node ROOT/watch-artefact.js",
		);
		for (let i = 0; i < 3; i++) bash("sleep 1; ls");
		expect(
			expectWarn(
				judge(
					{
						session_id: "s1",
						tool_name: "Bash",
						tool_input: { command: "sleep 1; ls" },
					},
					{ corePaths },
				),
			),
		).toContain("node ROOT/watch-artefact.js");
	});

	it.skipIf(process.getuid?.() === 0)(
		"still warns where the window cannot be written, and logs the lost record",
		() => {
			for (let i = 0; i < 3; i++) bash("sleep 1; ls");
			fs.chmodSync(stateDir(), 0o500);
			try {
				expectWarn(bash("sleep 1; ls"));
			} finally {
				fs.chmodSync(stateDir(), 0o700);
			}
			expect(logs.join("\n")).toContain(
				`could not write ${stateFile()} — this call went unrecorded`,
			);
		},
	);

	it("sweeps a day-old window file on a recorded call, and leaves a fresh one and a directory", () => {
		fs.mkdirSync(path.join(stateDir(), "keep-dir"), { recursive: true });
		for (const name of ["old", "fresh"])
			fs.writeFileSync(path.join(stateDir(), name), "");
		const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000 - 60_000);
		fs.utimesSync(path.join(stateDir(), "old"), dayAgo, dayAgo);
		fs.utimesSync(path.join(stateDir(), "keep-dir"), dayAgo, dayAgo);
		run();
		expect(fs.readdirSync(stateDir()).sort()).toEqual([
			"fresh",
			"keep-dir",
			"s1",
		]);
	});

	it("does not sweep on a refusal", () => {
		run();
		run();
		fs.writeFileSync(path.join(stateDir(), "old"), "");
		const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000 - 60_000);
		fs.utimesSync(path.join(stateDir(), "old"), dayAgo, dayAgo);
		expectDeny(run());
		expect(fs.existsSync(path.join(stateDir(), "old"))).toBe(true);
	});
});
