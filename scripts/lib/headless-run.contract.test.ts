// @vitest-environment node
/*
 * Holds a headless `claude -p` run's two faces (#4586) — the options it takes,
 * which lib/headless-sessions.js's launch passes, and its `result` row, which
 * lib/headless-runs.js's readEndResult reads — to the installed harness's
 * recording (scripts/fixtures/headless-run.json, re-recorded by
 * `node scripts/record-headless-run.js`), to lib/headless-run-fake.ts, which
 * every suite's `claude` stub execs for `-p`, and, on the founder's machine,
 * to the real `claude` where a call is free: its `--help` and its refusal of
 * an unknown flag. Breaking it lets a renamed flag or result field pass every
 * suite, and an overflow run launch refused or bill as a success it was not.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readProcStartOf } from "./arbiter-proc.js";
import { claudeLiveSkipReason, LIVE_CALL_TIMEOUT_MS } from "./claude-stub";
import { parseHelpOptions } from "./headless-options.js";
import {
	buildResultRow,
	readHeadlessCalls,
	recorded,
	writeHeadlessFake,
} from "./headless-run-fake";
import { readEndResult } from "./headless-runs.js";

const SESSION = "0f0e0d0c-0000-4000-8000-000000000000";
const UNKNOWN = "--wfc-contract-no-such-flag";
const ARGV = ["-p", "--session-id", SESSION, "/implement 7"];

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "headless-run-"));
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const fakeBin = () =>
	writeHeadlessFake(path.join(dir, "claude"), {
		log: path.join(dir, "calls.jsonl"),
		mode: "end",
	});

const runFake = (argv: string[]) =>
	spawnSync(fakeBin(), argv, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});

/** An ended run whose stream is `stdout`, as readEndResult reads it. */
function endedRun(stdout: string) {
	const pid = spawnSync("true").pid;
	const log = path.join(dir, "out.jsonl");
	const stderr = path.join(dir, "stderr.log");
	fs.writeFileSync(log, stdout);
	fs.writeFileSync(stderr, "");
	return {
		jobId: "0badf00d",
		sessionId: SESSION,
		pid,
		procStart: readProcStartOf(pid),
		bootId: null,
		pgid: pid,
		seat: dir,
		keyVar: "K",
		cwd: dir,
		prompt: "/implement 7",
		log,
		stderr,
		launchedAt: 1,
	};
}

describe("the result row", () => {
	it(`carries, in ${recorded.harness}'s recording, every field readEndResult reads`, () => {
		const row = recorded.result;
		expect(row.type).toBe("result");
		expect(row.is_error).toBe(false);
		expect(typeof row.result).toBe("string");
		expect(row.result_index).toBe(0);
		expect(row.total_cost_usd).toBeGreaterThan(0);
		expect(typeof row.session_id).toBe("string");
	});

	it("reads as the recorded run's success at its cost", () => {
		expect(
			readEndResult(endedRun(`${JSON.stringify(recorded.result)}\n`)),
		).toEqual({
			outcome: "success",
			costUsd: recorded.result.total_cost_usd,
			sessionId: SESSION,
		});
	});

	it("reads the fake's end the same, re-keyed to its session", () => {
		const r = runFake(ARGV);
		expect(r.status).toBe(0);
		expect(JSON.parse(r.stdout)).toEqual(
			buildResultRow({ session_id: SESSION }),
		);
		expect(readEndResult(endedRun(r.stdout))).toEqual({
			outcome: "success",
			costUsd: recorded.result.total_cost_usd,
			sessionId: SESSION,
		});
	});
});

const SESSION_ID_FLAGS = recorded.options.find((o) =>
	o.names.includes("--session-id"),
)?.flags;

/* The refusals the binary makes before any turn, so free to run live. */
const refusals = [
	{
		what: "a flag the recording lacks",
		argv: ["-p", UNKNOWN, "3", "x"],
		stderr: `error: unknown option '${UNKNOWN}'\n`,
	},
	{
		what: "a value-taking flag given none",
		argv: ["-p", "--session-id"],
		stderr: `error: option '${SESSION_ID_FLAGS}' argument missing\n`,
	},
];

/* The installed `claude` side skips where claudeLiveSkipReason says (§G7.2).
 * Residual: off the founder's machine it skips, and the fixture goes
 * unchecked. */
const binaries = [
	{ name: "the fake", skip: undefined, bin: () => fakeBin() },
	{
		name: "the installed claude",
		skip: claudeLiveSkipReason(),
		bin: () => "claude",
	},
];

describe.each(binaries)("$name", ({ skip, bin }) => {
	it.skipIf(skip).each(refusals)(
		"refuses $what, in the binary's words, before any turn",
		({ argv, stderr }) => {
			const r = spawnSync(bin(), argv, {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				timeout: LIVE_CALL_TIMEOUT_MS,
			});
			expect(r.status).toBe(1);
			expect(r.stderr).toBe(stderr);
			expect(readHeadlessCalls(path.join(dir, "calls.jsonl"))).toEqual([]);
		},
		LIVE_CALL_TIMEOUT_MS,
	);
});

/*
 * The installed `claude`'s help, also free. A run's result row has no live
 * case: it spends a turn, so the recorder takes it.
 */
it.skipIf(claudeLiveSkipReason())(
	"the installed claude still lists every recorded option, as recorded",
	() => {
		const help = spawnSync("claude", ["--help"], {
			encoding: "utf8",
			timeout: LIVE_CALL_TIMEOUT_MS,
		});
		expect(parseHelpOptions(help.stdout)).toEqual(
			expect.arrayContaining(recorded.options),
		);
	},
	LIVE_CALL_TIMEOUT_MS,
);
