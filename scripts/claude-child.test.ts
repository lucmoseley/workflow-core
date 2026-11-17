// @vitest-environment node
/*
 * claude-child.js, driven through its command line against a stub `claude`
 * whose `-p` is the headless-run fake, which reads its argv against the
 * harness's recorded options and logs it, its environment and its stdin
 * (#2040).
 *
 * spawn-kept: a real fd (§X3) — the script hands the child real fds —
 * its own stdout and stderr, and the prompt file as stdin.
 *
 * Each of the Chrome mode's ends (#4847, #5385) is a launch of its own, most
 * a third of a second, those waiting out the 1.5 s SIGKILL or a closer's 5 s
 * wait for a live child longer: clean, a close turn, its caps, the limit's
 * interrupt, a hold, a trim, a trapped SIGTERM, a signal, a binary that is
 * gone; and each of chrome-close's outcomes and skips. The rows are
 * hand-built in the extension's wording (lib/chrome-rows-fake.ts): a
 * rewording there is caught only by a live run. That is this file's run time
 * over its CI record.
 */

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readProcStartOf } from "./lib/arbiter-proc.js";
import {
	ADMITTED_AUTH,
	buildAuthStatusBranch,
	REFUSED_AUTH,
	writeSeatHelper,
} from "./lib/auth-status-fake";
import {
	CLOSE_PROMPT,
	chromeStandingLines,
	TRIM_PROMPT,
} from "./lib/chrome-child.js";
import { buildTabContext, buildToolResultRow } from "./lib/chrome-rows-fake";
import { writeClaudeStub } from "./lib/claude-stub";
import { readJudgeCalls, writeJudgeFake } from "./lib/gate-judge-fake";
import { JUDGE_ARGS, JUDGE_TIMEOUT_EXIT } from "./lib/gate-judge-mode.js";
import {
	buildHeadlessBranch,
	buildResultRow,
	readHeadlessCalls,
	readStreamEvents,
	writeHeadlessFake,
} from "./lib/headless-run-fake";

const SCRIPT = path.resolve(__dirname, "claude-child.js");

let dir = "";
let seat = "";

const callsLog = () => path.join(dir, "calls.jsonl");

/** The stub `claude`, its `-p` run ending `exit`. */
const writeStub = (exit = 0) =>
	writeClaudeStub(path.join(dir, "claude"), [
		buildHeadlessBranch(
			writeHeadlessFake(path.join(dir, "claude-p"), {
				log: callsLog(),
				mode: "end",
				text: "child said hello\n",
				exit,
			}),
		),
	]);

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-child-"));
	seat = path.join(dir, ".claude");
	fs.mkdirSync(seat);
	writeStub();
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const runEnv = (extra: Record<string, string> = {}) => ({
	...process.env,
	CLAUDE_CONFIG_DIR: seat,
	CLAUDE_PROJECT_DIR: dir,
	WFC_CLAUDE_CONFIG_A: path.join(dir, ".claude"),
	WFC_CLAUDE_CONFIG_B: path.join(dir, ".claude2"),
	WFC_CLAUDE_CONFIG_C: path.join(dir, ".claude3"),
	WFC_CLAUDE_BIN: path.join(dir, "claude"),
	WFC_USER_MANAGER: "no",
	...extra,
});

const run = (
	args: string[],
	extra: Record<string, string> = {},
	input?: string,
) =>
	spawnSync(process.execPath, [SCRIPT, ...args], {
		encoding: "utf8",
		input,
		env: runEnv(extra),
	});

/** The clock every launcher and closer test runs at, through WFC_NOW. */
const Now = "2026-11-17T12:00:00.000Z";

/** A resume's tool result emptying the group. */
const CLOSED_ROW = buildToolResultRow(
	"Closed tab 8. Group is now empty (auto-removed).",
);

/** The one file named `name` under `root`. */
const findFile = (root: string, name: string): string => {
	const hit = (fs.readdirSync(root, { recursive: true }) as string[]).find(
		(f) => path.basename(f) === name,
	);
	if (!hit) throw new Error(`no ${name} under ${root}`);
	return path.join(root, hit);
};

const readSeen = () => {
	const [seen] = readHeadlessCalls(callsLog());
	if (!seen) throw new Error("the child was never launched");
	return seen;
};
const launched = () => readHeadlessCalls(callsLog()).length > 0;

