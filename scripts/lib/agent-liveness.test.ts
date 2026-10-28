// @vitest-environment node
/*
 * agent-liveness.js is the one reader of `claude agents --json`, and every
 * caller refuses on the `{why}` it returns. These tests pin the refusals rather
 * than the happy path: a branch that wrongly returned `{agents}` would let a
 * caller narrow the live set on a partial read and break a live session's claim
 * (lucmoseley/mantahostels#512).
 *
 * A fake `claude` on WFC_CLAUDE_BIN stands in for the daemon. `isListedLive`,
 * a pure predicate, is tested in process at the end.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeHeadlessRun } from "./headless-runs-testkit";

// The module is CommonJS and stays that way — it is required by plain node
// scripts that a bash hook spawns.
// biome-ignore lint/suspicious/noExplicitAny: a CJS module has no types to import
const liveness: any = createRequire(__filename)("./agent-liveness.js");

let dir = "";
const savedEnv = { ...process.env };

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "liveness-"));
	// Outside a session there is nothing for the self-test to test against; each
	// test that wants it opts in.
	process.env.CLAUDE_CODE_SESSION_ID = "";
	process.env.WFC_REFILL_DIR = path.join(dir, "refill");
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
	process.env = { ...savedEnv };
});

/** A `claude` stand-in: `agents --json` prints `body`, then exits `code`. */
function fakeClaude(body: string, code = 0) {
	const bin = path.join(dir, "claude");
	fs.writeFileSync(
		bin,
		`#!/bin/sh\ncat <<'EOF'\n${body}\nEOF\nexit ${code}\n`,
		{
			mode: 0o755,
		},
	);
	process.env.WFC_CLAUDE_BIN = bin;
	return bin;
}

const listing = (...sessionIds: string[]) =>
	JSON.stringify(
		sessionIds.map((sessionId, i) => ({
			pid: 100 + i,
			sessionId,
			status: "busy",
			state: "working",
			kind: "session",
		})),
	);

describe("the binary will not run", () => {
	it("refuses with the spawn error code when there is no such binary", () => {
		process.env.WFC_CLAUDE_BIN = path.join(dir, "no-such-claude");
		const r = liveness.listedAgents();
		expect(r.agents).toBeUndefined();
		expect(r.why).toContain("would not run");
		expect(r.why).toContain("ENOENT");
	});

	it("refuses with the exit status when it runs and fails", () => {
		fakeClaude("[]", 3);
		const r = liveness.listedAgents();
		expect(r.agents).toBeUndefined();
		expect(r.why).toContain("would not run");
		expect(r.why).toContain("exit 3");
	});

	it("names the binary it tried, so a wrong WFC_CLAUDE_BIN is visible", () => {
		const bin = path.join(dir, "no-such-claude");
		process.env.WFC_CLAUDE_BIN = bin;
		expect(liveness.listedAgents().why).toContain(`\`${bin} agents --json\``);
	});
});

/*
 * A `claude` stand-in that HANGS on its first `hangs` calls and answers `body`
 * after that, counting every call in a file. The count is what pins "exactly
 * one retry": a caller that looped would drive it past 2.
 *
 * `exec sleep` matters — execFileSync's timeout signals the process it spawned,
 * and a plain `sleep` would leave the shell to be signalled while the sleep ran
 * on, so the fake would outlive the test.
 */
function hangingClaude(body: string, hangs: number) {
	const count = path.join(dir, "calls");
	const bin = path.join(dir, "claude");
	fs.writeFileSync(
		bin,
		"#!/bin/sh\n" +
			`n=$(cat ${count} 2>/dev/null || echo 0)\n` +
			"n=$((n + 1))\n" +
			`echo $n > ${count}\n` +
			`[ $n -le ${hangs} ] && exec sleep 30\n` +
			`cat <<'EOF'\n${body}\nEOF\n`,
		{ mode: 0o755 },
	);
	process.env.WFC_CLAUDE_BIN = bin;
	return () => Number(fs.readFileSync(count, "utf8").trim());
}

