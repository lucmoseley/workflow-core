// @vitest-environment node
/*
 * Pins lib/overflow-budget.js: a session on the key priced from its transcript,
 * priced again as it grows and counted once; only sessions the launch record
 * marks on the key counted, from any checkout; the exhausted mark from a credit
 * refusal in a transcript; a listed session held, not settled; and the CLI's JSON
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildStopBranch, type StopKind } from "./agents-stop-fake";
import { writeClaudeStub } from "./claude-stub";
import { writeCostTable } from "./cost-table-testkit";
import { record } from "./dispatch-ledger.js";
import { seatBudget, stopOverAllowance } from "./overflow-budget.js";
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
const SAVED_ENV = [
	"WFC_REFILL_DIR",
	"WFC_DISPATCH_ROOT",
	"WFC_CLAUDE_BIN",
	"CLAUDE_PROJECT_DIR",
	"CLAUDE_CODE_SESSION_ID",
	"HOME",
] as const;
const saved = SAVED_ENV.map((k) => [k, process.env[k]] as const);
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
	process.env.WFC_REFILL_DIR = refill;
	process.env.WFC_DISPATCH_ROOT = root;
	process.env.WFC_CLAUDE_BIN = stub;
	process.env.HOME = home;
	delete process.env.CLAUDE_CODE_SESSION_ID;
});

afterEach(() => {
	for (const [k, v] of saved)
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
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
	}: { keyVar?: string; at?: string; withSessionId?: boolean } = {},
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

/* As Claude Code 2.1.312 wrote it (#3692's probes). */
const CREDIT_REFUSAL_ROW = {
	type: "assistant",
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
		delete process.env.CLAUDE_PROJECT_DIR;
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

	it("is not this key's where the launch record does not say so", () => {
		writeListing([{ id: "0000000d", sessionId: sessionIdOf("0000000d") }]);
		expect(budget()).toMatchObject({ running: 0, reservedUsd: 0 });
	});

	it("says why where the listing will not read", () => {
		fs.writeFileSync(stub, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
		expect(budget()).toEqual({ why: expect.stringContaining("agents --json") });
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
			`overflow ${seatDir}: fits 42; headroom $170.02 ($0.00 held by 0 running); $170.02 on the Console at 2026-11-03T04:00:00.000Z, $0.00 spent since; last Console read failed: Chrome is closed`,
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
