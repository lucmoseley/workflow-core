// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	isFinishedAgent,
	isTerminalAgent,
	listedAgents,
	TERMINAL_STATES,
} from "./agent-liveness.js";
import {
	buildAgentsBranch,
	buildJobRow,
	buildListedRow,
	buildPermissionRow,
	buildStopBranch,
	buildUnrecordedRow,
	isPermissionRow,
	type Row,
	recorded,
	type StopKind,
} from "./agents-stop-fake";
import { blockCause } from "./block-cause.js";
import { stopOn } from "./claude-stop.js";
import { claudeLiveSkipReason, writeClaudeStub } from "./claude-stub";
import { shellQuote } from "./sh-quote.js";

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-stop-"));
	vi.stubEnv("CLAUDE_CODE_SESSION_ID", "");
	vi.stubEnv("WFC_REFILL_DIR", path.join(dir, "refill"));
	vi.stubEnv("WFC_ORACLE_CACHE", "0");
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const claudeOf = (...lines: string[]) =>
	writeClaudeStub(path.join(dir, "claude"), lines, 9);

const readListing = (bin: string) => {
	vi.stubEnv("WFC_CLAUDE_BIN", bin);
	const listing = listedAgents({ requireSelf: false });
	expect(listing.why).toBeUndefined();
	return (listing.agents ?? []).map(({ seat, ...row }) => {
		expect(seat).toEqual(expect.any(String));
		return row;
	});
};

const expectReadAlike = (row: Row) => {
	const [read] = readListing(claudeOf(buildAgentsBranch([row])));
	expect(read).toEqual(row);
	expect(isFinishedAgent(read)).toBe(row.state === "done");
	expect(isTerminalAgent(read)).toBe(TERMINAL_STATES.has(String(row.state)));
};

const keyTypes = (row: object) =>
	Object.entries(row).map(([key, value]) => `${key}:${typeof value}`);
const printedKeyTypes = new Set(recorded.rows.flatMap(keyTypes));

it("records the working, done and blocked rows the verdicts are held on, and a waiting one", () => {
	const states = recorded.rows.map((r) => r.state);
	expect(states).toContain("working");
	expect(states).toContain("done");
	expect(states).toContain("blocked");
	expect(recorded.rows.some(isPermissionRow)).toBe(true);
});

const QUESTION_JOB = {
	state: "blocked",
	tempo: "blocked",
	inFlight: { tasks: 0 },
	needs: "Which colour?",
	cliVersion: recorded.harness,
};

describe.each(recorded.rows.filter((r) => r.state === "blocked"))(
	"a recorded blocked row",
	(row) => {
		it("reads as its fake does to block-cause.js", () => {
			const waiting = isPermissionRow(row);
			const fake = waiting
				? buildPermissionRow("job7")
				: buildJobRow("job7", "blocked");
			expect(fake.status).toBe(row.status);
			expect(fake.waitingFor).toBe(row.waitingFor);
			const recordedReading = blockCause({ row, job: QUESTION_JOB, tail: [] });
			expect(recordedReading).toEqual({
				cause: waiting ? "PERMISSION" : "QUESTION",
			});
			expect(blockCause({ row: fake, job: QUESTION_JOB, tail: [] })).toEqual(
				recordedReading,
			);
		});
	},
);

describe.each(recorded.rows)("a recorded $state row", (row) => {
	it(`reads ${recorded.harness}'s recorded row`, () => {
		expectReadAlike(row);
	});

	it("reads the fake of it", () => {
		const { status } = row;
		const fake = buildJobRow(
			"job7",
			String(row.state),
			status ? { status } : {},
		);
		expectReadAlike(fake);
		for (const pair of keyTypes(fake)) expect(printedKeyTypes).toContain(pair);
	});
});

it("refuses a field the harness never lists", () => {
	expect(() => buildListedRow({ tempo: "active" })).toThrow(/lists no "tempo"/);
});

it("refuses a status and state the harness never lists together", () => {
	expect(() => buildListedRow({ status: "busy", state: "blocked" })).toThrow(
		/lists no busy\/blocked row/,
	);
});

it("refuses to leave out a field the harness always lists", () => {
	expect(() => buildListedRow({}, ["sessionId"])).toThrow(
		/never leaves out "sessionId"/,
	);
});

it("holds an unrecorded row to the harness's field names alone", () => {
	expect(buildUnrecordedRow({ state: "failed" })).toEqual({ state: "failed" });
	expect(() => buildUnrecordedRow({ tempo: "active" })).toThrow(
		/lists no "tempo"/,
	);
});