describe("the oracle times out (mantahostels#1900)", () => {
	beforeEach(() => {
		// Milliseconds, not the 10s/20s defaults, so the suite does not wait on a
		// real ceiling. The retry's cap stays the longer of the two.
		process.env.WFC_ORACLE_TIMEOUT_MS = "300";
		process.env.WFC_ORACLE_RETRY_TIMEOUT_MS = "600";
	});

	it("retries once and answers, so a load spike does not refuse the caller", () => {
		const calls = hangingClaude(listing("aaaa"), 1);
		const r = liveness.listedAgents();
		expect(r.why).toBeUndefined();
		expect(r.agents.map((a: { sessionId: string }) => a.sessionId)).toEqual([
			"aaaa",
		]);
		expect(calls()).toBe(2);
	});

	it("retries exactly once, never looping", () => {
		const calls = hangingClaude(listing("aaaa"), 5);
		liveness.listedAgents();
		expect(calls()).toBe(2);
	});

	it("refuses when the retry times out too, naming the longer cap", () => {
		hangingClaude(listing("aaaa"), 5);
		const r = liveness.listedAgents();
		expect(r.agents).toBeUndefined();
		expect(r.why).toContain("would not run (ETIMEDOUT)");
		expect(r.why).toContain("twice, the retry given 600 ms");
	});

	it("gives the retry the longer cap, not the first attempt's", () => {
		// The fake sleeps far past both caps, so a retry capped at 300 ms would
		// return before 600 ms elapsed. 300+600 is the floor for the honest path.
		hangingClaude(listing("aaaa"), 5);
		const started = Date.now();
		liveness.listedAgents();
		// §X9: a process timeout: the caps bound a real hung child, and this floor proves the retry got the longer one.
		expect(Date.now() - started).toBeGreaterThanOrEqual(850);
	});

	it("does not retry a failure that is not a timeout", () => {
		const count = path.join(dir, "calls");
		const bin = path.join(dir, "claude");
		fs.writeFileSync(
			bin,
			`#!/bin/sh\nn=$(cat ${count} 2>/dev/null || echo 0)\necho $((n + 1)) > ${count}\nexit 3\n`,
			{ mode: 0o755 },
		);
		process.env.WFC_CLAUDE_BIN = bin;
		const r = liveness.listedAgents();
		expect(r.why).toContain("exit 3");
		expect(r.why).not.toContain("twice");
		expect(Number(fs.readFileSync(count, "utf8").trim())).toBe(1);
	});

	it("leaves no child of a wrapper behind it (#2665)", async () => {
		// The union wrapper's shape: a child per seat backgrounded, then waited on.
		const pids = path.join(dir, "pids");
		const bin = path.join(dir, "claude");
		fs.writeFileSync(
			bin,
			`#!/bin/bash\nsleep 30 &\necho $! >> ${pids}\nsleep 30 &\necho $! >> ${pids}\nwait\n`,
			{ mode: 0o755 },
		);
		process.env.WFC_CLAUDE_BIN = bin;
		expect(liveness.listedAgents().why).toContain("ETIMEDOUT");
		const children = fs.readFileSync(pids, "utf8").trim().split("\n");
		// Two children a call, and two calls: the first and its one retry.
		expect(children).toHaveLength(4);
		const running = (pid: string) => {
			try {
				return !/\) [ZX] /.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
			} catch {
				return false;
			}
		};
		// §X9: SIGKILL is delivered asynchronously, so the reap is polled for —
		// up to 1 s, untraced: far past a kill's delivery on an idle machine.
		for (let i = 0; i < 20 && children.some(running); i++)
			await new Promise((r) => setTimeout(r, 50));
		expect(children.filter(running)).toEqual([]);
	});

	it("falls back to the default cap when the knob is garbled", () => {
		process.env.WFC_ORACLE_TIMEOUT_MS = "not-a-number";
		fakeClaude(listing("aaaa"));
		// A cap of NaN or 0 would disable the ceiling; the answer proves it ran.
		expect(liveness.listedAgents().why).toBeUndefined();
	});
});

describe("the output is not JSON", () => {
	it("refuses on output that does not parse", () => {
		fakeClaude("not json at all");
		const r = liveness.listedAgents();
		expect(r.agents).toBeUndefined();
		expect(r.why).toContain("did not return JSON");
	});
});

describe("the output is JSON but not an array", () => {
	it("refuses on an object, naming what it got", () => {
		fakeClaude('{"agents":[{"sessionId":"a"}]}');
		const r = liveness.listedAgents();
		expect(r.agents).toBeUndefined();
		expect(r.why).toContain("returned object, not the expected array");
	});

	it("refuses on a bare JSON scalar", () => {
		fakeClaude("null");
		expect(liveness.listedAgents().why).toContain("not the expected array");
	});
});

