// @vitest-environment node

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import {
	afterEach,
	assert,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	type AgentsAnswer,
	buildAgentsBranch,
	buildListedRow,
	buildUnrecordedRow,
} from "./agents-stop-fake";
import { writeClaudeStub } from "./claude-stub";
import { readText } from "./file-read.js";
import { writeHeadlessRun } from "./headless-runs-testkit";
import { withStopClockLeft } from "./hook-deadline-testkit";

const liveness: typeof import("./agent-liveness.js") = createRequire(
	__filename,
)("./agent-liveness.js");

let dir = "";

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "liveness-"));
	vi.stubEnv("CLAUDE_CODE_SESSION_ID", "");
	vi.stubEnv("WFC_REFILL_DIR", path.join(dir, "refill"));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function fakeClaude(
	answer: AgentsAnswer,
	bySeat?: Record<string, AgentsAnswer>,
) {
	const bin = writeClaudeStub(path.join(dir, "claude"), [
		buildAgentsBranch(answer, bySeat),
	]);
	vi.stubEnv("WFC_CLAUDE_BIN", bin);
	return bin;
}

const malformed = (text: string) => ({ malformed: text });

const answeredAgents = (opts?: Parameters<typeof liveness.listedAgents>[0]) => {
	const { agents, why } = liveness.listedAgents(opts);
	assert(agents, why);
	return agents;
};

const answeredIds = (
	opts?: Parameters<typeof liveness.listedSessionIds>[0],
) => {
	const r = liveness.listedSessionIds(opts);
	assert(r.why === undefined, r.why);
	return r;
};

const sweptIds = (...args: Parameters<typeof liveness.sweepSessionIds>) => {
	const r = liveness.sweepSessionIds(...args);
	assert(r.why === undefined, r.why);
	return r;
};

const listing = (...sessionIds: string[]) =>
	sessionIds.map((sessionId, i) =>
		buildListedRow({
			pid: 100 + i,
			sessionId,
			status: "busy",
			state: "working",
			kind: "session",
		}),
	);

describe("one seat's own listing (#3512)", () => {
	it("answers the seat's records where it lists an array", () => {
		const row = buildListedRow({ id: "abc12345" });
		fakeClaude([row]);
		expect(liveness.readSeatListing(dir, 1000)).toEqual({ agents: [row] });
	});

	it("answers why where the listing is not JSON", () => {
		fakeClaude(malformed("not json"));
		const r = liveness.readSeatListing(dir, 1000);
		assert("why" in r);
		expect(r.why).toContain("did not return JSON");
	});

	it("answers why where the listing is not an array", () => {
		fakeClaude(malformed("{}"));
		const r = liveness.readSeatListing(dir, 1000);
		assert("why" in r);
		expect(r.why).toContain("not the expected array");
	});
});

describe("the binary will not run", () => {
	it("refuses with the spawn error code when there is no such binary", () => {
		vi.stubEnv("WFC_CLAUDE_BIN", path.join(dir, "no-such-claude"));
		const r = liveness.listedAgents();
		expect(r.agents).toBeUndefined();
		expect(r.why).toContain("would not run");
		expect(r.why).toContain("ENOENT");
	});

	it("refuses with the exit status when it runs and fails", () => {
		fakeClaude({ exit: 3 });
		const r = liveness.listedAgents();
		expect(r.agents).toBeUndefined();
		expect(r.why).toContain("would not run");
		expect(r.why).toContain("exit 3");
	});

	it("refuses with EACCES where the binary is a directory, as a direct spawn names it", () => {
		const bin = path.join(dir, "claude-dir");
		fs.mkdirSync(bin);
		vi.stubEnv("WFC_CLAUDE_BIN", bin);
		expect(liveness.listedAgents().why).toContain("would not run (EACCES)");
	});

	it("names the binary it tried, so a wrong WFC_CLAUDE_BIN is visible", () => {
		const bin = path.join(dir, "no-such-claude");
		vi.stubEnv("WFC_CLAUDE_BIN", bin);
		expect(liveness.listedAgents().why).toContain(`\`${bin} agents --json\``);
	});
});

