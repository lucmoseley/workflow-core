// @vitest-environment node
/*
 * The two call sites of the persist-mode gate agree (mantahostels#2252).
 *
 * `lib/check.js` and `reap-finished-sessions.js` each decide whether a run
 * persists its report or prints it, and nothing read the gate from both — so
 * an edit to one was silent in the other.
 *
 * Each case runs both real scripts over the same argv and env, because the
 * shared function agreeing with itself proves nothing about how either site
 * calls it.
 *
 * Both run as SessionStart hooks in `.claude/settings.json` under
 * `WFC_NOTIFY_PERSIST=1`; loosen a case and one can drift into writing no
 * report and printing nothing, its finding lost unseen (mantahostels#1854's class).
 *
 * Mutations run: mantahostels#2252. One survives and is an equivalent mutant —
 * `CheckContext`'s own `persisting` field is not what suppresses stdout,
 * say()'s `_capture` route is, so clearing the field changes no output.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./run-in-process";

const require_ = createRequire(__filename);
// biome-ignore lint/suspicious/noExplicitAny: a CJS module has no types to import
const notify: any = require_("./notify-report.js");
// biome-ignore lint/suspicious/noExplicitAny: a CJS module has no types to import
const { readProcStartOf }: any = require_("./arbiter-proc.js");
const CHECK_LIB = path.resolve(__dirname, "check.js");
const REAPER = path.resolve(__dirname, "..", "reap-finished-sessions.js");
const CHECKER_KEY = "persist-gate-fixture";
const REAPER_KEY = "reap-finished-sessions";

const savedEnv = { ...process.env };
let sandbox = "";

beforeEach(() => {
	sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "persist-gate-"));
	/* Mirrored onto this process as well as each child's, so the parent's
	 * readReport() and the run under it agree on where base() puts a report. */
	for (const v of [
		"CLAUDE_CONFIG_DIR",
		"CLAUDE_PROJECT_DIR",
		"WFC_CLAUDE_CONFIG_A",
		"WFC_CLAUDE_CONFIG_B",
		"WFC_CLAUDE_CONFIG_C",
	])
		process.env[v] = sandbox;
});
afterEach(() => {
	process.env = { ...savedEnv };
	fs.rmSync(sandbox, { recursive: true, force: true });
});

/** One finished session in the sandbox's registry (lib/registry-agents.js),
 * naming this test's own running process, and a `claude` that answers its
 * stop — so the run has something to say whichever route it says it by. */
function finishedSession() {
	fs.mkdirSync(path.join(sandbox, "sessions"), { recursive: true });
	fs.writeFileSync(
		path.join(sandbox, "sessions", "1.json"),
		JSON.stringify({
			pid: process.pid,
			procStart: readProcStartOf(process.pid),
			sessionId: "other-1",
			jobId: "other",
			name: "a finished session",
			kind: "bg",
		}),
	);
	fs.mkdirSync(path.join(sandbox, "jobs", "other"), { recursive: true });
	fs.writeFileSync(
		path.join(sandbox, "jobs", "other", "state.json"),
		JSON.stringify({ sessionId: "other-1", state: "done", cwd: "/w" }),
	);
	/* A transcript whose last turn ended, so the reaper does not hold the
	 * session for its turn (#2980). */
	fs.mkdirSync(path.join(sandbox, "projects", "-w"), { recursive: true });
	fs.writeFileSync(
		path.join(sandbox, "projects", "-w", "other-1.jsonl"),
		`${JSON.stringify({ type: "system", subtype: "turn_duration" })}\n`,
	);
	const bin = path.join(sandbox, "claude");
	fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	return bin;
}

/** The smallest real member of the `runCheck` family that has something to
 * report, so an unpersisted run is visible on stdout rather than merely quiet. */
function fixtureChecker() {
	const file = path.join(sandbox, "fixture-check.js");
	fs.writeFileSync(
		file,
		`const { runCheck } = require(${JSON.stringify(CHECK_LIB)});
runCheck({
  name: ${JSON.stringify(CHECKER_KEY)},
  usage: "node fixture-check.js [--notify] [--json]",
  run(ctx) { ctx.fail("T", "something to say"); return { noun: "thing" }; },
});
`,
	);
	return file;
}