describe("the array is empty", () => {
	it("refuses, because a running daemon lists at least this session", () => {
		fakeClaude("[]");
		const r = liveness.listedAgents();
		expect(r.agents).toBeUndefined();
		expect(r.why).toContain("listed no agents at all");
	});

	it("reads as nothing live to admission outside a session (#2180)", () => {
		fakeClaude("[]");
		expect(liveness.admissionSessionIds().ids?.size).toBe(0);
	});

	it("still refuses to admission inside a session, and to every other reader however asked", () => {
		fakeClaude("[]");
		expect(
			liveness.listedSessionIds({ allowEmpty: true } as never).why,
		).toContain("listed no agents at all");
		expect(liveness.listedAgents({ allowEmpty: true }).why).toContain(
			"listed no agents at all",
		);
		process.env.CLAUDE_CODE_SESSION_ID = "me";
		expect(liveness.admissionSessionIds().why).toContain(
			"listed no agents at all",
		);
	});
});

describe("no record carries a sessionId", () => {
	it("refuses when every record lacks the field, naming sessionId and the record count", () => {
		fakeClaude('[{"pid":1,"status":"busy"},{"pid":2}]');
		const r = liveness.listedAgents();
		expect(r.agents).toBeUndefined();
		expect(r.why).toContain("2 agent(s), none of them carrying a sessionId");
	});

	it("refuses when the field is present but empty or not a string", () => {
		fakeClaude('[{"sessionId":""},{"sessionId":7},{"sessionId":null}]');
		expect(liveness.listedAgents().why).toContain(
			"none of them carrying a sessionId",
		);
	});

	it("does not refuse when only some records lack it, and drops those", () => {
		fakeClaude('[{"pid":1},{"pid":2,"sessionId":"a"}]');
		const r = liveness.listedAgents();
		expect(r.why).toBeUndefined();
		expect(r.agents.map((a: { sessionId: string }) => a.sessionId)).toEqual([
			"a",
		]);
	});
});

describe("the self-test: the list omits the session this is running in", () => {
	it("refuses, naming the session, when the oracle does not list it", () => {
		process.env.CLAUDE_CODE_SESSION_ID = "me";
		fakeClaude(listing("someone-else"));
		const r = liveness.listedAgents();
		expect(r.agents).toBeUndefined();
		expect(r.why).toContain("does not list this very session (me)");
	});

	it("passes when the oracle does list it", () => {
		process.env.CLAUDE_CODE_SESSION_ID = "me";
		fakeClaude(listing("someone-else", "me"));
		const r = liveness.listedAgents();
		expect(r.why).toBeUndefined();
		expect(r.agents).toHaveLength(2);
	});

	it("is skipped outside a session, where there is nothing to test against", () => {
		delete process.env.CLAUDE_CODE_SESSION_ID;
		fakeClaude(listing("someone-else"));
		const r = liveness.listedAgents();
		expect(r.why).toBeUndefined();
		expect(r.agents).toHaveLength(1);
	});
});

describe("requireSelf: false, the opt-in exemption from the self-test (mantahostels#540)", () => {
	it("returns the listing when the only fault is that this session is absent", () => {
		process.env.CLAUDE_CODE_SESSION_ID = "me";
		fakeClaude(listing("someone-else"));
		const r = liveness.listedAgents({ requireSelf: false });
		expect(r.why).toBeUndefined();
		expect(r.agents).toHaveLength(1);
	});

	/* Fail-closed: only the literal `false` exempts. */
	it.each([
		["unset", {}],
		["true", { requireSelf: true }],
		["undefined", { requireSelf: undefined }],
		["null", { requireSelf: null }],
		["0", { requireSelf: 0 }],
		["the string 'false'", { requireSelf: "false" }],
	])("keeps the self-test when requireSelf is %s", (_name, opts) => {
		process.env.CLAUDE_CODE_SESSION_ID = "me";
		fakeClaude(listing("someone-else"));
		expect(liveness.listedAgents(opts).why).toContain(
			"does not list this very session",
		);
	});

	/* It suppresses ONE test, not the oracle's judgement. */
	it.each([
		["the binary will not run", () => fakeClaude("[]", 3), "would not run"],
		[
			"the output is not JSON",
			() => fakeClaude("not json"),
			"did not return JSON",
		],
		[
			"the output is not an array",
			() => fakeClaude('{"a":1}'),
			"not the expected array",
		],
		["the array is empty", () => fakeClaude("[]"), "listed no agents at all"],
		[
			"no record carries a sessionId",
			() => fakeClaude('[{"pid":1}]'),
			"none of them carrying a sessionId",
		],
	])("still refuses when %s", (_name, arrange, fragment) => {
		process.env.CLAUDE_CODE_SESSION_ID = "me";
		arrange();
		const r = liveness.listedAgents({ requireSelf: false });
		expect(r.agents).toBeUndefined();
		expect(r.why).toContain(fragment);
	});

	/* pick-next subtracts self from its session count on the strength of this
	 * reader listing its own caller (mantahostels#437). */
	it("does not exempt listedSessionIds, whose callers rely on the self-test", () => {
		process.env.CLAUDE_CODE_SESSION_ID = "me";
		fakeClaude(listing("someone-else"));
		const r = liveness.listedSessionIds({ requireSelf: false });
		expect(r.ids).toBeUndefined();
		expect(r.why).toContain("does not list this very session (me)");
	});
});

