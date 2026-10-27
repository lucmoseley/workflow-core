// @vitest-environment node
/*
 * lib/lost-verdict.js, guard-lost-verdict.js's core (#1575, ported at
 * #2799), in process: a suite run whose output lost its pass/fail line is
 * handed that run's verdict and TEST LOG path.
 *
 * The run record and the logs are real files in the case's temp directory,
 * read through lib/lost-verdict-host.js's production ports; only the clock
 * is injected.
 *
 * Loosen the "which log" cases and a session is handed a neighbour's verdict
 * as its own; loosen the silent ones and a shown verdict draws a second copy.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { kitContextFake } from "./kit-context-fake";
import { dirPath, recordRun } from "./test-log.js";

const { decide } = require("./lost-verdict.js") as {
	decide: (command: string, ctx: object) => { context: string } | null;
};
const { buildHostPorts } = require("./lost-verdict-host.js") as {
	buildHostPorts: (env: object) => Record<string, unknown>;
};

const SID = "sess-1575";
/* The call's length as the payload reports it; a run recorded inside it
 * starts `offset` ms after the call began. */
const CALL_MS = 60_000;
const NOW = Date.parse("2026-10-25T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

let project: string;
let logged: string[];

const OWN_LOG = [
	"READ-GRAPH SELECTION — 2 test file(s)",
	"MEETS THE PUSH GATE — every reader of the diff was selected.",
	"  The certificate is keyed to HEAD as this run ENDS.",
	" ✓ scripts/a.test.ts (3 tests) 20ms",
	" FAIL  scripts/b.test.ts > fails on purpose",
	" Test Files  1 failed | 1 passed (2)",
	"      Tests  1 failed | 3 passed (4)",
	"   Duration  1.20s",
	"",
].join("\n");

function writeLog(name: string, text: string) {
	const file = path.join(dirPath(project), name);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
	return file;
}

/** A finished run in `session`'s record, `offset` ms after the call began. */
function record(session: string, log: string, pid = 4242, offset = 5000) {
	const began = NOW - CALL_MS;
	recordRun(project, session, {
		log,
		pid,
		startedAt: iso(began + offset),
		endedAt: iso(began + offset + 5000),
	});
}

const run = (
	command: string,
	response: Record<string, unknown> | undefined = {},
	payload: Record<string, unknown> = {},
) => {
	const full: Record<string, unknown> = {
		hook_event_name: "PostToolUse",
		tool_name: "Bash",
		tool_input: { command },
		tool_response: response && {
			stdout: " ✓ scripts/a.test.ts (3 tests) 20ms\n",
			stderr: "",
			interrupted: false,
			...response,
		},
		duration_ms: CALL_MS,
		session_id: SID,
		...payload,
	};
	const log = (what: string, detail?: string) =>
		logged.push(detail ? `${what}: ${detail}` : what);
	return decide(
		command,
		kitContextFake({
			...buildHostPorts({ root: project, payload: full, log }),
			now: () => NOW,
			cwd: project,
			fallbackCwd: project,
			isDir: () => true,
			log,
		}),
	);
};

const context = (r: ReturnType<typeof run>) => {
	expect(r).not.toBeNull();
	return r?.context ?? "";
};

beforeEach(() => {
	project = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "lostverdict-")),
	);
	logged = [];
});

afterEach(() => {
	fs.rmSync(project, { recursive: true, force: true });
});

