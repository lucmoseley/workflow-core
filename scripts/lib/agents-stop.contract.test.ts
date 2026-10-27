// @vitest-environment node
/*
 * Holds lib/agent-liveness.js's and lib/block-cause.js's reads of `claude
 * agents --json` (#3005) and lib/claude-stop.js's read of `claude stop`
 * (#2988) to one case list, run against the installed harness's recorded
 * responses (scripts/fixtures/agents-stop.json, re-recorded by
 * `node scripts/record-claude-responses.js`), against
 * lib/agents-stop-fake.ts, which refill-loop-run.test.ts's `claude` stub
 * prints, and, on the founder's machine, against the real `claude` where a
 * call is free. Breaking it costs the refill loop's judging of its launches: a
 * row the fake shapes as the harness never would passes a test the loop
 * fails, and a "No job matching" the stop misreads stops on the wrong seat or
 * not at all.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
	isPermissionRow,
	type Row,
	recorded,
	type StopKind,
} from "./agents-stop-fake";
import { blockCause } from "./block-cause.js";
import { stopOn } from "./claude-stop.js";
import { writeClaudeStub } from "./claude-stub";

let dir: string;
const savedEnv = { ...process.env };

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-stop-"));
	process.env.CLAUDE_CODE_SESSION_ID = "";
	process.env.WFC_REFILL_DIR = path.join(dir, "refill");
	process.env.WFC_ORACLE_CACHE = "0";
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
	process.env = { ...savedEnv };
});

/** A `claude` whose body is `lines`. */
const claudeOf = (...lines: string[]) =>
	writeClaudeStub(path.join(dir, "claude"), lines, 9);

/** The reader's listing off a `claude` at `bin`. */
const readListing = (bin: string) => {
	process.env.WFC_CLAUDE_BIN = bin;
	const listing = listedAgents({ requireSelf: false });
	expect(listing.why).toBeUndefined();
	return listing.agents ?? [];
};

/** `row` read back unchanged through the listing, with the reaper's and the
 * liveness verdicts its state calls for. */
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

/* A job record and transcript block-cause.js reads QUESTION off, so the
 * reading turns on the row alone: QUESTION, or PERMISSION off a waiting
 * row. */
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
			/* As refill-loop-run.test.ts builds it, so the fields block-cause.js
			 * reads are the fake's own, not copied from the recording. */
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
		const bin = claudeOf(`cat '${out}'; cat '${err}' >&2; exit ${r.status}`);
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

/*
 * The free call, against the installed `claude` on the case's own config dir:
 * a stop of an id no daemon issued (§G7.2). The listing has no live case: under the suite's own
 * CLAUDE_CONFIG_DIR (#838) no daemon lists a session, and the live seat is
 * the one #838 keeps every test out of.
 */
// Residual: off the founder's machine this skips, and the fixture goes unchecked.
function liveSkipReason(): string | undefined {
	if (process.env.CI)
		return "CI: the live claude case runs on the founder's machine only";
	const { status } = spawnSync("claude", ["--version"], {
		stdio: "ignore",
		// A guess: it answers in well under a second, and a hang should skip.
		timeout: 30_000,
	});
	return status === 0 ? undefined : "no claude on PATH";
}

it.skipIf(liveSkipReason())(
	"the installed claude answers a stop of no job as the recording does",
	() => {
		const noJob = stopCases.find((c) => c.kind === "noJob");
		expect(stopOn(dir, recorded.stops.noJob.id, "claude")).toMatchObject(
			noJob?.outcome ?? {},
		);
	},
	30_000,
);
