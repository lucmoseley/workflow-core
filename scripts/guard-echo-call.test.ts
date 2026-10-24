// @vitest-environment node
/*
 * guard-echo-call.sh refuses a tool call that has already answered the same
 * thing twice in a row (mantahostels#2570), and record-tool-echo.sh is the PostToolUse half
 * that gives it something to read.
 *
 * Like guard-agent-poll.test.ts, the verdict depends on ACCUMULATED STATE, so
 * guard-log-fixture.ts's single stateless payload cannot drive it and the
 * fail-open cases are carried here. Every case gets its own TMPDIR, because that
 * is where the chain lives, and its own CLAUDE_CONFIG_DIR, because a fail-open
 * is recorded (mantahostels#147) and an unset config dir would append to the founder's real
 * log.
 *
 * Both halves run on every Bash and Read call (`PreToolUse` and `PostToolUse`
 * in `self-plugin/hooks/hooks.json` and `hooks/hooks.json`): loosen a case and
 * a session spins on a call that keeps answering the same thing; widen "same"
 * and a legitimate re-check after a change is refused.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyLibs, sourcedLibs } from "./guard-parse-fixture";

const GUARD = path.resolve(__dirname, "guard-echo-call.sh");
const RECORDER = path.resolve(__dirname, "record-tool-echo.sh");

let dir: string;
let tmp: string;
let config: string;

interface Payload {
	session_id?: string;
	agent_id?: string;
	tool_name?: string;
	tool_input?: Record<string, unknown>;
	tool_response?: unknown;
}

const drive = (
	script: string,
	payload: Payload,
	opts: { pathPrefix?: string; env?: Record<string, string> } = {},
) => {
	const r = spawnSync(script, [], {
		encoding: "utf8",
		input: JSON.stringify(payload),
		env: {
			...process.env,
			// Cleared, not inherited: the founder's own shell setting this would
			// turn the recorder off and leave every case below passing vacuously.
			WFC_NO_ECHO_CHAIN: "",
			TMPDIR: tmp,
			CLAUDE_CONFIG_DIR: config,
			...(opts.pathPrefix
				? { PATH: `${opts.pathPrefix}:${process.env.PATH}` }
				: {}),
			...(opts.env ?? {}),
		},
	});
	if (r.status === null) throw new Error(`${script} did not run: ${r.error}`);
	return r;
};

/** One completed call: the guard judges it, then the recorder records it. */
const call = (
	input: Record<string, unknown>,
	response: unknown,
	opts: {
		tool?: string;
		session?: string;
		agent?: string;
		env?: Record<string, string>;
	} = {},
) => {
	const base = {
		session_id: opts.session ?? "s1",
		...(opts.agent === undefined ? {} : { agent_id: opts.agent }),
		tool_name: opts.tool ?? "Bash",
		tool_input: input,
	};
	const verdict = drive(GUARD, base, { env: opts.env });
	// A denied call never runs, so nothing answers and the recorder never fires.
	if (!denied(verdict)) {
		const rec = drive(
			RECORDER,
			{ ...base, tool_response: response },
			{ env: opts.env },
		);
		// A PostToolUse hook's stdout is context handed to the session, on EVERY
		// Bash and Read call. Asserted here rather than in a case of its own so
		// no path through this file can leave it unchecked.
		expect(rec.stdout ?? "").toBe("");
		expect(rec.stderr ?? "").toBe("");
	}
	return verdict;
};

const denied = (r: ReturnType<typeof drive>) =>
	(r.stdout ?? "").includes('"deny"');

/*
 * A guard that CRASHES also emits no verdict, so an allow alone would pass
 * whether the line failed open or the script died.
 */
const expectSilentAllow = (r: ReturnType<typeof drive>) => {
	expect(r.status).toBe(0);
	expect(r.stdout ?? "").toBe("");
	expect(r.stderr ?? "").toBe("");
};

const expectDeny = (r: ReturnType<typeof drive>) => {
	const out = JSON.parse(r.stdout);
	expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
	expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
	return out.hookSpecificOutput.permissionDecisionReason as string;
};

const stateFile = (session = "s1", agent = "main") =>
	path.join(tmp, "wfc-echo-chain", `${session}.${agent}`);

/** A stub binary earlier on PATH than the real one. */
const stub = (name: string, body: string) => {
	const at = path.join(dir, `stub-${name}`);
	fs.mkdirSync(at, { recursive: true });
	fs.writeFileSync(path.join(at, name), `#!/bin/sh\n${body}\n`);
	fs.chmodSync(path.join(at, name), 0o755);
	return at;
};

