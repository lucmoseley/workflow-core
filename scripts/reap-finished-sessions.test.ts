// @vitest-environment node
/*
 * Pins the reaper that stops finished background sessions: its gates, its
 * plan, every path where it degrades to reaping nothing, the retry window
 * after a failed stop, and its SessionStart wiring.
 *
 * The judgement — every gate, the retry window, the per-run ceiling, the
 * report, the deaths a wedged run counts — lives in lib/reaper.js and is
 * driven through `reap` and `openedRecord`, the two exports the program calls,
 * against a frozen clock and injected readings: end to end the program reads
 * the real clock and /proc and spawns git, and `deaths` shows only in a row a
 * killed run left open. What the program
 * itself reads and writes — the claim store, the finish clock, the state and
 * run files, persist mode, its command line — is pinned by running it in a
 * sandbox config dir holding a fixture registry (lib/registry-agents.js),
 * against a fake `claude` (WFC_CLAUDE_BIN) answering its stops, so no test
 * stops a real session. Nothing is imported from the program: §G6 exports
 * nothing for a test alone (#1369).
 *
 * Breaking it either stops a session still working, or leaves finished ones
 * holding memory, so admission turns new sessions away (mantahostels#421).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process";

// biome-ignore lint/suspicious/noExplicitAny: CommonJS module
const { readProcStartOf } = require("./lib/arbiter-proc.js") as any;
// biome-ignore lint/suspicious/noExplicitAny: CommonJS module
const { projectSlug } = require("./lib/project-slug.js") as any;

const {
	reap,
	openedRecord,
	// biome-ignore lint/suspicious/noExplicitAny: CommonJS module under test
} = require("./lib/reaper.js") as any;

/* A state-file row: the bare first-sighting stamp, or the record a failed stop
 * leaves behind (mantahostels#846). */
type StateRow =
	| number
	| {
			since: number;
			failures: number;
			retryAt: number;
			lastError?: string | null;
	  };

const SCRIPT = path.resolve(__dirname, "reap-finished-sessions.js");

const NOW = 1_787_030_000_000;

/* The test's own figures, never the module's constants (#1369): the per-run
 * ceiling, and the first and longest retry windows (mantahostels#846). */
const CAP = 10;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/* The name the persisted report is filed under — the replay reader keys on it
 * (mantahostels#2152). */
const REPORT_NAME = "reap-finished-sessions";

interface Agent {
	sessionId: string;
	id?: string;
	name: string;
	kind: string;
	state: string;
	status: string;
	tempo?: string;
}

function agent(over: Partial<Agent> = {}): Agent {
	return {
		sessionId: "aaaa-1",
		id: "aaaa",
		name: "a finished session",
		kind: "background",
		state: "done",
		status: "idle",
		...over,
	};
}

interface ReapOverrides {
	argv?: string[];
	listed?: unknown;
	claims?: unknown;
	self?: string | null;
	state?: Record<string, StateRow>;
	finishAt?: (a: Agent) => number | null;
	lastTurn?: (a: Agent) => { ended: boolean; at: number | null } | null;
	stop?: (id: string) => { ok: boolean; why?: string };
	isDirty?: (f: string) => boolean | null;
	runs?: Record<string, object>;
}

/**
 * One `reap` against the frozen clock, every write captured: the lines it
 * logged, the states it saved, the job ids it stopped and the run records it
 * wrote. By default it lists one finished, unclaimed session and stops it.
 */
function reapWith(over: ReapOverrides = {}) {
	const lines: string[] = [];
	const saved: Record<string, StateRow>[] = [];
	const stopped: string[] = [];
	// biome-ignore lint/suspicious/noExplicitAny: run records as written
	const records: any[] = [];
	const verdict = reap({
		argv: [],
		listed: { faults: [], seats: ["/s"], agents: [agent()] },
		claims: { held: new Map<string, string[]>() },
		// A real session id that matches no fixture, so gate 2 is satisfied
		// without hiding it: the unset case is its own test.
		self: "the-running-session",
		now: NOW,
		// Default: finished long enough ago to be past the grace window.
		state: { "aaaa-1": NOW - 1 },
		finishAt: () => null,
		// Default: its transcript shows its last turn ended.
		lastTurn: () => ({ ended: true, at: null }),
		stop: (id: string) => {
			stopped.push(id);
			return { ok: true };
		},
		readPss: () => 400,
		isDirty: () => false,
		runs: {},
		// biome-ignore lint/suspicious/noExplicitAny: run records as written
		recordRun: (r: any) => {
			records.push(r);
		},
		saveState: (s: Record<string, StateRow>) => {
			saved.push(s);
		},
		log: (l: string) => {
			lines.push(l);
		},
		...over,
	});
	return {
		lines,
		saved,
		stopped,
		records,
		verdict,
		out: lines.join("\n"),
	};
}

/**
 * The plan for one run: `reap` under `--dry-run --json`, which judges every
 * session and stops none, read back as what it would take (`reap`), what it
 * held back (`kept`), the state it saves (`nextState`) and the run record it
 * closes (`record`).
 */
function run({
	agents,
	held,
	...over
}: Omit<ReapOverrides, "argv" | "stop"> & {
	agents?: Agent[];
	held?: Map<string, string[]>;
}) {
	const h = reapWith({
		...over,
		argv: ["--dry-run", "--json"],
		...(agents && { listed: { faults: [], seats: ["/s"], agents } }),
		...(held && { claims: { held } }),
		stop: () => {
			throw new Error("a dry run stops nothing");
		},
	});
	const out = JSON.parse(h.out);
	return {
		reap: out.reaped,
		kept: out.kept,
		nextState: h.saved[0],
		record: h.records.at(-1),
	};
}

const ids = (list: Agent[]) => list.map((a) => a.sessionId);

/**
 * The registry the program reads its pool from (lib/registry-agents.js,
 * #2665), laid under `seat`: one `sessions/<n>.json` per agent naming this
 * test's own process — running, with its real start time — and each job's
 * `state.json`, merged into one the test laid down itself and never written
 * over one that will not parse. Answers the body of a fake `claude` that
 * exits 0 to a stop.
 */
function registered(seat: string, agents: Agent[]) {
	const sessions = path.join(seat, "sessions");
	fs.mkdirSync(sessions, { recursive: true });
	const procStart = readProcStartOf(process.pid);
	agents.forEach((a, i) => {
		fs.writeFileSync(
			path.join(sessions, `${i + 1}.json`),
			JSON.stringify({
				pid: process.pid,
				procStart,
				sessionId: a.sessionId,
				kind: a.kind === "background" ? "bg" : a.kind,
				name: a.name,
				...(a.id && { jobId: a.id }),
			}),
		);
		if (!a.id) return;
		const file = path.join(seat, "jobs", a.id, "state.json");
		let rec = {};
		if (fs.existsSync(file))
			try {
				rec = JSON.parse(fs.readFileSync(file, "utf8"));
			} catch {
				return;
			}
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const testLaidRecord = Object.keys(rec).length > 0;
		const job: Record<string, unknown> = {
			...rec,
			...(!testLaidRecord && { cwd: "/registered" }),
			sessionId: a.sessionId,
			state: a.state,
			...(a.tempo && { tempo: a.tempo }),
		};
		fs.writeFileSync(file, JSON.stringify(job));
		if (!testLaidRecord) endedTranscript(seat, "/registered", a.sessionId);
	});
	return "exit 0\n";
}

/** A turn's closing rows, as the harness writes them once a turn has ended. */
const ENDED_TURN = `${[
	{ type: "assistant", message: { content: [] } },
	{ type: "system", subtype: "stop_hook_summary" },
	{ type: "system", subtype: "turn_duration" },
]
	.map((r) => JSON.stringify(r))
	.join("\n")}\n`;

/**
 * A transcript whose last turn ended, where the program looks for `sessionId`'s
 * — unless the test laid one there itself. Dated at `firstTerminalAt` where
 * that is set, so the finish clock still reads the stamp the test laid.
 */
function endedTranscript(
	seat: string,
	cwd: string,
	sessionId: string,
	firstTerminalAt?: string,
) {
	const t = path.join(seat, "projects", projectSlug(cwd), `${sessionId}.jsonl`);
	if (fs.existsSync(t)) return;
	fs.mkdirSync(path.dirname(t), { recursive: true });
	fs.writeFileSync(t, ENDED_TURN);
	const at = Date.parse(String(firstTerminalAt));
	if (Number.isFinite(at)) fs.utimesSync(t, at / 1000, at / 1000);
}

/**
 * The program run for real with `sandbox` as its config dir and cwd, against a
 * fake `claude` whose shell body is `stub`, as a session the fake does not
 * list. `subprocess` spawns a real process instead, for a case that kills it;
 * a timeout or a non-zero exit then throws.
 */
function runReaper(
	sandbox: string,
	stub: string,
	argv: string[],
	opts: {
		env?: Record<string, string>;
		subprocess?: { timeout?: number };
	} = {},
) {
	const bin = path.join(sandbox, "claude");
	fs.writeFileSync(bin, `#!/bin/sh\n${stub}`, { mode: 0o755 });
	const env = {
		...process.env,
		CLAUDE_CONFIG_DIR: sandbox,
		/* The sandbox as the only seat, so no stop is retried on a sibling of the
		 * tmpdir (#1571); the two-seat cases override all three. */
		WFC_CLAUDE_CONFIG_A: sandbox,
		WFC_CLAUDE_CONFIG_B: sandbox,
		WFC_CLAUDE_CONFIG_C: sandbox,
		WFC_CLAUDE_BIN: bin,
		CLAUDE_CODE_SESSION_ID: "the-session-this-hook-started-in",
		...opts.env,
	};
	if (!opts.subprocess)
		return runInProcess(SCRIPT, argv, { cwd: sandbox, env });
	// spawn-kept: a timeout kills the run inside its slow part (mantahostels#1920).
	const res = spawnSync(process.execPath, [SCRIPT, ...argv], {
		encoding: "utf8",
		cwd: sandbox,
		env,
		timeout: opts.subprocess.timeout,
	});
	if (res.error) throw res.error;
	if (res.status !== 0) throw new Error(`exit ${res.status}: ${res.stderr}`);
	return { status: 0, stdout: res.stdout, stderr: res.stderr };
}

/* The claim store as main() reads it: lock records under the sandbox config
 * dir, judged through a `--dry-run --json` run whose reaped rows carry the
 * paths each holder claimed. */
