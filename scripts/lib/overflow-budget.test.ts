// @vitest-environment node
/*
 * Pins lib/overflow-budget.js: a session on the key priced from its transcript,
 * priced again as it grows and counted once; only sessions the launch record
 * marks on the key counted, from any checkout; the exhausted mark from a credit
 * refusal in a transcript; a listed session held, not settled; a resumed copy's
 * shared requests settled once (#4208), its transcript gone or not (#4370);
 * and the CLI's JSON
 * and status line for a fixture seat, every figure read from a fixed cost table
 * in a fixture checkout, and read there from a working directory that is no
 * checkout (#3683, #3695).
 *
 * Loosen one and a session's spend goes uncounted or counted twice, a plan
 * session is charged to the key, or the CLI reports a figure the gate did not
 * size (#2609).
 *
 * Launches are rows in a fixture checkout's dispatch ledger; `claude` is a stub
 * printing a fixture listing.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildStopBranch, type StopKind } from "./agents-stop-fake";
import { readProcStartOf } from "./arbiter-proc.js";
import { writeClaudeStub } from "./claude-stub";
import { writeCostTable } from "./cost-table-testkit";
import { record } from "./dispatch-ledger.js";
import { writeHeadlessRun } from "./headless-runs-testkit";
import { seatBudget, stopOverAllowance } from "./overflow-budget.js";
import { killGroup, readStat, startOrphan } from "./process-fixture";
import { runInProcess } from "./run-in-process.js";
import { shellQuote } from "./sh-quote.js";

const SCRIPT = path.join(__dirname, "overflow-budget.js");
/* Mean 4; a session 5 in, past u 3, has the tail's expected remainder of 7. */
const TABLE = {
	n: 3,
	meanUsd: 4,
	quantilesUsd: [1, 3, 10],
	tailRemainderUsd: 7,
};
/* Past any one month's cycle, so the write falls in an earlier one. */
const TWO_CYCLES_MS = 62 * 24 * 3600 * 1000;
let tmp: string;
let home: string;
let refill: string;
let seatDir: string;
let root: string;
let listingFile: string;
let stub: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "overflow-budget-"));
	home = path.join(tmp, "home");
	refill = path.join(tmp, "refill");
	seatDir = path.join(home, ".claude2");
	fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
	fs.mkdirSync(seatDir, { recursive: true });
	fs.writeFileSync(
		path.join(home, ".claude", "refill-seats"),
		`${path.join(home, ".claude2")}\n~/.claude2 api key=WFC_TEST_KEY grant=200 cycle-day=1\n`,
	);
	root = path.join(tmp, "checkout");
	writeCostTable(root, TABLE);
	listingFile = path.join(tmp, "listing.json");
	stub = path.join(tmp, "claude");
	writeClaudeStub(stub, [
		`if [ "$1" = "agents" ]; then cat "${listingFile}"; exit 0; fi`,
	]);
	writeListing([]);
	vi.stubEnv("WFC_REFILL_DIR", refill);
	vi.stubEnv("WFC_DISPATCH_ROOT", root);
	vi.stubEnv("WFC_CLAUDE_BIN", stub);
	vi.stubEnv("HOME", home);
	vi.stubEnv("CLAUDE_CODE_SESSION_ID", undefined);
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

function writeListing(agents: object[]) {
	fs.writeFileSync(listingFile, JSON.stringify(agents));
}

const sessionIdOf = (jobId: string) => `${jobId}-0000-4000-8000-000000000000`;

/* An overflow launch's ledger row; `keyVar` another key's where it is not this
 * seat's. Returns the session id. */
function recordLaunch(
	jobId: string,
	{
		keyVar = "WFC_TEST_KEY",
		at = root,
		withSessionId = true,
		copyOf,
		offKeyUsd,
	}: {
		keyVar?: string;
		at?: string;
		withSessionId?: boolean;
		copyOf?: string;
		offKeyUsd?: number;
	} = {},
) {
	const sessionId = sessionIdOf(jobId);
	record({
		issues: [],
		model: "opus",
		prompt: "/implement",
		root: at,
		jobId,
		overflow: {
			keyVar,
			allowanceUsd: 50,
			sessionId: withSessionId ? sessionId : null,
			...(copyOf ? { copyOf } : {}),
			...(offKeyUsd === undefined ? {} : { offKeyUsd }),
		},
	});
	return sessionId;
}

const transcriptOf = (sessionId: string) =>
	path.join(seatDir, "projects", "-fixture", `${sessionId}.jsonl`);

/* A request costing US$4 per million fresh Opus input tokens. */
const buildModelTurn = (inputTokens: number, requestId = "r1") => ({
	type: "assistant",
	requestId,
	message: {
		model: "claude-opus-5-5",
		usage: { input_tokens: inputTokens },
	},
});

/* As Claude Code 2.1.312 wrote it (#3692's probes), in a `claude -p` run. */
const CREDIT_REFUSAL_ROW = {
	type: "assistant",
	entrypoint: "sdk-cli",
	isApiErrorMessage: true,
	error: "billing_error",
	message: {
		model: "<synthetic>",
		content: [{ type: "text", text: "Credit balance is too low" }],
	},
};

