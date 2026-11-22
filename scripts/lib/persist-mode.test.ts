// @vitest-environment node

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInProcess } from "./run-in-process";

const require_ = createRequire(__filename);
const notify = require_(
	"./notify-report.js",
) as typeof import("./notify-report.js");
const { readProcStartOf } = require_(
	"./arbiter-proc.js",
) as typeof import("./arbiter-proc.js");
const CHECK_LIB = path.resolve(__dirname, "check.js");
const REAPER = path.resolve(__dirname, "..", "reap-finished-sessions.js");
const CHECKER_KEY = "persist-gate-fixture";
const REAPER_KEY = "reap-finished-sessions";

let sandbox = "";

beforeEach(() => {
	sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "persist-gate-"));
	for (const v of [
		"CLAUDE_CONFIG_DIR",
		"CLAUDE_PROJECT_DIR",
		"WFC_CLAUDE_CONFIG_A",
		"WFC_CLAUDE_CONFIG_B",
		"WFC_CLAUDE_CONFIG_C",
	])
		vi.stubEnv(v, sandbox);
});
afterEach(() => {
	fs.rmSync(sandbox, { recursive: true, force: true });
});

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
	fs.mkdirSync(path.join(sandbox, "projects", "-w"), { recursive: true });
	fs.writeFileSync(
		path.join(sandbox, "projects", "-w", "other-1.jsonl"),
		`${JSON.stringify({ type: "system", subtype: "turn_duration" })}\n`,
	);
	const bin = path.join(sandbox, "claude");
	fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	return bin;
}

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

describe("the reaper's --dry-run limb", () => {
	it("refuses to persist a dry run, printing it instead", () => {
		expect(asReaper(["--notify", "--dry-run"], ON)).toMatchObject({
			persisted: false,
			silent: false,
		});
	});

	it("is the caller's, not the shared gate's", () => {
		const { persisting } = require_("./persist-mode.js");
		vi.stubEnv("WFC_NOTIFY_PERSIST", "1");
		expect(persisting(["--notify", "--dry-run"])).toBe(true);
		expect(
			persisting(["--notify", "--dry-run"], { forbid: ["--dry-run"] }),
		).toBe(false);
	});
});

describe("the gate exists in exactly one file", () => {
	it("is named in neither caller's code, only in their headers", () => {
		for (const [f, spec] of [
			[CHECK_LIB, "./persist-mode.js"],
			[REAPER, "./lib/persist-mode.js"],
		]) {
			const src = fs.readFileSync(f, "utf8");
			const code = src
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.replace(/^[ \t]*\/\/.*$/gm, "");
			expect(code).not.toContain("WFC_NOTIFY_PERSIST");
			expect(code).toContain(`require("${spec}")`);
		}
	});
});