describe("the claim store, as the run reads it", () => {
	let sandbox: string;
	let project: string;
	let locksDir: string;

	beforeEach(() => {
		sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "reap-claims-"));
		project = fs.mkdtempSync(path.join(os.tmpdir(), "reap-claims-proj-"));
		locksDir = path.join(
			sandbox,
			"projects",
			project.replace(/[^a-zA-Z0-9]/g, "-"),
			"locks",
		);
		fs.mkdirSync(locksDir, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(sandbox, { recursive: true, force: true });
		fs.rmSync(project, { recursive: true, force: true });
	});

	function writeLock(name: string, body: string) {
		fs.writeFileSync(path.join(locksDir, `${name}.json`), body);
	}

	function runWith(holders: string[]) {
		const listing = holders.map((h) =>
			agent({ sessionId: h, id: h.replace("-", ""), name: h }),
		);
		const res = runReaper(
			sandbox,
			registered(sandbox, listing),
			["--dry-run", "--json"],
			{
				env: { CLAUDE_PROJECT_DIR: project },
			},
		);
		expect(res.status, "reap-finished-sessions.js must exit 0").toBe(0);
		const r = JSON.parse(res.stdout);
		const claimsOf = (holder: string) =>
			r.reaped.find((a: Agent) => a.sessionId === holder)?.claims;
		return { ...r, claimsOf };
	}

	it("reports the holders of every readable claim", () => {
		writeLock("a", JSON.stringify({ sessionId: "holder-1", path: "a.md" }));
		writeLock("b", JSON.stringify({ sessionId: "holder-2", path: "b.md" }));
		const r = runWith(["holder-1", "holder-2"]);
		expect(r.claimsUnread).toBeNull();
		expect(r.claimsOf("holder-1")).toEqual(["a.md"]);
		expect(r.claimsOf("holder-2")).toEqual(["b.md"]);
	});

	/* The paths are the whole reason this is read at all: the reaper decides
	 * nothing on a claim (mantahostels#747). */
	it("reports every path one holder claims, grouped under it", () => {
		writeLock("a", JSON.stringify({ sessionId: "holder-1", path: "a.md" }));
		writeLock("b", JSON.stringify({ sessionId: "holder-1", path: "b.md" }));
		const r = runWith(["holder-1"]);
		expect([...r.claimsOf("holder-1")].sort()).toEqual(["a.md", "b.md"]);
	});

	/* mantahostels#1692, where one bad record ended the whole run. */
	it("judges every readable claim past a record that will not parse", () => {
		writeLock("a", JSON.stringify({ sessionId: "holder-1", path: "a.md" }));
		writeLock("b", "{ this is not json");
		writeLock("c", ""); // the zero-byte shape the incident actually left
		const r = runWith(["holder-1", "holder-2"]);
		expect(r.claimsUnread).toBeNull();
		expect(r.claimsOf("holder-1")).toEqual(["a.md"]);
		expect(r.claimsOf("holder-2")).toEqual([]);
		expect([...r.unnamedRecords].sort()).toEqual(["b.json", "c.json"]);
	});

	it("names a record carrying no session id rather than refusing the run", () => {
		writeLock("a", JSON.stringify({ path: "a.md" }));
		writeLock("b", JSON.stringify({ sessionId: "holder-1", path: "b.md" }));
		const r = runWith(["holder-1"]);
		expect(r.claimsUnread).toBeNull();
		expect(r.claimsOf("holder-1")).toEqual(["b.md"]);
		// Named by the PATH it claims: this one parsed, so there is no filename
		// fault to report — only its holder is missing.
		expect(r.unnamedRecords).toEqual(["a.md"]);
	});

	it("reports no unreadable records when every claim parses", () => {
		writeLock("a", JSON.stringify({ sessionId: "holder-1", path: "a.md" }));
		expect(runWith(["holder-1"]).unnamedRecords).toEqual([]);
	});

	it("reports no holders when nothing is claimed", () => {
		const r = runWith(["holder-1", "holder-2"]);
		expect(r.claimsUnread).toBeNull();
		expect(r.claimsOf("holder-1")).toEqual([]);
		expect(r.claimsOf("holder-2")).toEqual([]);
	});
});

/* Gate 1, read off where the plan files each session: taken, or turned away
 * at gate `finished` in the run record. */
describe("gate 1: finished", () => {
	const gateOf = (a: Agent) =>
		run({ agents: [a], state: { [a.sessionId]: NOW - 1 } }).record.candidates[0]
			.gate;

	it("accepts a background session the oracle calls done, whatever its status", () => {
		expect(gateOf(agent())).toBeNull();
		// A registry `status: "shell"` emits `done` and `busy` together (mantahostels#768; https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/session-state-status-skew.md).
		expect(gateOf(agent({ status: "busy" }))).toBeNull();
	});

	it("refuses a working session whatever its status, recording the finished gate", () => {
		expect(gateOf(agent({ state: "working", status: "busy" }))).toBe(
			"finished",
		);
		expect(gateOf(agent({ state: "working" }))).toBe("finished");
	});

	/* #2980: a forced Stop-hook turn runs under `done`, and `claude stop` on a
	 * job reading `tempo: active` writes `stopped` over its result. */
	it("refuses a done session whose tempo is active", () => {
		expect(gateOf(agent({ tempo: "active" }))).toBe("finished");
		expect(gateOf(agent({ tempo: "idle" }))).toBeNull();
	});

	it("refuses an interactive record, which carries neither field", () => {
		expect(gateOf(agent({ kind: "interactive" }))).toBe("finished");
		expect(
			gateOf({
				sessionId: "i-1",
				name: "an interactive session",
				kind: "interactive",
			} as unknown as Agent),
		).toBe("finished");
	});
});

describe("a headless overflow run (#2608)", () => {
	it("is never stopped, since `claude stop` cannot reach it", () => {
		for (const state of ["working", "done"]) {
			const h = reapWith({
				listed: {
					faults: [],
					seats: ["/s"],
					agents: [agent({ kind: "headless", state })],
				},
			});
			expect(h.stopped).toEqual([]);
		}
	});
});

describe("plan", () => {
	it("reaps a finished, unclaimed session that is past the grace window", () => {
		const p = run({});
		expect(ids(p.reap)).toEqual(["aaaa-1"]);
		expect(p.kept).toEqual([]);
	});

	it("reaps a finished session the oracle also calls busy", () => {
		const p = run({ agents: [agent({ status: "busy" })] });
		expect(ids(p.reap)).toEqual(["aaaa-1"]);
		expect(p.kept).toEqual([]);
	});

	it("never considers a session that is still working", () => {
		const p = run({
			agents: [agent({ state: "working", status: "busy" })],
		});
		expect(p.reap).toEqual([]);
		expect(p.kept).toEqual([]);
	});

	it("never reaps this very session", () => {
		const p = run({ self: "aaaa-1" });
		expect(p.reap).toEqual([]);
		expect(p.kept[0].why).toMatch(/this very session/);
	});

	it("reaps a finished session that still holds a file claim", () => {
		const p = run({ held: new Map([["aaaa-1", ["scripts/x.js"]]]) });
		expect(ids(p.reap)).toEqual(["aaaa-1"]);
		expect(p.kept).toEqual([]);
	});

	it("carries the paths a reaped session held, for the report to name", () => {
		const p = run({
			held: new Map([["aaaa-1", ["scripts/x.js", "docs/y.md"]]]),
		});
		expect(p.reap[0].claims).toEqual(["scripts/x.js", "docs/y.md"]);
	});

	it("carries an empty claim list for a session that held nothing", () => {
		expect(run({}).reap[0].claims).toEqual([]);
	});

	it("never attributes another session's claim to the one it reaps", () => {
		const p = run({ held: new Map([["someone-else", ["scripts/x.js"]]]) });
		expect(p.reap[0].claims).toEqual([]);
	});

	/* Zero (mantahostels#1290; docs/environment.md §5). */
	it("holds nothing back for age alone: the grace window is zero", () => {
		expect(ids(run({ finishAt: () => NOW }).reap)).toEqual(["aaaa-1"]);
		const ahead = run({ finishAt: () => NOW + 1 });
		expect(ahead.reap).toEqual([]);
		expect(ahead.kept[0].gate).toBe("grace");
	});

	it("reaps a session that finished a second ago", () => {
		const p = run({ state: { "aaaa-1": NOW - 1000 } });
		expect(ids(p.reap)).toEqual(["aaaa-1"]);
	});

	it("reaps a second past the window on the ordinary path", () => {
		const p = run({ state: { "aaaa-1": NOW - 61_000 } });
		expect(ids(p.reap)).toEqual(["aaaa-1"]);
	});

	/* The stamp is written before the age gate, so it still lands on the run that
	 * reaps. */
	it("stamps a newly-finished session even as it reaps it", () => {
		const p = run({ state: {} });
		expect(p.nextState["aaaa-1"]).toBe(NOW);
		expect(ids(p.reap)).toEqual(["aaaa-1"]);
	});

	it("keeps the original first-seen time across runs", () => {
		const first = NOW - 120_000;
		const p = run({ state: { "aaaa-1": first } });
		expect(p.nextState["aaaa-1"]).toBe(first);
	});

	it("caps one run at ten", () => {
		const agents: Agent[] = [];
		const state: Record<string, number> = {};
		for (let i = 0; i < CAP + 5; i++) {
			agents.push(agent({ sessionId: `s-${i}`, id: `s${i}` }));
			state[`s-${i}`] = NOW - 1;
		}
		const p = run({ agents, state });
		expect(p.reap).toHaveLength(CAP);
		// The rest are reaped at the next start, and the record names them.
		expect(
			// biome-ignore lint/suspicious/noExplicitAny: record rows
			p.record.candidates.filter((c: any) => c.gate === "cap"),
		).toHaveLength(5);
	});

	it("sorts each finished session into exactly one of reap or kept", () => {
		const agents = [
			agent({ sessionId: "reapable" }),
			agent({ sessionId: "mine" }),
			agent({ sessionId: "claimed" }),
			agent({ sessionId: "busy", state: "working", status: "busy" }),
		];
		const state = Object.fromEntries(agents.map((a) => [a.sessionId, NOW - 1]));
		const p = run({
			agents,
			state,
			self: "mine",
			held: new Map([["claimed", ["scripts/x.js"]]]),
		});
		expect(ids(p.reap).sort()).toEqual(["claimed", "reapable"]);
		expect(ids(p.kept)).toEqual(["mine"]);
	});
});