describe("what it returns when it can answer", () => {
	it("hands back the whole record, not just the id", () => {
		fakeClaude(listing("a"));
		const [agent] = liveness.listedAgents().agents;
		expect(agent).toMatchObject({
			sessionId: "a",
			status: "busy",
			state: "working",
			kind: "session",
		});
	});

	it("reads WFC_CLAUDE_BIN per call, not once at load", () => {
		fakeClaude(listing("a"));
		expect(liveness.claudeBin()).toBe(path.join(dir, "claude"));
		delete process.env.WFC_CLAUDE_BIN;
		expect(liveness.claudeBin()).toBe("claude");
	});
});

describe("headless runs (#2608)", () => {
	const store = () => path.join(dir, "refill", ".headless-runs");
	const headlessRun = (jobId: string, sessionId: string, live = true) =>
		writeHeadlessRun(path.join(dir, "refill"), jobId, sessionId, {
			live,
			cwd: dir,
		});

	it("merges each live run into every listing as a headless record", () => {
		fakeClaude(listing("a"));
		headlessRun("0123abcd", "h");
		expect(liveness.listedAgents().agents).toEqual([
			expect.objectContaining({ sessionId: "a" }),
			{
				id: "0123abcd",
				sessionId: "h",
				pid: process.pid,
				cwd: dir,
				startedAt: 1000,
				state: "working",
				kind: "headless",
			},
		]);
		const ids = liveness.listedSessionIds();
		expect([...ids.ids]).toEqual(["a", "h"]);
		expect(ids.kinds.get("h")).toBe("headless");
		expect([...liveness.sweepSessionIds().ids]).toContain("h");
	});

	it("lists no ended run, a reused pid included", () => {
		fakeClaude(listing("a"));
		headlessRun("0123abcd", "h", false);
		expect([...liveness.listedSessionIds().ids]).toEqual(["a"]);
	});

	it("never writes a run into the oracle cache", () => {
		fakeClaude(listing("a"));
		headlessRun("0123abcd", "h");
		expect(liveness.listedAgents().agents).toHaveLength(2);
		const config = String(process.env.CLAUDE_CONFIG_DIR);
		const cached = fs
			.readdirSync(config)
			.filter((f) => f.startsWith("wfc-oracle-cache-") && f.endsWith(".json"))
			.map((f) => fs.readFileSync(path.join(config, f), "utf8"));
		expect(cached.length).toBeGreaterThan(0);
		for (const c of cached) expect(c).not.toContain("0123abcd");
	});

	it("refuses every reader where the store will not read", () => {
		fakeClaude(listing("a"));
		fs.mkdirSync(path.dirname(store()), { recursive: true });
		fs.writeFileSync(store(), "not a directory");
		for (const read of [
			liveness.listedAgents,
			liveness.listedSessionIds,
			liveness.admissionSessionIds,
			liveness.sweepSessionIds,
		]) {
			const r = read();
			expect(r.why).toContain("headless-run store could not be read");
			expect(r.agents ?? r.ids).toBeUndefined();
		}
	});

	it("passes the self-test for a headless session the oracle cannot list", () => {
		process.env.CLAUDE_CODE_SESSION_ID = "h";
		headlessRun("0123abcd", "h");
		fakeClaude(listing("a"));
		expect(liveness.listedSessionIds().ids.has("h")).toBe(true);
		// The daemon may have nothing of its own to list beside it.
		fakeClaude("[]");
		expect(liveness.listedSessionIds().ids).toEqual(new Set(["h"]));
	});

	it("still fails the self-test once the session's run has ended", () => {
		process.env.CLAUDE_CODE_SESSION_ID = "h";
		headlessRun("0123abcd", "h", false);
		fakeClaude(listing("a"));
		expect(liveness.listedSessionIds().why).toContain(
			"does not list this very session",
		);
	});
});

