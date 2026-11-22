// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readProcStartOf } from "./arbiter-proc.js";
import { STREAM_ARGS, startStreamChild } from "./chrome-stream.js";
import { claudeLiveSkipReason } from "./claude-stub";
import { LIVE_CALL_TIMEOUT_MS, parseHelpOptions } from "./headless-options.js";
import {
	buildResultRow,
	readHeadlessCalls,
	readStreamEvents,
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

describe("the interrupt answer", () => {
	const { controlResponse, result } = recorded.interrupt;

	it("is, in the recording, a control_response and an interrupted result row", () => {
		expect(controlResponse).toMatchObject({
			type: "control_response",
			response: { subtype: "success" },
		});
		expect(result.type).toBe("result");
		expect(result.subtype).not.toBe("success");
	});

	it("is the fake's too, as chrome-stream's capped turn reads it: the recorded control_response to the request sent, then a result row of the recorded subtype", async () => {
		const bin = writeHeadlessFake(path.join(dir, "claude"), {
			log: path.join(dir, "calls.jsonl"),
			mode: "stream",
			turns: [[]],
			events: path.join(dir, "events.jsonl"),
		});
		const rows: Record<string, unknown>[] = [];
		const run = startStreamChild(
			bin,
			["-p", ...STREAM_ARGS, "--session-id", SESSION],
			{},
			(row) => rows.push(row),
		);
		run.send("x");
		const end = await run.turn({ capMs: 50, graceMs: 5000 });
		await run.finish();
		const interrupt = readStreamEvents(path.join(dir, "events.jsonl")).find(
			(e) => "stdin" in e && e.stdin.type === "control_request",
		);
		const response = rows.find((r) => r.type === "control_response") as {
			response: Record<string, unknown>;
		};
		expect(
			interrupt && "stdin" in interrupt && interrupt.stdin.request_id,
		).toBe(response.response.request_id);
		expect({
			...response,
			response: {
				...response.response,
				request_id: controlResponse.response.request_id,
			},
		}).toEqual(controlResponse);
		expect(end.capped).toBe(true);
		expect(end.result).toMatchObject({
			type: "result",
			subtype: result.subtype,
			is_error: result.is_error,
		});
	});
});

it("the fake ends on the text and exit status it is given, logging a file on stdin as its text", () => {
	const prompt = path.join(dir, "prompt.md");
	fs.writeFileSync(prompt, "Read it.\n");
	const bin = writeHeadlessFake(path.join(dir, "claude"), {
		log: path.join(dir, "calls.jsonl"),
		mode: "end",
		text: "said\n",
		exit: 3,
	});
	const r = spawnSync(bin, ["-p"], {
		encoding: "utf8",
		stdio: [fs.openSync(prompt, "r"), "pipe", "pipe"],
	});
	expect(r.status).toBe(3);
	expect(r.stdout).toBe("said\n");
	expect(
		readHeadlessCalls(path.join(dir, "calls.jsonl")).map((c) => c.stdinText),
	).toEqual(["Read it.\n"]);
});

const SESSION_ID_FLAGS = recorded.options.find((o) =>
	o.names.includes("--session-id"),
)?.flags;

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
	...recorded.hidden.map((o) => ({
		what: `the hidden ${o.names[0]} given no value`,
		argv: ["-p", o.names[0] ?? ""],
		stderr: `error: option '${o.flags}' argument missing\n`,
	})),
];

const LIVE_SKIP = claudeLiveSkipReason();

const binaries = [
	{ name: "the fake", skip: undefined, bin: () => fakeBin(), logs: true },
	{
		name: "the installed claude",
		skip: LIVE_SKIP,
		bin: () => "claude",
		logs: false,
	},
];

describe.each(binaries)("$name", ({ skip, bin, logs }) => {
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
			if (logs)
				expect(readHeadlessCalls(path.join(dir, "calls.jsonl"))).toEqual([]);
		},
		LIVE_CALL_TIMEOUT_MS,
	);
});

it.skipIf(LIVE_SKIP)(
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