describe("reap — the degradation paths", () => {
	/* #2665: a seat that will not read costs its own sessions, not the run. */
	const darkSeat = {
		listed: {
			agents: [agent()],
			faults: ["/s/sessions would not read (EACCES)"],
			seats: ["/t"],
		},
	};

	it("returns DEGRADED where no seat's registry would read", () => {
		const listed = {
			agents: [],
			faults: ["/s/sessions would not read (EACCES)"],
			seats: [],
		};
		expect(reapWith({ listed }).verdict).toBe("degraded");
		expect(reapWith(darkSeat).verdict).toBe("clean");
	});

	it("keeps the state rows of sessions a seat that would not read could not list", () => {
		const held = { since: NOW - 1, failures: 1, retryAt: NOW + HOUR };
		const h = reapWith({
			...darkSeat,
			state: { "aaaa-1": NOW - 1, "unread-1": held },
		});
		expect(h.saved[0]["unread-1"]).toEqual(held);
	});

	it("reaps what the other seats listed, naming a seat whose registry would not read", () => {
		const h = reapWith(darkSeat);
		expect(h.stopped).toEqual(["aaaa"]);
		expect(h.lines[0]).toBe(
			"reap: /s/sessions would not read (EACCES), so its sessions went unjudged",
		);
	});

	it("carries a seat that would not read into the --json report and the run record", () => {
		const h = reapWith({ ...darkSeat, argv: ["--json"] });
		expect(JSON.parse(h.out).faults).toEqual([
			"/s/sessions would not read (EACCES)",
		]);
		expect(h.records.at(-1).faults).toEqual([
			"/s/sessions would not read (EACCES)",
		]);
	});

	/* mantahostels#747: a claim decides nothing, so an unreadable store costs the naming and
	 * not the run. */
	const darkStore = {
		claims: { why: "the claim store could not be read" },
	};

	it("reaps as normal when the claim store cannot be read", () => {
		const h = reapWith(darkStore);
		expect(h.stopped).toEqual(["aaaa"]);
	});

	it("says no lock can be named when the claim store cannot be read", () => {
		expect(reapWith(darkStore).out).toContain(
			"the claim store could not be read (the claim store could not be read), so no lock this run leaves stale can be named",
		);
	});

	it("says nothing about an unreadable store when it stopped nothing", () => {
		const h = reapWith({
			...darkStore,
			listed: {
				faults: [],
				seats: ["/s"],
				agents: [agent({ state: "working", status: "busy" })],
			},
		});
		expect(h.stopped).toEqual([]);
		expect(h.out).not.toContain("no lock this run leaves stale");
	});

	it("carries the unreadable store into the --json report", () => {
		const h = reapWith({ ...darkStore, argv: ["--json"] });
		expect(JSON.parse(h.out).claimsUnread).toBe(
			"the claim store could not be read",
		);
	});

	/* mantahostels#1692: individual records that would not parse, as against the whole store
	 * going dark above. */
	const badRecords = {
		claims: {
			held: new Map([["aaaa-1", ["docs/a.md"]]]),
			unnamed: ["b.json", "c.json"],
		},
	};

	it("names the records that would not parse, and still names what it read", () => {
		const h = reapWith(badRecords);
		expect(h.out).toContain(
			"2 lock record(s) name no holder this run could read",
		);
		expect(h.out).toContain("b.json, c.json");
		expect(h.out).toContain("docs/a.md");
	});

	it("says nothing about bad records when every claim parsed", () => {
		expect(reapWith().out).not.toContain("name no holder");
	});

	it("carries the unparseable records into the --json report", () => {
		const h = reapWith({ ...badRecords, argv: ["--json"] });
		expect(JSON.parse(h.out).unnamedRecords).toEqual(["b.json", "c.json"]);
	});

	it("reaps nothing, and stops nothing, when this session has no id of its own", () => {
		const h = reapWith({ self: undefined });
		expect(h.stopped).toEqual([]);
		expect(h.saved).toEqual([]);
		expect(h.out).toMatch(/^reap: nothing — CLAUDE_CODE_SESSION_ID is unset/);
	});

	it("reaps for a caller that is no session, sparing none as its own", () => {
		const h = reapWith({ self: null });
		expect(h.stopped).toEqual(["aaaa"]);
	});

	it("reports a degradation as an empty reap under --json", () => {
		const h = reapWith({ argv: ["--json"], self: undefined });
		expect(JSON.parse(h.out)).toEqual({
			reaped: [],
			why: expect.stringMatching(/^CLAUDE_CODE_SESSION_ID is unset/),
			previousRunUnfinished: null,
		});
	});

	it("reports a session `claude stop` refused to stop, rather than claiming it went", () => {
		const h = reapWith({ stop: () => ({ ok: false, why: "exit 1" }) });
		expect(h.out).toContain("reap: could not stop aaaa (exit 1)");
		expect(h.out).not.toMatch(/reap: stopped/);
	});

	/* The stamp is kept so the next attempt is not made to serve a fresh grace
	 * window. */
	it("keeps the first-seen stamp of a session that would not stop", () => {
		const h = reapWith({ stop: () => ({ ok: false, why: "exit 1" }) });
		expect(h.saved[0]["aaaa-1"]).toMatchObject({ since: NOW - 1 });
	});

	it("drops the stamp of a session that did stop", () => {
		const h = reapWith({});
		expect(h.saved[0]["aaaa-1"]).toBeUndefined();
	});

	/* mantahostels#846: what stops the retry happening again at the very next session start. */
	it("records the failure, and a window before the next attempt", () => {
		const h = reapWith({ stop: () => ({ ok: false, why: "exit 1" }) });
		expect(h.saved[0]["aaaa-1"]).toEqual({
			since: NOW - 1,
			failures: 1,
			retryAt: NOW + HOUR,
			lastError: "exit 1",
		});
	});

	/* #2665: a busy daemon, not a refusal. */
	const timedOut = () => ({ ok: false, why: "ETIMEDOUT", timedOut: true });

	it("records no failure for a stop that timed out, so the next run retries it", () => {
		const h = reapWith({ stop: timedOut });
		expect(h.saved[0]["aaaa-1"]).toBe(NOW - 1);
		expect(h.out).toContain("reap: could not stop aaaa (ETIMEDOUT)");
	});

	it("does not hold back a session whose earlier refusal has expired and whose stop now times out", () => {
		const h = reapWith({
			stop: timedOut,
			state: { "aaaa-1": { since: NOW - 1, failures: 2, retryAt: NOW - 1 } },
		});
		expect(h.saved[0]["aaaa-1"]).toBe(NOW - 1);
	});

	it("still backs a refusal off an hour", () => {
		const h = reapWith({
			stop: () => ({ ok: false, why: "exit 1: No job matching 'aaaa'." }),
		});
		expect(h.saved[0]["aaaa-1"]).toMatchObject({
			failures: 1,
			retryAt: NOW + HOUR,
		});
	});

	it("doubles the window on a second consecutive failure", () => {
		const h = reapWith({
			state: {
				"aaaa-1": {
					since: NOW - 1,
					failures: 1,
					retryAt: NOW - 1,
				},
			},
			stop: () => ({ ok: false, why: "exit 1" }),
		});
		expect(h.stopped).toEqual([]);
		expect(h.saved[0]["aaaa-1"]).toMatchObject({
			failures: 2,
			retryAt: NOW + 2 * HOUR,
		});
	});

	it("clears a standing failure record when the stop finally works", () => {
		const h = reapWith({
			state: {
				"aaaa-1": { since: NOW - 1, failures: 3, retryAt: NOW - 1 },
			},
		});
		expect(h.stopped).toEqual(["aaaa"]);
		expect(h.saved[0]["aaaa-1"]).toBeUndefined();
	});

	/* A held-back session, i.e. one inside the window a failure opened. */
	const ghost = {
		state: {
			"aaaa-1": {
				since: NOW - 1,
				failures: 1,
				retryAt: NOW + 30 * 60_000,
				lastError: "exit 1: No job matching 'aaaa'.",
			},
		},
	};

	it("does not call `claude stop` at all for a held-back session", () => {
		expect(reapWith(ghost).stopped).toEqual([]);
	});

	it("names a held-back session in the ordinary report", () => {
		const out = reapWith(ghost).out;
		expect(out).toContain("reap: not retrying aaaa (a finished session)");
		expect(out).toContain("No job matching 'aaaa'.");
	});

	it("does not call a held-back session stopped", () => {
		const out = reapWith(ghost).out;
		expect(out).not.toMatch(/reap: stopped/);
		expect(out).not.toMatch(/reap: could not stop/);
	});

	it("carries a held-back session into the --json report", () => {
		const h = reapWith({ ...ghost, argv: ["--json"] });
		const r = JSON.parse(h.out);
		expect(r.reaped).toEqual([]);
		expect(r.kept[0].heldBack).toBe(true);
		expect(r.kept[0].failures).toBe(1);
	});

	/* `claude stop` and `claude attach` are both addressed by the short job id,
	 * and answer a session id with "No job matching '<id>'" and exit 1 — so the
	 * wrong spelling fails every stop, and hands back a recovery command that
	 * cannot work (mantahostels#492). */
	it("addresses claude stop by the job id", () => {
		expect(reapWith({}).stopped).toEqual(["aaaa"]);
	});

	it("hands back an attach command carrying the job id", () => {
		expect(reapWith({}).out).toContain("`claude attach aaaa`");
	});

	it("keeps, rather than stops, a session its registry record names no job for", () => {
		const listed = {
			faults: [],
			seats: ["/s"],
			agents: [agent({ id: undefined })],
		};
		expect(reapWith({ listed }).stopped).toEqual([]);
		expect(reapWith({ listed, argv: ["--dry-run"] }).out).toContain(
			"reap: keeping aaaa-1 — its registry record names no job",
		);
	});

	it("stops nothing under --dry-run, though the session is due to be reaped", () => {
		const h = reapWith({ argv: ["--dry-run"] });
		expect(h.stopped).toEqual([]);
		expect(h.out).toMatch(/^reap: would stop aaaa \(a finished session\)/);
	});

	it("stamps the clock under --dry-run", () => {
		const h = reapWith({ argv: ["--dry-run"], state: {} });
		expect(h.saved[0]["aaaa-1"]).toBe(NOW);
	});

	/*
	 * What a stop leaves behind (mantahostels#747). The reaper releases nothing: stopping
	 * the host is what makes the lock stale.
	 */
	const holding = (paths: string[]) => ({
		claims: { held: new Map([["aaaa-1", paths]]) },
	});

	it("names the file claims a stop has just left stale", () => {
		const h = reapWith(holding(["scripts/x.js"]));
		expect(h.out).toContain(
			"it held 1 file claim(s), now stale and breakable by the next session to claim them: scripts/x.js",
		);
	});

	it("marks a claimed file that carries uncommitted work", () => {
		const h = reapWith({
			...holding(["scripts/x.js", "docs/y.md"]),
			isDirty: (f: string) => f === "docs/y.md",
		});
		expect(h.out).toContain("scripts/x.js, docs/y.md (DIRTY)");
	});

	/* git answering `null` is doubt, not dirt: saying DIRTY on a git that could
	 * not run would send someone hunting a diff that is not there. */
	it("marks nothing where git could not say whether the file is clean", () => {
		const h = reapWith({ ...holding(["scripts/x.js"]), isDirty: () => null });
		expect(h.out).toContain(": scripts/x.js");
		expect(h.out).not.toContain("DIRTY");
	});

	it("says nothing about claims for a session that held none", () => {
		expect(reapWith({}).out).not.toContain("file claim(s)");
	});

	it("costs no git call at all when nothing was held", () => {
		let asked = 0;
		reapWith({
			isDirty: () => {
				asked++;
				return false;
			},
		});
		expect(asked).toBe(0);
	});

	it("names the claims a --dry-run would leave stale, without stopping", () => {
		const h = reapWith({ ...holding(["scripts/x.js"]), argv: ["--dry-run"] });
		expect(h.stopped).toEqual([]);
		expect(h.out).toContain("it held 1 file claim(s)");
	});

	it("says nothing about claims for a session it could not stop", () => {
		const h = reapWith({
			...holding(["scripts/x.js"]),
			stop: () => ({ ok: false, why: "exit 1" }),
		});
		expect(h.out).not.toContain("file claim(s)");
	});
});

describe("the state file — an unwritable config dir", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reap-state-"));
	});
	afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

	it("swallows a config directory that cannot be created, and still judges the run", () => {
		// A plain file where the config directory should be: mkdirSync throws
		// ENOTDIR for any user, root included.
		const blocked = path.join(tmp, "not-a-dir");
		fs.writeFileSync(blocked, "");
		const res = runReaper(
			tmp,
			registered(tmp, [agent()]),
			["--dry-run", "--json"],
			{
				env: { CLAUDE_CONFIG_DIR: blocked },
			},
		);
		expect(res.status, "reap-finished-sessions.js must exit 0").toBe(0);
		expect(ids(JSON.parse(res.stdout).reaped)).toEqual(["aaaa-1"]);
	});

	it("writes the state where it can", () => {
		const res = runReaper(tmp, registered(tmp, [agent()]), [
			"--dry-run",
			"--json",
		]);
		expect(res.status).toBe(0);
		const state = JSON.parse(
			fs.readFileSync(path.join(tmp, "wfc-reap-state.json"), "utf8"),
		);
		expect(Object.keys(state)).toEqual(["aaaa-1"]);
		expect(state["aaaa-1"]).toEqual(expect.any(Number));
	});
});

/* main() is the wiring the unit tests above cannot reach: the oracle refuses a
 * listing not naming the session the hook is starting in (mantahostels#535). */