describe("listedSessionIds", () => {
	it("returns the ids as a Set", () => {
		fakeClaude(listing("a", "b"));
		const r = liveness.listedSessionIds();
		expect(r.why).toBeUndefined();
		expect([...r.ids].sort()).toEqual(["a", "b"]);
	});

	/* Off the SAME oracle read, so a caller pricing the daemon+spare overhead
	 * can build its live-pid set without a second oracle spawn (mantahostels#1295). */
	it("maps each session id to its pid", () => {
		fakeClaude(listing("a", "b"));
		const r = liveness.listedSessionIds();
		expect(r.pids.get("a")).toBe(100);
		expect(r.pids.get("b")).toBe(101);
	});

	/* Every session's cwd, whatever its state, for its repo's draw (#2221). */
	it("maps each session to its cwd, whatever its state", () => {
		fakeClaude(
			JSON.stringify([
				{ sessionId: "me", state: "working", cwd: "/r/a" },
				{ sessionId: "w", state: "working", cwd: "/r/b" },
				{ sessionId: "d", kind: "background", state: "done", cwd: "/r/c" },
				{ sessionId: "nocwd", state: "working" },
			]),
		);
		process.env.CLAUDE_CODE_SESSION_ID = "me";
		expect([...liveness.listedSessionIds().cwds]).toEqual([
			["me", "/r/a"],
			["w", "/r/b"],
			["d", "/r/c"],
			["nocwd", ""],
		]);
	});

	it("leaves a record with no pid absent from the map", () => {
		fakeClaude(JSON.stringify([{ sessionId: "me" }]));
		process.env.CLAUDE_CODE_SESSION_ID = "me";
		expect(liveness.listedSessionIds().pids.has("me")).toBe(false);
	});

	/* The derived sets must not move beside the raw fields (#588). */
	it("maps each session to the oracle's own state and kind", () => {
		const records = [
			{ sessionId: "me", kind: "session", state: "working" },
			{ sessionId: "done-1", kind: "background", state: "done" },
			{ sessionId: "fail-1", kind: "background", state: "failed" },
			{ sessionId: "bare" },
		];
		fakeClaude(JSON.stringify(records));
		process.env.CLAUDE_CODE_SESSION_ID = "me";
		const r = liveness.listedSessionIds();
		for (const a of records) {
			expect(r.states.get(a.sessionId)).toBe(a.state);
			expect(r.kinds.get(a.sessionId)).toBe(a.kind);
		}
		expect(r.states.has("bare")).toBe(false);
		expect(r.kinds.has("bare")).toBe(false);
		expect([...r.finished]).toEqual(["done-1"]);
		expect([...r.terminal]).toEqual(["done-1", "fail-1"]);
	});

	/* `finished` — the pool a caller reports as reclaimable, off this same read
	 * (mantahostels#653). */
	it("holds the background sessions the oracle calls done", () => {
		fakeClaude(
			JSON.stringify([
				{ sessionId: "me", kind: "session", state: "working" },
				{ sessionId: "done-1", kind: "background", state: "done" },
			]),
		);
		process.env.CLAUDE_CODE_SESSION_ID = "me";
		expect([...liveness.listedSessionIds().finished]).toEqual(["done-1"]);
	});

	/* The reaper's gate 1 exactly (mantahostels#768; doc-map
	 * https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/session-state-status-skew.md). A `shell` session pairs `state: done` with `status: busy`, and must
	 * still count here. */
	it("reads kind and state alone, never status", () => {
		fakeClaude(
			JSON.stringify([
				{ sessionId: "me", kind: "session", state: "working" },
				{
					sessionId: "shell",
					kind: "background",
					state: "done",
					status: "busy",
				},
			]),
		);
		process.env.CLAUDE_CODE_SESSION_ID = "me";
		expect([...liveness.listedSessionIds().finished]).toEqual(["shell"]);
	});

	it.each([
		[
			"a background session still working",
			{ kind: "background", state: "working" },
		],
		["a foreground session that is done", { kind: "session", state: "done" }],
		["a record whose state the oracle omitted", { kind: "background" }],
	])("leaves out %s", (_name, extra: Record<string, string>) => {
		fakeClaude(JSON.stringify([{ sessionId: "me", ...extra }]));
		process.env.CLAUDE_CODE_SESSION_ID = "me";
		const r = liveness.listedSessionIds();
		expect(r.finished.size).toBe(0);
	});

	/* Every refusal reaches the callers through this wrapper, so a wrapper that
	 * dropped `why` would hand them an empty Set — every claim reading dead. */
	it.each([
		["the binary will not run", () => fakeClaude("[]", 3)],
		["the output is not JSON", () => fakeClaude("not json")],
		["the output is not an array", () => fakeClaude('{"a":1}')],
		["the array is empty", () => fakeClaude("[]")],
		["no record carries a sessionId", () => fakeClaude('[{"pid":1}]')],
		[
			"the self-test fails",
			() => {
				process.env.CLAUDE_CODE_SESSION_ID = "me";
				fakeClaude(listing("other"));
			},
		],
	])("passes the refusal through when %s", (_name, arrange) => {
		arrange();
		const r = liveness.listedSessionIds();
		expect(r.ids).toBeUndefined();
		expect(typeof r.why).toBe("string");
		// The same sentence, not merely some refusal: the net below would other-
		// wise swallow a dropped pass-through and report an unreadable oracle.
		expect(r.why).toBe(liveness.listedAgents().why);
	});
});

