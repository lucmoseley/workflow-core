// @vitest-environment node
/*
 * guard-lost-verdict.js hands back a suite run's verdict where the call's
 * output lost its pass/fail line (#1575). These are its boundary cases: the
 * lines hooks/hooks.json registers on PostToolUse and PostToolUseFailure,
 * run by bash as the harness runs them, on a harness-shaped payload — the
 * wiring, each exit, the fail-open record, and the run record, the logs and
 * the clock crossed for real. Which run's verdict is handed over, and when,
 * is lib/lost-verdict.test.ts's (#2799).
 *
 * Break a line and a cut verdict goes unreported, so the session re-runs the
 * suite to read it.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFailOpenLog } from "./guard-log-fixture";
import {
	guardDirs,
	guardOutput,
	readHookLines,
} from "./lib/pretool-guard-testkit";
import { dirPath, recordRun } from "./lib/test-log.js";

const SCRIPT = "scripts/guard-lost-verdict.js";
const LINES = readHookLines("hooks/hooks.json", SCRIPT);
const CHECKOUT = path.resolve(__dirname, "..");
const SID = "sess-1575";
const CALL_MS = 60_000;
const OWN_LOG =
	" FAIL  scripts/b.test.ts\n      Tests  1 failed | 3 passed (4)\n";

let dir: string;
let config: string;

beforeEach(() => {
	({ dir, config } = guardDirs("lost-verdict-entry-"));
	dir = fs.realpathSync(dir);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A finished run in this session's record, inside the call. */
function record(text: string) {
	const log = path.join(dirPath(dir), "own.log");
	fs.mkdirSync(path.dirname(log), { recursive: true });
	fs.writeFileSync(log, text);
	const began = Date.now() - CALL_MS;
	recordRun(dir, SID, {
		log,
		pid: 4242,
		startedAt: new Date(began + 5000).toISOString(),
		endedAt: new Date(began + 10_000).toISOString(),
	});
	return log;
}

const fire = (
	line: string,
	payload: Record<string, unknown>,
	{ stdin, env = {} }: { stdin?: string; env?: NodeJS.ProcessEnv } = {},
) =>
	guardOutput(
		"/bin/bash",
		{
			tool_name: "Bash",
			tool_input: { command: "npm run test | grep x" },
			duration_ms: CALL_MS,
			session_id: SID,
			cwd: dir,
			...payload,
		},
		{
			project: dir,
			config,
			cwd: dir,
			args: ["-c", line],
			stdin,
			env: { CLAUDE_PLUGIN_ROOT: CHECKOUT, ...env },
		},
	);

const posted = (payload: Record<string, unknown> = {}, run = {}) =>
	fire(
		LINES[0] ?? "",
		{
			hook_event_name: "PostToolUse",
			tool_response: { stdout: " ✓ scripts/a.test.ts\n", stderr: "" },
			...payload,
		},
		run,
	);

const readFaults = () => readFailOpenLog(config, dir);

describe("the registered hook lines", () => {
	it("are one on PostToolUse and one on PostToolUseFailure, narrowed by `if: Bash(*test*)`, in the plugin and the self-plugin alike", () => {
		for (const file of ["hooks/hooks.json", "self-plugin/hooks/hooks.json"]) {
			const hooks = JSON.parse(
				fs.readFileSync(path.join(CHECKOUT, file), "utf8"),
			).hooks as Record<string, { hooks: Record<string, unknown>[] }[]>;
			for (const event of ["PostToolUse", "PostToolUseFailure"]) {
				const entries = (hooks[event] ?? [])
					.flatMap((group) => group.hooks)
					.filter((hook) => String(hook.command).includes(SCRIPT));
				expect(entries).toHaveLength(1);
				expect(entries[0]).toMatchObject({ if: "Bash(*test*)" });
				expect(entries[0]).not.toHaveProperty("args");
			}
		}
		expect(LINES).toHaveLength(2);
	});
});

describe("each exit", () => {
	it("hands back the recorded run's verdict as PostToolUse additionalContext on exit 0", () => {
		const log = record(OWN_LOG);
		const out = posted();
		expect(out.hookEventName).toBe("PostToolUse");
		expect(out.additionalContext).toContain("Tests  1 failed | 3 passed (4)");
		expect(out.additionalContext).toContain(
			`TEST LOG: ${path.relative(dir, log)}`,
		);
		expect(readFaults()).toBe("");
	});

	it("answers a failed call on PostToolUseFailure, reading its output from `error`", () => {
		record(OWN_LOG);
		const out = fire(LINES[1] ?? "", {
			hook_event_name: "PostToolUseFailure",
			error: "Exit code 1",
			is_interrupt: false,
		});
		expect(out.hookEventName).toBe("PostToolUseFailure");
		expect(out.additionalContext).toContain("Tests  1 failed | 3 passed (4)");
	});

	it("is silent where the verdict showed", () => {
		record(OWN_LOG);
		expect(
			posted({ tool_response: { stdout: "      Tests  4 passed (4)\n" } }),
		).toBeNull();
		expect(readFaults()).toBe("");
	});
});

describe("what it fails open on", () => {
	it("is silent on a run whose log is gone, and records why", () => {
		fs.rmSync(record(OWN_LOG));
		expect(posted()).toBeNull();
		expect(readFaults()).toMatch(
			/guard-lost-verdict\.js\ta suite run's lost verdict went unreported\t.*unreadable/,
		);
	});

	it("is silent on a payload carrying no command, and records that it did", () => {
		expect(
			posted(
				{},
				{ stdin: JSON.stringify({ session_id: "s1", tool_name: "Bash" }) },
			),
		).toBeNull();
		expect(readFaults()).toMatch(
			/guard-lost-verdict\.js\t.*no command in payload/,
		);
	});

	it("is silent on a payload that is not JSON, and records that it did", () => {
		expect(posted({}, { stdin: "not json" })).toBeNull();
		expect(readFaults()).toMatch(
			/guard-lost-verdict\.js\t.*payload did not parse as JSON/,
		);
	});

	it("is silent, exit 0, where node is not on PATH", () => {
		record(OWN_LOG);
		expect(posted({}, { env: { PATH: "/nonexistent" } })).toBeNull();
	});
});