describe("the SessionStart wiring: the run's own session is not yet registered", () => {
	let sandbox = "";

	beforeEach(() => {
		sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "reap-wiring-"));
	});
	afterEach(() => fs.rmSync(sandbox, { recursive: true, force: true }));

	/** Runs the script for real, as a session the fake daemon does not list.
	 * Returns the parsed `--json` object, or raw stdout where `argv` overrides it. */
	function runScript(listing: Agent[], argv?: string[]) {
		// Finished well before the grace window, so it is due rather than held.
		fs.writeFileSync(
			path.join(sandbox, "wfc-reap-state.json"),
			JSON.stringify({ "other-1": Date.now() - 60_000 }),
		);
		const res = runReaper(
			sandbox,
			registered(sandbox, listing),
			argv ?? ["--dry-run", "--json"],
		);
		expect(res.status, "reap-finished-sessions.js must exit 0").toBe(0);
		const out = res.stdout;
		return argv ? out : JSON.parse(out);
	}

	const finished = agent({ sessionId: "other-1", id: "other" });

	it("reaps a due session even though the listing omits this very session", () => {
		const r = runScript([finished]);
		expect(r.why).toBeUndefined();
		expect(r.reaped.map((a: Agent) => a.sessionId)).toEqual(["other-1"]);
	});

	it("reaps for a caller that says it is no session, with no session id set", () => {
		fs.writeFileSync(
			path.join(sandbox, "wfc-reap-state.json"),
			JSON.stringify({ "other-1": Date.now() - 60_000 }),
		);
		const res = runReaper(
			sandbox,
			registered(sandbox, [finished]),
			["--dry-run", "--json", "--not-a-session"],
			{ env: { CLAUDE_CODE_SESSION_ID: "" } },
		);
		expect(
			JSON.parse(res.stdout).reaped.map((a: Agent) => a.sessionId),
		).toEqual(["other-1"]);
	});

	it("still spares the session it runs in when one passes --not-a-session", () => {
		fs.writeFileSync(
			path.join(sandbox, "wfc-reap-state.json"),
			JSON.stringify({ "other-1": Date.now() - 60_000 }),
		);
		const res = runReaper(
			sandbox,
			registered(sandbox, [finished]),
			["--dry-run", "--json", "--not-a-session"],
			{ env: { CLAUDE_CODE_SESSION_ID: "other-1" } },
		);
		const out = JSON.parse(res.stdout);
		expect(out.reaped).toEqual([]);
		expect(out.kept[0]).toMatchObject({ sessionId: "other-1", gate: "self" });
	});

	it("names a seat whose registry will not read (#2665)", () => {
		fs.writeFileSync(path.join(sandbox, "sessions"), "");
		const res = runReaper(sandbox, "exit 0\n", ["--dry-run", "--json"]);
		expect(res.status, "reap-finished-sessions.js must exit 0").toBe(0);
		expect(JSON.parse(res.stdout).faults).toEqual([
			`${path.join(sandbox, "sessions")} would not read (ENOTDIR)`,
		]);
	});

	/* The one thing only the wiring carries: that main() passes the recorder in
	 * at all (mantahostels#1920). */
	it("leaves a closed record on disk, under the mode it ran in", () => {
		runScript([finished]);
		const runs = JSON.parse(
			fs.readFileSync(path.join(sandbox, "wfc-reap-run.json"), "utf8"),
		);
		expect(runs.dry).toMatchObject({
			mode: "dry",
			startedAt: expect.any(String),
			finishedAt: expect.any(String),
			listed: 1,
		});
		expect(runs.live).toBeUndefined();
	});

	/* THE CASE mantahostels#1920 EXISTS FOR, and the only test that can see it: a run killed
	 * inside its slow part, here a stop the daemon never answers. */
	it("leaves the start half behind when it is killed inside a stop", () => {
		registered(sandbox, [finished]);
		expect(() =>
			runReaper(sandbox, "exec sleep 20\n", [], {
				subprocess: { timeout: 3000 },
			}),
		).toThrow();
		const runs = JSON.parse(
			fs.readFileSync(path.join(sandbox, "wfc-reap-run.json"), "utf8"),
		);
		expect(runs.live).toMatchObject({
			mode: "live",
			startedAt: expect.any(String),
		});
		expect(runs.live.finishedAt).toBeUndefined();
	});

	/* The other half of the wiring: that main() reads the previous record back. */
	it("reads the previous run's record back off disk and reports it unfinished", () => {
		fs.writeFileSync(
			path.join(sandbox, "wfc-reap-run.json"),
			JSON.stringify({
				dry: { mode: "dry", startedAt: "2026-08-29T11:50:16.090Z" },
			}),
		);
		expect(runScript([finished], ["--dry-run"])).toContain(
			"the previous dry run started 2026-08-29T11:50:16.090Z and never finished",
		);
	});

	/* #920 (`--help` once ran a live reap). The fake daemon records any call,
	 * list or stop, and the run record is what openRun writes before the oracle
	 * is read. */
	describe("a command line it does not take reaps nothing", () => {
		function runArgv(argv: string[]) {
			const called = path.join(sandbox, "claude-called");
			const res = runReaper(
				sandbox,
				`echo "$@" >> "${called}"\nexit 0\n`,
				argv,
			);
			expect(fs.existsSync(called), "the daemon was called").toBe(false);
			expect(fs.existsSync(path.join(sandbox, "wfc-reap-run.json"))).toBe(
				false,
			);
			return res;
		}

		it("--help prints the usage and exits 0", () => {
			const res = runArgv(["--help"]);
			expect(res.status).toBe(0);
			expect(res.stdout).toMatch(/^usage: node scripts\/reap-finished/);
		});

		it("an unknown flag exits 2, naming it", () => {
			const res = runArgv(["--bogus"]);
			expect(res.status).toBe(2);
			expect(res.stderr).toContain("unknown flag: --bogus");
			expect(res.stderr).toContain(
				"usage: node scripts/reap-finished-sessions.js",
			);
		});
	});

	it("leaves a record even when it takes nothing at all", () => {
		runScript([{ ...finished, state: "working", status: "busy" }]);
		const runs = JSON.parse(
			fs.readFileSync(path.join(sandbox, "wfc-reap-run.json"), "utf8"),
		);
		expect(runs.dry.candidates).toEqual([
			expect.objectContaining({ sessionId: "other-1", gate: "finished" }),
		]);
	});
});

/*
 * The clock mantahostels#654 chose: `max(firstTerminalAt, transcript mtime)`, both terms or
 * neither (mantahostels#652): the stamp survives a resume and so can read early, the mtime
 * is "last touched" and so reads late.
 */
describe("the finish clock, as the run reads it off disk", () => {
	let sandbox = "";

	beforeEach(() => {
		sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "reap-clock-"));
	});
	afterEach(() => {
		fs.rmSync(sandbox, { recursive: true, force: true });
	});

	const jobCwd = "/home/lucmo/mantahostels";
	const slug = "-home-lucmo-mantahostels";
	const minute = 60_000;

	/** Lays down a job record and a transcript the way the real harness does,
	 * each dated `…Ago` before the real clock the script will read. */
	function lay(over: { record?: unknown; transcriptAgo?: number | null } = {}) {
		const now = Date.now();
		const dir = path.join(sandbox, "jobs", "aaaa");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "state.json"),
			JSON.stringify(
				over.record ?? {
					cwd: jobCwd,
					firstTerminalAt: new Date(now - 20 * minute).toISOString(),
				},
			),
		);
		if (over.transcriptAgo !== null) {
			const proj = path.join(sandbox, "projects", slug);
			fs.mkdirSync(proj, { recursive: true });
			const t = path.join(proj, "aaaa-1.jsonl");
			fs.writeFileSync(t, ENDED_TURN);
			const ms = now - (over.transcriptAgo ?? 30 * minute);
			fs.utimesSync(t, ms / 1000, ms / 1000);
		}
	}

	/** The one reaped row of a real `--dry-run --json` run, with no state file,
	 * so the observation clock — the fallback — reads zero minutes. */
	function reaped() {
		const res = runReaper(sandbox, registered(sandbox, [agent()]), [
			"--dry-run",
			"--json",
		]);
		expect(res.status, "reap-finished-sessions.js must exit 0").toBe(0);
		const out = JSON.parse(res.stdout);
		expect(out.reaped).toHaveLength(1);
		return out.reaped[0];
	}

	/** Where the transcript cannot be found, the run holds the session for the
	 * hold window, timed on the observation clock — never off the stamp alone,
	 * and never off another session's transcript (#2980). */
	function heldUnreadable() {
		const res = runReaper(sandbox, registered(sandbox, [agent()]), [
			"--dry-run",
			"--json",
		]);
		expect(res.status, "reap-finished-sessions.js must exit 0").toBe(0);
		const out = JSON.parse(res.stdout);
		expect(out.reaped).toEqual([]);
		expect(out.kept).toHaveLength(1);
		expect(out.kept[0].gate).toBe("unreadable");
		expect(out.kept[0].clock).toBe("observation");
	}

	const noTime = (row: { clock: string; why: string }) => {
		expect(row.clock).toBe("observation");
		expect(row.why).toBe("finished 0 minute(s) ago");
	};

	it("takes the finish stamp where it is the later of the two", () => {
		lay({ transcriptAgo: 30 * minute });
		const row = reaped();
		expect(row.clock).toBe("finish-stamp");
		expect(row.why).toBe("finished 20 minute(s) ago");
	});

	it("takes the transcript mtime where it is the later of the two", () => {
		lay({ transcriptAgo: 5 * minute });
		const row = reaped();
		expect(row.clock).toBe("finish-stamp");
		expect(row.why).toBe("finished 5 minute(s) ago");
	});

	it("derives the transcript path from the cwd, not from linkScanPath", () => {
		// A resumed session's linkScanPath still names the transcript it resumed
		// FROM.
		lay({
			record: {
				cwd: jobCwd,
				firstTerminalAt: new Date(Date.now() - 20 * minute).toISOString(),
				linkScanPath: path.join(sandbox, "projects", slug, "some-other.jsonl"),
			},
			transcriptAgo: 5 * minute,
		});
		expect(reaped().why).toBe("finished 5 minute(s) ago");
	});

	it("gives no time where firstTerminalAt is null", () => {
		// The `backend: "peer"` shape of mantahostels#652 F4, which stamps null unconditionally.
		lay({ record: { cwd: jobCwd, firstTerminalAt: null } });
		noTime(reaped());
	});

	it("holds a job whose transcript ends on a blocked Stop hook and the turn it forced (#2980)", () => {
		lay({ transcriptAgo: 0 });
		const t = path.join(sandbox, "projects", slug, "aaaa-1.jsonl");
		fs.appendFileSync(
			t,
			`${[
				{ type: "assistant", message: { content: [] } },
				{
					type: "attachment",
					attachment: { type: "hook_blocking_error", hookEvent: "Stop" },
				},
				{ type: "api-request" },
			]
				.map((r) => JSON.stringify(r))
				.join("\n")}\n`,
		);
		const res = runReaper(sandbox, registered(sandbox, [agent()]), [
			"--dry-run",
			"--json",
		]);
		expect(res.status, "reap-finished-sessions.js must exit 0").toBe(0);
		const out = JSON.parse(res.stdout);
		expect(out.reaped).toEqual([]);
		expect(out.kept[0].gate).toBe("turn");
		expect(out.kept[0].why).toMatch(/a turn still running/);
	});

	it("holds, on no time, a job whose record carries no cwd to find the transcript by", () => {
		lay({
			record: {
				firstTerminalAt: new Date(Date.now() - 20 * minute).toISOString(),
			},
		});
		/* A transcript where the REAPING run's own cwd would put it, so a
		 * reader that defaulted the missing cwd would find one and date the
		 * session off somebody else's mtime. */
		const own = path.join(
			sandbox,
			"projects",
			sandbox.replace(/[^a-zA-Z0-9]/g, "-"),
		);
		fs.mkdirSync(own, { recursive: true });
		fs.writeFileSync(path.join(own, "aaaa-1.jsonl"), ENDED_TURN);
		heldUnreadable();
	});

	it("holds, on no time, a job whose transcript is missing, rather than reaping off the stamp alone", () => {
		lay({ transcriptAgo: null });
		heldUnreadable();
	});
});

/* #2980: a job reads `done` before its Stop hooks run, and a blocking one
 * forces a turn under that `done`. */