/** Both halves of the gate's observable consequence, for one invocation. */
function persistedBy(
	script: string,
	key: string,
	argv: string[],
	env: Record<string, string>,
) {
	const r = runInProcess(script, argv, {
		cwd: sandbox,
		env: {
			...process.env,
			GITHUB_ACTIONS: "",
			WFC_CLAUDE_BIN: finishedSession(),
			CLAUDE_CODE_SESSION_ID: "the-session-this-hook-started-in",
			...env,
		},
	});
	// The exit code is a checker's severity, not its delivery route, so it says
	// nothing either way about the gate.
	return {
		persisted: notify.readReport(key) !== null,
		silent: r.stdout === "",
		said: `${r.stdout}${r.stderr}` !== "",
	};
}

const asCheck = (argv: string[], env: Record<string, string>) =>
	persistedBy(fixtureChecker(), CHECKER_KEY, argv, env);
const asReaper = (argv: string[], env: Record<string, string>) =>
	persistedBy(REAPER, REAPER_KEY, argv, env);

const ON = { WFC_NOTIFY_PERSIST: "1" };

describe("both call sites read the same gate", () => {
	/* `persisted` is the gate itself. `silent` is its other half — under the
	 * gate stdout must stay EMPTY, an async hook's stdout being discarded, so a
	 * run that persisted and also printed would be no more delivered than one
	 * that did neither. It is asserted only where both sites put the report on
	 * stdout, which is `--notify`: a hand run routes its report elsewhere, and
	 * the two sites need not agree on where. `said` covers that case — the run
	 * reported on some stream rather than swallowing its finding. */
	interface Seen {
		persisted: boolean;
		silent?: boolean;
		said: boolean;
	}

	const cases: [string, string[], Record<string, string>, Seen][] = [
		[
			"persists under --notify with the variable set to 1",
			["--notify"],
			ON,
			{ persisted: true, silent: true, said: false },
		],
		[
			"does not persist under --json, which outranks the variable",
			["--notify", "--json"],
			ON,
			{ persisted: false, silent: false, said: true },
		],
		[
			"does not persist with the variable absent",
			["--notify"],
			{ WFC_NOTIFY_PERSIST: "" },
			{ persisted: false, silent: false, said: true },
		],
		[
			"does not persist with the variable set to 0, never read for truthiness",
			["--notify"],
			{ WFC_NOTIFY_PERSIST: "0" },
			{ persisted: false, silent: false, said: true },
		],
		[
			"does not persist without --notify, never inferred",
			[],
			ON,
			{ persisted: false, said: true },
		],
	];

	for (const [name, argv, env, expected] of cases)
		it(`${name} — both sites`, () => {
			expect(asCheck(argv, env)).toMatchObject(expected);
			expect(asReaper(argv, env)).toMatchObject(expected);
		});
});

/* The reaper's one extra limb, held as a caller-supplied `forbid` rather than
 * as a second copy of the predicate: both its modes file under the one report
 * key, so a hand `--dry-run --notify` would overwrite the live report. */
describe("the reaper's --dry-run limb", () => {
	it("refuses to persist a dry run, printing it instead", () => {
		expect(asReaper(["--notify", "--dry-run"], ON)).toMatchObject({
			persisted: false,
			silent: false,
		});
	});

	it("is the caller's, not the shared gate's", () => {
		const { persisting } = require_("./persist-mode.js");
		process.env.WFC_NOTIFY_PERSIST = "1";
		expect(persisting(["--notify", "--dry-run"])).toBe(true);
		expect(
			persisting(["--notify", "--dry-run"], { forbid: ["--dry-run"] }),
		).toBe(false);
	});
});

/* Structural, because the behavioural cases above would still pass if one site
 * re-grew a copy that happened to agree today. */
describe("the gate exists in exactly one file", () => {
	it("is named in neither caller's code, only in their headers", () => {
		for (const [f, spec] of [
			[CHECK_LIB, "./persist-mode.js"],
			[REAPER, "./lib/persist-mode.js"],
		]) {
			const src = fs.readFileSync(f, "utf8");
			// Both headers still name the variable in prose; only a copy of the
			// gate itself is the defect.
			const code = src
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.replace(/^[ \t]*\/\/.*$/gm, "");
			expect(code).not.toContain("WFC_NOTIFY_PERSIST");
			expect(code).toContain(`require("${spec}")`);
		}
	});
});