function fakeRun(
	hangs: number,
	failure: () => Error = () =>
		Object.assign(new Error("spawnSync /bin/sh ETIMEDOUT"), {
			code: "ETIMEDOUT",
		}),
) {
	const caps: number[] = [];
	const run = (_bin: string, timeoutMs: number, dirs: string[]) => {
		caps.push(timeoutMs);
		if (caps.length <= hangs) throw failure();
		return dirs.map(() => JSON.stringify(listing("aaaa")));
	};
	return { caps, run };
}

describe("the oracle times out (mantahostels#1900)", () => {
	beforeEach(() => {
		vi.stubEnv("WFC_ORACLE_TIMEOUT_MS", "300");
		vi.stubEnv("WFC_ORACLE_RETRY_TIMEOUT_MS", "600");
	});

	it("retries once and answers, so a load spike does not refuse the caller", () => {
		const { caps, run } = fakeRun(1);
		const r = liveness.listedAgents({ run });
		expect(r.why).toBeUndefined();
		assert(r.agents);
		expect(r.agents.map((a: { sessionId: string }) => a.sessionId)).toEqual([
			"aaaa",
		]);
		expect(caps).toHaveLength(2);
	});

	it("retries exactly once, never looping", () => {
		const { caps, run } = fakeRun(5);
		liveness.listedAgents({ run });
		expect(caps).toHaveLength(2);
	});

	it("gives the retry the longer cap, not the first attempt's", () => {
		const { caps, run } = fakeRun(5);
		expect(liveness.listedAgents({ run }).why).toContain(
			"twice, the retry given 600 ms",
		);
		expect(caps).toEqual([300, 600]);
	});

	it("does not retry a failure that is not a timeout", () => {
		const { caps, run } = fakeRun(5, () =>
			Object.assign(new Error("claude agents --json failed"), { status: 3 }),
		);
		const r = liveness.listedAgents({ run });
		expect(r.why).toContain("exit 3");
		expect(r.why).not.toContain("twice");
		expect(caps).toHaveLength(1);
	});

	it("refuses when the retry times out too, naming the longer cap", () => {
		fakeClaude("hang");
		const r = liveness.listedAgents();
		expect(r.agents).toBeUndefined();
		expect(r.why).toContain("would not run (ETIMEDOUT)");
		expect(r.why).toContain("twice, the retry given 600 ms");
	});

	it("leaves no child of the oracle behind it, on any seat's read (#2665)", async () => {
		const seat = path.join(dir, "seat-a");
		fs.mkdirSync(seat);
		vi.stubEnv("WFC_CLAUDE_CONFIG_A", seat);
		vi.stubEnv("WFC_CLAUDE_CONFIG_B", path.join(dir, "no-b"));
		vi.stubEnv("WFC_CLAUDE_CONFIG_C", path.join(dir, "no-c"));
		const pids = path.join(dir, "pids");
		fakeClaude({ hangsWithChildren: pids });
		const running = (pid: string) => {
			try {
				return !/\) [ZX] /.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
			} catch {
				return false;
			}
		};
		const childrenOfAllReads = 8;
		let children: string[] = [];
		// guess, #5529
		for (
			let capMs = 1000;
			capMs <= 8000 && children.length < childrenOfAllReads;
			capMs *= 2
		) {
			fs.rmSync(pids, { force: true });
			vi.stubEnv("WFC_ORACLE_TIMEOUT_MS", String(capMs));
			vi.stubEnv("WFC_ORACLE_RETRY_TIMEOUT_MS", String(capMs * 2));
			expect(liveness.listedAgents().why).toContain("ETIMEDOUT");
			const log = readText(pids);
			if (log.state === "unreadable") throw log.error;
			children =
				log.state === "read" ? log.data.trim().split("\n").filter(Boolean) : [];
			// guess, #5529
			for (let i = 0; i < 20 && children.some(running); i++)
				await new Promise((r) => setTimeout(r, 50));
			expect(children.filter(running)).toEqual([]);
		}
		expect(children).toHaveLength(childrenOfAllReads);
	});

	it("falls back to the default cap when the knob is garbled", () => {
		vi.stubEnv("WFC_ORACLE_TIMEOUT_MS", "not-a-number");
		fakeClaude(listing("aaaa"));
		expect(liveness.listedAgents().why).toBeUndefined();
	});
});