describe("plan — holding a job whose turn has not visibly ended", () => {
	const Min = 60_000;
	const withTurn = (
		turn: { ended: boolean; at: number | null } | null,
		finishedAgo: number,
	) => run({ lastTurn: () => turn, finishAt: () => NOW - finishedAgo });
	const running = { ended: false, at: null };

	it("holds a job whose transcript shows a turn still running", () => {
		const p = withTurn(running, 5000);
		expect(p.reap).toEqual([]);
		expect(p.kept[0].gate).toBe("turn");
	});

	it("reaps it fifteen minutes after its last turn row", () => {
		const at = (ago: number) => ({ ended: false, at: NOW - ago });
		const held = withTurn(at(15 * Min - 1000), 0).kept[0];
		expect([held.gate, held.clock]).toEqual(["turn", "turn-row"]);
		expect(held.why).toMatch(/last turn row 899s ago/);
		// Bookkeeping rows moved the finish clock to now; the row still rules.
		expect(ids(withTurn(at(15 * Min), 0).reap)).toEqual(["aaaa-1"]);
	});

	it("times a turn row with no timestamp off the finish clock", () => {
		expect(withTurn(running, 15 * Min - 1000).kept[0].gate).toBe("turn");
		expect(ids(withTurn(running, 15 * Min).reap)).toEqual(["aaaa-1"]);
	});

	it("holds a job whose transcript will not read for fifteen minutes from its last write", () => {
		expect(withTurn(null, 15 * Min - 1000).kept[0].gate).toBe("unreadable");
		expect(ids(withTurn(null, 15 * Min).reap)).toEqual(["aaaa-1"]);
	});

	it("reaps a job whose turn ended at once", () => {
		expect(ids(withTurn({ ended: true, at: NOW }, 0).reap)).toEqual(["aaaa-1"]);
	});
});

describe("plan — dating a session from when it finished, not when it was sighted", () => {
	const withClock = (
		finishAt: (a: Agent) => number | null,
		state: Record<string, number>,
	) => run({ state, finishAt });

	it("reaps a session sighted this very instant but finished long ago", () => {
		const p = withClock(() => NOW - 20 * 60_000, {});
		expect(ids(p.reap)).toEqual(["aaaa-1"]);
		expect(p.reap[0].clock).toBe("finish-stamp");
		expect(p.reap[0].why).toMatch(/finished 20 minute/);
	});

	it("reaps a session finished a moment ago, whatever its sighting time", () => {
		const p = withClock(() => NOW - 1000, { "aaaa-1": NOW - 60 * 60_000 });
		expect(ids(p.reap)).toEqual(["aaaa-1"]);
		expect(p.reap[0].clock).toBe("finish-stamp");
	});

	/* The age gate survives the cut to zero for this one case: a finish stamp in
	 * the future means the clock is wrong, and a run that cannot date a session
	 * does not reap it. */
	it("holds a session whose finish stamp is in the future", () => {
		const p = withClock(() => NOW + 5000, {});
		expect(p.reap).toEqual([]);
		expect(p.kept[0].why).toMatch(/future/);
	});

	it("falls back to the sighting clock where no finish time can be read", () => {
		const p = withClock(() => null, { "aaaa-1": NOW - 1 });
		expect(ids(p.reap)).toEqual(["aaaa-1"]);
		expect(p.reap[0].clock).toBe("observation");
	});

	/* mantahostels#632's burst case: with no finish time to read the fallback clock dates a
	 * session from its first sighting, which at a zero window is this very run. */
	it("reaps on the fallback clock at first sighting", () => {
		const p = withClock(() => null, { "aaaa-1": NOW - 1000 });
		expect(ids(p.reap)).toEqual(["aaaa-1"]);
		expect(p.reap[0].clock).toBe("observation");
	});

	it("never reads the clock for a session an earlier gate already kept", () => {
		let reads = 0;
		const p = run({
			/* Gate 2, this very session. */
			self: "aaaa-1",
			state: {},
			finishAt: () => {
				reads++;
				return NOW - 20 * 60_000;
			},
		});
		expect(p.reap).toEqual([]);
		expect(reads).toBe(0);
	});
});

describe("the SessionStart wiring: one sighting is enough", () => {
	let sandbox = "";

	beforeEach(() => {
		sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "reap-first-run-"));
	});
	afterEach(() => fs.rmSync(sandbox, { recursive: true, force: true }));

	const finished = agent({
		sessionId: "burst-1",
		id: "burst",
		name: "a session from the burst",
	});

	/** Runs the script for real, with no wfc-reap-state.json written first. */
	function runFirstEver(withJobRecord: boolean) {
		const cwd = process.cwd();
		if (withJobRecord) {
			const dir = path.join(sandbox, "jobs", "burst");
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(
				path.join(dir, "state.json"),
				JSON.stringify({
					cwd,
					firstTerminalAt: new Date(Date.now() - 25 * 60_000).toISOString(),
				}),
			);
			const proj = path.join(
				sandbox,
				"projects",
				cwd.replace(/[^A-Za-z0-9]/g, "-"),
			);
			fs.mkdirSync(proj, { recursive: true });
			const t = path.join(proj, "burst-1.jsonl");
			fs.writeFileSync(t, "");
			const ms = Date.now() - 25 * 60_000;
			fs.utimesSync(t, ms / 1000, ms / 1000);
		}
		const res = runReaper(sandbox, registered(sandbox, [finished]), [
			"--dry-run",
			"--json",
		]);
		expect(res.status, "reap-finished-sessions.js must exit 0").toBe(0);
		return JSON.parse(res.stdout);
	}

	it("reaps a burst on the first session start after it finished", () => {
		const r = runFirstEver(true);
		expect(r.reaped.map((a: Agent) => a.sessionId)).toEqual(["burst-1"]);
	});

	it("reaps a burst on first sighting where there is no finish time to read", () => {
		const r = runFirstEver(false);
		expect(r.reaped.map((a: Agent) => a.sessionId)).toEqual(["burst-1"]);
	});
});

/*
 * mantahostels#747: end to end, a finished session holding a claim is stopped, and the run
 * says which lock it left stale. Driven through the CLI entry point because the
 * claim store is read by main() alone — the judgement is handed the answer.
 *
 * UNVERIFIED: that main() passes `gitDirty` as the reader
 * behind the DIRTY marker. Only main()'s own stdout is asserted on here, and
 * making a tracked file dirty to find out would write to the shared working
 * tree. The marker's own logic is unit-covered above; the omission costs a
 * marker, never a wrong reap.
 */
describe("the SessionStart wiring: a claim does not keep a session", () => {
	let sandbox = "";
	let project = "";

	beforeEach(() => {
		sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "reap-claim-"));
		project = fs.mkdtempSync(path.join(os.tmpdir(), "reap-proj-"));
	});
	afterEach(() => {
		fs.rmSync(sandbox, { recursive: true, force: true });
		fs.rmSync(project, { recursive: true, force: true });
	});

	const finished = agent({
		sessionId: "holder-1",
		id: "holder",
		name: "a finished session sitting on a file",
	});

	function runScript(claimed: string[]) {
		fs.writeFileSync(
			path.join(sandbox, "wfc-reap-state.json"),
			JSON.stringify({ "holder-1": Date.now() - 60_000 }),
		);
		const locks = path.join(
			sandbox,
			"projects",
			project.replace(/[^a-zA-Z0-9]/g, "-"),
			"locks",
		);
		fs.mkdirSync(locks, { recursive: true });
		for (const [i, rel] of claimed.entries()) {
			fs.writeFileSync(
				path.join(locks, `lock-${i}.json`),
				JSON.stringify({ sessionId: "holder-1", path: rel }),
			);
		}
		const res = runReaper(
			sandbox,
			registered(sandbox, [finished]),
			["--dry-run"],
			{
				env: { CLAUDE_PROJECT_DIR: project },
			},
		);
		expect(res.status, "reap-finished-sessions.js must exit 0").toBe(0);
		return res.stdout;
	}

	it("stops a finished session even though it holds a claim", () => {
		const out = runScript(["scripts/x.js"]);
		expect(out).toContain("reap: would stop holder");
		expect(out).not.toContain("reap: keeping");
	});

	it("names the lock that stop leaves stale", () => {
		expect(runScript(["scripts/x.js"])).toContain(
			"it held 1 file claim(s), now stale and breakable by the next session to claim them: scripts/x.js",
		);
	});

	it("still stops a session holding nothing, and says nothing about claims", () => {
		const out = runScript([]);
		expect(out).toContain("reap: would stop holder");
		expect(out).not.toContain("file claim(s)");
	});
});

/*
 * mantahostels#846: the reaper selected and retried two ghost ids at every session start,
 * for ever — job records the listing oracle still names whose daemon holds no
 * job to stop, so `claude stop` answers "No job matching '<id>'" and exit 1
 * however often it is asked.
 */
describe("a stop that failed is not retried at every session start", () => {
	const failed = (over: Partial<Extract<StateRow, object>> = {}) => ({
		"aaaa-1": {
			since: NOW - 1,
			failures: 1,
			retryAt: NOW + 30 * 60_000,
			lastError: "exit 1: No job matching 'aaaa'.",
			...over,
		},
	});

	it("holds back a session whose stop failed, inside its retry window", () => {
		const p = run({ state: failed() });
		expect(p.reap).toEqual([]);
		expect(p.kept[0].heldBack).toBe(true);
	});

	it("says how often the stop failed and what the daemon answered", () => {
		const p = run({ state: failed() });
		expect(p.kept[0].why).toContain("`claude stop` has failed 1 time(s)");
		expect(p.kept[0].why).toContain("No job matching 'aaaa'.");
		expect(p.kept[0].why).toContain("not retried for another 30 minute(s)");
	});

	it("retries once the retry window has run out", () => {
		const p = run({ state: failed({ retryAt: NOW - 1 }) });
		expect(ids(p.reap)).toEqual(["aaaa-1"]);
	});

	it("retries at the very instant the window expires", () => {
		const p = run({ state: failed({ retryAt: NOW }) });
		expect(ids(p.reap)).toEqual(["aaaa-1"]);
	});

	/* Two permanent failures took two of the ten slots on every run, so the
	 * ceiling bound two lower than it reads. */
	it("spends no slot under the ten-a-run ceiling on a held-back session", () => {
		const agents: Agent[] = [];
		const state: Record<string, StateRow> = {};
		for (let i = 0; i < CAP + 2; i++) {
			agents.push(agent({ sessionId: `s-${i}`, id: `s${i}` }));
			state[`s-${i}`] = NOW - 1;
		}
		for (const g of ["s-0", "s-1"])
			state[g] = { since: NOW - 1, failures: 1, retryAt: NOW + 1 };
		const p = run({ agents, state });
		expect(p.reap).toHaveLength(CAP);
		expect(ids(p.reap)).not.toContain("s-0");
	});

	it("holds the session back rather than reaping it", () => {
		/* `failed()` must stay past the grace window, or gate 4 keeps this and
		 * gate 5 — the point of the test — is never reached. `heldBack` is the
		 * discriminator; `reap` being empty is true at either gate. */
		const p = run({ state: failed() });
		expect(p.reap).toEqual([]);
		expect(p.kept[0].heldBack).toBe(true);
	});

	it("carries the failure record forward untouched while it is held back", () => {
		const p = run({ state: failed() });
		expect(p.nextState["aaaa-1"]).toEqual(failed()["aaaa-1"]);
	});

	it("leaves a session that has never failed on the bare stamp it always had", () => {
		const p = run({ state: { "aaaa-1": NOW - 120_000 } });
		expect(p.nextState["aaaa-1"]).toBe(NOW - 120_000);
	});
});

/* Through `plan`, which reads each row and writes it back into `nextState`: a
 * never-failed row goes back as the bare stamp, a failed one as its whole
 * record. */