describe("a suite run whose verdict was cut from its output", () => {
	it("hands back the verdict lines and the log path from this session's run record", () => {
		const log = writeLog("own.log", OWN_LOG);
		record(SID, log);
		const said = context(run("npm run test 2>&1 | grep -E 'a.test'"));
		expect(said).toContain("Test Files  1 failed | 1 passed (2)");
		expect(said).toContain("Tests  1 failed | 3 passed (4)");
		expect(said).toContain("FAIL  scripts/b.test.ts > fails on purpose");
		expect(said).toContain("MEETS THE PUSH GATE");
		// Only a gate line's first line, and none of vitest's other summary lines.
		expect(said).not.toContain("The certificate is keyed");
		expect(said).not.toContain("Duration");
		expect(said).toContain(`TEST LOG: ${path.relative(project, log)}`);
		expect(said).toContain("Do not re-run the suite");
		expect(logged).toEqual([]);
	});

	it("hands back the landing banner as the gate line (#2961)", () => {
		const log = writeLog(
			"own.log",
			OWN_LOG.replace(
				/^MEETS THE PUSH GATE.*$/m,
				'NO PUSH GATE — module "landing" is on (#2961).',
			),
		);
		record(SID, log);
		const said = context(run("npm run test 2>&1 | grep -E 'a.test'"));
		expect(said).toContain('NO PUSH GATE — module "landing" is on');
	});

	it("reads the log the output's own TEST LOG line names where that line survived", () => {
		const log = writeLog("own.log", OWN_LOG);
		const said = context(
			run("npm run test:changed | grep -E 'TEST LOG|✓'", {
				stdout: ` ✓ scripts/a.test.ts\nTEST LOG: ${path.relative(project, log)}\n`,
			}),
		);
		expect(said).toContain("Test Files  1 failed | 1 passed (2)");
	});

	it.each([
		"node scripts/run-vitest.js scripts/a.test.ts | head -5",
		"npm test | tail -1",
		"timeout 600 npm run test | tail -1",
	])("reads the launch %j", (command) => {
		record(SID, writeLog("own.log", OWN_LOG));
		expect(context(run(command))).toContain("Tests  1 failed | 3 passed (4)");
	});

	it("reads a failed call's output from `error`", () => {
		record(SID, writeLog("own.log", OWN_LOG));
		const said = context(
			run("npm run test 2>&1 | grep NOMATCH", undefined, {
				hook_event_name: "PostToolUseFailure",
				error: "Exit code 1",
				is_interrupt: false,
			}),
		);
		expect(said).toContain("Tests  1 failed | 3 passed (4)");
	});

	it("hands back a filtered run whose one file failed to collect, which also counts 0 tests (#1661)", () => {
		record(
			SID,
			writeLog(
				"broken.log",
				[
					" FAIL  scripts/a.test.ts [ scripts/a.test.ts ]",
					" Test Files  1 failed (1)",
					"      Tests  no tests",
					"FILTERED RUN — ran 0 of 0 tests in 1 of 480 files; paths: scripts/a.test.ts",
					"",
				].join("\n"),
			),
		);
		expect(
			context(run("npm run test -- scripts/a.test.ts | grep x")),
		).toContain("Test Files  1 failed (1)");
	});

	it("caps the FAIL lines at ten, counting the rest", () => {
		const fails = Array.from(
			{ length: 12 },
			(_, i) => ` FAIL  scripts/f${i}.test.ts`,
		);
		record(
			SID,
			writeLog(
				"many.log",
				[...fails, " Test Files  12 failed (12)", ""].join("\n"),
			),
		);
		const said = context(run("npm run test | grep x"));
		expect(said).toContain("FAIL  scripts/f9.test.ts");
		expect(said).not.toContain("FAIL  scripts/f10.test.ts");
		expect(said).toContain("… and 2 more FAIL line(s) in the log");
	});

	it("says so where the log holds no pass/fail line", () => {
		record(SID, writeLog("cut.log", " ✓ scripts/a.test.ts\n"));
		expect(context(run("npm run test | grep x"))).toContain(
			"the log holds no pass/fail line",
		);
	});

	it("never hands over a neighbour's log", () => {
		const own = writeLog("own.log", OWN_LOG);
		record(SID, own);
		record(
			"sess-neighbour",
			writeLog("theirs.log", " Tests  99 passed (99)\n"),
			9999,
			8000,
		);
		const said = context(run("npm run test | grep x"));
		expect(said).toContain(path.relative(project, own));
		expect(said).not.toContain("99 passed");
	});
});

describe("where it says nothing", () => {
	it("is silent where the verdict showed", () => {
		record(SID, writeLog("own.log", OWN_LOG));
		expect(
			run("npm run test | tail -5", {
				stdout: " Test Files  2 passed (2)\n      Tests  4 passed (4)\n",
			}),
		).toBeNull();
		expect(logged).toEqual([]);
	});

	it.each([
		[
			"the run's log is missing",
			() => record(SID, path.join(dirPath(project), "reaped.log")),
			{},
			"unreadable",
		],
		[
			"no run of this session falls inside the call",
			() => record(SID, writeLog("old.log", OWN_LOG), 4242, -120_000),
			{},
			"no run in this session's record falls inside the call",
		],
		[
			"this session's only run ended after the call did",
			() => record(SID, writeLog("late.log", OWN_LOG), 4242, CALL_MS - 1000),
			{},
			"no run in this session's record falls inside the call",
		],
		[
			"two launches of this session ran inside the call",
			() => {
				record(SID, writeLog("a.log", OWN_LOG), 1);
				record(SID, writeLog("b.log", OWN_LOG), 2, 8000);
			},
			{},
			"2 launches of this session ran inside the call",
		],
		[
			"the payload carries no duration",
			() => record(SID, writeLog("own.log", OWN_LOG)),
			{ duration_ms: undefined },
			"no session id or duration_ms in the payload",
		],
		[
			"the selection was empty (#1661)",
			() =>
				record(
					SID,
					writeLog(
						"empty.log",
						"FILTERED RUN — ran 0 of 0 tests in 0 of 480 files; paths: wfc-empty-selection\n",
					),
				),
			{},
			"an empty selection",
		],
	])("is silent, and logs why, where %s", (_, seed, payload, why) => {
		seed();
		expect(run("npm run test | grep x", {}, payload)).toBeNull();
		expect(logged).toHaveLength(1);
		expect(logged[0]).toMatch(/^a suite run's lost verdict went unreported: /);
		expect(logged[0]).toContain(why);
	});

	it("is silent, and logs why, on two launches in one command", () => {
		record(SID, writeLog("a.log", OWN_LOG), 1);
		expect(
			run("npm run test | grep x; npm run test:changed | grep y"),
		).toBeNull();
		expect(logged).toEqual([
			"2 suite launches in one call — which lost its verdict is uncertain",
		]);
	});

	it.each([
		["a backgrounded run", { stdout: "", backgroundTaskId: "b1" }, {}],
		["an interrupted run", { interrupted: true }, {}],
		["a timed-out run", { timedOutAfterMs: 1000 }, {}],
		["an interrupt", {}, { is_interrupt: true }],
	])(
		"is silent on %s, whose output was never whole",
		(_, response, payload) => {
			record(SID, writeLog("own.log", OWN_LOG));
			expect(run("npm run test", response, payload)).toBeNull();
			expect(logged).toEqual([]);
		},
	);

	it("is silent on a call that launched no suite", () => {
		record(SID, writeLog("own.log", OWN_LOG));
		expect(run("npm run lint | grep x")).toBeNull();
		expect(run("npx vitest run scripts/a.test.ts | grep x")).toBeNull();
		expect(run("npm run test:watch | grep x")).toBeNull();
		expect(logged).toEqual([]);
	});
});