describe("a hook's time budget (#4115)", () => {
	it("cuts a hung read to what the budget leaves, and does not retry it", () => {
		vi.stubEnv("WFC_ORACLE_TIMEOUT_MS", "5000");
		vi.stubEnv("WFC_ORACLE_RETRY_TIMEOUT_MS", "10000");
		const { caps, run } = fakeRun(5);
		const { loaded, drop } = withStopClockLeft(
			["./oracle-cache.js", "./agent-liveness.js"],
			400,
		);
		try {
			const [, fresh] = loaded;
			expect(fresh.listedAgents({ run }).why).toContain(
				"inside the hook's time budget",
			);
			expect(caps).toHaveLength(1);
			expect(caps[0]).toBeLessThanOrEqual(400);
		} finally {
			drop();
		}
	});
});

describe("the output is not JSON", () => {
	it("refuses on output that does not parse", () => {
		fakeClaude(malformed("not json at all"));
		const r = liveness.listedAgents();
		expect(r.agents).toBeUndefined();
		expect(r.why).toContain("did not return JSON");
	});
});

describe("the output is JSON but not an array", () => {
	it("refuses on an object, naming what it got", () => {
		fakeClaude(malformed('{"agents":[{"sessionId":"a"}]}'));
		const r = liveness.listedAgents();
		expect(r.agents).toBeUndefined();
		expect(r.why).toContain("returned object, not the expected array");
	});

	it("refuses on a bare JSON scalar", () => {
		fakeClaude(malformed("null"));
		expect(liveness.listedAgents().why).toContain("not the expected array");
	});
});

describe("the array is empty", () => {
	it("refuses, because a running daemon lists at least this session", () => {
		fakeClaude([]);
		const r = liveness.listedAgents();
		expect(r.agents).toBeUndefined();
		expect(r.why).toContain("listed no agents at all");
	});

	it("reads as nothing live to admission outside a session (#2180)", () => {
		fakeClaude([]);
		expect(liveness.admissionSessionIds().ids?.size).toBe(0);
	});

	it("reads as nothing live after a boot, outside a session alone (#3880)", () => {
		fakeClaude([]);
		expect(liveness.readAgentsAfterBoot().agents).toEqual([]);
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", "me");
		expect(liveness.readAgentsAfterBoot().why).toContain(
			"listed no agents at all",
		);
	});

	it("reads as nothing live to a levelling pass, outside a session alone", () => {
		fakeClaude([]);
		expect(liveness.readAgentsForLevelling().agents).toEqual([]);
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", "me");
		expect(liveness.readAgentsForLevelling().why).toContain(
			"listed no agents at all",
		);
	});

	it("reads as nothing live to the cutover, outside a session alone (#4743)", () => {
		fakeClaude([]);
		expect(liveness.readAgentsForCutover().agents).toEqual([]);
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", "me");
		expect(liveness.readAgentsForCutover().why).toContain(
			"listed no agents at all",
		);
	});

	it("still refuses to admission inside a session, and to every other reader however asked", () => {
		fakeClaude([]);
		expect(
			liveness.listedSessionIds({ allowEmpty: true } as never).why,
		).toContain("listed no agents at all");
		expect(liveness.listedAgents({ allowEmpty: true }).why).toContain(
			"listed no agents at all",
		);
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", "me");
		expect(liveness.admissionSessionIds().why).toContain(
			"listed no agents at all",
		);
	});
});

describe("no record carries a sessionId", () => {
	it("refuses when every record lacks the field, naming sessionId and the record count", () => {
		fakeClaude(malformed('[{"pid":1,"status":"busy"},{"pid":2}]'));
		const r = liveness.listedAgents();
		expect(r.agents).toBeUndefined();
		expect(r.why).toContain("2 agent(s), none of them carrying a sessionId");
	});

	it("refuses when the field is present but empty or not a string", () => {
		fakeClaude(
			malformed('[{"sessionId":""},{"sessionId":7},{"sessionId":null}]'),
		);
		expect(liveness.listedAgents().why).toContain(
			"none of them carrying a sessionId",
		);
	});

	it("does not refuse when only some records lack it, and drops those", () => {
		fakeClaude(malformed('[{"pid":1},{"pid":2,"sessionId":"a"}]'));
		const r = liveness.listedAgents();
		expect(r.why).toBeUndefined();
		assert(r.agents);
		expect(r.agents.map((a: { sessionId: string }) => a.sessionId)).toEqual([
			"a",
		]);
	});
});

