// @vitest-environment node
/*
 * guard-lost-verdict.test.ts — the PostToolUse and PostToolUseFailure hook
 * that hands back a suite run's cut verdict (#1575).
 *
 * Loosen the "which log" cases and a session is handed a neighbour's verdict
 * as its own; loosen the silent ones and a shown verdict draws a second copy.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failOpenLogPath } from "./guard-log-fixture";
import { dirPath, recordRun } from "./lib/test-log.js";

const GUARD = path.resolve(__dirname, "guard-lost-verdict.sh");
const SID = "sess-1575";
/* The call's length as the payload reports it; a run recorded inside it
 * starts `offset` ms after the call began. */
const CALL_MS = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

let dir: string;
let config: string;
let project: string;

const OWN_LOG = [
	"READ-GRAPH SELECTION — 2 test file(s)",
	"MEETS THE PUSH GATE — every reader of the diff was selected.",
	"  The marker is keyed to HEAD as this run ENDS.",
	" ✓ scripts/a.test.ts (3 tests) 20ms",
	" FAIL  scripts/b.test.ts > fails on purpose",
	" Test Files  1 failed | 1 passed (2)",
	"      Tests  1 failed | 3 passed (4)",
	"   Duration  1.20s",
	"",
].join("\n");

const NEIGHBOUR_LOG = [
	" Test Files  9 passed (9)",
	"      Tests  99 passed (99)",
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
	const began = Date.now() - CALL_MS;
	recordRun(project, session, {
		log,
		pid,
		startedAt: iso(began + offset),
		endedAt: iso(began + offset + 5000),
	});
}

const run = (
	command: string,
	response: Record<string, unknown> = {},
	payload: Record<string, unknown> = {},
) => {
	const r = spawnSync(GUARD, [], {
		encoding: "utf8",
		input: JSON.stringify({
			hook_event_name: "PostToolUse",
			tool_name: "Bash",
			tool_input: { command },
			tool_response: {
				stdout: " ✓ scripts/a.test.ts (3 tests) 20ms\n",
				stderr: "",
				interrupted: false,
				...response,
			},
			tool_use_id: "toolu_1575",
			duration_ms: CALL_MS,
			session_id: SID,
			cwd: project,
			...payload,
		}),
		env: {
			...process.env,
			CLAUDE_CONFIG_DIR: config,
			CLAUDE_PROJECT_DIR: project,
		},
	});
	if (r.status === null) throw new Error(`guard did not run: ${r.error}`);
	return r;
};

const context = (r: ReturnType<typeof run>, event = "PostToolUse") => {
	expect(r.status).toBe(0);
	const out = JSON.parse(r.stdout).hookSpecificOutput;
	expect(out.hookEventName).toBe(event);
	return out.additionalContext as string;
};

const silent = (r: ReturnType<typeof run>) => {
	expect(r.status).toBe(0);
	expect(r.stdout).toBe("");
};

const failOpenLog = () => {
	const at = failOpenLogPath(config, project);
	return fs.existsSync(at) ? fs.readFileSync(at, "utf8") : "";
};

beforeEach(() => {
	dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lostverdict-")));
	config = path.join(dir, "config");
	project = path.join(dir, "project");
	fs.mkdirSync(path.join(project, ".claude"), { recursive: true });
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
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
		expect(said).not.toContain("The marker is keyed");
		expect(said).not.toContain("Duration");
		expect(said).toContain(`TEST LOG: ${path.relative(project, log)}`);
		expect(said).toContain("Do not re-run the suite");
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

	it("reads the wrapper launch too", () => {
		record(SID, writeLog("own.log", OWN_LOG));
		expect(
			context(run("node scripts/run-vitest.js scripts/a.test.ts | head -5")),
		).toContain("Tests  1 failed | 3 passed (4)");
	});

	it("answers a call that exited non-zero on PostToolUseFailure, reading its output from `error`", () => {
		record(SID, writeLog("own.log", OWN_LOG));
		const said = context(
			run(
				"npm run test 2>&1 | grep NOMATCH",
				{},
				{
					hook_event_name: "PostToolUseFailure",
					tool_response: undefined,
					error: "Exit code 1",
					is_interrupt: false,
				},
			),
			"PostToolUseFailure",
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

	it("never hands over a neighbour's newer log", () => {
		const own = writeLog("own.log", OWN_LOG);
		record(SID, own);
		const theirs = writeLog("theirs.log", NEIGHBOUR_LOG);
		record("sess-neighbour", theirs, 9999, 8000);
		const later = Date.now() / 1000 + 60;
		fs.utimesSync(theirs, later, later);
		const said = context(run("npm run test | grep x"));
		expect(said).toContain(path.relative(project, own));
		expect(said).not.toContain("99 passed");
	});
});

describe("where it says nothing", () => {
	it("is silent where the verdict showed", () => {
		record(SID, writeLog("own.log", OWN_LOG));
		silent(
			run("npm run test | tail -5", {
				stdout: " Test Files  2 passed (2)\n      Tests  4 passed (4)\n",
			}),
		);
		expect(failOpenLog()).toBe("");
	});

	it("is silent, and logs why, where the run's log is missing", () => {
		record(SID, path.join(dirPath(project), "reaped.log"));
		silent(run("npm run test | grep x"));
		expect(failOpenLog()).toContain("unreadable");
	});

	it("is silent, and logs why, where no run of this session falls inside the call", () => {
		record(SID, writeLog("old.log", OWN_LOG), 4242, -120_000);
		silent(run("npm run test | grep x"));
		expect(failOpenLog()).toContain("no run in this session's record");
	});

	it("is silent, and logs why, on two launches in one command", () => {
		record(SID, writeLog("a.log", OWN_LOG), 1);
		silent(run("npm run test | grep x; npm run test:changed | grep y"));
		expect(failOpenLog()).toContain("2 suite launches in one call");
	});

	it("is silent, and logs why, where two launches of this session ran inside the call", () => {
		record(SID, writeLog("a.log", OWN_LOG), 1);
		record(SID, writeLog("b.log", OWN_LOG), 2, 8000);
		silent(run("npm run test | grep x"));
		expect(failOpenLog()).toContain("2 launches of this session");
	});

	it("is silent, and logs why, where the payload carries no duration", () => {
		record(SID, writeLog("own.log", OWN_LOG));
		silent(run("npm run test | grep x", {}, { duration_ms: undefined }));
		expect(failOpenLog()).toContain("no session id or duration_ms");
	});

	it("is silent on an empty selection, where vitest ran nothing and printed no verdict (#1661)", () => {
		record(
			SID,
			writeLog(
				"empty.log",
				[
					"READ-GRAPH SELECTION — the diff reaches no test file. Nothing to run.",
					"No test files found, exiting with code 0",
					"FILTERED RUN — ran 0 of 0 tests in 0 of 480 files; paths: wfc-empty-selection",
					"",
				].join("\n"),
			),
		);
		silent(run("npm run test:changed 2>&1 | tail -3"));
		expect(failOpenLog()).toContain("an empty selection");
	});

	it("is silent on a backgrounded run, which has not finished", () => {
		record(SID, writeLog("own.log", OWN_LOG));
		silent(run("npm run test", { stdout: "", backgroundTaskId: "b1" }));
	});

	it("is silent on a call that launched no suite", () => {
		record(SID, writeLog("own.log", OWN_LOG));
		silent(run("npm run lint | grep x"));
		silent(run("npx vitest run scripts/a.test.ts | grep x"));
	});
});
