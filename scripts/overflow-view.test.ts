// @vitest-environment node
/*
 * Pins the overflow view (#4583) on a fixture run store holding a session in
 * each state: the three sections, each key driven through scripted stdin, a
 * reply resuming the session under a fake `claude` with the key reaching it
 * through the apiKeyHelper alone and refused off the run's seat, a stop
 * through the real stop routing, and the list and an open thread following
 * the store without a restart.
 *
 * Loosen one and the founder misses a run waiting on him, answers a session
 * still working, or a reply leaks the key into the session's environment.
 */
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readProcStartOf } from "./lib/arbiter-proc.js";
import { buildAuthStatusNodeBranch } from "./lib/auth-status-fake";
import type { RunRecord } from "./lib/headless-runs.js";
import { writeHeadlessRun } from "./lib/headless-runs-testkit";
import { readHeadroom, sendReply, stopRun } from "./lib/overflow-actions.js";
import { openViewer } from "./lib/overflow-viewer.js";
import { runInProcessAsync } from "./lib/run-in-process.js";

const SCRIPT = path.join(__dirname, "overflow-view.js");
const KEY = "sk-fake-overflow-0123456789";
const KEY_VAR = "WFC_TEST_OVERFLOW_KEY";
const ESC = "\x1b";
const DOWN = `${ESC}[B`;
const LEFT = `${ESC}[D`;
const ENTER = "\r";

const AWAITING = {
	job: "0000000a",
	sid: "aaaaaaaa-0000-4000-8000-000000000000",
};
const WORKING = {
	job: "0000000b",
	sid: "bbbbbbbb-0000-4000-8000-000000000000",
};
const DONE = { job: "0000000c", sid: "cccccccc-0000-4000-8000-000000000000" };

const FAKE = `#!/usr/bin/env node
${buildAuthStatusNodeBranch()}
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");
const argv = process.argv.slice(2);
const settings = JSON.parse(argv[argv.indexOf("--settings") + 1]);
const helped = execSync(settings.apiKeyHelper, { encoding: "utf8" }).trim();
fs.writeFileSync(path.join(process.env.FAKE_OUT, "seen.json"),
	JSON.stringify({ argv, env: process.env, helped }));
`;

let tmp: string;
let refill: string;
let seat: string;
let fakeOut: string;
const savedEnv = { ...process.env };

const says = (text: string) =>
	JSON.stringify({
		type: "assistant",
		message: { content: [{ type: "text", text }] },
	});
const tool = (name: string, command: string) =>
	JSON.stringify({
		type: "assistant",
		message: { content: [{ type: "tool_use", name, input: { command } }] },
	});
const result = JSON.stringify({
	type: "result",
	subtype: "success",
	is_error: false,
});

function writeRun(
	{ job, sid }: { job: string; sid: string },
	lines: string[],
	{
		live,
		prompt,
		launchedAt = Date.now(),
	}: { live: boolean; prompt: string; launchedAt?: number },
) {
	const dir = path.join(refill, ".headless-runs", job);
	fs.mkdirSync(dir, { recursive: true });
	const log = path.join(dir, "out.jsonl");
	fs.writeFileSync(log, `${lines.join("\n")}\n`);
	writeHeadlessRun(refill, job, sid, {
		live,
		prompt,
		log,
		stderr: path.join(dir, "stderr.log"),
		seat,
		keyVar: KEY_VAR,
		launchedAt,
	});
}

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "overflow-view-"));
	refill = path.join(tmp, "refill");
	const home = path.join(tmp, "home");
	seat = path.join(home, ".claude2");
	fakeOut = path.join(tmp, "fake-out");
	const secrets = path.join(tmp, "secrets.env");
	for (const d of [path.join(home, ".claude"), seat, fakeOut])
		fs.mkdirSync(d, { recursive: true });
	fs.writeFileSync(
		path.join(home, ".claude", "refill-seats"),
		`${seat}\n~/.claude2 api key=${KEY_VAR} grant=200 cycle-day=20\n`,
	);
	fs.writeFileSync(secrets, `${KEY_VAR}=${KEY}\n`);
	fs.writeFileSync(path.join(tmp, "claude"), FAKE, { mode: 0o755 });
	Object.assign(process.env, {
		HOME: home,
		WFC_REFILL_DIR: refill,
		WFC_CLAUDE_BIN: path.join(tmp, "claude"),
		WFC_SECRETS_FILE: secrets,
		FAKE_OUT: fakeOut,
		/* In the parent too, so the child's lacking it proves the unset. */
		[KEY_VAR]: KEY,
	});
	writeRun(
		AWAITING,
		[
			says("Which colour?\n\nneeds input: pick a colour — waits on you: #7"),
			result,
		],
		{ live: false, prompt: "/implement 7" },
	);
	writeRun(WORKING, [tool("Bash", "npm test"), says("running the suite")], {
		live: true,
		prompt: "/implement 8",
	});
	writeRun(DONE, [says("Done.\n\nresult: shipped"), result], {
		live: false,
		prompt: "/implement 9",
	});
});