describe("the fake's listing answers", () => {
	it("fails with the exit status it is given", () => {
		vi.stubEnv("WFC_CLAUDE_BIN", claudeOf(buildAgentsBranch({ exit: 4 })));
		expect(listedAgents({ requireSelf: false }).why).toContain("exit 4");
	});

	it("fails as given after printing rows, logging the call", () => {
		const log = path.join(dir, "calls");
		const rows = [buildJobRow("own", "working")];
		vi.stubEnv(
			"WFC_CLAUDE_BIN",
			claudeOf(buildAgentsBranch({ exit: 4, rows }, {}, log)),
		);
		const listing = listedAgents({ requireSelf: false });
		expect(listing.why).toContain("exit 4");
		expect(listing.agents).toBeUndefined();
		expect(fs.readFileSync(log, "utf8")).toMatch(/^(agents --json\n)+$/);
	});

	it("appends each call's argv to the file it is given, then answers", () => {
		const log = path.join(dir, "calls");
		const row = buildJobRow("own", "working");
		const bin = claudeOf(buildAgentsBranch([row], {}, log));
		expect(readListing(bin)).toEqual([row]);
		readListing(bin);
		expect(fs.readFileSync(log, "utf8")).toBe("agents --json\nagents --json\n");
	});

	it("answers a seat it maps as that seat's, any other as the fallback", () => {
		const seat = path.join(dir, "seat-a");
		fs.mkdirSync(seat);
		vi.stubEnv("WFC_CLAUDE_CONFIG_A", seat);
		vi.stubEnv("WFC_CLAUDE_CONFIG_B", path.join(dir, "no-b"));
		vi.stubEnv("WFC_CLAUDE_CONFIG_C", path.join(dir, "no-c"));
		const bin = claudeOf(
			buildAgentsBranch([buildJobRow("own", "working")], {
				[seat]: [buildJobRow("a1", "working")],
			}),
		);
		expect(
			readListing(bin)
				.map((r) => r.id)
				.sort(),
		).toEqual(["a1", "own"]);
	});
});

const stopCases: { kind: StopKind; outcome: object }[] = [
	{ kind: "ok", outcome: { ok: true } },
	{ kind: "noJob", outcome: { ok: false, noJob: true, timedOut: false } },
];

describe.each(stopCases)("the $kind stop", ({ kind, outcome }) => {
	it(`reads ${recorded.harness}'s recorded answer`, () => {
		const r = recorded.stops[kind];
		const out = path.join(dir, "out");
		const err = path.join(dir, "err");
		fs.writeFileSync(out, r.stdout);
		fs.writeFileSync(err, r.stderr);
		const bin = claudeOf(
			`cat ${shellQuote(out)}; cat ${shellQuote(err)} >&2; exit ${r.status}`,
		);
		expect(stopOn(dir, r.id, bin)).toMatchObject(outcome);
	});

	it("reads the fake of it", () => {
		const log = path.join(dir, "stops");
		const read = stopOn(dir, "job7", claudeOf(buildStopBranch(log, kind)));
		expect(read).toMatchObject(outcome);
		expect(read.said).toContain("job7");
		expect(fs.readFileSync(log, "utf8")).toBe("stop job7\n");
	});
});

describe.each([
	{ answer: "busy", outcome: { ok: false, noJob: false, timedOut: false } },
	{
		answer: "warnedNoJob",
		outcome: { ok: false, noJob: true, said: expect.stringContaining("job7") },
	},
	{
		answer: "oldNoJob",
		outcome: { ok: false, noJob: true, said: expect.stringContaining("job7") },
	},
	{
		answer: "killed",
		outcome: { ok: false, why: "exit on a signal: going down" },
	},
] as const)("the fake's $answer stop", ({ answer, outcome }) => {
	it("reads as the verdict it stands for", () => {
		const log = path.join(dir, "stops");
		expect(
			stopOn(dir, "job7", claudeOf(buildStopBranch(log, answer))),
		).toMatchObject(outcome);
	});
});

it.skipIf(claudeLiveSkipReason())(
	"the installed claude answers a stop of no job as the recording does",
	() => {
		const noJob = stopCases.find((c) => c.kind === "noJob");
		expect(stopOn(dir, recorded.stops.noJob.id, "claude")).toMatchObject(
			noJob?.outcome ?? {},
		);
	},
	30_000,
);
