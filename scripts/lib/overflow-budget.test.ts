// @vitest-environment node
/*
 * Pins lib/overflow-budget.js: settlement from a run's `result` event, from
 * its transcript, and at Q where it left neither; the exhausted mark from a
 * credit refusal; a running run's reservation; and the CLI's JSON and status
 * line for a fixture seat, every figure read from a fixed
 * WFC_SESSION_COST_TABLE.
 *
 * Loosen one and a settled run's spend goes uncounted or counted twice, or
 * the CLI reports a figure the gate did not size (#2609).
 *
 * Runs are fixture records in a sandboxed WFC_REFILL_DIR: a live one carries
 * this test process's pid and start time, an ended one a start time no
 * process has.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { currentBootId, procStartOf } from "./arbiter-proc.js";
import { seatBudget } from "./overflow-budget.js";
import { runInProcess } from "./run-in-process.js";

const SCRIPT = path.join(__dirname, "overflow-budget.js");
/* Mean 4 and a two-step table: a run 5 in has an expected remainder of 5. */
const TABLE = { n: 3, meanUsd: 4, quantilesUsd: [1, 3, 10] };
let tmp: string;
let home: string;
let refill: string;
let seatDir: string;
let tableFile: string;
const saved = {
	refill: process.env.WFC_REFILL_DIR,
	table: process.env.WFC_SESSION_COST_TABLE,
};

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "overflow-budget-"));
	home = path.join(tmp, "home");
	refill = path.join(tmp, "refill");
	seatDir = path.join(home, ".claude2-api");
	fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
	fs.mkdirSync(seatDir, { recursive: true });
	fs.writeFileSync(
		path.join(home, ".claude", "refill-seats"),
		`${path.join(home, ".claude2")}\n~/.claude2-api api key=WFC_TEST_KEY grant=200 cycle-day=1\n`,
	);
	tableFile = path.join(tmp, "table.json");
	fs.writeFileSync(tableFile, JSON.stringify(TABLE));
	process.env.WFC_REFILL_DIR = refill;
	process.env.WFC_SESSION_COST_TABLE = tableFile;
});

afterEach(() => {
	for (const [k, v] of [
		["WFC_REFILL_DIR", saved.refill],
		["WFC_SESSION_COST_TABLE", saved.table],
	] as const)
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	fs.rmSync(tmp, { recursive: true, force: true });
});

function storeRun(
	jobId: string,
	{ live = false, events = [] as object[] } = {},
): string {
	const dir = path.join(refill, ".headless-runs", jobId);
	fs.mkdirSync(dir, { recursive: true });
	const sessionId = `00000000-0000-4000-8000-0000${jobId}`;
	const log = path.join(dir, "out.jsonl");
	fs.writeFileSync(log, events.map((e) => `${JSON.stringify(e)}\n`).join(""));
	fs.writeFileSync(
		path.join(dir, "run.json"),
		JSON.stringify({
			jobId,
			sessionId,
			pid: process.pid,
			procStart: live ? procStartOf(process.pid) : "not-a-start-time",
			bootId: currentBootId(),
			pgid: process.pid,
			seat: seatDir,
			cwd: tmp,
			log,
			stderr: path.join(dir, "stderr.log"),
			launchedAt: Date.now(),
		}),
	);
	return sessionId;
}

/* A transcript costing US$4 per million fresh Opus input tokens. */
function storeTranscript(sessionId: string, inputTokens: number) {
	const dir = path.join(seatDir, "projects", "-fixture");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, `${sessionId}.jsonl`),
		`${JSON.stringify({
			type: "assistant",
			requestId: "r1",
			message: {
				model: "claude-opus-5-5",
				usage: { input_tokens: inputTokens },
			},
		})}\n`,
	);
}

const seat = {
	dir: "",
	kind: "overflow" as const,
	keyVar: "WFC_TEST_KEY",
	grantUsd: 200,
	cycleDay: 1,
};
const ledgerLines = () =>
	fs
		.readFileSync(
			path.join(refill, ".overflow-ledger", "WFC_TEST_KEY.jsonl"),
			"utf8",
		)
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));

