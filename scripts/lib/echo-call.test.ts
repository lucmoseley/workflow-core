// @vitest-environment node
/*
 * lib/echo-call.js refuses a tool call that has already answered the same
 * thing twice in a row (mantahostels#2570), and lib/echo-record.js is the
 * PostToolUse core that gives it something to read (#2787).
 *
 * The verdict depends on ACCUMULATED STATE, which the recorder writes after
 * every allowed call. Each case runs a session's calls as the two halves
 * meet: the core judges the call in process, over its production ports
 * (lib/echo-call-host.js), then `record` below runs the real recorder core
 * in process through lib/guard-core-testkit.ts. The rules both run on are
 * lib/echo-chain.test.ts's. Each case gets its own TMPDIR, because that is
 * where the chain lives.
 *
 * Module cases call `decide` over the context lib/kit-context.js's kitContext
 * builds, so a store or stat port can be swapped for a failing one. The
 * dispatcher row's own cases use lib/guard-core-testkit.ts; the hook
 * line's are scripts/guard-dispatch.test.ts's.
 *
 * Both halves run on every Bash and Read call: loosen a case and a session
 * spins on a call that keeps answering the same thing; widen "same" and a
 * legitimate re-check after a change is refused.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildHostPorts } from "./echo-call-host.js";
import chain from "./echo-chain.js";
import { runCore } from "./guard-core-testkit";
import { resolveScriptPaths } from "./script-path.js";

/* Required with casts, not imported (#3145): `kitContext` is handed empty
 * readers its checked type refuses, and `decide`'s `CoreDecision` is narrowed
 * to the deny this core returns. Residual: the cast's types are hand-written,
 * so nothing checks them against the module. */
const core = require("./echo-call.js") as {
	decide: (
		session: string,
		ctx: Record<string, unknown>,
	) => { deny: string } | null;
};
const { kitContext } = require("./kit-context.js") as {
	kitContext: (
		env: {
			root: string;
			payload: Record<string, unknown>;
			log: (what: string) => void;
		},
		readers: Record<string, unknown>,
	) => Record<string, unknown>;
};

let dir: string;
let tmp: string;
let logs: string[];

interface Payload {
	session_id?: string;
	agent_id?: string;
	tool_name?: string;
	tool_input?: Record<string, unknown>;
	tool_response?: unknown;
}

/** The core's decision on `payload`, over the context lib/guard-entry.js's
 * kitContext builds from it, as the dispatcher composes it. */
const judge = (payload: Payload, over: Record<string, unknown> = {}) =>
	core.decide(payload.session_id ?? "", {
		...kitContext(
			{ root: dir, payload: { ...payload }, log: (what) => logs.push(what) },
			{},
		),
		corePaths: resolveScriptPaths,
		...buildHostPorts(dir, (what) => logs.push(what)),
		...over,
	});

/**
 * The real recorder on one completed call, as PostToolUse runs it. Its output
 * is context handed to the session on every Bash and Read call, so each run
 * asserts it silent.
 */
const record = (payload: Payload) => {
	const r = runCore(
		"record-tool-echo",
		{ ...payload },
		{ root: dir, event: "PostToolUse" },
	);
	expect(r.output).toBeNull();
	logs.push(...r.logs);
};

/** One completed call: the core judges it, then the recorder records it. */
const call = (
	input: Record<string, unknown>,
	response: unknown,
	opts: { tool?: string; session?: string; agent?: string } = {},
) => {
	const base: Payload = {
		session_id: opts.session ?? "s1",
		...(opts.agent === undefined ? {} : { agent_id: opts.agent }),
		tool_name: opts.tool ?? "Bash",
		tool_input: input,
	};
	const verdict = judge(base);
	// A denied call never runs, so nothing answers and the recorder never fires.
	if (!verdict) record({ ...base, tool_response: response });
	return verdict;
};

const expectSilentAllow = (v: { deny: string } | null) => expect(v).toBeNull();

const expectDeny = (v: { deny: string } | null) => {
	expect(v).toHaveProperty("deny");
	return (v as { deny: string }).deny;
};

const stateFile = (session = "s1", agent = "main") =>
	path.join(tmp, "wfc-echo-chain", `${session}.${agent}`);

const SAME = { stdout: "1 passed", stderr: "", interrupted: false };
const LS = { command: "ls" };

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "echo-call-"));
	tmp = path.join(dir, "tmp");
	fs.mkdirSync(tmp);
	logs = [];
	vi.stubEnv("TMPDIR", tmp);
});