afterEach(() => {
	for (const k of Object.keys(process.env))
		if (!(k in savedEnv)) delete process.env[k];
	Object.assign(process.env, savedEnv);
	fs.rmSync(tmp, { recursive: true, force: true });
});

/* `close` stops the view's poll. */
function openTerminal(over: Partial<Parameters<typeof openViewer>[0]> = {}) {
	const stdin = Object.assign(new EventEmitter(), {
		setRawMode: vi.fn(),
		resume: vi.fn(),
		setEncoding: vi.fn(),
	});
	const writes: string[] = [];
	const stdout = Object.assign(new EventEmitter(), {
		columns: 120,
		rows: 30,
		write: (s: string) => {
			writes.push(s);
			return true;
		},
	});
	const proc = Object.assign(new EventEmitter(), { exit: vi.fn() });
	const reply = vi.fn<
		(run: RunRecord, text: string) => { jobId: string } | { why: string }
	>(() => ({ jobId: "0000000d" }));
	const stop = vi.fn<
		(run: RunRecord) => { ok: true; said: string } | { ok: false; why: string }
	>(() => ({ ok: true, said: "headless run 0000000b stopped" }));
	const close = openViewer({
		stdin: stdin as never,
		stdout: stdout as never,
		proc: proc as never,
		reply,
		stop,
		reportCrash: (err) => {
			throw err;
		},
		...over,
	});
	const frame = () =>
		(writes.findLast((w) => w.startsWith(`${ESC}[H`)) ?? "")
			// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes
			.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
			.split("\r\n")
			.map((l) => l.trimEnd());
	const type = (...chunks: string[]) => {
		for (const c of chunks) stdin.emit("data", c);
	};
	return { frame, type, reply, stop, proc, close };
}

const runOf = ({ job }: { job: string }) =>
	JSON.parse(
		fs.readFileSync(
			path.join(refill, ".headless-runs", job, "run.json"),
			"utf8",
		),
	) as RunRecord;

describe("the list", () => {
	it("renders the three sections, each row with its name, state and last message", () => {
		const t = openTerminal();
		const f = t.frame();
		t.close();
		const at = (s: string) => f.findIndex((l) => l.includes(s));
		expect(at("AWAITING INPUT · 1")).toBeLessThan(at("WORKING · 1"));
		expect(at("WORKING · 1")).toBeLessThan(at("COMPLETED · 1"));
		const row = (name: string) => f.find((l) => l.includes(name)) ?? "";
		expect(row("/implement 7")).toMatch(
			/^> \/implement 7 +awaiting input +Which colour\? needs input: pick a colour/,
		);
		expect(row("/implement 8")).toMatch(
			/^ {2}\/implement 8 +working {9}running the suite/,
		);
		expect(row("/implement 9")).toMatch(/completed +Done\. result: shipped/);
		expect(at("/implement 7")).toBe(at("AWAITING INPUT · 1") + 1);
		expect(at("/implement 8")).toBe(at("WORKING · 1") + 1);
		expect(at("/implement 9")).toBe(at("COMPLETED · 1") + 1);
	});

	it("prints the list once, unstyled, where its output is not a terminal", async () => {
		const r = await runInProcessAsync(SCRIPT, [], { env: { ...process.env } });
		expect(r.status).toBe(0);
		expect(r.stdout).not.toContain(ESC);
		expect(r.stdout).toMatch(
			/AWAITING INPUT · 1\n {2}\/implement 7 +awaiting input/,
		);
	});

	it("follows a run's state change without a restart", async () => {
		const t = openTerminal({ pollMs: 20 });
		writeRun(WORKING, [says("Which test?\n\nneeds input: which one")], {
			live: false,
			prompt: "/implement 8",
		});
		await vi.waitFor(() => expect(t.frame()).toContain("AWAITING INPUT · 2"));
		t.close();
		expect(t.frame()).toContain("WORKING · 0");
	});
});

describe("the window", () => {
	it("keeps a session awaiting input however old, and drops an old completed one", () => {
		const old = Date.now() - 72 * 60 * 60 * 1000;
		writeRun(AWAITING, [says("needs input: still waiting")], {
			live: false,
			prompt: "/implement 7",
			launchedAt: old,
		});
		writeRun(DONE, [says("result: shipped")], {
			live: false,
			prompt: "/implement 9",
			launchedAt: old,
		});
		const t = openTerminal();
		t.close();
		expect(t.frame()).toContain("AWAITING INPUT · 1");
		expect(t.frame()).toContain("COMPLETED · 0");
	});
});