describe("seatBudget settlement", () => {
	it("settles an ended run from its result event, once", () => {
		storeRun("0000000a", {
			events: [
				{ type: "result", result_index: 0, total_cost_usd: 2 },
				{ type: "result", result_index: 1, total_cost_usd: 6 },
			],
		});
		const s = { ...seat, dir: seatDir };
		const b = seatBudget(s);
		expect(b).toMatchObject({ settledUsd: 6, fit: 48, running: 0 });
		seatBudget(s);
		expect(ledgerLines()).toMatchObject([
			{ jobId: "0000000a", costUsd: 6, costSource: "result" },
		]);
	});

	it("prices an ended run with no result from its transcript", () => {
		const id = storeRun("0000000b");
		storeTranscript(id, 2_000_000);
		const b = seatBudget({ ...seat, dir: seatDir });
		expect(b).toMatchObject({ settledUsd: 8 });
		expect(ledgerLines()).toMatchObject([
			{
				sessionId: id,
				costUsd: 8,
				costSource: "transcript",
				outcome: "killed",
			},
		]);
	});

	it("charges Q for an ended run that left neither a result nor a transcript", () => {
		storeRun("0000000f");
		expect(seatBudget({ ...seat, dir: seatDir })).toMatchObject({
			settledUsd: 4,
		});
		expect(ledgerLines()).toMatchObject([
			{ costUsd: 4, costSource: "reservation", outcome: "killed" },
		]);
	});

	it("marks the key exhausted from a credit refusal", () => {
		storeRun("0000000c", {
			events: [
				{
					type: "result",
					is_error: true,
					result: "Credit balance is too low",
					total_cost_usd: 0,
				},
			],
		});
		expect(seatBudget({ ...seat, dir: seatDir })).toMatchObject({
			exhausted: true,
			fit: 0,
		});
	});

	it("reserves a running run from its transcript and leaves it unsettled", () => {
		const id = storeRun("0000000d", { live: true });
		storeTranscript(id, 1_250_000);
		const b = seatBudget({ ...seat, dir: seatDir });
		/* spent 5: max(4, 5 + 5) = 10 held. */
		expect(b).toMatchObject({ running: 1, reservedUsd: 10, fit: 47 });
		expect(
			fs.existsSync(
				path.join(refill, ".overflow-ledger", "WFC_TEST_KEY.jsonl"),
			),
		).toBe(false);
	});

	it("says why where the cost table is unreadable", () => {
		process.env.WFC_SESSION_COST_TABLE = path.join(tmp, "absent.json");
		expect(seatBudget({ ...seat, dir: seatDir })).toEqual({
			why: "the session cost table is unreadable",
		});
	});
});

describe("the CLI", () => {
	const cli = (...args: string[]) =>
		runInProcess(SCRIPT, args, {
			env: {
				PATH: process.env.PATH ?? "",
				HOME: home,
				WFC_REFILL_DIR: refill,
				WFC_SESSION_COST_TABLE: tableFile,
			},
		});

	beforeEach(() => {
		storeRun("0000000e", {
			events: [{ type: "result", total_cost_usd: 20 }],
		});
	});

	it("prints the seat's budget as JSON", () => {
		const r = cli("--json", "~/.claude2-api");
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
		const { cycleStart, nextCycleStart, ...figures } = JSON.parse(r.stdout);
		expect(figures).toEqual({
			fit: 45,
			headroomUsd: 180,
			settledUsd: 20,
			reservedUsd: 0,
			grantUsd: 200,
			qUsd: 4,
			running: 0,
			exhausted: false,
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

	it("prints the seat's status line", () => {
		const r = cli(seatDir);
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
		const prefix = `overflow ${seatDir}: `;
		expect(r.stdout.startsWith(prefix)).toBe(true);
		expect(r.stdout.slice(prefix.length)).toMatch(
			/^fits 45; headroom \$180\.00 \(\$0\.00 held by 0 running\); spent \$20\.00 of \$200\.00 since \d{4}-\d{2}-01; resets \d{4}-\d{2}-01\n$/,
		);
	});

	it("refuses a plan seat by name", () => {
		const r = cli(path.join(home, ".claude2"));
		expect(r.status).toBe(1);
		expect(r.stderr).toBe(
			`${path.join(home, ".claude2")} is not an overflow seat in the seat file\n`,
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