describe("the state file's rows — reading both shapes it holds", () => {
	const minute = 60_000;

	it("reads a never-failed row's bare number as a first-sighting stamp", () => {
		const p = run({ state: { "aaaa-1": NOW - 20 * minute } });
		expect(p.nextState["aaaa-1"]).toBe(NOW - 20 * minute);
		expect(ids(p.reap)).toEqual(["aaaa-1"]);
		expect(p.reap[0].why).toBe("finished 20 minute(s) ago");
	});

	it("reads the failure record", () => {
		const row = { since: 1, failures: 2, retryAt: 3, lastError: "boom" };
		const p = run({ state: { "aaaa-1": row } });
		expect(p.nextState["aaaa-1"]).toEqual(row);
	});

	it("reads the failure record's count, window and error into the hold-back", () => {
		const p = run({
			state: {
				"aaaa-1": {
					since: 1,
					failures: 2,
					retryAt: NOW + 10 * minute,
					lastError: "boom",
				},
			},
		});
		expect(p.kept[0].heldBack).toBe(true);
		expect(p.kept[0].why).toBe(
			"`claude stop` has failed 2 time(s) (boom); not retried for another 10 minute(s)",
		);
	});

	it("dates a session it has no row for from now", () => {
		const p = run({ state: {} });
		expect(p.nextState["aaaa-1"]).toBe(NOW);
		expect(p.reap[0].why).toBe("finished 0 minute(s) ago");
	});

	/* Degrades to "never failed", which costs a retry — never to a state that
	 * would suppress one. */
	it("reads junk as a session that has never failed", () => {
		for (const row of [null, "yesterday", [1, 2], Number.NaN, undefined]) {
			const p = run({
				state: { "aaaa-1": row } as unknown as Record<string, StateRow>,
			});
			expect(p.nextState["aaaa-1"]).toBe(NOW);
			expect(ids(p.reap)).toEqual(["aaaa-1"]);
		}
	});

	it("reads a record missing its fields as never having failed", () => {
		const p = run({
			state: { "aaaa-1": {} } as unknown as Record<string, StateRow>,
		});
		expect(p.nextState["aaaa-1"]).toBe(NOW);
		expect(ids(p.reap)).toEqual(["aaaa-1"]);
	});
});

/* Through `reap` with a stop that fails, reading the window off the state it
 * saves. A prior failure count
 * is seeded with its window already run out, so the stop is attempted. */
describe("the retry window — it doubles, then stops doubling", () => {
	function windowAfter(prior: StateRow) {
		const { saved } = reapWith({
			state: { "aaaa-1": prior },
			stop: () => ({ ok: false, why: "exit 1: No job matching 'aaaa'." }),
		});
		const row = saved[0]["aaaa-1"] as Extract<StateRow, object>;
		return row.retryAt - NOW;
	}
	const failedBefore = (failures: number) => ({
		since: NOW - 1,
		failures,
		retryAt: NOW,
	});

	it("waits an hour after the first failure", () => {
		expect(windowAfter(NOW - 1)).toBe(HOUR);
	});

	it("doubles with each consecutive failure", () => {
		expect(windowAfter(failedBefore(1))).toBe(2 * HOUR);
		expect(windowAfter(failedBefore(2))).toBe(4 * HOUR);
	});

	/* Reachable only from a corrupt row: a negative count passes gate 5 (its
	 * `failures &&` is truthy but the window is long gone) and the failure
	 * then counts to zero. */
	it("treats a nonsensical zeroth failure as the first, not half a window", () => {
		expect(windowAfter({ since: NOW - 1, failures: -1, retryAt: 0 })).toBe(
			HOUR,
		);
	});

	it("caps at a day, however many times it has failed", () => {
		expect(windowAfter(failedBefore(98))).toBe(DAY);
	});
});

/*
 * mantahostels#846 end to end, against a daemon that lists a job it cannot stop. Two runs,
 * because the bug was only ever visible across runs: the first attempt is
 * right, the SECOND one is the loop.
 */
describe("a ghost the daemon lists but cannot stop, across consecutive runs", () => {
	let sandbox = "";

	beforeEach(() => {
		sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "reap-ghost-"));
	});
	afterEach(() => fs.rmSync(sandbox, { recursive: true, force: true }));

	const ghost = {
		pid: 999_999_999,
		sessionId: "ghost-1",
		id: "ghost",
		name: "a session that finished long ago",
		kind: "background",
		state: "done",
		status: "idle",
	};

	/* The fake `claude` body: lists the ghost, logs each stop asked of it and
	 * refuses it. */
	function ghostStub() {
		registered(sandbox, [ghost]);
		return [
			'if [ "$1" = "stop" ]; then',
			`  echo "$2" >> "${path.join(sandbox, "stops")}"`,
			// A warning ABOVE the reason, per docs/agents/verification.md.
			'  echo "warning: daemon socket is busy, retrying" >&2',
			"  echo \"No job matching '$2'. Run 'claude agents' to list running sessions.\" >&2",
			"  exit 1",
			"fi",
			"exit 0",
		].join("\n");
	}

	function runOnce(stub: string) {
		const res = runReaper(sandbox, stub, []);
		expect(res.status, "reap-finished-sessions.js must exit 0").toBe(0);
		return res.stdout;
	}

	const readStopsAttempted = () => {
		try {
			return fs
				.readFileSync(path.join(sandbox, "stops"), "utf8")
				.split("\n")
				.filter(Boolean);
		} catch {
			return [];
		}
	};

	/** Seeds the sighting clock so the ghost is already past its grace window. */
	function seed() {
		fs.writeFileSync(
			path.join(sandbox, "wfc-reap-state.json"),
			JSON.stringify({ "ghost-1": Date.now() - 60_000 }),
		);
	}

	it("tries the stop once, then never again on the next run", () => {
		const stub = ghostStub();
		seed();

		const first = runOnce(stub);
		expect(readStopsAttempted()).toEqual(["ghost"]);
		expect(first).toContain("reap: could not stop ghost");
		// The daemon's own answer, which is what tells a reader it is a ghost
		// rather than a slow stop.
		expect(first).toContain("No job matching 'ghost'.");

		const second = runOnce(stub);
		// THE BUG: this read ["ghost", "ghost"], for ever, at every session start.
		expect(readStopsAttempted()).toEqual(["ghost"]);
		expect(second).not.toContain("could not stop");

		// A third run, because the record has to SURVIVE the runs it suppresses:
		// a suppression that forgot the failure while holding the session back
		// would pass on two runs and loop again on every one after.
		runOnce(stub);
		expect(readStopsAttempted()).toEqual(["ghost"]);
	});

	it("reports the daemon's reason, not a warning printed above it", () => {
		const stub = ghostStub();
		seed();
		const first = runOnce(stub);
		expect(first).toContain("No job matching 'ghost'.");
		expect(first).not.toContain("daemon socket is busy");
	});

	it("still reports the un-reapable session on the run that holds it back", () => {
		const stub = ghostStub();
		seed();
		runOnce(stub);
		const second = runOnce(stub);
		expect(second).toContain(
			"reap: not retrying ghost (a session that finished long ago)",
		);
		expect(second).toContain("`claude stop` has failed 1 time(s)");
		expect(second).toContain("No job matching 'ghost'.");
	});

	it("writes a failure record the next run can read", () => {
		const stub = ghostStub();
		seed();
		runOnce(stub);
		const state = JSON.parse(
			fs.readFileSync(path.join(sandbox, "wfc-reap-state.json"), "utf8"),
		);
		expect(state["ghost-1"].failures).toBe(1);
		expect(state["ghost-1"].lastError).toContain("No job matching");
		expect(state["ghost-1"].retryAt).toBeGreaterThan(Date.now());
	});

	/* The state file must not grow a row per dead session for ever. */
	it("forgets a ghost that has left the listing altogether", () => {
		const stub = ghostStub();
		seed();
		runOnce(stub);
		runOnce(
			registered(sandbox, [
				{
					...ghost,
					sessionId: "someone-else",
					id: "other",
					state: "working",
					status: "busy",
				},
			]),
		);
		const state = JSON.parse(
			fs.readFileSync(path.join(sandbox, "wfc-reap-state.json"), "utf8"),
		);
		expect(state["ghost-1"]).toBeUndefined();
	});
});

describe("the run record — what a run that took nothing leaves behind (mantahostels#1920)", () => {
	/** The record the run closed with, or undefined where it closed none. */
	// biome-ignore lint/suspicious/noExplicitAny: run records as written
	const closed = (records: any[]) => records.filter((r) => r.finishedAt).pop();

	it("closes the record on a run that reaped nothing at all", () => {
		const h = reapWith({
			listed: {
				faults: [],
				seats: ["/s"],
				agents: [agent({ state: "working", status: "busy" })],
			},
		});
		expect(h.out).toBe("");
		expect(closed(h.records)).toMatchObject({ listed: 1, stopped: 0 });
	});

	it("tells an empty listing apart from a listing whose candidates were all refused", () => {
		const empty = closed(
			reapWith({ listed: { faults: [], seats: ["/s"], agents: [] } }).records,
		);
		expect(empty).toMatchObject({ listed: 0, candidates: [] });

		const refused = closed(
			reapWith({
				listed: {
					faults: [],
					seats: ["/s"],
					agents: [agent({ state: "working", status: "busy" })],
				},
			}).records,
		);
		expect(refused.listed).toBe(1);
		expect(refused.candidates).toHaveLength(1);
	});

	it("names the gate that turned each candidate away, and the state it read", () => {
		const h = reapWith({
			listed: {
				faults: [],
				seats: ["/s"],
				agents: [
					agent({
						sessionId: "w-1",
						id: "w",
						state: "working",
						status: "busy",
					}),
					agent({ sessionId: "the-running-session", id: "me" }),
					agent({ sessionId: "n-1", id: undefined }),
				],
			},
			state: {},
		});
		const byId = new Map(
			// biome-ignore lint/suspicious/noExplicitAny: record rows
			closed(h.records).candidates.map((c: any) => [c.sessionId, c]),
		);
		expect(byId.get("w-1")).toMatchObject({
			gate: "finished",
			state: "working",
		});
		expect(byId.get("the-running-session")).toMatchObject({ gate: "self" });
		expect(byId.get("n-1")).toMatchObject({ gate: "job-id" });
	});

	it("names a session it took with no gate at all", () => {
		const h = reapWith();
		expect(closed(h.records).candidates).toEqual([
			expect.objectContaining({ sessionId: "aaaa-1", gate: null }),
		]);
	});

	it("marks a stop the daemon refused, rather than filing it as taken", () => {
		const h = reapWith({ stop: () => ({ ok: false, why: "exit 1" }) });
		expect(closed(h.records)).toMatchObject({ stopped: 0 });
		expect(closed(h.records).candidates[0]).toMatchObject({
			gate: "stop-failed",
			error: "exit 1",
		});
	});

	it("closes a record when this session has no id of its own, naming what it saw", () => {
		const h = reapWith({ self: undefined });
		expect(closed(h.records)).toMatchObject({ listed: 1 });
		expect(closed(h.records).why).toMatch(/^CLAUDE_CODE_SESSION_ID is unset/);
		/* Gate 2's, not gate 1's: nothing was judged, so nothing can be said about
		 * which of them were finished. */
		expect(closed(h.records).candidates).toEqual([
			expect.objectContaining({ sessionId: "aaaa-1", gate: "session-id" }),
		]);
	});

	it("files a dry run under its own mode, so it cannot overwrite a session start's", () => {
		const h = reapWith({ argv: ["--dry-run"] });
		expect(h.records.every((r) => r.mode === "dry")).toBe(true);
	});
});