/** A copy of a script whose lib/ can be tampered with. */
const detach = (script: string) => {
	const at = path.join(dir, `detached-${path.basename(script)}`);
	copyLibs(path.join(at, "lib"), sourcedLibs(script));
	const copy = path.join(at, path.basename(script));
	fs.copyFileSync(script, copy);
	fs.chmodSync(copy, 0o755);
	return { at, script: copy };
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

const SAME = { stdout: "1 passed", stderr: "", interrupted: false };
const LS = { command: "ls" };

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-echo-call-"));
	tmp = path.join(dir, "tmp");
	config = path.join(dir, "claude-config");
	fs.mkdirSync(tmp);
});

afterEach(() => {
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
		for (const line of (parsed.stdout ?? "").trim().split("\n").filter(Boolean))
			expect(line.split("|").filter(Boolean)).toHaveLength(3);
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
	});

	it("keeps a subagent's chain in a file of its own, sanitised", () => {
		call(LS, SAME, { agent: "../x y" });
		expect(fs.existsSync(stateFile("s1", "a___x_y"))).toBe(true);
	});

	it("ignores field order in the input", () => {
		call({ command: "y", description: "d" }, SAME);
		call({ description: "d", command: "y" }, SAME);
		expectDeny(call({ command: "y", description: "d" }, SAME));
	});

	it("leaves guard-agent-poll.sh's two shapes alone — the timed beat and the no-op", () => {
		for (const command of ["sleep 595; echo tick", "true", "  :  "]) {
			call({ command }, SAME);
			call({ command }, SAME);
			expectSilentAllow(call({ command }, SAME));
		}
		expect(fs.existsSync(stateFile())).toBe(false);
	});

	it("does not mistake a Read whose path merely starts with sleep", () => {
		const input = { file_path: "/tmp/sleep 600" };
		call(input, SAME, { tool: "Read" });
		call(input, SAME, { tool: "Read" });
		expectDeny(call(input, SAME, { tool: "Read" }));
	});

	it("leaves every tool but Bash and Read alone — ListAgents is guard-agent-poll.sh's", () => {
		for (const tool of ["ListAgents", "Edit", "Grep"]) {
			call(LS, SAME, { tool });
			call(LS, SAME, { tool });
			expectSilentAllow(call(LS, SAME, { tool }));
		}
		expect(fs.existsSync(stateFile())).toBe(false);
	});
});

describe("the response projection", () => {
	it("ignores a volatile field", () => {
		call(LS, { stdout: "ok", durationMs: 11 });
		call(LS, { stdout: "ok", durationMs: 22 });
		expectDeny(call(LS, { stdout: "ok", durationMs: 33 }));
	});

	it("still reads a real change under a volatile field", () => {
		call(LS, { stdout: "ok", durationMs: 11 });
		call(LS, { stdout: "different", durationMs: 22 });
		expectSilentAllow(call(LS, { stdout: "ok", durationMs: 33 }));
	});

	it("reads a plain string response", () => {
		call(LS, "same text");
		call(LS, "same text");
		expectDeny(call(LS, "same text"));
	});

	it("counts an EMPTY response", () => {
		call(LS, "");
		call(LS, "");
		expectDeny(call(LS, ""));
	});

	it("treats a MISSING response as no evidence, never as an empty one", () => {
		const base = { session_id: "s1", tool_name: "Bash", tool_input: LS };
		drive(RECORDER, base);
		drive(RECORDER, base);
		drive(RECORDER, base);
		expectSilentAllow(drive(GUARD, base));
	});
});