describe("the self-test: the list omits the session this is running in", () => {
	it("keeps the self-test for the cutover inside a session (#4743)", () => {
		fakeClaude([{ sessionId: "other" }]);
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", "me");
		expect(liveness.readAgentsForCutover().why).toContain(
			"does not list this very session (me)",
		);
	});

	it("refuses, naming the session, when the oracle does not list it", () => {
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", "me");
		fakeClaude(listing("someone-else"));
		const r = liveness.listedAgents();
		expect(r.agents).toBeUndefined();
		expect(r.why).toContain("does not list this very session (me)");
	});

	it("passes when the oracle does list it", () => {
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", "me");
		fakeClaude(listing("someone-else", "me"));
		const r = liveness.listedAgents();
		expect(r.why).toBeUndefined();
		expect(r.agents).toHaveLength(2);
	});

	it("is skipped outside a session, where there is nothing to test against", () => {
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", undefined);
		fakeClaude(listing("someone-else"));
		const r = liveness.listedAgents();
		expect(r.why).toBeUndefined();
		expect(r.agents).toHaveLength(1);
	});
});

describe("requireSelf: false, the opt-in exemption from the self-test (mantahostels#540)", () => {
	it("returns the listing when the only fault is that this session is absent", () => {
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", "me");
		fakeClaude(listing("someone-else"));
		const r = liveness.listedAgents({ requireSelf: false });
		expect(r.why).toBeUndefined();
		expect(r.agents).toHaveLength(1);
	});

	it.each([
		["unset", {}],
		["true", { requireSelf: true }],
		["undefined", { requireSelf: undefined }],
		["null", { requireSelf: null }],
		["0", { requireSelf: 0 }],
		["the string 'false'", { requireSelf: "false" }],
	])("keeps the self-test when requireSelf is %s", (_name, opts) => {
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", "me");
		fakeClaude(listing("someone-else"));
		expect(liveness.listedAgents(opts).why).toContain(
			"does not list this very session",
		);
	});

	it.each([
		["the binary will not run", () => fakeClaude({ exit: 3 }), "would not run"],
		[
			"the output is not JSON",
			() => fakeClaude(malformed("not json")),
			"did not return JSON",
		],
		[
			"the output is not an array",
			() => fakeClaude(malformed('{"a":1}')),
			"not the expected array",
		],
		["the array is empty", () => fakeClaude([]), "listed no agents at all"],
		[
			"no record carries a sessionId",
			() => fakeClaude(malformed('[{"pid":1}]')),
			"none of them carrying a sessionId",
		],
	])("still refuses when %s", (_name, arrange, fragment) => {
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", "me");
		arrange();
		const r = liveness.listedAgents({ requireSelf: false });
		expect(r.agents).toBeUndefined();
		expect(r.why).toContain(fragment);
	});

	it("does not exempt listedSessionIds, whose callers rely on the self-test", () => {
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", "me");
		fakeClaude(listing("someone-else"));
		const r = liveness.listedSessionIds({ requireSelf: false });
		expect(r.ids).toBeUndefined();
		expect(r.why).toContain("does not list this very session (me)");
	});
});

describe("what it returns when it can answer", () => {
	it("hands back the whole record, not just the id", () => {
		fakeClaude(listing("a"));
		const [agent] = answeredAgents();
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
		vi.stubEnv("WFC_CLAUDE_BIN", undefined);
		expect(liveness.claudeBin()).toBe("claude");
	});
});