describe("a previous run that never finished (mantahostels#1920)", () => {
	const unfinished = {
		live: { mode: "live", startedAt: "2026-08-29T11:50:16.090Z" },
	};

	it("says so, naming when it started", () => {
		expect(reapWith({ runs: unfinished }).out).toContain(
			"the previous run started 2026-08-29T11:50:16.090Z and never finished",
		);
	});

	it("says so even on a run that itself reaps nothing", () => {
		const out = reapWith({
			runs: unfinished,
			listed: {
				faults: [],
				seats: ["/s"],
				agents: [agent({ state: "working", status: "busy" })],
			},
		}).out;
		expect(out).toContain("never finished");
	});

	it("says nothing when the previous run closed its record", () => {
		const out = reapWith({
			runs: {
				live: { ...unfinished.live, finishedAt: "2026-08-29T11:50:18.000Z" },
			},
		}).out;
		expect(out).not.toContain("never finished");
	});

	it("says nothing when there is no previous record at all", () => {
		expect(reapWith({ runs: {} }).out).not.toContain("never finished");
	});

	/* `admission.js` parses the whole of --json's stdout, so the warning has to
	 * ride inside the object rather than beside it. */
	it("rides inside the --json object rather than beside it", () => {
		const out = reapWith({ argv: ["--json"], runs: unfinished }).out;
		expect(JSON.parse(out).previousRunUnfinished).toBe(
			"2026-08-29T11:50:16.090Z",
		);
	});

	it("reads only its own mode, so a dry run cannot mask a live one", () => {
		const out = reapWith({ argv: ["--dry-run"], runs: unfinished }).out;
		expect(out).not.toContain("never finished");
	});
});

describe("the run record on disk (mantahostels#1920)", () => {
	let sandbox = "";

	beforeEach(() => {
		sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "reap-run-"));
	});
	afterEach(() => fs.rmSync(sandbox, { recursive: true, force: true }));

	const runFile = () => path.join(sandbox, "wfc-reap-run.json");
	const readRunsOnDisk = () => JSON.parse(fs.readFileSync(runFile(), "utf8"));

	/** One run, against a daemon listing one session still working, so even a
	 * live run stops nothing. */
	function runOnce(argv: string[]) {
		const res = runReaper(
			sandbox,
			registered(sandbox, [agent({ state: "working", status: "busy" })]),
			argv,
		);
		expect(res.status, "reap-finished-sessions.js must exit 0").toBe(0);
		return res.stdout;
	}

	it("leaves the other mode's record alone", () => {
		runOnce([]);
		runOnce(["--dry-run"]);
		const runs = readRunsOnDisk();
		expect(runs.live).toMatchObject({
			mode: "live",
			finishedAt: expect.any(String),
		});
		expect(runs.dry).toMatchObject({
			mode: "dry",
			finishedAt: expect.any(String),
		});
	});

	it("reads an unparseable record as no record, rather than throwing", () => {
		fs.writeFileSync(runFile(), "{oh no");
		expect(runOnce(["--dry-run"])).not.toContain("never finished");
		expect(readRunsOnDisk().dry).toMatchObject({
			finishedAt: expect.any(String),
		});
	});

	it("is not in the state file, whose rows are rewritten whole each run", () => {
		runOnce([]);
		const state = JSON.parse(
			fs.readFileSync(path.join(sandbox, "wfc-reap-state.json"), "utf8"),
		);
		expect(Object.keys(state)).not.toContain("live");
		expect(readRunsOnDisk().live).toMatchObject({ mode: "live" });
	});
});

/* The record the program's openRun writes, judged by lib/reaper.js's
 * `openedRecord` against the prior row the run read. */
describe("openedRecord — a live reap cancelled at consecutive session starts (mantahostels#1952)", () => {
	/* The grace an open row is aged against: the test's own figure. */
	const liveGraceMs = 300_000;

	/* More than one grace past `now`, matching detached-run.test.ts's own
	 * reasoning: a ladder spaced at exactly the grace reads every row as still
	 * alive, since an open row is aged on `>`, not `>=`. */
	const pastGrace = (from: number, ms = liveGraceMs + 60_000) => from - ms;

	it("stays at zero across runs that each close", () => {
		let runs: Record<string, unknown> = {};
		for (let i = 0; i < 5; i++) {
			const opened = openedRecord([], runs, NOW + i * 1000);
			runs = { live: { ...opened, finishedAt: new Date().toISOString() } };
		}
		expect(runs.live).toMatchObject({ deaths: 0 });
	});

	it("does not count an open row still inside its grace", () => {
		const first = openedRecord([], {}, NOW);
		const second = openedRecord([], { live: first }, NOW + 1000);
		expect(second.deaths).toBe(0);
	});

	it("counts a previous open row aged past its grace", () => {
		const first = openedRecord([], {}, pastGrace(NOW));
		const second = openedRecord([], { live: first }, NOW);
		expect(second.deaths).toBe(1);
	});

	it("accumulates across consecutive deaths", () => {
		const a = openedRecord([], {}, pastGrace(NOW, liveGraceMs * 6));
		const b = openedRecord([], { live: a }, pastGrace(NOW, liveGraceMs * 4));
		const c = openedRecord([], { live: b }, pastGrace(NOW, liveGraceMs * 2));
		const d = openedRecord([], { live: c }, NOW);
		expect(d.deaths).toBe(3);
	});

	it("ages from openedSince, not startedAt — the busy-machine case (mantahostels#1999's reasoning, reused here)", () => {
		/* Each reopen is closer to the one before it than the grace, so ageing
		 * against `startedAt` alone would read every one as still fresh and never
		 * count a death; ageing from `openedSince` — fixed at the first open of
		 * this unbroken run — lets the total elapsed time win. */
		const step = liveGraceMs / 3;
		const start = NOW - liveGraceMs * 2;
		let record = openedRecord([], {}, start);
		for (let i = 1; i <= 4; i++)
			record = openedRecord([], { live: record }, start + step * i);
		expect(record.deaths).toBe(1);
	});

	it("counts one death from a burst of concurrent starts, never one per opener", () => {
		const stale = openedRecord([], {}, pastGrace(NOW, liveGraceMs * 3));
		const burstStart = NOW;
		const a = openedRecord([], { live: stale }, burstStart);
		const b = openedRecord([], { live: a }, burstStart + 2000);
		const c = openedRecord([], { live: b }, burstStart + 4000);
		expect(c.deaths).toBe(1);
	});

	it("clears the count as soon as one run closes", () => {
		const a = openedRecord([], {}, pastGrace(NOW, liveGraceMs * 6));
		const b = openedRecord([], { live: a }, pastGrace(NOW, liveGraceMs * 4));
		const c = openedRecord([], { live: b }, pastGrace(NOW, liveGraceMs * 2));
		expect(c.deaths).toBe(2);
		const closed = { ...c, finishedAt: new Date().toISOString() };
		const d = openedRecord([], { live: closed }, NOW);
		expect(d.deaths).toBe(0);
	});

	it("leaves the count alone on a stamp it cannot age", () => {
		const record = openedRecord(
			[],
			{
				live: {
					mode: "live",
					startedAt: "not a date",
					openedSince: "not a date",
					deaths: 2,
				},
			},
			NOW,
		);
		expect(record.deaths).toBe(2);
	});

	it("reads only its own mode, so a dry cancellation cannot count against live", () => {
		const dry = openedRecord(["--dry-run"], {}, pastGrace(NOW));
		const live = openedRecord([], { dry }, NOW);
		expect(live.deaths).toBe(0);
	});
});

/*
 * PERSIST MODE (mantahostels#2152).
 */
describe("persist mode: the report goes to a file, not to stdout", () => {
	// biome-ignore lint/suspicious/noExplicitAny: a CJS module has no types to import
	const notify: any = require("./lib/notify-report.js");
	const savedEnv = { ...process.env };
	let sandbox = "";

	beforeEach(() => {
		sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "reap-persist-"));
		/* Mirrored onto this process as well as the run's, so the two agree on
		 * where `base()` puts the report. */
		process.env.CLAUDE_CONFIG_DIR = sandbox;
		process.env.CLAUDE_PROJECT_DIR = sandbox;
		process.env.WFC_CLAUDE_CONFIG_A = sandbox;
		process.env.WFC_CLAUDE_CONFIG_B = sandbox;
		process.env.WFC_CLAUDE_CONFIG_C = sandbox;
	});
	afterEach(() => {
		process.env = { ...savedEnv };
		fs.rmSync(sandbox, { recursive: true, force: true });
	});

	const finished = agent({ sessionId: "other-1", id: "other" });

	function runWithListing(
		listing: Agent[],
		argv: string[],
		extra: Record<string, string> = {},
	) {
		return runReaper(sandbox, registered(sandbox, listing), argv, {
			env: { WFC_NOTIFY_PERSIST: "1", ...extra },
		}).stdout;
	}

	it("writes what it would have printed, and prints nothing", () => {
		const out = runWithListing([finished], ["--notify"]);
		expect(out).toBe("");
		const report = notify.readReport(REPORT_NAME);
		expect(report.outcome).toBe("WARN");
		expect(report.text).toContain("reap: stopped a finished session");
		expect(report.durationMs).toEqual(expect.any(Number));
	});

	it("stamps the report with the session it ran in", () => {
		runWithListing([finished], ["--notify"]);
		expect(notify.readReport(REPORT_NAME).owner).toBe(
			"the-session-this-hook-started-in",
		);
	});

	/* The reader must be able to tell "ran and had nothing to say" apart from
	 * "never ran", and only a present file can say the first. */
	it("writes an empty OK report when it has nothing to say", () => {
		// An empty listing is the degraded path; a listing of one LIVE session is
		// the quiet one — judged, kept, and nothing worth a line.
		const live = { ...finished, state: "working" };
		runWithListing([live], ["--notify"]);
		const report = notify.readReport(REPORT_NAME);
		expect(report.outcome).toBe("OK");
		expect(report.text).toBe("");
	});

	/* A reaper that ran and could not work is not a reaper that found nothing. */
	it("writes BROKEN when it judged no candidate at all", () => {
		runWithListing([finished], ["--notify"], { CLAUDE_CODE_SESSION_ID: "" });
		const report = notify.readReport(REPORT_NAME);
		expect(report.outcome).toBe("BROKEN");
		expect(report.text).toContain("CLAUDE_CODE_SESSION_ID is unset");
	});

	/* The record the replay reader (mantahostels#1976) calls a cancellation. A run that
	 * finished must not leave one behind. */
	it("closes its open run record once the report has landed", () => {
		runWithListing([finished], ["--notify"]);
		expect(notify.readRun(REPORT_NAME)).toBeNull();
	});

	/* notify-report.js's stated contract, exercised through the reaper: an
	 * unwritable report directory costs the report and never the reap. */
	it("still reaps when the report directory cannot be written", () => {
		const base = notify.base();
		fs.mkdirSync(path.dirname(base), { recursive: true });
		// A regular file where the directory must go, so every write below fails.
		fs.writeFileSync(base, "not a directory");
		expect(runWithListing([finished], ["--notify"])).toContain(
			"reap: stopped a finished session",
		);
		expect(notify.readReport(REPORT_NAME)).toBeNull();
		const runs = JSON.parse(
			fs.readFileSync(path.join(sandbox, "wfc-reap-run.json"), "utf8"),
		);
		expect(runs.live).toMatchObject({
			stopped: 1,
			finishedAt: expect.any(String),
		});
	});

	/* The half of the close-only-if-wrote trade a writable directory cannot show:
	 * the record opens, the report write fails, and the record is LEFT open so the
	 * reader (mantahostels#1976) reads this run as a cancellation rather than as silence. */
	it("leaves its run record open when only the report write fails", () => {
		// A directory where the report file must go: openRun's own file lands
		// beside it, so the record opens and only writeReport fails.
		fs.mkdirSync(notify.reportFile(REPORT_NAME), { recursive: true });
		runWithListing([finished], ["--notify"]);
		expect(notify.readRun(REPORT_NAME)).toMatchObject({
			checker: REPORT_NAME,
			pid: expect.any(Number),
		});
	});

	it("prints to stdout and writes no report without the variable", () => {
		const out = runWithListing([finished], ["--notify"], {
			WFC_NOTIFY_PERSIST: "",
		});
		expect(out).toContain("reap: stopped a finished session");
		expect(notify.readReport(REPORT_NAME)).toBeNull();
	});

	/* One REPORT_NAME key serves both modes, so a hand `--dry-run --notify` would
	 * otherwise overwrite the live report the next session start reads. */
	it("persists nothing from a dry run", () => {
		const out = runWithListing([finished], ["--notify", "--dry-run"]);
		expect(out).toContain("reap: would stop other");
		expect(notify.readReport(REPORT_NAME)).toBeNull();
	});

	/* `--json` is a caller's document (lib/admission.js parses it), never a
	 * reader's, so it outranks the variable rather than being captured by it. */
	it("keeps --json on stdout and writes no report", () => {
		// No --dry-run: that limb would mask this one.
		const out = runWithListing([finished], ["--notify", "--json"]);
		expect(JSON.parse(out).reaped.map((a: Agent) => a.sessionId)).toEqual([
			"other-1",
		]);
		expect(notify.readReport(REPORT_NAME)).toBeNull();
	});
});