function appendTranscript(sessionId: string, ...rows: object[]) {
	const file = transcriptOf(sessionId);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.appendFileSync(file, rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
}

const seat = {
	dir: "",
	kind: "overflow" as const,
	keyVar: "WFC_TEST_KEY",
	grantUsd: 200,
	cycleDay: 1,
};
const budget = () => seatBudget({ ...seat, dir: seatDir }, root);
const ledgerPath = () =>
	path.join(refill, ".overflow-ledger", "WFC_TEST_KEY.jsonl");
const readLedgerLines = () =>
	fs
		.readFileSync(ledgerPath(), "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));

describe("seatBudget pricing", () => {
	it("prices a session moved onto the key at what it spent there (#3736)", () => {
		const id = recordLaunch("0000d001", { offKeyUsd: 40 });
		appendTranscript(
			id,
			buildModelTurn(10_000_000, "r1"),
			buildModelTurn(5_000_000, "r2"),
		);
		expect(budget()).toMatchObject({ settledUsd: 20 });
	});

	it("prices a session from its transcript", () => {
		const id = recordLaunch("0000000b");
		appendTranscript(id, buildModelTurn(2_000_000));
		expect(budget()).toMatchObject({ settledUsd: 8, fit: 48, running: 0 });
		expect(readLedgerLines()).toMatchObject([
			{ sessionId: id, jobId: "0000000b", costUsd: 8 },
		]);
	});

	it("replaces a session's row once its transcript grows, counting it once", () => {
		const id = recordLaunch("0000000b");
		appendTranscript(id, buildModelTurn(2_000_000));
		budget();
		appendTranscript(id, buildModelTurn(1_000_000, "r2"));
		expect(budget()).toMatchObject({ settledUsd: 12 });
		expect(readLedgerLines()).toMatchObject([{ sessionId: id, costUsd: 12 }]);
	});

	it("prices again when only a subagent's transcript grew", () => {
		const id = recordLaunch("0000000b");
		appendTranscript(id, buildModelTurn(2_000_000));
		budget();
		const subagents = path.join(
			path.dirname(transcriptOf(id)),
			id,
			"subagents",
		);
		fs.mkdirSync(subagents, { recursive: true });
		fs.writeFileSync(
			path.join(subagents, "agent-a.jsonl"),
			`${JSON.stringify(buildModelTurn(1_000_000, "r2"))}\n`,
		);
		expect(budget()).toMatchObject({ settledUsd: 12 });
	});

	it("does not price again a transcript that has not grown", () => {
		const id = recordLaunch("0000000b");
		appendTranscript(id, buildModelTurn(2_000_000));
		budget();
		const [row] = readLedgerLines();
		fs.writeFileSync(
			ledgerPath(),
			`${JSON.stringify({ ...row, costUsd: 99 })}\n`,
		);
		expect(budget()).toMatchObject({ settledUsd: 99 });
	});

	it("keeps a row whose transcript is gone, as the credits stay spent", () => {
		const id = recordLaunch("0000000b");
		appendTranscript(id, buildModelTurn(2_000_000));
		budget();
		fs.rmSync(transcriptOf(id));
		expect(budget()).toMatchObject({ settledUsd: 8 });
	});

	it("counts a session in the cycle of its latest transcript write", () => {
		const id = recordLaunch("0000000b");
		appendTranscript(id, buildModelTurn(2_000_000));
		const lastCycle = new Date(Date.now() - TWO_CYCLES_MS);
		fs.utimesSync(transcriptOf(id), lastCycle, lastCycle);
		expect(budget()).toMatchObject({ settledUsd: 0 });
		appendTranscript(id, buildModelTurn(1_000_000, "r2"));
		expect(budget()).toMatchObject({ settledUsd: 12 });
	});

	it("reads the cost table in the root it is given, not the working directory's checkout (#3683)", () => {
		vi.stubEnv("CLAUDE_PROJECT_DIR", undefined);
		const cwd = process.cwd();
		process.chdir(home);
		try {
			expect(budget()).toMatchObject({ fit: 50 });
		} finally {
			process.chdir(cwd);
		}
	});

	it("says why where no checkout is served", () => {
		expect(seatBudget({ ...seat, dir: seatDir }, undefined)).toEqual({
			why: "the loop serves no checkout to read the cost table in",
		});
	});

	it("says why where the cost table is unreadable", () => {
		expect(seatBudget({ ...seat, dir: seatDir }, tmp)).toEqual({
			why: "the session cost table is unreadable",
		});
	});
});

describe("which sessions count", () => {
	it("leaves out a transcript in the dir the launch record does not mark", () => {
		appendTranscript(sessionIdOf("0000000a"), buildModelTurn(2_000_000));
		expect(budget()).toMatchObject({ settledUsd: 0 });
		expect(fs.existsSync(ledgerPath())).toBe(false);
	});

	it("leaves out a session on another key in the same dir", () => {
		const id = recordLaunch("0000000a", { keyVar: "WFC_OTHER_KEY" });
		appendTranscript(id, buildModelTurn(2_000_000));
		expect(budget()).toMatchObject({ settledUsd: 0 });
	});

	it("joins a session to a launch of unknown session id by its job id (#3692 (e))", () => {
		const id = recordLaunch("0000000a", { withSessionId: false });
		appendTranscript(id, buildModelTurn(2_000_000));
		expect(budget()).toMatchObject({ settledUsd: 8 });
	});

	it("counts a launch recorded in another checkout", () => {
		const other = path.join(home, "other-repo");
		fs.mkdirSync(path.join(other, ".git"), { recursive: true });
		fs.mkdirSync(path.join(other, ".claude"), { recursive: true });
		fs.writeFileSync(path.join(other, ".claude", "workflow-core.json"), "{}\n");
		const id = recordLaunch("0000000a", { at: other });
		appendTranscript(id, buildModelTurn(2_000_000));
		expect(budget()).toMatchObject({ settledUsd: 8 });
	});

	it("says why where a checkout's launch record will not read, never counting it as plan", () => {
		const ledger = path.join(
			root,
			".claude",
			"tmp",
			"markers",
			".pick-next",
			"dispatched.jsonl",
		);
		fs.mkdirSync(ledger, { recursive: true });
		expect(budget()).toEqual({
			why: expect.stringContaining("would not read"),
		});
	});
});

describe("a credit refusal in a transcript", () => {
	it("marks the key exhausted", () => {
		const id = recordLaunch("0000000c");
		appendTranscript(id, CREDIT_REFUSAL_ROW);
		expect(budget()).toMatchObject({ exhausted: true, fit: 0 });
	});

	it("marks it from a running session, which a refusal leaves idle", () => {
		const id = recordLaunch("0000000c");
		appendTranscript(id, CREDIT_REFUSAL_ROW);
		writeListing([{ id: "0000000c", sessionId: id, state: "idle" }]);
		expect(budget()).toMatchObject({ exhausted: true, fit: 0, running: 1 });
	});

	it("marks it from a subagent's transcript", () => {
		const id = recordLaunch("0000000c");
		appendTranscript(id, buildModelTurn(1000));
		const subagents = path.join(
			path.dirname(transcriptOf(id)),
			id,
			"subagents",
		);
		fs.mkdirSync(subagents, { recursive: true });
		fs.writeFileSync(
			path.join(subagents, "agent-a.jsonl"),
			`${JSON.stringify(CREDIT_REFUSAL_ROW)}\n`,
		);
		expect(budget()).toMatchObject({ exhausted: true });
	});

	it("dates the mark by the refusal, not a later write", () => {
		const id = recordLaunch("0000000c");
		appendTranscript(id, {
			...CREDIT_REFUSAL_ROW,
			timestamp: new Date(Date.now() - TWO_CYCLES_MS).toISOString(),
		});
		expect(budget()).toMatchObject({ exhausted: false });
	});

	it("reads the refusal's words where the billing error's name is absent", () => {
		const id = recordLaunch("0000000c");
		appendTranscript(id, { ...CREDIT_REFUSAL_ROW, error: undefined });
		expect(budget()).toMatchObject({ exhausted: true });
	});

	it("is not an interactive session's refusal, a --bg job's among them, which the key's credits never cover (#4578)", () => {
		const id = recordLaunch("0000000c");
		appendTranscript(id, {
			...CREDIT_REFUSAL_ROW,
			entrypoint: "cli",
			sessionKind: "bg",
		});
		expect(budget()).toMatchObject({ exhausted: false });
	});

	it("is an API error naming billing_error in its text alone (#4580)", () => {
		const id = recordLaunch("0000000c");
		appendTranscript(id, {
			...CREDIT_REFUSAL_ROW,
			error: "unknown",
			message: {
				model: "<synthetic>",
				content: [{ type: "text", text: "API Error: billing_error" }],
			},
		});
		expect(budget()).toMatchObject({ exhausted: true });
	});

	it("is not a session quoting the words, or another API error", () => {
		const id = recordLaunch("0000000c");
		appendTranscript(
			id,
			{ type: "user", message: { content: "Credit balance is too low" } },
			{
				type: "assistant",
				message: {
					model: "claude-opus-5-5",
					content: [{ type: "text", text: "Credit balance is too low" }],
				},
			},
			{
				...CREDIT_REFUSAL_ROW,
				error: "server_error",
				message: { model: "<synthetic>", content: "API Error" },
			},
		);
		expect(budget()).toMatchObject({ exhausted: false });
	});

	it("stays through a synthetic line, and clears on a model turn since", () => {
		const id = recordLaunch("0000000c");
		appendTranscript(id, CREDIT_REFUSAL_ROW, {
			type: "assistant",
			message: { model: "<synthetic>", content: "No response requested." },
		});
		expect(budget()).toMatchObject({ exhausted: true });
		appendTranscript(id, buildModelTurn(1000));
		expect(budget()).toMatchObject({ exhausted: false });
	});

	it("clears at the next cycle", () => {
		const id = recordLaunch("0000000c");
		appendTranscript(id, CREDIT_REFUSAL_ROW);
		const lastCycle = new Date(Date.now() - TWO_CYCLES_MS);
		fs.utimesSync(transcriptOf(id), lastCycle, lastCycle);
		expect(budget()).toMatchObject({ exhausted: false });
	});
});

describe("a listed session", () => {
	it("is held at its spend plus remainder, and not settled too", () => {
		const id = recordLaunch("0000000d");
		appendTranscript(id, buildModelTurn(1_250_000));
		writeListing([{ id: "0000000d", sessionId: id, state: "working" }]);
		/* spent 5, past u 3: max(4, 5 + 7) = 12 held. */
		expect(budget()).toMatchObject({
			running: 1,
			reservedUsd: 12,
			settledUsd: 0,
			fit: 47,
		});
	});

	it("is held at Q before it has a transcript", () => {
		const id = recordLaunch("0000000d");
		writeListing([{ id: "0000000d", sessionId: id, state: "working" }]);
		expect(budget()).toMatchObject({ running: 1, reservedUsd: 4 });
	});

	it("settles once the listing calls it done", () => {
		const id = recordLaunch("0000000d");
		appendTranscript(id, buildModelTurn(1_250_000));
		writeListing([
			{ id: "0000000d", sessionId: id, state: "done", kind: "background" },
		]);
		expect(budget()).toMatchObject({
			running: 0,
			reservedUsd: 0,
			settledUsd: 5,
		});
	});

	it("is held once where it runs headless and the oracle also lists its transcript (#4588)", () => {
		const id = recordLaunch("0000000d");
		writeHeadlessRun(refill, "0000000d", id);
		writeListing([{ sessionId: id, state: "working", kind: "interactive" }]);
		expect(budget()).toMatchObject({ running: 1, reservedUsd: 4 });
	});

	it("is not this key's where the launch record does not say so", () => {
		writeListing([{ id: "0000000d", sessionId: sessionIdOf("0000000d") }]);
		expect(budget()).toMatchObject({ running: 0, reservedUsd: 0 });
	});

	it("says why where the listing will not read", () => {
		fs.writeFileSync(stub, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
		expect(budget()).toEqual({ why: expect.stringContaining("agents --json") });
	});
});

describe("a resumed copy's settled spend (#4208)", () => {
	it("settles the requests a copy shares with its parent once, keeping a row each", () => {
		const parent = recordLaunch("0000c001");
		appendTranscript(parent, buildModelTurn(5_000_000, "r1"));
		const copy = recordLaunch("0000c002", { copyOf: parent });
		appendTranscript(
			copy,
			buildModelTurn(5_000_000, "r1"),
			buildModelTurn(3_000_000, "r2"),
		);
		expect(budget()).toMatchObject({ settledUsd: 32 });
		expect(readLedgerLines()).toMatchObject([
			{ sessionId: parent, costUsd: 20 },
			{ sessionId: copy, costUsd: 32 },
		]);
	});

	it("counts what the parent spent after the fork, and a copy of a copy", () => {
		const parent = recordLaunch("0000c001");
		appendTranscript(
			parent,
			buildModelTurn(5_000_000, "r1"),
			buildModelTurn(4_000_000, "r9"),
		);
		const copy = recordLaunch("0000c002", { copyOf: parent });
		appendTranscript(copy, buildModelTurn(5_000_000, "r1"));
		const second = recordLaunch("0000c003", { copyOf: copy });
		appendTranscript(
			second,
			buildModelTurn(5_000_000, "r1"),
			buildModelTurn(3_500_000, "r2"),
		);
		expect(budget()).toMatchObject({ settledUsd: 50 });
	});

	it("settles a copy at what it adds while its parent is held", () => {
		const parent = recordLaunch("0000c001");
		appendTranscript(parent, buildModelTurn(5_000_000, "r1"));
		const copy = recordLaunch("0000c002", { copyOf: parent });
		appendTranscript(
			copy,
			buildModelTurn(5_000_000, "r1"),
			buildModelTurn(3_000_000, "r2"),
		);
		writeListing([{ id: "0000c001", sessionId: parent, state: "working" }]);
		/* the root held as before: spent 20 + remainder 7. */
		expect(budget()).toMatchObject({
			running: 1,
			settledUsd: 12,
			reservedUsd: 27,
		});
	});

	it("takes a moved chain's off-key spend off once", () => {
		const parent = recordLaunch("0000d001", { offKeyUsd: 40 });
		appendTranscript(
			parent,
			buildModelTurn(10_000_000, "r1"),
			buildModelTurn(5_000_000, "r2"),
		);
		const copy = recordLaunch("0000d002", { copyOf: parent });
		appendTranscript(
			copy,
			buildModelTurn(10_000_000, "r1"),
			buildModelTurn(5_000_000, "r2"),
			buildModelTurn(1_000_000, "r3"),
		);
		expect(budget()).toMatchObject({ settledUsd: 24 });
	});

	it("settles them once after the parent's transcript is gone, the copy still growing (#4370)", () => {
		const parent = recordLaunch("0000c001");
		appendTranscript(parent, buildModelTurn(5_000_000, "r1"));
		const copy = recordLaunch("0000c002", { copyOf: parent });
		appendTranscript(
			copy,
			buildModelTurn(5_000_000, "r1"),
			buildModelTurn(3_000_000, "r2"),
		);
		expect(budget()).toMatchObject({ settledUsd: 32 });
		fs.rmSync(transcriptOf(parent));
		expect(budget()).toMatchObject({ settledUsd: 32 });
		appendTranscript(copy, buildModelTurn(1_000_000, "r3"));
		expect(budget()).toMatchObject({ settledUsd: 36 });
		expect(readLedgerLines()).toMatchObject([
			{ sessionId: parent, costUsd: 20 },
			{ sessionId: copy, costUsd: 36, sharedUsd: 20 },
		]);
		expect(readLedgerLines()[0]).not.toHaveProperty("sharedUsd");
	});

	it("settles a copy of a copy once after the middle copy's transcript is gone (#4370)", () => {
		const parent = recordLaunch("0000c001");
		appendTranscript(parent, buildModelTurn(5_000_000, "r1"));
		const copy = recordLaunch("0000c002", { copyOf: parent });
		appendTranscript(
			copy,
			buildModelTurn(5_000_000, "r1"),
			buildModelTurn(3_000_000, "r2"),
		);
		const second = recordLaunch("0000c003", { copyOf: copy });
		appendTranscript(
			second,
			buildModelTurn(5_000_000, "r1"),
			buildModelTurn(3_000_000, "r2"),
			buildModelTurn(1_000_000, "r3"),
		);
		expect(budget()).toMatchObject({ settledUsd: 36 });
		fs.rmSync(transcriptOf(copy));
		appendTranscript(second, buildModelTurn(1_000_000, "r4"));
		expect(budget()).toMatchObject({ settledUsd: 40 });
	});

	it("takes a moved chain's off-key spend off once after its root's transcript is gone (#4370)", () => {
		const parent = recordLaunch("0000d001", { offKeyUsd: 40 });
		appendTranscript(
			parent,
			buildModelTurn(10_000_000, "r1"),
			buildModelTurn(5_000_000, "r2"),
		);
		const copy = recordLaunch("0000d002", { copyOf: parent });
		appendTranscript(
			copy,
			buildModelTurn(10_000_000, "r1"),
			buildModelTurn(5_000_000, "r2"),
			buildModelTurn(1_000_000, "r3"),
		);
		expect(budget()).toMatchObject({ settledUsd: 24 });
		fs.rmSync(transcriptOf(parent));
		appendTranscript(copy, buildModelTurn(1_000_000, "r4"));
		expect(budget()).toMatchObject({ settledUsd: 28 });
	});

	it("settles them once after the copy's transcript is gone (#4370)", () => {
		const parent = recordLaunch("0000c001");
		appendTranscript(parent, buildModelTurn(5_000_000, "r1"));
		const copy = recordLaunch("0000c002", { copyOf: parent });
		appendTranscript(
			copy,
			buildModelTurn(5_000_000, "r1"),
			buildModelTurn(3_000_000, "r2"),
		);
		expect(budget()).toMatchObject({ settledUsd: 32 });
		fs.rmSync(transcriptOf(copy));
		appendTranscript(parent, buildModelTurn(2_000_000, "r9"));
		expect(budget()).toMatchObject({ settledUsd: 40 });
	});
});

describe("a running resumed copy (#4369)", () => {
	it("is held at what it adds to its settled parent, plus its own spend's remainder", () => {
		const parent = recordLaunch("0000c001");
		appendTranscript(parent, buildModelTurn(5_000_000, "r1"));
		const copy = recordLaunch("0000c002", { copyOf: parent });
		appendTranscript(
			copy,
			buildModelTurn(5_000_000, "r1"),
			buildModelTurn(3_000_000, "r2"),
		);
		writeListing([{ id: "0000c002", sessionId: copy, state: "working" }]);
		/* spent 32, past u 3: share 12 + remainder 7 = 19 held. */
		expect(budget()).toMatchObject({
			running: 1,
			settledUsd: 20,
			reservedUsd: 19,
		});
	});
});

describe("a seat on a dir another seat shares (#3693)", () => {
	it("prices only the sessions of its own key", () => {
		const id = recordLaunch("0000000f");
		appendTranscript(id, buildModelTurn(5_000_000));
		const other = { ...seat, dir: seatDir, keyVar: "WFC_OTHER_KEY" };
		expect(seatBudget(other, root)).toMatchObject({ settledUsd: 0 });
		expect(budget()).toMatchObject({ settledUsd: 20 });
	});
});

describe("the CLI", () => {
	const cli = (...args: string[]) =>
		runInProcess(SCRIPT, args, {
			env: {
				PATH: process.env.PATH ?? "",
				HOME: home,
				WFC_REFILL_DIR: refill,
				WFC_CLAUDE_BIN: stub,
				CLAUDE_PROJECT_DIR: root,
				WFC_DISPATCH_ROOT: root,
			},
		});

	beforeEach(() => {
		appendTranscript(recordLaunch("0000000e"), buildModelTurn(5_000_000));
	});

	it("prints the seat's budget as JSON", () => {
		const r = cli("--json", "WFC_TEST_KEY");
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
		const { cycleStart, nextCycleStart, ...figures } = JSON.parse(r.stdout);
		expect(figures).toEqual({
			fit: 45,
			headroomUsd: 180,
			settledUsd: 20,
			reservedUsd: 0,
			creditUsd: 200,
			grantUsd: 200,
			readAt: null,
			expiresOn: null,
			qUsd: 4,
			running: 0,
			exhausted: false,
			readFailure: null,
			lastAttemptAt: null,
		});
		/* cycle-day=1: whatever the clock, the cycle runs from one 1st at
		 * local midnight to the next. */
		const start = new Date(cycleStart);
		expect([start.getDate(), start.getHours(), start.getMinutes()]).toEqual([
			1, 0, 0,
		]);
		expect(nextCycleStart).toBe(
			new Date(start.getFullYear(), start.getMonth() + 1, 1).getTime(),
		);
	});

	it("replaces a session's row as its transcript grows, counting it once", () => {
		const id = sessionIdOf("0000000e");
		cli("--json", "WFC_TEST_KEY");
		appendTranscript(id, buildModelTurn(1_000_000, "r2"));
		expect(JSON.parse(cli("--json", "WFC_TEST_KEY").stdout)).toMatchObject({
			settledUsd: 24,
		});
		expect(readLedgerLines()).toHaveLength(1);
	});

	it("reads a key exhausted from a credit refusal in a transcript", () => {
		appendTranscript(recordLaunch("0000000c"), CREDIT_REFUSAL_ROW);
		expect(JSON.parse(cli("--json", "WFC_TEST_KEY").stdout)).toMatchObject({
			exhausted: true,
			fit: 0,
		});
	});

	it("leaves out a transcript the launch record does not mark", () => {
		appendTranscript(sessionIdOf("0000000a"), buildModelTurn(5_000_000));
		expect(JSON.parse(cli("--json", "WFC_TEST_KEY").stdout)).toMatchObject({
			settledUsd: 20,
		});
	});

	it("prints the seat's status line", () => {
		const r = cli("WFC_TEST_KEY");
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
		const prefix = `overflow ${seatDir}: `;
		expect(r.stdout.startsWith(prefix)).toBe(true);
		expect(r.stdout.slice(prefix.length)).toMatch(
			/^fits 45; headroom \$180\.00 \(\$0\.00 held by 0 running\); spent \$20\.00 of \$200\.00 since \d{4}-\d{2}-01; resets \d{4}-\d{2}-01\n$/,
		);
	});

	it("refuses a key no overflow line declares by name", () => {
		const r = cli("WFC_NO_KEY");
		expect(r.status).toBe(1);
		expect(r.stderr).toBe(
			"WFC_NO_KEY is not an overflow seat's key in the seat file\n",
		);
	});

	it("refuses a bad command line with the usage", () => {
		for (const args of [[], ["--bogus", seatDir]]) {
			const r = cli(...args);
			expect(r.status).toBe(2);
			expect(r.stderr).toContain("usage:");
		}
	});
});

describe("the status line", () => {
	it("names the Console figure, the spend since and a failed read", () => {
		fs.mkdirSync(path.join(refill, ".overflow-ledger"), { recursive: true });
		fs.writeFileSync(
			path.join(refill, ".overflow-ledger", "WFC_TEST_KEY.console.jsonl"),
			[
				{
					at: Date.parse("2026-11-03T04:00:00Z"),
					credits: [
						{
							remainingUsd: 170.02,
							grantUsd: 200,
							grantedOn: "2026-10-28",
							expiresOn: "2099-12-01",
						},
					],
				},
				{ at: Date.parse("2026-11-04T04:00:00Z"), why: "Chrome is closed" },
			]
				.map((row) => `${JSON.stringify(row)}\n`)
				.join(""),
		);
		const r = runInProcess(SCRIPT, ["WFC_TEST_KEY"], {
			env: {
				PATH: process.env.PATH ?? "",
				HOME: home,
				WFC_REFILL_DIR: refill,
				WFC_CLAUDE_BIN: stub,
				CLAUDE_PROJECT_DIR: root,
				WFC_DISPATCH_ROOT: root,
			},
		});
		expect(r.stdout.trim()).toBe(
			`overflow ${seatDir}: fits 42; headroom $170.02 ($0.00 held by 0 running); $170.02 of $200.00 on the Console at 2026-11-03T04:00:00.000Z, $0.00 spent since; expires 2099-12-01; last Console read failed: Chrome is closed`,
		);
	});
});

describe("the per-session cap (#3698)", () => {
	let stops: string;
	const declared = () => ({
		seats: [
			{ dir: path.join(home, ".claude2"), kind: "plan" as const },
			{ ...seat, dir: seatDir },
		],
		errors: [],
	});
	const listed = (jobId: string, state = "working") => ({
		id: jobId,
		sessionId: sessionIdOf(jobId),
		name: `Overflow · job ${jobId}`,
		kind: "background",
		state,
	});
	const readStops = () =>
		fs.existsSync(stops)
			? fs.readFileSync(stops, "utf8").trim().split("\n")
			: [];

	/* Every call, with the seat it ran under; a stop answers as recorded. */
	const writeStopStub = (kind: StopKind = "ok") =>
		writeClaudeStub(stub, [
			`echo "$CLAUDE_CONFIG_DIR $*" >> ${shellQuote(stops)}`,
			buildStopBranch(path.join(tmp, "stop-argv.log"), kind),
		]);

	beforeEach(() => {
		stops = path.join(tmp, "stops.log");
		writeStopStub();
	});

	/* Allowance US$50; at US$4 a million tokens, 15M is US$60, 5M US$20. */
	it("stops a session past its allowance under its seat's dir, naming spend and allowance", () => {
		appendTranscript(recordLaunch("0000a001"), buildModelTurn(15_000_000));
		expect(stopOverAllowance(declared(), [listed("0000a001")])).toEqual([
			`stopped overflow session Overflow · job 0000a001 (0000a001) on ${seatDir}: spent $60.00 of its $50.00 allowance`,
		]);
		expect(readStops()).toEqual([`${seatDir} stop 0000a001`]);
	});

	it("stops a headless run past its allowance by its process group, never through claude stop (#4580)", () => {
		/* A `sleep` in a group of its own, orphaned to init so its reaping is
		 * not this process's. */
		const pid = startOrphan("sleep", "60");
		try {
			expect(readStat(pid)).toMatchObject({ pgrp: pid });
			expect(readStat(pid)?.ppid).not.toBe(process.pid);
			writeHeadlessRun(refill, "0000a005", sessionIdOf("0000a005"), {
				pid,
				pgid: pid,
				procStart: readProcStartOf(pid),
			});
			appendTranscript(recordLaunch("0000a005"), buildModelTurn(15_000_000));
			expect(
				stopOverAllowance(declared(), [
					{ ...listed("0000a005"), kind: "headless" },
				]),
			).toEqual([
				`stopped overflow session Overflow · job 0000a005 (0000a005) on ${seatDir}: spent $60.00 of its $50.00 allowance`,
			]);
			expect(readStops()).toEqual([]);
			expect(readProcStartOf(pid)).toBeNull();
		} finally {
			killGroup(pid);
		}
	});

	it("keeps the stopped session: a stop, never a removal, and its transcript stays", () => {
		const id = recordLaunch("0000a001");
		appendTranscript(id, buildModelTurn(15_000_000));
		stopOverAllowance(declared(), [listed("0000a001")]);
		expect(readStops().join("\n")).not.toMatch(/ rm /);
		expect(fs.existsSync(transcriptOf(id))).toBe(true);
	});

	it("leaves one under its allowance, a plan session and another key's alone", () => {
		appendTranscript(recordLaunch("0000a002"), buildModelTurn(5_000_000));
		appendTranscript(sessionIdOf("0000a003"), buildModelTurn(15_000_000));
		appendTranscript(
			recordLaunch("0000a004", { keyVar: "WFC_OTHER_KEY" }),
			buildModelTurn(15_000_000),
		);
		const agents = ["0000a002", "0000a003", "0000a004"].map((j) => listed(j));
		expect(stopOverAllowance(declared(), agents)).toEqual([]);
		expect(readStops()).toEqual([]);
	});

	it("stops a session once, so a reply to it afterwards runs uncapped", () => {
		appendTranscript(recordLaunch("0000a001"), buildModelTurn(15_000_000));
		stopOverAllowance(declared(), [listed("0000a001")]);
		expect(stopOverAllowance(declared(), [listed("0000a001")])).toEqual([]);
		expect(readStops()).toHaveLength(1);
	});

	it("caps without a stop one that ended past its allowance", () => {
		appendTranscript(recordLaunch("0000a001"), buildModelTurn(15_000_000));
		expect(stopOverAllowance(declared(), [listed("0000a001", "done")])).toEqual(
			[],
		);
		expect(stopOverAllowance(declared(), [listed("0000a001")])).toEqual([]);
		expect(readStops()).toEqual([]);
	});

	it("says why a stop failed, and tries again next tick", () => {
		writeStopStub("noJob");
		appendTranscript(recordLaunch("0000bad0"), buildModelTurn(15_000_000));
		const [line] = stopOverAllowance(declared(), [listed("0000bad0")]);
		expect(line).toMatch(
			/^could not stop overflow session .*0000bad0.*spent \$60\.00 of its \$50\.00 allowance: .*No job matching/,
		);
		stopOverAllowance(declared(), [listed("0000bad0")]);
		expect(readStops()).toHaveLength(2);
	});

	/* Its transcript repeats US$40 of requests its plan paid before the move. */
	describe("a session moved onto the key (#3736)", () => {
		const moved = (jobId: string) => {
			const id = recordLaunch(jobId, { offKeyUsd: 40 });
			appendTranscript(id, buildModelTurn(10_000_000, "r1"));
			return id;
		};

		it("is charged only what it spends on the key", () => {
			appendTranscript(moved("0000d001"), buildModelTurn(5_000_000, "r2"));
			expect(stopOverAllowance(declared(), [listed("0000d001")])).toEqual([]);
			appendTranscript(
				sessionIdOf("0000d001"),
				buildModelTurn(8_000_000, "r3"),
			);
			expect(stopOverAllowance(declared(), [listed("0000d001")])).toEqual([
				`stopped overflow session Overflow · job 0000d001 (0000d001) on ${seatDir}: spent $52.00 of its $50.00 allowance`,
			]);
		});

		it("charges a copy of it on the key only the chain's spend since the move", () => {
			const first = moved("0000d001");
			appendTranscript(first, buildModelTurn(2_000_000, "r2"));
			const copy = recordLaunch("0000d002", { copyOf: first });
			appendTranscript(
				copy,
				buildModelTurn(10_000_000, "r1"),
				buildModelTurn(2_000_000, "r2"),
				buildModelTurn(3_000_000, "r3"),
			);
			expect(
				stopOverAllowance(declared(), [
					listed("0000d001", "done"),
					listed("0000d002"),
				]),
			).toEqual([]);
		});

		it("takes the move's off-key spend off a copy whose root's transcript is gone", () => {
			const first = moved("0000d001");
			const copy = recordLaunch("0000d002", { copyOf: first });
			appendTranscript(
				copy,
				buildModelTurn(10_000_000, "r1"),
				buildModelTurn(3_000_000, "r2"),
			);
			expect(stopOverAllowance(declared(), [listed("0000d002")])).toEqual([]);
			fs.rmSync(transcriptOf(first));
			expect(stopOverAllowance(declared(), [listed("0000d002")])).toEqual([]);
		});
	});

	/* A `--bg --resume` copy repeats its parent's main-thread requests up to the
	 * fork, never the parent's subagents or what the parent spends after it
	 * (#4195's measurement). */
	describe("a resumed copy", () => {
		const subagentOf = (sessionId: string) =>
			path.join(
				path.dirname(transcriptOf(sessionId)),
				sessionId,
				"subagents",
				"agent-a1.jsonl",
			);
		const writeSubagent = (sessionId: string, ...rows: object[]) => {
			const file = subagentOf(sessionId);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(
				file,
				rows.map((r) => `${JSON.stringify(r)}\n`).join(""),
			);
		};

		it("stops a copy once its chain's spend reaches the allowance, the shared requests counted once", () => {
			const parent = recordLaunch("0000c001");
			appendTranscript(parent, buildModelTurn(5_000_000, "r1"));
			writeSubagent(parent, buildModelTurn(5_000_000, "rs"));
			const copy = recordLaunch("0000c002", { copyOf: parent });
			appendTranscript(
				copy,
				buildModelTurn(5_000_000, "r1"),
				buildModelTurn(3_000_000, "r2"),
			);
			expect(
				stopOverAllowance(declared(), [
					listed("0000c001", "done"),
					listed("0000c002"),
				]),
			).toEqual([
				`stopped overflow session Overflow · job 0000c002 (0000c002) on ${seatDir}: spent $52.00 of its $50.00 allowance`,
			]);
			expect(readStops()).toEqual([`${seatDir} stop 0000c002`]);
		});

		it("counts what the parent spent after the fork, and a copy of a copy", () => {
			const parent = recordLaunch("0000c001");
			appendTranscript(
				parent,
				buildModelTurn(5_000_000, "r1"),
				buildModelTurn(4_000_000, "r9"),
			);
			const copy = recordLaunch("0000c002", { copyOf: parent });
			appendTranscript(copy, buildModelTurn(5_000_000, "r1"));
			const second = recordLaunch("0000c003", { copyOf: copy });
			appendTranscript(
				second,
				buildModelTurn(5_000_000, "r1"),
				buildModelTurn(3_500_000, "r2"),
			);
			expect(stopOverAllowance(declared(), [listed("0000c003")])).toEqual([
				`stopped overflow session Overflow · job 0000c003 (0000c003) on ${seatDir}: spent $50.00 of its $50.00 allowance`,
			]);
			expect(readStops()).toEqual([`${seatDir} stop 0000c003`]);
		});

		it("counts a parent whose transcript is gone at its ledger row, the shared requests once (#4370)", () => {
			const parent = recordLaunch("0000c001");
			appendTranscript(parent, buildModelTurn(5_000_000, "r1"));
			writeSubagent(parent, buildModelTurn(5_000_000, "rs"));
			const copy = recordLaunch("0000c002", { copyOf: parent });
			appendTranscript(copy, buildModelTurn(5_000_000, "r1"));
			expect(stopOverAllowance(declared(), [listed("0000c002")])).toEqual([]);
			fs.rmSync(transcriptOf(parent));
			fs.rmSync(path.dirname(path.dirname(subagentOf(parent))), {
				recursive: true,
			});
			appendTranscript(copy, buildModelTurn(3_000_000, "r2"));
			expect(stopOverAllowance(declared(), [listed("0000c002")])).toEqual([
				`stopped overflow session Overflow · job 0000c002 (0000c002) on ${seatDir}: spent $52.00 of its $50.00 allowance`,
			]);
		});

		it("caps a chain once, so a copy that carries a reply to a capped session runs uncapped", () => {
			const parent = recordLaunch("0000c001");
			appendTranscript(parent, buildModelTurn(15_000_000, "r1"));
			stopOverAllowance(declared(), [listed("0000c001")]);
			const copy = recordLaunch("0000c002", { copyOf: parent });
			appendTranscript(
				copy,
				buildModelTurn(15_000_000, "r1"),
				buildModelTurn(1_000_000, "r2"),
			);
			expect(stopOverAllowance(declared(), [listed("0000c002")])).toEqual([]);
			expect(readStops()).toEqual([`${seatDir} stop 0000c001`]);
		});

		it("counts a request with no id once per file, a residual", () => {
			const idless = {
				type: "assistant",
				message: {
					model: "claude-opus-5-5",
					usage: { input_tokens: 5_000_000 },
				},
			};
			const parent = recordLaunch("0000c001");
			appendTranscript(parent, idless);
			const copy = recordLaunch("0000c002", { copyOf: parent });
			appendTranscript(copy, idless, buildModelTurn(3_000_000, "r2"));
			expect(stopOverAllowance(declared(), [listed("0000c002")])).toEqual([
				`stopped overflow session Overflow · job 0000c002 (0000c002) on ${seatDir}: spent $52.00 of its $50.00 allowance`,
			]);
		});

		it("leaves a copy whose chain is under the allowance", () => {
			const parent = recordLaunch("0000c001");
			appendTranscript(parent, buildModelTurn(5_000_000, "r1"));
			const copy = recordLaunch("0000c002", { copyOf: parent });
			appendTranscript(
				copy,
				buildModelTurn(5_000_000, "r1"),
				buildModelTurn(3_000_000, "r2"),
			);
			expect(stopOverAllowance(declared(), [listed("0000c002")])).toEqual([]);
		});
	});

	it("judges none whose launch records no allowance", () => {
		const id = sessionIdOf("0000a005");
		record({
			issues: [],
			model: "opus",
			prompt: "/implement",
			root,
			jobId: "0000a005",
			overflow: {
				keyVar: "WFC_TEST_KEY",
				allowanceUsd: Number.NaN,
				sessionId: id,
			},
		});
		appendTranscript(id, buildModelTurn(15_000_000));
		expect(stopOverAllowance(declared(), [listed("0000a005")])).toEqual([
			`overflow session Overflow · job 0000a005 (0000a005) on ${seatDir} unjudged: its launch records no allowance`,
		]);
		expect(readStops()).toEqual([]);
	});

	it("says so where the listing is unread, and is silent with no overflow seat", () => {
		expect(stopOverAllowance(declared(), null)).toEqual([
			"overflow allowances unjudged: the listing is unread",
		]);
		expect(
			stopOverAllowance({ seats: [declared().seats[0]], errors: [] }, null),
		).toEqual([]);
	});
});