describe("every plan's listing (#3512)", () => {
	function seats({ bFails = false } = {}) {
		const a = path.join(dir, "seat-a");
		const b = path.join(dir, "seat-b");
		fs.mkdirSync(a);
		fs.mkdirSync(b);
		vi.stubEnv("WFC_CLAUDE_CONFIG_A", a);
		vi.stubEnv("WFC_CLAUDE_CONFIG_B", b);
		const absent = path.join(dir, "no-such-seat");
		vi.stubEnv("WFC_CLAUDE_CONFIG_C", absent);
		fakeClaude(listing("own"), {
			[a]: listing("a1", "shared"),
			[b]: bFails ? { exit: 4 } : listing("b1", "shared"),
			[absent]: listing("absent"),
		});
	}

	it("unions every existing seat's listing, one record per session, reading no absent seat", () => {
		seats();
		const ids = answeredAgents().map((r) => r.sessionId);
		expect(ids.sort()).toEqual(["a1", "b1", "own", "shared"]);
	});

	it("names on each record the seat whose dir listed it (#5293)", () => {
		seats();
		const seatOf = new Map(answeredAgents().map((r) => [r.sessionId, r.seat]));
		expect(seatOf.get("a1")).toBe(path.join(dir, "seat-a"));
		expect(seatOf.get("b1")).toBe(path.join(dir, "seat-b"));
		expect(seatOf.get("shared")).toBe(path.join(dir, "seat-a"));
	});

	it("keeps a seat's live record over an earlier seat's terminal one for one session (#3734)", () => {
		const a = path.join(dir, "seat-a");
		fs.mkdirSync(a);
		vi.stubEnv("WFC_CLAUDE_CONFIG_A", a);
		vi.stubEnv("WFC_CLAUDE_CONFIG_B", path.join(dir, "no-b"));
		vi.stubEnv("WFC_CLAUDE_CONFIG_C", path.join(dir, "no-c"));
		const moved = { sessionId: "moved", id: "moved", kind: "background" };
		fakeClaude([buildUnrecordedRow({ ...moved, state: "stopped" })], {
			[a]: [buildListedRow({ ...moved, state: "working" })],
		});
		expect(liveness.listedAgents({ requireSelf: false }).agents).toMatchObject([
			{ sessionId: "moved", state: "working" },
		]);
	});

	it("refuses the whole listing where any one seat's read fails", () => {
		seats({ bFails: true });
		const r = liveness.listedAgents();
		expect(r.agents).toBeUndefined();
		expect(r.why).toContain("exit 4");
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
		const ids = answeredIds();
		expect([...ids.ids]).toEqual(["a", "h"]);
		expect([...sweptIds().ids]).toContain("h");
	});

	it("lists a run once, though the oracle derives an interactive row from its transcript (#4588)", () => {
		fakeClaude([
			...listing("a"),
			buildListedRow({ pid: 101, sessionId: "h", kind: "interactive" }),
		]);
		headlessRun("0123abcd", "h");
		expect(liveness.listedAgents().agents).toEqual([
			expect.objectContaining({ sessionId: "a" }),
			expect.objectContaining({ sessionId: "h", kind: "headless" }),
		]);
	});

	it("drops a live oracle row sharing a run's pid under another session id, never a dead one (#4588)", () => {
		fakeClaude([
			...listing("a"),
			buildListedRow({ pid: process.pid, sessionId: "x", kind: "interactive" }),
			buildUnrecordedRow({
				pid: process.pid,
				sessionId: "old",
				state: "failed",
				kind: "background",
			}),
		]);
		headlessRun("0123abcd", "h");
		expect(answeredAgents().map((a) => a.sessionId)).toEqual(["a", "old", "h"]);
	});

	it("lists no ended run, a reused pid included", () => {
		fakeClaude(listing("a"));
		headlessRun("0123abcd", "h", false);
		expect([...answeredIds().ids]).toEqual(["a"]);
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
			expect("agents" in r ? r.agents : undefined).toBeUndefined();
			expect("ids" in r ? r.ids : undefined).toBeUndefined();
		}
	});

	it("passes the self-test for a headless session the oracle cannot list", () => {
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", "h");
		headlessRun("0123abcd", "h");
		fakeClaude(listing("a"));
		expect(answeredIds().ids.has("h")).toBe(true);
		fakeClaude([]);
		expect(liveness.listedSessionIds().ids).toEqual(new Set(["h"]));
	});

	it("still fails the self-test once the session's run has ended", () => {
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", "h");
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
		assert(r.why === undefined);
		expect([...r.ids].sort()).toEqual(["a", "b"]);
	});

	it("maps each session id to its pid", () => {
		fakeClaude(listing("a", "b"));
		const r = answeredIds();
		expect(r.pids.get("a")).toBe(100);
		expect(r.pids.get("b")).toBe(101);
	});

	it("maps each session to its cwd, whatever its state", () => {
		fakeClaude([
			buildListedRow({ sessionId: "me", cwd: "/r/a" }),
			buildListedRow({ sessionId: "w", cwd: "/r/b" }),
			buildListedRow({ sessionId: "d", state: "done", cwd: "/r/c" }),
			buildUnrecordedRow({ sessionId: "nocwd", state: "working" }),
		]);
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", "me");
		expect([...answeredIds().cwds]).toEqual([
			["me", "/r/a"],
			["w", "/r/b"],
			["d", "/r/c"],
			["nocwd", ""],
		]);
	});

	it("leaves a record with no pid absent from the map", () => {
		fakeClaude([buildListedRow({ sessionId: "me" }, ["pid", "status"])]);
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", "me");
		expect(answeredIds().pids.has("me")).toBe(false);
	});

	it("derives the finished and terminal sets from the oracle's own state", () => {
		fakeClaude([
			buildListedRow({ sessionId: "me", kind: "session" }),
			buildListedRow({ sessionId: "done-1", state: "done" }),
			buildUnrecordedRow({
				sessionId: "fail-1",
				kind: "background",
				state: "failed",
			}),
			buildUnrecordedRow({ sessionId: "bare" }),
		]);
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", "me");
		const r = answeredIds();
		expect([...r.finished]).toEqual(["done-1"]);
		expect([...r.terminal]).toEqual(["done-1", "fail-1"]);
	});

	it("holds the background sessions the oracle calls done", () => {
		fakeClaude([
			buildListedRow({ sessionId: "me", kind: "session" }),
			buildListedRow({ sessionId: "done-1", state: "done" }),
		]);
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", "me");
		expect([...answeredIds().finished]).toEqual(["done-1"]);
	});

	/* The reaper's gate 1 exactly (mantahostels#768; doc-map
	 * https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/session-state-status-skew.md). A `shell` session pairs `state: done` with `status: busy`, and must
	 * still count here. */
	it("reads kind and state alone, never status", () => {
		fakeClaude([
			buildListedRow({ sessionId: "me", kind: "session" }),
			buildUnrecordedRow({
				sessionId: "shell",
				kind: "background",
				state: "done",
				status: "busy",
			}),
		]);
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", "me");
		expect([...answeredIds().finished]).toEqual(["shell"]);
	});

	it.each([
		[
			"a background session still working",
			{ kind: "background", state: "working" },
		],
		["a foreground session that is done", { kind: "session", state: "done" }],
		["a record whose state the oracle omitted", { kind: "background" }],
	])("leaves out %s", (_name, extra: Record<string, string>) => {
		fakeClaude([buildUnrecordedRow({ sessionId: "me", ...extra })]);
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", "me");
		const r = answeredIds();
		expect(r.finished.size).toBe(0);
	});

	it.each([
		["the binary will not run", () => fakeClaude({ exit: 3 })],
		["the output is not JSON", () => fakeClaude(malformed("not json"))],
		["the output is not an array", () => fakeClaude(malformed('{"a":1}'))],
		["the array is empty", () => fakeClaude([])],
		[
			"no record carries a sessionId",
			() => fakeClaude(malformed('[{"pid":1}]')),
		],
		[
			"the self-test fails",
			() => {
				vi.stubEnv("CLAUDE_CODE_SESSION_ID", "me");
				fakeClaude(listing("other"));
			},
		],
	])("passes the refusal through when %s", (_name, arrange) => {
		arrange();
		const r = liveness.listedSessionIds();
		expect(r.ids).toBeUndefined();
		expect(typeof r.why).toBe("string");
		expect(r.why).toBe(liveness.listedAgents().why);
	});
});