/*
 * Two fake seats under one root, the run made from seat A. The fake
 * `claude` lists every seat, as the union oracle does, and answers `stop` as a
 * per-seat daemon: it holds the job ids in its seat's `daemon-jobs` file, and
 * answers anything else "No job matching". Job RECORDS are laid separately, so
 * a test can hold the record and the daemon on different seats.
 */
/*
 * #2665: the pool is each seat's registry, pid-verified and joined to its job
 * records. Each record a check refuses is one
 * the run must not stop.
 */
describe("the pool, read off the registry", () => {
	let sandbox = "";
	beforeEach(() => {
		sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "reap-registry-"));
	});
	afterEach(() => fs.rmSync(sandbox, { recursive: true, force: true }));

	const done = agent();
	const jobFile = () => path.join(sandbox, "jobs", "aaaa", "state.json");

	/** What a `--dry-run --json` run would stop, by session id. */
	function wouldStop(env: Record<string, string> = {}) {
		const res = runReaper(sandbox, "exit 0\n", ["--dry-run", "--json"], {
			env,
		});
		return JSON.parse(res.stdout).reaped.map((a: Agent) => a.sessionId);
	}

	it("stops a finished session while the CLI listing hangs, never asking it", () => {
		registered(sandbox, [done]);
		const calls = path.join(sandbox, "calls");
		const res = runReaper(
			sandbox,
			`echo "$@" >> "${calls}"\n[ "$1" = "agents" ] && exec sleep 30\nexit 0\n`,
			[],
		);
		expect(res.stdout).toContain("reap: stopped a finished session");
		expect(fs.readFileSync(calls, "utf8").trim().split("\n")).toEqual([
			"stop aaaa",
		]);
	});

	it("stops nothing whose process is not the one its record names", () => {
		registered(sandbox, [done]);
		const entry = path.join(sandbox, "sessions", "1.json");
		const rec = JSON.parse(fs.readFileSync(entry, "utf8"));
		fs.writeFileSync(entry, JSON.stringify({ ...rec, procStart: "1" }));
		expect(wouldStop()).toEqual([]);
	});

	it("stops nothing whose job record is missing", () => {
		registered(sandbox, [done]);
		fs.rmSync(jobFile());
		expect(wouldStop()).toEqual([]);
	});

	it("stops nothing whose job record will not parse", () => {
		fs.mkdirSync(path.dirname(jobFile()), { recursive: true });
		fs.writeFileSync(jobFile(), "{ torn");
		registered(sandbox, [done]);
		expect(wouldStop()).toEqual([]);
	});

	it("stops nothing whose job record names another session", () => {
		registered(sandbox, [done]);
		const rec = JSON.parse(fs.readFileSync(jobFile(), "utf8"));
		fs.writeFileSync(jobFile(), JSON.stringify({ ...rec, sessionId: "x" }));
		expect(wouldStop()).toEqual([]);
	});

	it("stops nothing whose job record does not read done", () => {
		registered(sandbox, [agent({ state: "working" })]);
		expect(wouldStop()).toEqual([]);
	});

	it("never stops the session it runs in, listed in the registry", () => {
		registered(sandbox, [done]);
		expect(wouldStop({ CLAUDE_CODE_SESSION_ID: done.sessionId })).toEqual([]);
		expect(wouldStop()).toEqual([done.sessionId]);
	});
});

describe("seats other than the run's own (#1571)", () => {
	let root = "";
	let seatA = "";
	let seatB = "";

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "reap-seats-"));
		seatA = path.join(root, "a");
		seatB = path.join(root, "b");
		fs.mkdirSync(seatA);
		fs.mkdirSync(seatB);
	});
	afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

	const onB = agent({ sessionId: "bbbb-1", id: "bbbb", name: "done on B" });
	const liveA = agent({
		sessionId: "live-a-1",
		id: "livea",
		name: "working on A",
		state: "working",
		status: "busy",
	});
	const liveB = agent({
		sessionId: "live-b-1",
		id: "liveb",
		name: "working on B",
		state: "working",
		status: "busy",
	});

	const buildSeatEnv = () => ({
		WFC_CLAUDE_CONFIG_A: seatA,
		WFC_CLAUDE_CONFIG_B: seatB,
		WFC_CLAUDE_CONFIG_C: seatB,
	});

	function buildStub() {
		return [
			'if [ "$1" = "stop" ]; then',
			`  echo "$CLAUDE_CONFIG_DIR $2" >> "${path.join(root, "stops")}"`,
			'  grep -qx "$2" "$CLAUDE_CONFIG_DIR/daemon-jobs" 2>/dev/null && exit 0',
			"  echo \"No job matching '$2'.\" >&2",
			"  exit 1",
			"fi",
			"exit 0",
		].join("\n");
	}

	const daemonHolds = (seat: string, jobId: string) =>
		fs.appendFileSync(path.join(seat, "daemon-jobs"), `${jobId}\n`);

	/** A job record on `seat` naming `sessionId`, finished `agoMin` ago. */
	function record(seat: string, jobId: string, sessionId: string, agoMin = 0) {
		const dir = path.join(seat, "jobs", jobId);
		fs.mkdirSync(dir, { recursive: true });
		const cwd = "/home/lucmo/mantahostels";
		const firstTerminalAt = new Date(
			Date.now() - agoMin * 60_000,
		).toISOString();
		fs.writeFileSync(
			path.join(dir, "state.json"),
			JSON.stringify({ sessionId, cwd, firstTerminalAt }),
		);
		endedTranscript(seat, cwd, sessionId, firstTerminalAt);
	}

	/* Each session in its own seat's registry, after the test's own job
	 * records, which `registered` merges its state into. */
	function registerSeats() {
		registered(seatA, [liveA]);
		registered(seatB, [onB, liveB]);
	}

	function reapFromA(argv: string[] = []) {
		registerSeats();
		const res = runReaper(seatA, buildStub(), argv, { env: buildSeatEnv() });
		expect(res.status, "reap-finished-sessions.js must exit 0").toBe(0);
		return res.stdout;
	}

	const readStops = () => {
		try {
			return fs
				.readFileSync(path.join(root, "stops"), "utf8")
				.split("\n")
				.filter(Boolean);
		} catch {
			return [];
		}
	};

	it("stops a finished session on seat B, addressed on seat B, from a run on seat A", () => {
		record(seatB, "bbbb", "bbbb-1");
		daemonHolds(seatB, "bbbb");
		const out = reapFromA();
		expect(readStops()).toEqual([`${seatB} bbbb`]);
		expect(out).toContain("reap: stopped done on B");
	});

	it("never stops a live session on either seat", () => {
		record(seatA, "livea", "live-a-1");
		record(seatB, "liveb", "live-b-1");
		daemonHolds(seatA, "livea");
		daemonHolds(seatB, "liveb");
		record(seatB, "bbbb", "bbbb-1");
		daemonHolds(seatB, "bbbb");
		reapFromA();
		expect(readStops()).toEqual([`${seatB} bbbb`]);
	});

	it("retries a stop refused with No job matching on the other seat before reporting it", () => {
		/* Seat B's record names it, so B is asked first; seat A, holding no
		 * record of the id, is asked next. */
		daemonHolds(seatA, "bbbb");
		const out = reapFromA();
		expect(readStops()).toEqual([`${seatB} bbbb`, `${seatA} bbbb`]);
		expect(out).toContain("reap: stopped done on B");
		expect(out).not.toContain("could not stop");
	});

	it("reports No job matching only once every seat has refused it", () => {
		const out = reapFromA();
		expect(readStops()).toEqual([`${seatB} bbbb`, `${seatA} bbbb`]);
		expect(out).toContain(
			"reap: could not stop bbbb (exit 1: No job matching 'bbbb'. (on all 2 seats))",
		);
	});

	it("does not retry a failure other than No job matching on another seat", () => {
		record(seatB, "bbbb", "bbbb-1");
		const busy = buildStub().replace(
			"  echo \"No job matching '$2'.\" >&2",
			'  echo "daemon is busy" >&2',
		);
		registerSeats();
		const res = runReaper(seatA, busy, [], { env: buildSeatEnv() });
		expect(readStops()).toEqual([`${seatB} bbbb`]);
		expect(res.stdout).toContain(
			"reap: could not stop bbbb (exit 1: daemon is busy)",
		);
	});

	it("never addresses a seat whose record of the id names another session", () => {
		/* Seat A's bbbb is a different job under a colliding id; its daemon would
		 * stop it if asked. */
		record(seatA, "bbbb", "someone-else");
		daemonHolds(seatA, "bbbb");
		const out = reapFromA();
		expect(readStops()).toEqual([`${seatB} bbbb`]);
		expect(out).toContain("could not stop bbbb");
	});

	it("dates a seat-B session off seat B's own job record", () => {
		record(seatB, "bbbb", "bbbb-1", 20);
		const transcript = path.join(seatB, "projects", "-home-lucmo-mantahostels");
		fs.mkdirSync(transcript, { recursive: true });
		const t = path.join(transcript, "bbbb-1.jsonl");
		fs.writeFileSync(t, "");
		const ms = Date.now() - 30 * 60_000;
		fs.utimesSync(t, ms / 1000, ms / 1000);
		const plan = JSON.parse(reapFromA(["--dry-run", "--json"]));
		expect(plan.reaped.map((r: { id: string }) => r.id)).toEqual(["bbbb"]);
		expect(plan.reaped[0].clock).toBe("finish-stamp");
		expect(plan.reaped[0].why).toBe("finished 20 minute(s) ago");
	});

	/* What admission.js's `taken by the next reap` reads: the count off the
	 * reaper's own dry run, run here AFTER a live reap from seat A. Before #1571
	 * that reap's "No job matching" opened a retry window, and the dry run held
	 * the session back. The fake
	 * keeps listing it after the stop, so the dry run still sees it. */
	it("counts a seat-B session in admission's reclaimable figure after a reap from seat A", () => {
		daemonHolds(seatB, "bbbb");
		reapFromA();
		const saved = { ...process.env };
		Object.assign(process.env, buildSeatEnv(), {
			CLAUDE_CONFIG_DIR: seatA,
			WFC_CLAUDE_BIN: path.join(seatA, "claude"),
			CLAUDE_CODE_SESSION_ID: "the-session-this-hook-started-in",
		});
		delete process.env.WFC_REAP_SCRIPT;
		try {
			// biome-ignore lint/suspicious/noExplicitAny: CommonJS module, read for the figure admission.js prints
			const { reclaimableMb } = require("./lib/admission.js") as any;
			expect(reclaimableMb()).toMatchObject({ ok: true, count: 1 });
		} finally {
			process.env = saved;
		}
	});
});