describe("usage", () => {
	it("runs /usage on the named seat, approving no tool", () => {
		const r = run(["usage", "--config-dir", seat]);
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("child said hello\n");
		expect(readSeen().argv).toEqual([
			"-p",
			"/usage",
			"--permission-mode",
			"manual",
		]);
		expect(readSeen().env.CLAUDE_CONFIG_DIR).toBe(seat);
	});

	it("passes on the child's exit status", () => {
		writeStub(3);
		expect(run(["usage", "--config-dir", seat]).status).toBe(3);
	});

	it("refuses a binary that cannot answer for its auth, naming the cached reading", () => {
		const r = run(["usage", "--config-dir", seat], {
			WFC_CLAUDE_BIN: path.join(dir, "missing"),
		});
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("auth status` failed");
		expect(r.stderr).toContain("allowance.js --config-dir");
	});

	it("names the cached reading where the child cannot start", () => {
		/* Answers `auth status`, then is gone before the launch. */
		const vanishing = path.join(dir, "vanishing");
		fs.writeFileSync(
			vanishing,
			`#!/bin/bash\nif [ "$1" = "auth" ]; then rm -- "$0"; fi\n${buildAuthStatusBranch()}\n`,
			{ mode: 0o755 },
		);
		const r = run(["usage", "--config-dir", seat], {
			WFC_CLAUDE_BIN: vanishing,
		});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("the child did not finish");
		expect(r.stderr).toContain("allowance.js --config-dir");
	});
});