describe("sweepSessionIds", () => {
	it("adds the starting session it is handed, run with no session id of its own (#4706)", () => {
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", undefined);
		fakeClaude(listing("other"));
		expect([...sweptIds(undefined, "me").ids].sort()).toEqual(["me", "other"]);
	});

	it("answers where the only omission is the calling session", () => {
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", "me");
		fakeClaude(listing("other"));
		expect(liveness.listedSessionIds().ids).toBeUndefined();
		const r = liveness.sweepSessionIds();
		expect(r.why).toBeUndefined();
		assert(r.why === undefined);
		expect([...r.ids].sort()).toEqual(["me", "other"]);
	});

	it("adds the caller back rather than passing the short list through", () => {
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", "me");
		fakeClaude(listing("other"));
		expect(sweptIds().ids.has("me")).toBe(true);
	});

	it("adds nothing outside a session, where there is no caller to add", () => {
		fakeClaude(listing("other"));
		expect([...sweptIds().ids]).toEqual(["other"]);
	});

	it.each([
		["the binary will not run", () => fakeClaude({ exit: 3 })],
		["the output is not JSON", () => fakeClaude(malformed("not json"))],
		["the output is not an array", () => fakeClaude(malformed('{"a":1}'))],
		["the array is empty", () => fakeClaude([])],
		[
			"no record carries a sessionId",
			() => fakeClaude(malformed('[{"pid":1}]')),
		],
	])("still refuses when %s", (_name, arrange) => {
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", "me");
		arrange();
		const r = liveness.sweepSessionIds();
		expect(r.ids).toBeUndefined();
		expect(r.why).toBe(liveness.listedAgents({ requireSelf: false }).why);
	});

	it("carries display names, minus the caller it added back", () => {
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", "me");
		fakeClaude([
			buildListedRow({ sessionId: "other", name: "Implement 1924" }),
			buildUnrecordedRow({ pid: 2, sessionId: "nameless", kind: "session" }),
		]);
		const r = sweptIds();
		expect(r.names.get("other")).toBe("Implement 1924");
		expect(r.names.has("nameless")).toBe(false);
		expect(r.names.has("me")).toBe(false);
	});

	it("ignores a caller trying to set requireSelf back to true", () => {
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", "me");
		fakeClaude(listing("other"));
		expect([...sweptIds({ requireSelf: true }).ids].sort()).toEqual([
			"me",
			"other",
		]);
	});

	it("holds the background sessions the oracle calls done, like listedSessionIds", () => {
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", "me");
		fakeClaude([
			buildListedRow({ sessionId: "me", kind: "session" }),
			buildListedRow({ sessionId: "done-1", state: "done" }),
		]);
		expect([...sweptIds().finished]).toEqual(["done-1"]);
	});

	it("never adds the caller it added back to `ids` into `finished`", () => {
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", "me");
		fakeClaude(listing("other"));
		expect(sweptIds().finished.has("me")).toBe(false);
	});

	it.each(["done", "failed", "stopped"])(
		"holds a background session the oracle calls %s",
		(state) => {
			vi.stubEnv("CLAUDE_CODE_SESSION_ID", "me");
			fakeClaude([
				buildListedRow({ sessionId: "me", kind: "session" }),
				buildUnrecordedRow({ sessionId: "ended", kind: "background", state }),
			]);
			expect([...sweptIds().terminal]).toEqual(["ended"]);
		},
	);

	it("leaves a failed session out of `finished` while holding it in `terminal`", () => {
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", "me");
		fakeClaude([
			buildListedRow({ sessionId: "me", kind: "session" }),
			buildUnrecordedRow({
				sessionId: "failed-1",
				kind: "background",
				state: "failed",
			}),
		]);
		const r = sweptIds();
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
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", "me");
		fakeClaude([buildUnrecordedRow({ sessionId: "me", ...extra })]);
		expect(sweptIds().terminal.size).toBe(0);
	});

	it("never adds the caller it added back to `ids` into `terminal`", () => {
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", "me");
		fakeClaude(listing("other"));
		expect(sweptIds().terminal.has("me")).toBe(false);
	});
});

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
		fakeClaude(malformed(body));
		for (const call of [liveness.listedAgents, liveness.listedSessionIds]) {
			const r = call();
			expect(r).toBeTypeOf("object");
			const answered =
				("agents" in r && r.agents !== undefined) ||
				("ids" in r && r.ids !== undefined);
			expect(answered || typeof r.why === "string").toBe(true);
			expect(answered && r.why !== undefined).toBe(false);
		}
	});

	it.each(payloads)("refuses on %s inside a session too", (_n, body) => {
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", "me");
		fakeClaude(malformed(body));
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
		const { why } = liveness.listedAgents({ read: boom });
		assert(why);
		expect(why.length).toBeLessThan(400);
	});

	it("ignores a positional argument, so a stray caller cannot supply a reader", () => {
		fakeClaude(listing("a"));
		const boom = () => {
			throw new Error("should never run");
		};
		const stray: object = boom;
		expect(liveness.listedAgents(stray).agents).toHaveLength(1);
		expect([...answeredIds(stray).ids]).toEqual(["a"]);
		const positional: Record<never, never>[] = ["x"];
		const [mapped] = positional.map(liveness.listedSessionIds);
		assert(mapped.why === undefined);
		expect([...mapped.ids]).toEqual(["a"]);
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
			const good = read({ read: () => ({ agents: [{ sessionId: "a" }] }) });
			assert(good.why === undefined);
			expect([...good.ids]).toContain("a");
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