/*
 * The issue-claim prune's reader (mantahostels#710). Its only wiring is a SessionStart
 * hook, where the starting session is not yet listed.
 */
describe("sweepSessionIds", () => {
	it("answers where the only omission is the calling session", () => {
		process.env.CLAUDE_CODE_SESSION_ID = "me";
		fakeClaude(listing("other"));
		expect(liveness.listedSessionIds().ids).toBeUndefined();
		const r = liveness.sweepSessionIds();
		expect(r.why).toBeUndefined();
		expect([...r.ids].sort()).toEqual(["me", "other"]);
	});

	/* A sweep's judgement IS an absence, so a list short by the caller must be
	 * corrected rather than merely tolerated: leaving "me" out would delete the
	 * sweeping session's own claim. */
	it("adds the caller back rather than passing the short list through", () => {
		process.env.CLAUDE_CODE_SESSION_ID = "me";
		fakeClaude(listing("other"));
		expect(liveness.sweepSessionIds().ids.has("me")).toBe(true);
	});

	it("adds nothing outside a session, where there is no caller to add", () => {
		fakeClaude(listing("other"));
		expect([...liveness.sweepSessionIds().ids]).toEqual(["other"]);
	});

	/* The waiver reaches the self-test and nothing else: every other refusal
	 * still refuses, or a sweep would run on an oracle that said nothing. */
	it.each([
		["the binary will not run", () => fakeClaude("[]", 3)],
		["the output is not JSON", () => fakeClaude("not json")],
		["the output is not an array", () => fakeClaude('{"a":1}')],
		["the array is empty", () => fakeClaude("[]")],
		["no record carries a sessionId", () => fakeClaude('[{"pid":1}]')],
	])("still refuses when %s", (_name, arrange) => {
		process.env.CLAUDE_CODE_SESSION_ID = "me";
		arrange();
		const r = liveness.sweepSessionIds();
		expect(r.ids).toBeUndefined();
		expect(r.why).toBe(liveness.listedAgents({ requireSelf: false }).why);
	});

	/* Display names ride along on the same read (mantahostels#1924), the stranded-claim
	 * sweep naming its holders. The caller's own id is never in the map, since
	 * the oracle did not list it. */
	it("carries display names, minus the caller it added back", () => {
		process.env.CLAUDE_CODE_SESSION_ID = "me";
		fakeClaude(
			JSON.stringify([
				{ pid: 1, sessionId: "other", name: "Implement 1924", kind: "session" },
				{ pid: 2, sessionId: "nameless", kind: "session" },
			]),
		);
		const r = liveness.sweepSessionIds();
		expect(r.names.get("other")).toBe("Implement 1924");
		expect(r.names.has("nameless")).toBe(false);
		expect(r.names.has("me")).toBe(false);
	});

	/* The waiver is hard-coded, so a caller cannot re-arm the self-test. */
	it("ignores a caller trying to set requireSelf back to true", () => {
		process.env.CLAUDE_CODE_SESSION_ID = "me";
		fakeClaude(listing("other"));
		expect(
			[...liveness.sweepSessionIds({ requireSelf: true }).ids].sort(),
		).toEqual(["me", "other"]);
	});

	/* Mirrors listedSessionIds's `finished` field (mantahostels#2765): a caller reading the
	 * waived list still needs to tell a listed-but-done holder from a live one. */
	it("holds the background sessions the oracle calls done, like listedSessionIds", () => {
		process.env.CLAUDE_CODE_SESSION_ID = "me";
		fakeClaude(
			JSON.stringify([
				{ sessionId: "me", kind: "session", state: "working" },
				{ sessionId: "done-1", kind: "background", state: "done" },
			]),
		);
		expect([...liveness.sweepSessionIds().finished]).toEqual(["done-1"]);
	});

	it("never adds the caller it added back to `ids` into `finished`", () => {
		process.env.CLAUDE_CODE_SESSION_ID = "me";
		fakeClaude(listing("other"));
		expect(liveness.sweepSessionIds().finished.has("me")).toBe(false);
	});

	/* `terminal` — the pool a caller judging LIVENESS reads, wider than
	 * `finished` because a session that FAILED is no more alive than one that
	 * finished (mantahostels#2774). */
	it.each(["done", "failed", "stopped"])(
		"holds a background session the oracle calls %s",
		(state) => {
			process.env.CLAUDE_CODE_SESSION_ID = "me";
			fakeClaude(
				JSON.stringify([
					{ sessionId: "me", kind: "session", state: "working" },
					{ sessionId: "ended", kind: "background", state },
				]),
			);
			expect([...liveness.sweepSessionIds().terminal]).toEqual(["ended"]);
		},
	);

	/* `finished` feeds pick-next's reclaimable headline,
	 * which promises the memory the reaper returns, and the reaper stops `done`
	 * alone. Merging the two predicates would widen what it kills. */
	it("leaves a failed session out of `finished` while holding it in `terminal`", () => {
		process.env.CLAUDE_CODE_SESSION_ID = "me";
		fakeClaude(
			JSON.stringify([
				{ sessionId: "me", kind: "session", state: "working" },
				{ sessionId: "failed-1", kind: "background", state: "failed" },
			]),
		);
		const r = liveness.sweepSessionIds();
		expect(r.finished.has("failed-1")).toBe(false);
		expect(r.terminal.has("failed-1")).toBe(true);
	});

	it.each([
		[
			"a background session still working",
			{ kind: "background", state: "working" },
		],
		["a foreground session that is done", { kind: "session", state: "done" }],
		["a record whose state the oracle omitted", { kind: "background" }],
	])("leaves %s out of `terminal`", (_name, extra: Record<string, string>) => {
		process.env.CLAUDE_CODE_SESSION_ID = "me";
		fakeClaude(JSON.stringify([{ sessionId: "me", ...extra }]));
		expect(liveness.sweepSessionIds().terminal.size).toBe(0);
	});

	it("never adds the caller it added back to `ids` into `terminal`", () => {
		process.env.CLAUDE_CODE_SESSION_ID = "me";
		fakeClaude(listing("other"));
		expect(liveness.sweepSessionIds().terminal.has("me")).toBe(false);
	});
});