/*
 * mantahostels#2616. The two fixtures below are REAL payloads, captured by dumping
 * `_gp_payload` from record-tool-echo.sh while reading one unchanged file
 * twice. To re-capture: add a line to that script after `gp_begin` dumping
 * `$_gp_payload` to a file, Read one file twice through the tool, then remove
 * the line. Only the captured file's PATH is rewritten below, to a repo-neutral
 * one; every other byte is as the harness sent it. Two facts they settle:
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

describe("the Read short-circuit, on payloads captured at mantahostels#2616", () => {
	const read = (response: unknown) =>
		call(READ_INPUT, response, { tool: "Read" });

	it("refuses the THIRD call on an unchanged file, as on Bash", () => {
		expectSilentAllow(read(READ_FIRST));
		expectSilentAllow(read(READ_UNCHANGED));
		expectDeny(read(READ_UNCHANGED));
	});

	it("folds only the short circuit: a full read with new content resets", () => {
		expectSilentAllow(read(READ_FIRST));
		expectSilentAllow(
			read({ ...READ_FIRST, file: { ...READ_FIRST.file, content: "delta\n" } }),
		);
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

	it("does not fold a Bash response that happens to carry the same type", () => {
		call(LS, READ_FIRST);
		call(LS, READ_UNCHANGED);
		expectSilentAllow(call(LS, READ_UNCHANGED));
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
		expect(logged()).toBe("");
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
	});

	it("does not grow without bound", () => {
		// Seeded directly in ec_store's own tab format (sig/hash/run/t/denies,
		// scripts/lib/echo-chain.sh) rather than driven through 259 real
		// calls: ec_store's cap (EC_MAX_LINES) applies to
		// however the file got long, and the seed only needs to BE 259 distinct,
		// unexpired records — one real call still exercises the trim itself.
		// EC_MAX_LINES=200, so 259 seeded + 1 real = 260 must trim to exactly
		// 200, keeping the real one.
		fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
		const now = Math.floor(Date.now() / 1000);
		const seeded = Array.from(
			{ length: 259 },
			(_, i) => `preseed${i}\thash${i}\t1\t${now}\t0`,
		).join("\n");
		fs.writeFileSync(stateFile(), `${seeded}\n`);
		call({ command: "c259" }, SAME);
		const lines = fs
			.readFileSync(stateFile(), "utf8")
			.trim()
			.split("\n")
			.filter(Boolean);
		expect(lines.length).toBe(200);
		expect(lines.at(-1)?.startsWith("preseed")).toBe(false);
	});

	it("writes nothing inside the repo", () => {
		call(LS, SAME);
		expect(fs.existsSync(stateFile())).toBe(true);
		expect(stateFile().startsWith(tmp)).toBe(true);
	});
});

describe("the recorder's off switch", () => {
	it("records nothing under WFC_NO_ECHO_CHAIN=1, so the guard never fires", () => {
		const env = { WFC_NO_ECHO_CHAIN: "1" };
		call(LS, SAME, { env });
		call(LS, SAME, { env });
		expectSilentAllow(call(LS, SAME, { env }));
		expect(fs.existsSync(stateFile())).toBe(false);
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

	it("tells the parent why ending the turn loses nothing, in guard-agent-poll.sh's words (#1779)", () => {
		call(LS, SAME);
		call(LS, SAME);
		expect(expectDeny(call(LS, SAME))).toContain(
			"END THE TURN — the completion notification wakes the session or, arriving mid-call, is folded into the next tool result (97%, #845), so a repeat buys nothing.",
		);
	});

	/* #1732: a subagent's turn ending is its work ending, so it is told to wait
	 * inside the turn, in guard-agent-poll.sh's words (#1169, #1735). */
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
	it("allows rather than denying forever when the reset cannot be written", () => {
		call(LS, SAME);
		call(LS, SAME);
		const chainDir = path.dirname(stateFile());
		fs.chmodSync(chainDir, 0o500);
		try {
			const r = drive(GUARD, {
				session_id: "s1",
				tool_name: "Bash",
				tool_input: LS,
			});
			expect(r.stdout ?? "").toBe("");
			expect(logged()).toContain("could not clear the chain");
		} finally {
			fs.chmodSync(chainDir, 0o700);
		}
	});

	it("records the recorder's own faults, not only the guard's", () => {
		const r = drive(
			RECORDER,
			{
				session_id: "s1",
				tool_name: "Bash",
				tool_input: LS,
				tool_response: SAME,
			},
			{ pathPrefix: stub("sha1sum", "exit 127") },
		);
		expect(r.status).toBe(0);
		expect(logged()).toContain("no echo chain recorded");
	});

	/* A jq that EXISTS and fails is the shape a stub can make; `command -v jq`
	 * finds it, so the fault surfaces one step later as a payload that will not
	 * parse. */
	it("allows and records when jq is broken", () => {
		call(LS, SAME);
		call(LS, SAME);
		const r = drive(
			GUARD,
			{ session_id: "s1", tool_name: "Bash", tool_input: LS },
			{ pathPrefix: stub("jq", "exit 127") },
		);
		expect(r.status).toBe(0);
		expect(r.stdout ?? "").toBe("");
		expect(logged()).toContain("allowed unchecked");
	});

	it("allows and records when sha1sum is broken", () => {
		call(LS, SAME);
		call(LS, SAME);
		const r = drive(
			GUARD,
			{ session_id: "s1", tool_name: "Bash", tool_input: LS },
			{ pathPrefix: stub("sha1sum", "exit 127") },
		);
		expect(r.status).toBe(0);
		expect(r.stdout ?? "").toBe("");
		expect(logged()).toContain("could not hash the call");
	});

	it("allows and records when lib/echo-chain.sh will not load", () => {
		for (const script of [GUARD, RECORDER]) {
			const d = detach(script);
			// Emptied, not made to fail: `source` runs the file in this shell, so
			// a lib containing `exit 1` would take the guard's own exit code with
			// it and prove nothing about the missing-function path.
			fs.writeFileSync(path.join(d.at, "lib", "echo-chain.sh"), "# gone\n");
			const r = drive(d.script, {
				session_id: "s1",
				tool_name: "Bash",
				tool_input: LS,
				tool_response: SAME,
			});
			expect(r.status).toBe(0);
			expect(r.stdout ?? "").toBe("");
		}
		expect(logged()).toContain("echo-chain.sh");
	});

	it("allows on a payload carrying no session at all", () => {
		expectSilentAllow(drive(GUARD, { tool_name: "Bash", tool_input: LS }));
		expect(logged()).toContain("session_id");
	});
});