describe("chrome", () => {
	const SessionRe =
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
	const eventsLog = () => path.join(dir, "events.jsonl");
	const store = () => path.join(seat, "chrome-children");
	const records = () =>
		fs.existsSync(store())
			? fs.readdirSync(store()).filter((n) => n.endsWith(".json"))
			: [];
	const readStoredRecord = (id: string) =>
		JSON.parse(fs.readFileSync(path.join(store(), `${id}.json`), "utf8"));

	const prompt = () => {
		const f = path.join(dir, "prompt.md");
		fs.writeFileSync(f, "Read example.com and report.\n");
		return f;
	};

	/** The stub's `-p` run reading stream-json, answering each user message
	 * with the next of `turns`. */
	const writeTurns = (
		turns: Record<string, unknown>[][],
		over: Partial<Parameters<typeof writeHeadlessFake>[1]> = {},
	) =>
		writeClaudeStub(path.join(dir, "claude"), [
			buildHeadlessBranch(
				writeHeadlessFake(path.join(dir, "claude-p"), {
					log: callsLog(),
					mode: "stream",
					events: eventsLog(),
					turns,
					...over,
				}),
			),
		]);

	const chrome = (extra: Record<string, string> = {}, flags: string[] = []) =>
		run(
			[
				"chrome",
				"--config-dir",
				seat,
				"--pages",
				"1",
				"--prompt-file",
				prompt(),
				...flags,
			],
			extra,
		);

	/** The one JSON line stdout carries, on every end path (#5381). */
	const oneLine = (r: { stdout: string }) => {
		const lines = r.stdout.split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[1]).toBe("");
		return JSON.parse(lines[0] ?? "");
	};
	const sent = () =>
		readStreamEvents(eventsLog()).flatMap((e) =>
			"stdin" in e ? [e.stdin] : [],
		);
	const sentTexts = () =>
		sent()
			.filter((m) => m.type === "user")
			.map(
				(m) =>
					(m as { message: { content: { text: string }[] } }).message.content[0]
						?.text,
			);
	const signals = () =>
		readStreamEvents(eventsLog()).flatMap((e) =>
			"signal" in e ? [e.signal] : [],
		);
	const stdinClosed = () =>
		readStreamEvents(eventsLog()).some((e) => "stdinClosed" in e);

	const Open8 = buildToolResultRow(
		"Created new tab. Tab ID: 8",
		buildTabContext([8, "https://example.com/", "Example"]),
	);
	const Open89 = buildToolResultRow(
		"Created new tab. Tab ID: 9",
		buildTabContext(
			[8, "https://example.com/", "Example"],
			[9, "https://example.com/b", "B"],
		),
	);
	const Close8 = buildToolResultRow(
		"Closed tab 8. Group is now empty (auto-removed).",
	);
	/** One model turn's text row, its message id `id`. */
	const assistant = (id: string) => ({
		type: "assistant",
		message: { id, content: [{ type: "text", text: "closing" }] },
	});

	it("gives the child the Chrome tools only, file_upload barred, 10 turns a page plus 5, its own session id, the prompt as one stream message", () => {
		writeTurns([[buildResultRow()]]);
		const r = run([
			"chrome",
			"--config-dir",
			seat,
			"--pages",
			"2",
			"--prompt-file",
			prompt(),
		]);
		expect(r.status).toBe(0);
		const { argv, sessionId, env } = readSeen();
		expect(argv.slice(0, -2)).toEqual([
			"-p",
			"--chrome",
			"--tools",
			"",
			"--allowedTools",
			"mcp__claude-in-chrome__*",
			"--disallowedTools",
			"mcp__claude-in-chrome__file_upload",
			"--max-turns",
			"25",
			"--input-format",
			"stream-json",
			"--output-format",
			"stream-json",
			"--verbose",
			"--append-system-prompt",
			chromeStandingLines(false),
		]);
		expect(argv.at(-2)).toBe("--session-id");
		expect(sessionId).toMatch(SessionRe);
		expect(oneLine(r).sessionId).toBe(sessionId);
		expect(sentTexts()).toEqual(["Read example.com and report.\n"]);
		expect(env.CLAUDE_CONFIG_DIR).toBe(seat);
	});

	it("gives a --hand-over child the hand-over standing line", () => {
		writeTurns([[buildResultRow()]]);
		expect(chrome({}, ["--hand-over"]).status).toBe(0);
		expect(readSeen().argv).toContain(chromeStandingLines(true));
	});

	it("lets a child that closed its group exit cleanly, its record deleted", () => {
		writeTurns([
			[
				{ type: "system", subtype: "init" },
				Open8,
				Close8,
				buildResultRow({ result: "read it" }),
			],
		]);
		const r = chrome();
		expect(r.status).toBe(0);
		expect(r.stderr).toBe("");
		expect(oneLine(r)).toMatchObject({
			subtype: "success",
			result: "read it",
			tabsLeftOpen: [],
			heldTab: null,
			notes: [],
		});
		expect(sentTexts()).toHaveLength(1);
		expect(stdinClosed()).toBe(true);
		expect(signals()).toEqual([]);
		expect(records()).toEqual([]);
	});

	it.each([
		["a success", buildResultRow()],
		[
			"error_max_turns",
			buildResultRow({ subtype: "error_max_turns", is_error: true }),
		],
	])(
		"sends one close-only turn after %s with tabs open, then lets the emptied child exit",
		(_, first) => {
			writeTurns([
				[Open8, first],
				[Close8, buildResultRow()],
			]);
			const r = chrome();
			expect(sentTexts()).toEqual([
				"Read example.com and report.\n",
				CLOSE_PROMPT,
			]);
			const row = oneLine(r);
			expect(row.subtype).toBe(first.subtype);
			expect(row.tabsLeftOpen).toEqual([]);
			expect(stdinClosed()).toBe(true);
			expect(records()).toEqual([]);
		},
	);

	it("interrupts the close turn at a 6th assistant message, then stops the child by signal, the record kept", () => {
		writeTurns([
			[Open8, buildResultRow()],
			["m1", "m2", "m3", "m4", "m5", "m6"].map(assistant),
		]);
		const r = chrome();
		const row = oneLine(r);
		expect(sent().filter((m) => m.type === "control_request")).toHaveLength(1);
		expect(signals()).toEqual(["SIGTERM"]);
		expect(stdinClosed()).toBe(false);
		expect(row.tabsLeftOpen).toEqual([
			{ tabId: 8, title: "Example", url: "https://example.com/" },
		]);
		expect(row.notes[0]).toMatch(
			/^claude-child: the child left 1 tab\(s\) open in its Claude tab group: 8 \(https:\/\/example.com\/\)/,
		);
		expect(r.stderr).toContain(row.notes[0]);
		expect(records()).toEqual([`${row.sessionId}.json`]);
		expect(readStoredRecord(row.sessionId)).toMatchObject({
			sessionId: row.sessionId,
			seat,
			attempts: 0,
			tabs: row.tabsLeftOpen,
		});
		expect(r.status).toBe(0);
	});

	it("lets a close turn's 5th assistant message finish its call", () => {
		writeTurns([
			[Open8, buildResultRow()],
			[
				...["m1", "m2", "m3", "m4", "m5"].map(assistant),
				Close8,
				buildResultRow(),
			],
		]);
		const r = chrome();
		expect(sent().filter((m) => m.type === "control_request")).toEqual([]);
		expect(oneLine(r).tabsLeftOpen).toEqual([]);
		expect(records()).toEqual([]);
	});

	it("counts a model turn's rows, one per content block, as one assistant message", () => {
		const block = assistant("m1");
		writeTurns([
			[Open8, buildResultRow()],
			[block, block, block, block, block, block, Close8, buildResultRow()],
		]);
		const row = oneLine(chrome());
		expect(sent().filter((m) => m.type === "control_request")).toEqual([]);
		expect(row.tabsLeftOpen).toEqual([]);
		expect(records()).toEqual([]);
	});

	it("caps the close turn at its seconds too", () => {
		writeTurns([[Open8, buildResultRow()], [assistant("m1")]]);
		const r = chrome({ WFC_CHROME_CLOSE_CAP_MS: "300" });
		expect(sent().filter((m) => m.type === "control_request")).toHaveLength(1);
		expect(oneLine(r).tabsLeftOpen).toHaveLength(1);
		expect(signals()).toEqual(["SIGTERM"]);
	});

	it("interrupts a child still running at its limit through stdin, never a signal first, then closes its tabs", () => {
		writeTurns([[Open8], [Close8, buildResultRow()]]);
		const r = chrome({ WFC_CHROME_CHILD_LIMIT_MS: "300" });
		const [, interrupt] = sent();
		expect(interrupt).toMatchObject({
			type: "control_request",
			request: { subtype: "interrupt" },
		});
		expect(sentTexts()[1]).toBe(CLOSE_PROMPT);
		expect(signals()).toEqual([]);
		const row = oneLine(r);
		expect(row.subtype).toBe("error_during_execution");
		expect(row.tabsLeftOpen).toEqual([]);
		expect(row.notes).toEqual([
			"claude-child: the child was interrupted at its 300 ms limit.",
		]);
		expect(records()).toEqual([]);
	});

	it("stops by signal a child that gives no result row after its interrupt, the record kept", () => {
		writeTurns([[Open8]], { ignoreInterrupt: true });
		const r = chrome({
			WFC_CHROME_CHILD_LIMIT_MS: "300",
			WFC_CHROME_INTERRUPT_WAIT_MS: "300",
		});
		expect(r.status).toBe(1);
		const row = oneLine(r);
		expect(row).toMatchObject({
			type: "result",
			subtype: "launcher_time_limit",
			result: null,
		});
		expect(row.tabsLeftOpen).toHaveLength(1);
		expect(signals()).toEqual(["SIGTERM"]);
		expect(stdinClosed()).toBe(false);
		expect(records()).toEqual([`${row.sessionId}.json`]);
	});

	it("keeps the record of a child it stopped by signal with no tab seen open", () => {
		writeTurns([[]], { ignoreInterrupt: true });
		const r = chrome({
			WFC_CHROME_CHILD_LIMIT_MS: "300",
			WFC_CHROME_INTERRUPT_WAIT_MS: "300",
		});
		const row = oneLine(r);
		expect(row.tabsLeftOpen).toEqual([]);
		expect(signals()).toEqual(["SIGTERM"]);
		expect(records()).toEqual([`${row.sessionId}.json`]);
	});

	it("SIGKILLs a child that outlives SIGTERM by 1.5 s", () => {
		writeTurns([[Open8, buildResultRow()], [buildResultRow()]], {
			ignoreTerm: true,
		});
		const r = chrome();
		expect(signals()).toEqual(["SIGTERM"]);
		expect(oneLine(r).tabsLeftOpen).toHaveLength(1);
	});

	it("holds the one tab a --hand-over child leaves, naming it and the command that closes it", () => {
		writeTurns([[Open8, buildResultRow()]]);
		const r = chrome({ WFC_NOW: Now }, ["--hand-over"]);
		expect(r.status).toBe(0);
		const row = oneLine(r);
		const tab = { tabId: 8, title: "Example", url: "https://example.com/" };
		expect(row.heldTab).toEqual(tab);
		expect(row.tabsLeftOpen).toEqual([]);
		expect(sentTexts()).toHaveLength(1);
		expect(signals()).toEqual(["SIGTERM"]);
		expect(stdinClosed()).toBe(false);
		expect(row.notes).toHaveLength(1);
		expect(row.notes[0]).toContain(row.sessionId);
		expect(row.notes[0]).toContain('"Example" (https://example.com/)');
		expect(row.notes[0]).toContain(`chrome-close --session ${row.sessionId}`);
		expect(row.notes[0]).not.toMatch(/the child left \d+ tab\(s\) open/);
		const record = readStoredRecord(row.sessionId);
		expect(record.heldTab).toEqual(tab);
		expect(record.heldSince).toBe(Now);
	});

	it("trims a --hand-over child's group to one tab, then holds it", () => {
		writeTurns([
			[Open89, buildResultRow()],
			[
				buildToolResultRow(
					"Closed tab 8. 1 tab(s) remain.",
					buildTabContext([9, "https://example.com/b", "B"]),
				),
				buildResultRow(),
			],
		]);
		const row = oneLine(chrome({}, ["--hand-over"]));
		expect(sentTexts()[1]).toBe(TRIM_PROMPT);
		expect(row.heldTab).toMatchObject({ tabId: 9 });
		expect(row.tabsLeftOpen).toEqual([]);
	});

	it("holds every tab a --hand-over child could not trim, saying a hand-over leaves one", () => {
		writeTurns([[Open89, buildResultRow()], [buildResultRow()]]);
		const row = oneLine(chrome({}, ["--hand-over"]));
		expect(row.tabsLeftOpen).toEqual([]);
		expect(row.notes[0]).toContain("a hand-over leaves one tab");
		expect(readStoredRecord(row.sessionId).tabs).toHaveLength(2);
	});

	it("closes every tab without --hand-over, whatever the child left", () => {
		writeTurns([
			[Open8, buildResultRow()],
			[Close8, buildResultRow()],
		]);
		const row = oneLine(chrome());
		expect(sentTexts()[1]).toBe(CLOSE_PROMPT);
		expect(row.heldTab).toBeNull();
	});

	it("on SIGTERM stops the child, keeps the record, starts an outliving closer and still prints its line", async () => {
		writeTurns([[Open8]]);
		const trapLog = path.join(dir, "trap.log");
		const wrap = path.join(dir, "wrap.sh");
		fs.writeFileSync(wrap, `#!/bin/bash\necho "$*" >> ${trapLog}\n`, {
			mode: 0o755,
		});
		const launcher = spawn(
			process.execPath,
			[
				SCRIPT,
				"chrome",
				"--config-dir",
				seat,
				"--pages",
				"1",
				"--prompt-file",
				prompt(),
			],
			{
				env: runEnv({ WFC_USER_MANAGER: "yes", WFC_SYSTEMD_RUN: wrap }),
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let stdout = "";
		launcher.stdout.on("data", (d) => {
			stdout += d;
		});
		await vi.waitFor(
			() => {
				if (sentTexts().length === 0) throw new Error("not yet sent");
			},
			{ timeout: 5000, interval: 50 },
		);
		launcher.kill("SIGTERM");
		const [status] = await once(launcher, "exit");
		expect(status).toBe(1);
		const row = oneLine({ stdout });
		expect(row).toMatchObject({
			type: "result",
			subtype: "launcher_killed",
			result: null,
		});
		await vi.waitFor(() => {
			if (signals().length === 0) throw new Error("no signal yet");
		});
		expect(signals()).toEqual(["SIGTERM"]);
		expect(records()).toEqual([`${row.sessionId}.json`]);
		await vi.waitFor(() => {
			if (!fs.existsSync(trapLog)) throw new Error("no closer yet");
		});
		expect(fs.readFileSync(trapLog, "utf8")).toContain(
			`chrome-close --session ${row.sessionId} --trap`,
		);
	});

	it("sends a child stdout line that is no JSON row to stderr, printing its own row", () => {
		writeStub(1);
		const r = chrome();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("child said hello\n");
		expect(oneLine(r)).toMatchObject({ subtype: "launcher_no_result" });
	});

	it("names the signal that killed the child, keeping its record for the sweep", () => {
		writeClaudeStub(path.join(dir, "claude"), [
			buildHeadlessBranch(path.join(dir, "claude-p"), "kill -KILL $$;"),
		]);
		const r = chrome();
		expect(r.status).toBe(1);
		const row = oneLine(r);
		expect(row.notes).toEqual([
			"claude-child: the child was killed by SIGKILL.",
		]);
		/* A kill keeps the group, so the sweep may still find a tab (#5352). */
		expect(records()).toEqual([`${row.sessionId}.json`]);
	});

	it("says so where the child cannot start", () => {
		/* Answers `auth status`, then is gone before the launch. */
		const vanishing = path.join(dir, "vanishing");
		fs.writeFileSync(
			vanishing,
			`#!/bin/bash\nif [ "$1" = "auth" ]; then rm -- "$0"; fi\n${buildAuthStatusBranch()}\n`,
			{ mode: 0o755 },
		);
		const r = chrome({ WFC_CLAUDE_BIN: vanishing });
		expect(r.status).toBe(1);
		const row = oneLine(r);
		expect(row.subtype).toBe("launcher_no_result");
		expect(row.notes[0]).toMatch(/^claude-child: the child did not finish/);
		expect(r.stderr).toContain(row.notes[0]);
		expect(records()).toEqual([]);
	});

	it.each([
		["seven pages", ["--pages", "7"], "at most 6"],
		["no pages", ["--pages", "0"], "from 1 to 6"],
		["a page count that is not a number", ["--pages", "two"], "from 1 to 6"],
	])("refuses %s, launching nothing", (_, pages, says) => {
		const r = run([
			"chrome",
			"--config-dir",
			seat,
			...pages,
			"--prompt-file",
			prompt(),
		]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(says);
		expect(launched()).toBe(false);
	});

	it("refuses a missing prompt file, launching nothing", () => {
		const r = run([
			"chrome",
			"--config-dir",
			seat,
			"--pages",
			"1",
			"--prompt-file",
			path.join(dir, "nope.md"),
		]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("could not read the prompt file");
		expect(launched()).toBe(false);
		expect(records()).toEqual([]);
	});
});

describe("chrome-close", () => {
	const Id = "5e551011-0000-4000-8000-0000000000aa";
	const eventsLog = () => path.join(dir, "events.jsonl");
	const store = () => path.join(seat, "chrome-children");
	const recordAt = () => path.join(store(), `${Id}.json`);
	const otherSeat = () => path.join(dir, ".claude2");
	const Hour = 60 * 60 * 1000;

	const writeRecordFile = (over: Record<string, unknown> = {}) => {
		fs.mkdirSync(store(), { recursive: true });
		fs.writeFileSync(
			recordAt(),
			JSON.stringify({
				sessionId: Id,
				seat: otherSeat(),
				launcherPid: 2 ** 22 + 1,
				launcherStart: "1",
				childPid: null,
				childStart: null,
				startedAt: Now,
				attempts: 0,
				...over,
			}),
		);
	};
	const resumeWith = (rows: Record<string, unknown>[]) =>
		writeClaudeStub(path.join(dir, "claude"), [
			buildHeadlessBranch(
				writeHeadlessFake(path.join(dir, "claude-p"), {
					log: callsLog(),
					mode: "stream",
					events: eventsLog(),
					turns: [rows],
				}),
			),
		]);
	const close = (args: string[]) =>
		run(["chrome-close", ...args], { TMPDIR: dir, WFC_NOW: Now });
	const ago = (ms: number) => new Date(Date.parse(Now) - ms).toISOString();
	const line = (r: { stdout: string }) => {
		expect(r.stdout.trimEnd().split("\n")).toHaveLength(1);
		return JSON.parse(r.stdout);
	};
	const closedLog = () => {
		const f = path.join(store(), "closed.jsonl");
		return fs.existsSync(f)
			? fs
					.readFileSync(f, "utf8")
					.trimEnd()
					.split("\n")
					.map((l) => JSON.parse(l))
			: [];
	};
	const storedRecord = () => JSON.parse(fs.readFileSync(recordAt(), "utf8"));
	const stdinClosed = () =>
		readStreamEvents(eventsLog()).some((e) => "stdinClosed" in e);

	beforeEach(() => {
		fs.mkdirSync(otherSeat());
	});

	it("resumes the session on the record's seat, from an empty directory, with the two tab tools alone", () => {
		writeRecordFile();
		resumeWith([CLOSED_ROW, buildResultRow()]);
		const r = close(["--session", Id]);
		expect(r.status).toBe(0);
		expect(line(r)).toMatchObject({ sessionId: Id, outcome: "closed" });
		const { argv, sessionId, env, cwd } = readSeen();
		expect(sessionId).toBe(Id);
		expect(argv).toEqual(
			expect.arrayContaining(["--resume", Id, "--chrome", "--input-format"]),
		);
		expect(argv[argv.indexOf("--allowedTools") + 1]).toBe(
			"mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__tabs_close_mcp",
		);
		expect(env.CLAUDE_CONFIG_DIR).toBe(otherSeat());
		expect(path.basename(cwd)).toMatch(/^wfc-chrome-close-/);
		expect(fs.readdirSync(cwd)).toEqual([]);
		expect(fs.existsSync(recordAt())).toBe(false);
		expect(closedLog()).toEqual([
			expect.objectContaining({ sessionId: Id, by: "done" }),
		]);
		expect(stdinClosed()).toBe(true);
	});

	it("keeps a held record's heldSince on its closed-log line, its hold ignored on --session", () => {
		const heldSince = Now;
		writeRecordFile({ heldSince });
		resumeWith([CLOSED_ROW, buildResultRow()]);
		expect(close(["--session", Id]).status).toBe(0);
		expect(closedLog()[0]).toMatchObject({ heldSince, by: "done" });
	});

	it("deletes a record whose group is gone", () => {
		writeRecordFile();
		resumeWith([
			buildToolResultRow("This session's tab group no longer exists."),
			buildResultRow(),
		]);
		expect(line(close(["--session", Id])).outcome).toBe("gone");
		expect(fs.existsSync(recordAt())).toBe(false);
		expect(closedLog()).toEqual([]);
	});

	it("spends no attempt where the bridge is not connected, stopping the resume by signal", () => {
		writeRecordFile();
		resumeWith([
			buildToolResultRow("Browser extension is not connected."),
			buildResultRow(),
		]);
		const r = close(["--session", Id]);
		expect(r.status).toBe(1);
		expect(line(r).outcome).toBe("not-connected");
		expect(storedRecord()).toMatchObject({
			attempts: 0,
			lastReason: "not-connected",
		});
		expect(stdinClosed()).toBe(false);
	});

	it("counts an attempt for any other failure", () => {
		writeRecordFile();
		resumeWith([buildResultRow({ result: "out of allowance" })]);
		expect(line(close(["--session", Id])).outcome).toBe("failed");
		expect(storedRecord()).toMatchObject({
			attempts: 1,
			lastReason: "out of allowance",
		});
	});

	it("gives a record up on its third failed attempt, reporting its tab for a session to pass on", () => {
		writeRecordFile({
			attempts: 2,
			tabs: [{ tabId: 8, title: "Example", url: "https://example.com/" }],
		});
		resumeWith([buildResultRow({ result: "still open" })]);
		expect(line(close(["--session", Id])).outcome).toBe("given-up");
		expect(fs.existsSync(recordAt())).toBe(false);
		const gone = JSON.parse(
			fs.readFileSync(path.join(store(), "given-up", `${Id}.json`), "utf8"),
		);
		expect(gone).toMatchObject({ attempts: 3, reason: "still open" });
		expect(Date.parse(gone.givenUpAt)).not.toBeNaN();
		const report = findFile(seat, `chrome-give-up-${Id}.report.json`);
		const { text } = JSON.parse(fs.readFileSync(report, "utf8"));
		for (const part of ['"Example" (https://example.com/)', otherSeat(), Id])
			expect(text).toContain(part);
	});

	it("gives up without resuming a record past its 7 days", () => {
		writeRecordFile({
			startedAt: ago(8 * 24 * Hour),
		});
		resumeWith([CLOSED_ROW, buildResultRow()]);
		expect(line(close(["--session", Id])).outcome).toBe("given-up");
		expect(launched()).toBe(false);
	});

	it("refuses a record whose launcher still runs", () => {
		writeRecordFile({
			launcherPid: process.pid,
			launcherStart: readProcStartOf(process.pid),
		});
		const r = close(["--session", Id]);
		expect(r.status).toBe(2);
		expect(line(r).outcome).toBe("refused");
		expect(launched()).toBe(false);
	});

	it("SIGKILLs a child still running after 5 s before it resumes", () => {
		const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
		child.unref();
		writeRecordFile({
			childPid: child.pid,
			childStart: readProcStartOf(child.pid ?? 0),
		});
		resumeWith([CLOSED_ROW, buildResultRow()]);
		expect(close(["--session", Id]).status).toBe(0);
		expect(readProcStartOf(child.pid ?? 0)).toBeNull();
	}, 15_000);

	describe("--sweep", () => {
		it("closes a record whose launcher is dead, by sweep, stamping the sweep", () => {
			writeRecordFile();
			resumeWith([CLOSED_ROW, buildResultRow()]);
			const r = close(["--sweep"]);
			expect(r.status).toBe(0);
			expect(line(r).swept).toEqual([
				expect.objectContaining({ sessionId: Id, outcome: "closed" }),
			]);
			expect(closedLog()[0]).toMatchObject({ by: "sweep" });
			expect(
				Date.parse(
					fs.readFileSync(path.join(store(), "last-sweep"), "utf8").trim(),
				),
			).not.toBeNaN();
		});

		it.each([
			["a held record within its 2 h", () => ({ heldSince: Now }), "held"],
			[
				"a record whose launcher still runs",
				() => ({
					launcherPid: process.pid,
					launcherStart: readProcStartOf(process.pid),
				}),
				"launcher",
			],
			[
				"a record not connected within the hour",
				() => ({
					lastReason: "not-connected",
					lastAttemptAt: Now,
				}),
				"not connected",
			],
		])("skips %s", (_, over, why) => {
			writeRecordFile(over());
			resumeWith([CLOSED_ROW, buildResultRow()]);
			const r = close(["--sweep"]);
			expect(line(r).skipped).toEqual([
				{ sessionId: Id, why: expect.stringContaining(why) },
			]);
			expect(launched()).toBe(false);
			expect(fs.existsSync(recordAt())).toBe(true);
		});

		it("sweeps a held record past its 2 h", () => {
			writeRecordFile({
				heldSince: ago(3 * Hour),
			});
			resumeWith([CLOSED_ROW, buildResultRow()]);
			expect(line(close(["--sweep"])).swept).toHaveLength(1);
			expect(fs.existsSync(recordAt())).toBe(false);
		});

		it("skips a record another closer holds", () => {
			writeRecordFile();
			resumeWith([CLOSED_ROW, buildResultRow()]);
			const holder = spawn(
				process.execPath,
				["-e", "setTimeout(() => {}, 20000)", "claude-child.js"],
				{ stdio: "ignore" },
			);
			try {
				fs.writeFileSync(
					path.join(store(), `${Id}.lock`),
					JSON.stringify({ pid: holder.pid }),
				);
				const r = close(["--sweep"]);
				expect(line(r).skipped).toEqual([
					{ sessionId: Id, why: expect.stringContaining("closer") },
				]);
				expect(launched()).toBe(false);
			} finally {
				holder.kill("SIGKILL");
			}
		});
	});

	it("lists held records with their seat, hold start, title and URL", () => {
		const heldSince = Now;
		writeRecordFile({
			heldSince,
			heldTab: { tabId: 8, title: "Example", url: "https://example.com/" },
		});
		const r = close(["--held"]);
		expect(r.status).toBe(0);
		expect(line(r).held).toEqual([
			expect.objectContaining({
				sessionId: Id,
				seat: otherSeat(),
				heldSince,
				title: "Example",
				url: "https://example.com/",
			}),
		]);
	});

	it.each([
		["no form", [], "one of --session, --sweep or --held"],
		["two forms", ["--sweep", "--held"], "one of --session"],
		["--trap alone", ["--sweep", "--trap"], "--trap goes with --session"],
		["a session that is no id", ["--session", "../x"], "not a session id"],
		[
			"a --config-dir",
			["--held", "--config-dir", "SEAT"],
			"takes no --config-dir",
		],
	])("refuses %s", (_, args, says) => {
		const r = close(args.map((a) => (a === "SEAT" ? seat : a)));
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(says);
	});
});

describe("judge", () => {
	const judgeLog = () => path.join(dir, "judge-calls.jsonl");
	const judge = (ms = "60000", extra: Record<string, string> = {}) =>
		run(
			["judge", "--config-dir", seat, "--timeout-ms", ms],
			{ WFC_CLAUDE_BIN: path.join(dir, "claude-judge"), ...extra },
			"What waits does this body make?\n",
		);
	const writeFake = (plan: Parameters<typeof writeJudgeFake>[2]) =>
		writeJudgeFake(path.join(dir, "claude-judge"), judgeLog(), plan);
	const readJudged = () => {
		const seen = readJudgeCalls(judgeLog()).at(-1);
		if (!seen) throw new Error("the judge child was never launched");
		return seen;
	};

	beforeEach(() => {
		writeFake({ stdout: "child said hello\n" });
	});

	it("gives the child the judge mode's flags, the prompt on stdin, in an empty directory", () => {
		const r = judge();
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("child said hello\n");
		expect(readJudged().argv).toEqual(JUDGE_ARGS);
		expect(readJudged().argv).toEqual(
			expect.arrayContaining([
				"haiku",
				"--tools",
				"--setting-sources",
				"--strict-mcp-config",
				"--disable-slash-commands",
				"--no-session-persistence",
				"--json-schema",
			]),
		);
		expect(readJudged().stdin).toBe("What waits does this body make?\n");
		expect(readJudged().cwdEntries).toEqual([]);
		expect(readJudged().cwd).not.toBe(process.cwd());
		expect(readJudged().configDir).toBe(seat);
	});

	it("empties its working directory of what a call before it left", () => {
		judge();
		fs.writeFileSync(path.join(readJudged().cwd, "left-behind.txt"), "x\n");
		expect(judge().status).toBe(0);
		expect(readJudgeCalls(judgeLog())).toHaveLength(2);
		expect(readJudged().cwdEntries).toEqual([]);
	});

	it("kills a child still running at the bound, exiting as a timeout does", () => {
		writeFake({ hang: true });
		const r = judge("1500");
		expect(r.status).toBe(JUDGE_TIMEOUT_EXIT);
		expect(r.stderr).toContain("the child was killed at its 1500 ms bound");
	});

	it.each([
		["no bound", ["judge", "--config-dir", "SEAT"]],
		[
			"a bound that is no number",
			["judge", "--config-dir", "SEAT", "--timeout-ms", "soon"],
		],
		[
			"a bound of nothing",
			["judge", "--config-dir", "SEAT", "--timeout-ms", "0"],
		],
	])("refuses %s, launching nothing", (_, args) => {
		const r = run(args.map((a) => (a === "SEAT" ? seat : a)));
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("--timeout-ms is a whole number");
		expect(launched()).toBe(false);
	});

	it.each(REFUSED_AUTH)("refuses under %s, launching nothing", (name, env) => {
		const r = judge("60000", env);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(`${name} is set`);
		expect(readJudgeCalls(judgeLog())).toEqual([]);
	});
});

describe("refuses, launching nothing", () => {
	it.each([
		[
			"a config dir that is not a seat",
			["usage", "--config-dir", "/tmp/elsewhere"],
			"not one of this machine's seats",
		],
		["no config dir", ["usage"], "--config-dir is required"],
		[
			"a flag no mode takes",
			["usage", "--config-dir", "SEAT", "--dangerously-skip-permissions"],
			"unknown flag",
		],
		[
			"a chrome flag on usage",
			["usage", "--config-dir", "SEAT", "--pages", "1"],
			"unknown flag",
		],
		[
			"a free prompt",
			["usage", "--config-dir", "SEAT", "do anything"],
			"do anything",
		],
		["no mode", ["--config-dir", "SEAT"], "a command is required"],
		["an unknown mode", ["print", "--config-dir", "SEAT"], "unknown command"],
	])("%s", (_, args, says) => {
		const r = run(args.map((a) => (a === "SEAT" ? seat : a)));
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(says);
		expect(launched()).toBe(false);
	});
});

describe("the launch's auth (#2236)", () => {
	it.each(REFUSED_AUTH)("refuses under %s, launching nothing", (name, env) => {
		const r = run(["usage", "--config-dir", seat], env);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(`${name} is set`);
		expect(r.stderr).toContain("#2236");
		expect(launched()).toBe(false);
	});

	it("refuses an apiKeyHelper in the seat's settings", () => {
		writeSeatHelper(seat);
		const r = run(["usage", "--config-dir", seat]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("apiKeyHelper");
		expect(launched()).toBe(false);
	});

	it.each(ADMITTED_AUTH)("launches on %s", (_name, env) => {
		expect(run(["usage", "--config-dir", seat], env).status).toBe(0);
		expect(launched()).toBe(true);
	});
});