afterEach(() => {
	vi.unstubAllEnvs();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("the chain", () => {
	it("passes two identical answers and denies the third call", () => {
		expectSilentAllow(call(LS, SAME));
		expectSilentAllow(call(LS, SAME));
		expectDeny(call(LS, SAME));
	});

	it("never fires on a first call, however long the session runs", () => {
		for (let i = 0; i < 5; i++)
			expectSilentAllow(call({ command: `echo ${i}` }, { stdout: `${i}` }));
	});

	it("resets on a differing answer", () => {
		call(LS, SAME);
		call(LS, { stdout: "2 passed" });
		expectSilentAllow(call(LS, SAME));
	});

	it("counts a run, not a total: one A after A A B is not the third A", () => {
		call(LS, SAME);
		call(LS, SAME);
		call(LS, { stdout: "changed" });
		expectSilentAllow(call(LS, SAME));
		// And the run that follows the interruption arms on its own two.
		call(LS, SAME);
		expectDeny(call(LS, SAME));
	});

	it("clears the chain on the deny, so the identical call passes next time", () => {
		call(LS, SAME);
		call(LS, SAME);
		expectDeny(call(LS, SAME));
		expectSilentAllow(call(LS, SAME));
	});

	/* Read back through bash, not through JS: JS `split("\t")` does not collapse
	 * adjacent tabs, so a JS assertion on the field count passes on exactly the
	 * record shape this is guarding against. */
	it("keeps a cleared record readable — an empty field would shift the columns", () => {
		call(LS, SAME);
		call(LS, SAME);
		expectDeny(call(LS, SAME));
		const parsed = spawnSync(
			"bash",
			[
				"-c",
				`while IFS=$'\\t' read -r s h r t d; do printf '%s|%s|%s\\n' "$h" "$r" "$d"; done < "$1"`,
				"_",
				stateFile(),
			],
			{ encoding: "utf8" },
		);
		const lines = (parsed.stdout ?? "").trim().split("\n").filter(Boolean);
		expect(lines).toEqual(["-|0|1"]);
	});

	it("escalates: the second refusal on a call does not clear its chain", () => {
		call(LS, SAME);
		call(LS, SAME);
		expectDeny(call(LS, SAME)); // first refusal — chain cleared
		call(LS, SAME);
		call(LS, SAME);
		expectDeny(call(LS, SAME)); // second refusal — chain left armed
		expectDeny(call(LS, SAME));
		expectDeny(call(LS, SAME));
	});

	it("still lets a VARIED command through after the escalation", () => {
		for (let i = 0; i < 8; i++) call(LS, SAME);
		expectSilentAllow(call({ command: "ls -l" }, SAME));
	});
});

/*
 * mantahostels#2616. The two fixtures below are REAL payloads, captured by
 * dumping the hook payload on PostToolUse while reading one unchanged file
 * twice. To re-capture: add a line to lib/echo-record.js's decide dumping
 * ctx.input and ctx.response to a file, Read one file twice through the tool,
 * then remove the line. Only the captured file's PATH is rewritten below, to a
 * repo-neutral one; every other byte is as the harness sent it. Two facts they
 * settle:
 *
 *   * PostToolUse DOES fire on a short-circuited Read, so the Read limb arms.
 *   * The short-circuit response is a DIFFERENT SHAPE from the real read's —
 *     `type: "file_unchanged"` with no `content`, which would reset the chain
 *     had the recorder not folded it in by name (#1090).
 */
const READ_INPUT = { file_path: "/repo/.claude/tmp/echo-target.txt" };

const READ_FIRST = {
	type: "text",
	file: {
		filePath: "/repo/.claude/tmp/echo-target.txt",
		content: "alpha\nbeta\ngamma\n",
		numLines: 4,
		startLine: 1,
		totalLines: 4,
	},
};

const READ_UNCHANGED = {
	type: "file_unchanged",
	file: { filePath: "/repo/.claude/tmp/echo-target.txt" },
};

describe("what counts as the same call", () => {
	it("separates two different commands", () => {
		call({ command: "a" }, SAME);
		call({ command: "a" }, SAME);
		expectSilentAllow(call({ command: "b" }, SAME));
	});

	it("separates the same bytes read through a different tool", () => {
		call({ command: "x" }, SAME);
		call({ command: "x" }, SAME);
		expectSilentAllow(call({ command: "x" }, SAME, { tool: "Read" }));
	});

	it("separates two sessions", () => {
		call(LS, SAME);
		call(LS, SAME);
		expectSilentAllow(call(LS, SAME, { session: "s2" }));
	});

	/* A subagent's payload carries its parent's session_id and an agent_id of
	 * its own, on PostToolUse as on PreToolUse (hooks reference, "Common input
	 * fields"), #1004. */
	it("separates the parent and each subagent under one session", () => {
		const read = (agent?: string) =>
			call(READ_INPUT, READ_FIRST, { tool: "Read", agent });
		expectSilentAllow(read());
		expectSilentAllow(read("sibling"));
		expectSilentAllow(read("late"));
	});

	it("still refuses one agent's own third identical call, parent or subagent", () => {
		for (const agent of [undefined, "sub"]) {
			expectSilentAllow(call(LS, SAME, { agent }));
			expectSilentAllow(call(LS, SAME, { agent }));
			expectDeny(call(LS, SAME, { agent }));
		}
	});

	it("reads an empty agent_id as the parent, as the latch key does", () => {
		call(LS, SAME);
		call(LS, SAME);
		expectDeny(call(LS, SAME, { agent: "" }));
		// And the recorder files an empty agent_id's answers where the guard looks.
		call(LS, SAME, { agent: "" });
		call(LS, SAME, { agent: "" });
		expectDeny(call(LS, SAME));
	});

	it("ignores field order in the input", () => {
		call({ command: "y", description: "d" }, SAME);
		call({ description: "d", command: "y" }, SAME);
		expectDeny(call({ command: "y", description: "d" }, SAME));
	});

	it("leaves lib/agent-poll.js's two shapes alone — the timed beat and the no-op", () => {
		for (const command of ["sleep 595; echo tick", "true", "  :  "]) {
			call({ command }, SAME);
			call({ command }, SAME);
			expectSilentAllow(call({ command }, SAME));
		}
	});

	it("does not mistake a Read whose path merely starts with sleep", () => {
		const input = { file_path: "/tmp/sleep 600" };
		call(input, SAME, { tool: "Read" });
		call(input, SAME, { tool: "Read" });
		expectDeny(call(input, SAME, { tool: "Read" }));
	});

	it("leaves every tool but Bash and Read alone — ListAgents is lib/agent-poll.js's", () => {
		for (const tool of ["ListAgents", "Edit", "Grep"]) {
			call(LS, SAME, { tool });
			call(LS, SAME, { tool });
			expectSilentAllow(call(LS, SAME, { tool }));
		}
	});
});

describe("the Read short-circuit, on payloads captured at mantahostels#2616", () => {
	const read = (response: unknown) =>
		call(READ_INPUT, response, { tool: "Read" });

	it("refuses the THIRD call on an unchanged file, as on Bash", () => {
		expectSilentAllow(read(READ_FIRST));
		expectSilentAllow(read(READ_UNCHANGED));
		expectDeny(read(READ_UNCHANGED));
	});

	it("folds after a refusal cleared the chain, refusing again on the third", () => {
		expectSilentAllow(read(READ_FIRST));
		expectSilentAllow(read(READ_UNCHANGED));
		expectDeny(read(READ_UNCHANGED));
		expectSilentAllow(read(READ_UNCHANGED));
		expectSilentAllow(read(READ_UNCHANGED));
		expectDeny(read(READ_UNCHANGED));
	});
});

/* #1058: a Read signs the file's on-disk state as well as its input. */
describe("a Read of a file rewritten since its last reads", () => {
	const target = () => path.join(dir, "shot.png");
	const read = () =>
		call({ file_path: target() }, READ_UNCHANGED, { tool: "Read" });
	const armed = () => {
		fs.writeFileSync(target(), "v1");
		expectSilentAllow(read());
		expectSilentAllow(read());
	};

	it("still refuses the third identical read of a file nobody touched", () => {
		armed();
		expectDeny(read());
	});

	it("lands the refusal on the third call after a real first read", () => {
		fs.writeFileSync(target(), "v1");
		const real = (response: unknown) =>
			call({ file_path: target() }, response, { tool: "Read" });
		expectSilentAllow(real(READ_FIRST));
		expectSilentAllow(real(READ_UNCHANGED));
		expectDeny(real(READ_UNCHANGED));
	});

	it("signs a missing file on its input alone", () => {
		const missing = { file_path: path.join(dir, "absent.png") };
		call(missing, READ_UNCHANGED, { tool: "Read" });
		call(missing, READ_UNCHANGED, { tool: "Read" });
		expectDeny(call(missing, READ_UNCHANGED, { tool: "Read" }));
		expect(logs).toEqual([]);
	});

	it("is allowed when the file read through a symlink was rewritten", () => {
		fs.writeFileSync(target(), "v1");
		const link = path.join(dir, "link.png");
		fs.symlinkSync(target(), link);
		const viaLink = () =>
			call({ file_path: link }, READ_UNCHANGED, { tool: "Read" });
		viaLink();
		viaLink();
		fs.writeFileSync(target(), "v2");
		expectSilentAllow(viaLink());
	});

	it("is allowed when the rewrite changed only the mtime, not the size", () => {
		armed();
		fs.writeFileSync(target(), "v2");
		const later = new Date(Date.now() + 5000);
		fs.utimesSync(target(), later, later);
		expectSilentAllow(read());
	});

	it("is allowed when a rename replaced the file, as a generator does", () => {
		// One whole-second mtime on both, so only the inode tells them apart.
		const at = new Date(1_700_000_000_000);
		armed();
		fs.utimesSync(target(), at, at);
		expectSilentAllow(read());
		expectSilentAllow(read());
		const staged = path.join(dir, "shot.tmp");
		fs.writeFileSync(staged, "v1");
		fs.utimesSync(staged, at, at);
		fs.renameSync(staged, target());
		expectSilentAllow(read());
	});
});

describe("hygiene", () => {
	it("forgets a record older than the age bound", () => {
		call(LS, SAME);
		call(LS, SAME);
		const stale = fs
			.readFileSync(stateFile(), "utf8")
			.trim()
			.split("\n")
			.map((l) => {
				const f = l.split("\t");
				f[3] = String(Number(f[3]) - 7200);
				return f.join("\t");
			})
			.join("\n");
		fs.writeFileSync(stateFile(), `${stale}\n`);
		expectSilentAllow(call(LS, SAME));
		// The recorder drops it too, so the next identical call starts a run of one.
		expectSilentAllow(call(LS, SAME));
	});

	it("takes over a crashed holder's `<file>.dlock`, the lock it shares with the recorder, and leaves none", () => {
		call(LS, SAME);
		call(LS, SAME);
		const lock = `${stateFile()}.dlock`;
		fs.mkdirSync(lock);
		const old = Date.now() / 1000 - 60;
		fs.utimesSync(lock, old, old);
		// A denied call runs no recorder, so only the guard's clear can take it.
		expectDeny(call(LS, SAME));
		expect(fs.existsSync(lock)).toBe(false);
		expectSilentAllow(call(LS, SAME));
	});

	it("writes nothing inside the repo", () => {
		call(LS, SAME);
		expect(fs.existsSync(stateFile())).toBe(true);
		expect(stateFile().startsWith(tmp)).toBe(true);
	});
});

describe("the deny", () => {
	it("tells the session what to do instead", () => {
		call(LS, SAME);
		call(LS, SAME);
		const reason = expectDeny(call(LS, SAME));
		expect(reason).toContain("END THE TURN");
		expect(reason).toContain("VARY THE COMMAND");
	});

	it("tells the parent why ending the turn loses nothing, in lib/agent-poll.js's words (#1779)", () => {
		call(LS, SAME);
		call(LS, SAME);
		expect(expectDeny(call(LS, SAME))).toContain(
			"END THE TURN — the completion notification wakes the session or, arriving mid-call, is folded into the next tool result (97%, #845), so a repeat buys nothing.",
		);
	});

	/* #1732: a subagent's turn ending is its work ending, so it is told to wait
	 * inside the turn, in lib/agent-poll.js's words (#1169, #1735). */
	it("tells a subagent to wait inside its turn, never to end it", () => {
		call(LS, SAME, { agent: "sub1" });
		call(LS, SAME, { agent: "sub1" });
		const reason = expectDeny(call(LS, SAME, { agent: "sub1" }));
		expect(reason).toContain("wait inside the turn");
		expect(reason).toContain("ends your work for good");
		expect(reason).toContain("timeout: 600000");
		expect(reason).toContain("scripts/bg-run.sh wait <name>");
		expect(reason).toContain("retried directly");
		expect(reason).not.toContain("END THE TURN");
		expect(reason).toContain("VARY THE COMMAND");
	});
});

describe("fail-open, on the record", () => {
	it.skipIf(process.getuid?.() === 0)(
		"allows rather than denying forever when the reset cannot be written",
		() => {
			call(LS, SAME);
			call(LS, SAME);
			const chainDir = path.dirname(stateFile());
			fs.chmodSync(chainDir, 0o500);
			try {
				expectSilentAllow(
					judge({ session_id: "s1", tool_name: "Bash", tool_input: LS }),
				);
				expect(logs.join("\n")).toContain(
					"could not record the refusal — repeat allowed unchecked",
				);
			} finally {
				fs.chmodSync(chainDir, 0o700);
			}
		},
	);

	it("allows on a payload carrying no session at all, through the dispatcher", () => {
		const r = runCore(
			"guard-echo-call",
			{ tool_name: "Bash", tool_input: LS },
			{ root: dir },
		);
		expect(r.output).toBeNull();
		expect(r.logs.join("\n")).toContain(
			"no session_id in payload — repeat check allowed unchecked",
		);
	});
});

describe("through the dispatcher row (#2791)", () => {
	it("refuses the third identical Bash call off the recorder's store, under the env's TMPDIR", () => {
		const base = { session_id: "s1", tool_name: "Bash", tool_input: LS };
		const viaRow = () => runCore("guard-echo-call", base, { root: dir });
		for (let i = 0; i < 2; i++) {
			expect(viaRow().output).toBeNull();
			record({ ...base, tool_response: SAME });
		}
		const out = viaRow().output;
		expect(out?.permissionDecision).toBe("deny");
		expect(out?.permissionDecisionReason).toContain("VARY THE COMMAND");
	});

	it("keys a subagent's chain by the payload's agent_id, and tells it to wait in the turn (#1004, #1732)", () => {
		const base = {
			session_id: "s1",
			agent_id: "sub1",
			tool_name: "Bash",
			tool_input: LS,
		};
		const viaRow = () => runCore("guard-echo-call", base, { root: dir });
		for (let i = 0; i < 2; i++) {
			expect(viaRow().output).toBeNull();
			record({ ...base, tool_response: SAME });
		}
		expect(fs.existsSync(stateFile("s1", "asub1"))).toBe(true);
		expect(fs.existsSync(stateFile())).toBe(false);
		const reason = viaRow().output?.permissionDecisionReason ?? "";
		expect(reason).toContain("You are a subagent");
		expect(reason).not.toContain("END THE TURN");
	});
});

describe("the cases a mutant must not survive (#2791)", () => {
	/** A store holding one live record for LS, at run `run` with `denies`. */
	const seeded = (run: number, denies: number) => {
		call(LS, SAME);
		const [sig] = fs.readFileSync(stateFile(), "utf8").split("\t");
		const now = Math.floor(Date.now() / 1000);
		fs.writeFileSync(stateFile(), `${sig}\th\t${run}\t${now}\t${denies}\n`);
		return sig;
	};

	/* The recorder skips the same calls, so only a store armed by hand shows
	 * the core's own filter at work. */
	it("leaves a neighbour's shapes and other tools alone even on an armed chain", () => {
		const now = Math.floor(Date.now() / 1000);
		const arm = (tool: string, input: Record<string, unknown>) => {
			fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
			fs.writeFileSync(
				stateFile(),
				`${chain.signature(tool, input, null)}\th\t2\t${now}\t0\n`,
			);
			return judge({ session_id: "s1", tool_name: tool, tool_input: input });
		};
		expectSilentAllow(arm("Bash", { command: "sleep 5; ls" }));
		expectSilentAllow(arm("Bash", { command: "true" }));
		expectSilentAllow(arm("ListAgents", LS));
		expectDeny(arm("Bash", LS));
	});

	/** The refusal, verbatim: what the parent and a subagent are told. */
	it("says the refusal byte for byte, parent and subagent", () => {
		const said = (agent?: string) => {
			call(LS, SAME, { agent });
			call(LS, SAME, { agent });
			return expectDeny(call(LS, SAME, { agent }));
		};
		expect(said()).toBe(
			"This exact call has already run twice in a row and given the same answer both times — for a Read, the file unchanged since you last read it — so a third run is very unlikely to say anything new.\n\nIf you are waiting on a background job or a subagent: END THE TURN — the completion notification wakes the session or, arriving mid-call, is folded into the next tool result (97%, #845), so a repeat buys nothing. Say in one line what you are waiting for, then stop producing output.\n\nIf you genuinely need this again — the state it reads has changed since — VARY THE COMMAND and it will not match. The first refusal on a call clears its chain and lets the identical call through once more, but a second refusal on the same call does not, and from there only a varied command runs.",
		);
		expect(said("a1")).toBe(
			"This exact call has already run twice in a row and given the same answer both times — for a Read, the file unchanged since you last read it — so a third run is very unlikely to say anything new.\n\nIf you are waiting on a background job, wait inside the turn — what you wait on in the foreground with `timeout: 600000`, a bg-run.sh job with `scripts/bg-run.sh wait <name>`, or the blocked operation retried directly. You are a subagent: ending your turn ends your work for good, since nothing wakes you to resume it.\n\nIf you genuinely need this again — the state it reads has changed since — VARY THE COMMAND and it will not match. The first refusal on a call clears its chain and lets the identical call through once more, but a second refusal on the same call does not, and from there only a varied command runs.",
		);
	});

	it("allows at run 1, refuses at run 2", () => {
		seeded(1, 0);
		expectSilentAllow(
			judge({ session_id: "s1", tool_name: "Bash", tool_input: LS }),
		);
		seeded(2, 0);
		expectDeny(judge({ session_id: "s1", tool_name: "Bash", tool_input: LS }));
	});

	it("writes the cleared record on a first refusal and the armed one on a second", () => {
		const sig = seeded(2, 0);
		judge({ session_id: "s1", tool_name: "Bash", tool_input: LS });
		expect(fs.readFileSync(stateFile(), "utf8")).toMatch(
			new RegExp(`^${sig}\\t-\\t0\\t\\d+\\t1\\n$`),
		);
		seeded(2, 1);
		judge({ session_id: "s1", tool_name: "Bash", tool_input: LS });
		expect(fs.readFileSync(stateFile(), "utf8")).toMatch(
			new RegExp(`^${sig}\\th\\t2\\t\\d+\\t2\\n$`),
		);
	});

	it("allows, logged, where the escalated refusal cannot be recorded", () => {
		seeded(2, 1);
		expectSilentAllow(
			judge(
				{ session_id: "s1", tool_name: "Bash", tool_input: LS },
				{ chain: () => false },
			),
		);
		expect(logs).toContain(
			"could not record the refusal — repeat allowed unchecked",
		);
	});

	it("allows, logged, where the store will not read", () => {
		expectSilentAllow(
			judge(
				{ session_id: "s1", tool_name: "Bash", tool_input: LS },
				{ readChain: () => null },
			),
		);
		expect(logs).toContain(
			"could not read the chain store — repeat allowed unchecked",
		);
	});

	it("signs a Read on its input alone where its file will not stat", () => {
		const input = { file_path: path.join(dir, "f") };
		fs.writeFileSync(input.file_path, "x");
		const now = Math.floor(Date.now() / 1000);
		fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
		fs.writeFileSync(
			stateFile(),
			`${chain.signature("Read", input, null)}\th\t2\t${now}\t0\n`,
		);
		const base = { session_id: "s1", tool_name: "Read", tool_input: input };
		expectSilentAllow(judge(base));
		expectDeny(judge(base, { fileState: () => null }));
	});

	it("spells the refusal's core paths through corePaths", () => {
		call(LS, SAME, { agent: "s" });
		call(LS, SAME, { agent: "s" });
		expect(
			expectDeny(
				judge(
					{
						session_id: "s1",
						agent_id: "s",
						tool_name: "Bash",
						tool_input: LS,
					},
					{ corePaths: (t: string) => t.replaceAll("scripts/", "ROOT/") },
				),
			),
		).toContain("ROOT/bg-run.sh wait <name>");
	});

	it("reads the chain named by the segmented session and the agent", () => {
		const seen: string[] = [];
		judge(
			{ session_id: "s/1", tool_name: "Bash", tool_input: LS },
			{
				readChain: (name: string) => {
					seen.push(name);
					return "";
				},
			},
		);
		expect(seen).toEqual(["s_1.main"]);
	});
});