describe("the keys", () => {
	it("Enter opens the selected session's thread, and Left goes back", () => {
		const t = openTerminal();
		t.type(DOWN, ENTER);
		expect(t.frame()[0]).toBe("/implement 8 · working");
		expect(t.frame()).toContain("▶ /implement 8");
		expect(t.frame()).toContain("  [Bash] npm test");
		expect(t.frame()).toContain("running the suite");
		t.type(LEFT);
		t.close();
		expect(t.frame()[0]).toBe("Overflow sessions · 3");
	});

	it("an open thread follows its log as it grows", async () => {
		const t = openTerminal({ pollMs: 20 });
		t.type(DOWN, ENTER);
		fs.appendFileSync(runOf(WORKING).log, `${says("suite green")}\n`);
		await vi.waitFor(() => expect(t.frame()).toContain("suite green"));
		t.close();
	});

	it("Space opens a reply line, and Enter sends it to the session's latest run", () => {
		const t = openTerminal();
		t.type(" ", "blue", " please");
		expect(t.frame().at(-2)).toBe("reply to /implement 7> blue please█");
		t.type(ENTER);
		t.close();
		expect(t.reply).toHaveBeenCalledWith(runOf(AWAITING), "blue please");
		expect(t.frame().at(-2)).toBe("sent: /implement 7 resumed as job 0000000d");
	});

	it("refuses a reply line to a session still working", () => {
		const t = openTerminal();
		t.type(DOWN, " ");
		t.close();
		expect(t.frame().at(-2)).toBe(
			"/implement 8: still working, reply once it ends",
		);
	});

	it("the stop key asks first, then stops through the stop routing", () => {
		const t = openTerminal();
		t.type(DOWN, "x");
		expect(t.frame().at(-2)).toBe(
			"Stop /implement 8? y stop it · any other key keeps it running",
		);
		t.type("n");
		expect(t.stop).not.toHaveBeenCalled();
		t.type("x", "y");
		t.close();
		expect(t.stop).toHaveBeenCalledWith(runOf(WORKING));
		expect(t.frame().at(-2)).toBe("headless run 0000000b stopped");
	});

	it("q and Ctrl+C quit", () => {
		const t = openTerminal();
		t.type("q");
		t.type("\x03");
		t.close();
		expect(t.proc.exit.mock.calls).toEqual([[0], [0]]);
	});
});

describe("a reply", () => {
	it("resumes the session headless under its seat, the key in --settings alone", async () => {
		const t = openTerminal({
			reply: (run, text) => sendReply(run, text, () => ({ usd: 5 })),
		});
		t.type(" ", "blue", ENTER);
		t.close();
		expect(t.frame().at(-2)).toMatch(
			/^sent: \/implement 7 resumed as job [0-9a-f]{8}$/,
		);
		const seenFile = path.join(fakeOut, "seen.json");
		await vi.waitFor(() => expect(fs.existsSync(seenFile)).toBe(true), {
			timeout: 10_000,
		});
		const seen = JSON.parse(fs.readFileSync(seenFile, "utf8"));
		const flag = (name: string) => seen.argv[seen.argv.indexOf(name) + 1];
		expect(seen.argv[0]).toBe("-p");
		expect(flag("--resume")).toBe(AWAITING.sid);
		expect(flag("--output-format")).toBe("stream-json");
		expect(flag("--max-budget-usd")).toBe("5");
		expect(seen.argv.at(-1)).toBe("blue");
		expect(JSON.parse(flag("--settings")).apiKeyHelper).toBeTruthy();
		expect(seen.helped).toBe(KEY);
		expect(seen.env.CLAUDE_CONFIG_DIR).toBe(seat);
		expect(Object.values(seen.env)).not.toContain(KEY);
	});

	it("is not sent past the key's headroom", () => {
		const out = sendReply(runOf(AWAITING), "blue", () => ({
			why: "the key's budget does not fit a reply",
		}));
		expect(out).toEqual({ why: "the key's budget does not fit a reply" });
		expect(fs.existsSync(path.join(fakeOut, "seen.json"))).toBe(false);
	});
});

describe("the seat gate", () => {
	it("refuses a key the seat file does not name", () => {
		expect(
			readHeadroom({ ...runOf(AWAITING), keyVar: "WFC_NO_SUCH_KEY" }),
		).toEqual({
			why: "WFC_NO_SUCH_KEY is not an overflow seat's key in the seat file",
		});
	});

	it("refuses a key the seat file now gives another seat", () => {
		const elsewhere = path.join(tmp, "home", ".claude3");
		expect(readHeadroom({ ...runOf(AWAITING), seat: elsewhere })).toEqual({
			why: `${KEY_VAR} is now ${seat}'s key, and the session is on ${elsewhere}`,
		});
	});
});

describe("a stop", () => {
	/* A `sleep` is the run, so the stop's signal reaches nothing else. */
	it("ends the run's process group through the stop routing", async () => {
		const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
		const pid = child.pid as number;
		const exited = new Promise((r) => child.on("exit", r));
		writeRun(WORKING, [says("working")], {
			live: true,
			prompt: "/implement 8",
		});
		const dir = path.join(refill, ".headless-runs", WORKING.job);
		const record = {
			...runOf(WORKING),
			pid,
			pgid: pid,
			procStart: readProcStartOf(pid),
		};
		fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(record));
		try {
			expect(stopRun(record)).toEqual({
				ok: true,
				said: `headless run ${WORKING.job} stopped`,
			});
			await exited;
		} finally {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				/* already gone */
			}
		}
	});
});