/*
 * The oracle must be total: every input returns a list or a `{why}`, never a
 * throw (mantahostels#517, the ticket that found a JSON `null` throwing instead).
 */
describe("totality", () => {
	const payloads: [string, string][] = [
		["a JSON null", "null"],
		["a JSON true", "true"],
		["a JSON number", "7"],
		["a JSON string", '"agents"'],
		["an object", '{"agents":[]}'],
		["an empty array", "[]"],
		["an array of nulls", "[null,null]"],
		["an array of scalars", '[1,"a",true]'],
		["an array of arrays", "[[],[]]"],
		["no output at all", ""],
		["whitespace only", "   "],
		["a truncated array", '[{"sessionId":"a"}'],
	];

	it.each(payloads)("answers or refuses on %s, never throws", (_n, body) => {
		fakeClaude(body);
		for (const call of [liveness.listedAgents, liveness.listedSessionIds]) {
			const r = call();
			expect(r).toBeTypeOf("object");
			const answered = r.agents !== undefined || r.ids !== undefined;
			expect(answered || typeof r.why === "string").toBe(true);
			expect(answered && r.why !== undefined).toBe(false);
		}
	});

	it.each(payloads)("refuses on %s inside a session too", (_n, body) => {
		process.env.CLAUDE_CODE_SESSION_ID = "me";
		fakeClaude(body);
		expect(typeof liveness.listedAgents().why).toBe("string");
		expect(typeof liveness.listedSessionIds().why).toBe("string");
	});

	it("turns an unexpected throw in the reader into a refusal quoting the thrown message", () => {
		fakeClaude(listing("a"));
		const boom = () => {
			throw new TypeError("Cannot read properties of null (reading 'length')");
		};
		const r = liveness.listedAgents({ read: boom });
		expect(r.agents).toBeUndefined();
		expect(r.why).toContain("could not be read");
		expect(r.why).toContain("reading 'length'");
	});

	it("turns an unexpected throw into a refusal for listedSessionIds too", () => {
		fakeClaude(listing("a"));
		const boom = () => {
			throw new TypeError("nope");
		};
		const r = liveness.listedSessionIds({ read: boom });
		expect(r.ids).toBeUndefined();
		expect(r.why).toContain("could not be read");
	});

	it("caps the quoted message rather than printing an unbounded one", () => {
		fakeClaude(listing("a"));
		const boom = () => {
			throw new Error("x".repeat(5000));
		};
		expect(liveness.listedAgents({ read: boom }).why.length).toBeLessThan(400);
	});

	it("ignores a positional argument, so a stray caller cannot supply a reader", () => {
		fakeClaude(listing("a"));
		const boom = () => {
			throw new Error("should never run");
		};
		expect(liveness.listedAgents(boom).agents).toHaveLength(1);
		expect([...liveness.listedSessionIds(boom).ids]).toEqual(["a"]);
		// The shape `.map` would pass: an element, an index, then the array.
		const mapped: { ids: Set<string> }[] = ["x"].map(liveness.listedSessionIds);
		expect([...mapped[0].ids]).toEqual(["a"]);
	});

	it("refuses when the reader answers with neither agents nor a why", () => {
		fakeClaude(listing("a"));
		for (const answer of [null, undefined, 0, "listed", {}]) {
			const r = liveness.listedAgents({ read: () => answer });
			expect(r.agents).toBeUndefined();
			expect(typeof r.why).toBe("string");
		}
	});

	it("refuses when the reader returns a non-throwing wrong shape", () => {
		fakeClaude(listing("a"));
		const r = liveness.listedSessionIds({ read: () => ({ agents: null }) });
		expect(r.ids).toBeUndefined();
		expect(typeof r.why).toBe("string");
	});

	it("refuses both id readers an answer carrying neither field, and still answers a good one", () => {
		fakeClaude(listing("a"));
		for (const read of [liveness.listedSessionIds, liveness.sweepSessionIds]) {
			const r = read({ read: () => ({}) });
			expect(r.ids).toBeUndefined();
			expect(typeof r.why).toBe("string");
			// The positive half §X4 asks for: the same reader on a real listing.
			expect([
				...read({ read: () => ({ agents: [{ sessionId: "a" }] }) }).ids,
			]).toContain("a");
		}
	});
});

describe("isListedLive (#629)", () => {
	const ids = new Set(["a", "b"]);
	it("reads a listed id live, and a terminal or unlisted one not", () => {
		expect(liveness.isListedLive("a", ids, new Set(["b"]))).toBe(true);
		expect(liveness.isListedLive("b", ids, new Set(["b"]))).toBe(false);
		expect(liveness.isListedLive("c", ids, new Set())).toBe(false);
	});
	it("reads every listed id live where the oracle gave no terminal set", () => {
		expect(liveness.isListedLive("b", ids, undefined)).toBe(true);
	});
	it("matches an id a record stored untyped", () => {
		expect(liveness.isListedLive(7, new Set(["7"]), new Set())).toBe(true);
	});
});
