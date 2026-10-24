// @vitest-environment node
/*
 * Pins which finished sessions the weekly retro's picker pools, excludes and
 * ranks by fault signal over its window, and how `--calibrate` draws controls.
 *
 * pick-retro-sessions.js, driven as a command against a fake home. Asserts on
 * stdout, stderr and the exit code only (#960).
 *
 * What a break costs: the weekly retro reads the wrong sessions — a live one
 * mid-flight, a headless probe, another repo's scratch — or a calibration batch
 * whose controls are not random, so its verdict on the ranking means nothing.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process";
import { seatDirs } from "./lib/seat-testkit";

const SCRIPT = path.resolve(__dirname, "pick-retro-sessions.js");

const NOW = Date.parse("2026-10-08T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

let home: string;
let seats: string[];
let repos: { core: string; adopter: string; plain: string };
let systmp: string;

const slug = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");
const mkdir = (dir: string) => fs.mkdirSync(dir, { recursive: true });
const writeJson = (file: string, value: unknown) => {
	mkdir(path.dirname(file));
	fs.writeFileSync(file, JSON.stringify(value));
};

/* Records, each stamped after the session's first so only the header dates it. */
const later = iso(NOW - HOUR * 30);
const toolError = (text = "boom") =>
	JSON.stringify({
		type: "user",
		timestamp: later,
		message: {
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "t",
					is_error: true,
					content: text,
				},
			],
		},
	});
const denial = () =>
	toolError(
		"Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Self-Modification].",
	);
const stopBlock = () =>
	JSON.stringify({
		type: "user",
		isMeta: true,
		timestamp: later,
		message: { role: "user", content: "Stop hook feedback:\nrefused" },
	});
const compaction = () =>
	JSON.stringify({
		type: "system",
		subtype: "compact_boundary",
		timestamp: later,
	});
const founder = (text: string) =>
	JSON.stringify({
		type: "user",
		origin: { kind: "human" },
		timestamp: later,
		message: { role: "user", content: text },
	});
const apiError = (requestId: string) =>
	JSON.stringify({
		type: "assistant",
		isApiErrorMessage: true,
		requestId,
		timestamp: later,
		message: { role: "assistant", content: [{ type: "text", text: "429" }] },
	});
const response = (requestId: string) =>
	JSON.stringify({
		type: "assistant",
		requestId,
		timestamp: later,
		message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
	});
const responses = (n: number, prefix: string) =>
	Array.from({ length: n }, (_, i) => response(`${prefix}-${i}`));

interface SessionOpts {
	seat?: string;
	first?: number;
	entrypoint?: string;
	lines?: string[];
	subagents?: string[][];
	changed?: number;
}

/** One session's main log (and subagent logs) under `cwd`'s slug; returns its path. */
function session(cwd: string, id: string, opts: SessionOpts = {}) {
	const {
		seat = seats[0],
		first = NOW - 2 * DAY,
		entrypoint = "cli",
		lines = [],
		subagents = [],
		changed = first + HOUR,
	} = opts;
	const dir = path.join(seat, "projects", slug(cwd));
	mkdir(dir);
	const header = JSON.stringify({
		type: "user",
		timestamp: iso(first),
		cwd,
		entrypoint,
		sessionId: id,
		origin: { kind: "human" },
		message: { role: "user", content: "/implement 1" },
	});
	const file = path.join(dir, `${id}.jsonl`);
	fs.writeFileSync(file, `${[header, ...lines].join("\n")}\n`);
	subagents.forEach((sub, i) => {
		const subDir = path.join(dir, id, "subagents");
		mkdir(subDir);
		const log = path.join(subDir, `agent-${i}.jsonl`);
		fs.writeFileSync(log, `${sub.join("\n")}\n`);
		fs.utimesSync(log, changed / 1000, changed / 1000);
	});
	fs.utimesSync(file, changed / 1000, changed / 1000);
	return file;
}

/** What the stub oracle lists, the calling session always among it for the self-test. */
const oracleLists = (rows: Record<string, unknown>[]) =>
	writeJson(path.join(home, "agents.json"), [
		{ sessionId: "caller", kind: "interactive", state: "working" },
		...rows,
	]);

/** One output row, as far as these cases read it. */
interface Row {
	sessionId: string;
	transcript: string;
	score: number;
	rank: number;
	pick?: string;
	signals: Record<string, number>;
	[field: string]: unknown;
}
interface Picked {
	window: unknown;
	pooled: number;
	sessions: Row[];
}

function run(args: string[] = [], env: Record<string, string> = {}) {
	const r = runInProcess(
		SCRIPT,
		[...args, ...seats.flatMap((s) => ["--config-dir", s])],
		{
			env: {
				...process.env,
				// A sibling of the seats, so the registry walk finds them and the
				// oracle library's cache lands outside them.
				CLAUDE_CONFIG_DIR: path.join(home, ".oracle-home"),
				WFC_CLAUDE_BIN: path.join(home, "claude"),
				WFC_NOW: iso(NOW),
				CLAUDE_CODE_SESSION_ID: "caller",
				TMPDIR: systmp,
				WFC_CLAUDE_CONFIG_A: "",
				WFC_CLAUDE_CONFIG_B: "",
				WFC_CLAUDE_CONFIG_C: "",
				...env,
			},
		},
	);
	// Null on a refusal, whose cases read stderr and never this.
	const json = (
		r.stdout.startsWith("{") ? JSON.parse(r.stdout) : null
	) as Picked;
	return { ...r, json };
}
const ids = (out: { json: Picked }) =>
	out.json.sessions.map((s) => s.sessionId);

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "pick-retro-"));
	seats = seatDirs(home);
	mkdir(seats[0]);
	mkdir(seats[1]);
	fs.symlinkSync(seats[0], seats[2]);
	systmp = path.join(home, "systmp");
	mkdir(systmp);
	mkdir(path.join(home, ".oracle-home"));

	repos = {
		core: path.join(home, "repos", "workflow-core"),
		adopter: path.join(home, "repos", "adopter"),
		plain: path.join(home, "repos", "plain"),
	};
	for (const r of Object.values(repos)) mkdir(path.join(r, ".git"));
	writeJson(path.join(repos.core, ".claude-plugin", "plugin.json"), {
		name: "workflow-core",
	});
	writeJson(path.join(repos.adopter, ".claude", "settings.json"), {
		enabledPlugins: { "workflow-core@workflow-core": true },
		extraKnownMarketplaces: {
			"workflow-core": { source: { source: "git", ref: "v1.3.4" } },
		},
	});
	writeJson(path.join(repos.plain, ".claude", "settings.json"), {
		enabledPlugins: { "github@claude-plugins-official": true },
	});

	const bin = path.join(home, "claude");
	fs.writeFileSync(
		bin,
		`#!/bin/sh\n[ -f "${home}/oracle-down" ] && exit 1\ncat "${home}/agents.json"\n`,
	);
	fs.chmodSync(bin, 0o755);
	oracleLists([]);
});

afterEach(() => {
	fs.rmSync(home, { recursive: true, force: true });
});

describe("pool", () => {
	it("pools canonical and worktree sessions as their repo, and drops temp, scratch and plugin-less ones", () => {
		session(repos.core, "canonical");
		session(
			path.join(repos.adopter, ".claude", "worktrees", "probe-1"),
			"worktree",
		);
		session(path.join(seats[0], "jobs", "0e78dd3b", "tmp"), "job-temp");
		session(path.join(systmp, "tmp-2U9qtK8pej"), "system-temp");
		session(
			path.join(repos.core, ".claude", "tmp", "scratch-adopter"),
			"claude-tmp",
		);
		session(repos.plain, "no-plugin");

		const out = run();
		expect(out.status).toBe(0);
		expect(ids(out).sort()).toEqual(["canonical", "worktree"]);
		const by = Object.fromEntries(
			out.json.sessions.map((s: Row) => [s.sessionId, s]),
		);
		expect(by.canonical).toMatchObject({
			repo: "workflow-core",
			repoRoot: repos.core,
			release: "self",
			subagentDir: null,
		});
		expect(by.worktree).toMatchObject({
			repo: "adopter",
			repoRoot: repos.adopter,
			release: "v1.3.4",
		});
	});

	it("reports the pin committed when the session started, not one bumped since", () => {
		const git = (...args: string[]) =>
			spawnSync("git", ["-C", repos.adopter, ...args], {
				encoding: "utf8",
				env: {
					...process.env,
					GIT_AUTHOR_DATE: "2026-10-01T00:00:00Z",
					GIT_COMMITTER_DATE: "2026-10-01T00:00:00Z",
				},
			});
		fs.rmSync(path.join(repos.adopter, ".git"), { recursive: true });
		git("init", "-q");
		git(
			"-c",
			"user.name=t",
			"-c",
			"user.email=t@t",
			"add",
			".claude/settings.json",
		);
		git(
			"-c",
			"user.name=t",
			"-c",
			"user.email=t@t",
			"commit",
			"-qm",
			"pin v1.3.4",
		);
		writeJson(path.join(repos.adopter, ".claude", "settings.json"), {
			enabledPlugins: { "workflow-core@workflow-core": true },
			extraKnownMarketplaces: {
				"workflow-core": { source: { source: "git", ref: "v1.3.8" } },
			},
		});
		session(repos.adopter, "before-bump", { first: NOW - 3 * DAY });

		expect(run().json.sessions[0]).toMatchObject({
			sessionId: "before-bump",
			release: "v1.3.4",
		});
	});

	it("drops a repo whose settings name the plugin but disable it", () => {
		writeJson(path.join(repos.plain, ".claude", "settings.json"), {
			enabledPlugins: { "workflow-core@workflow-core": false },
			extraKnownMarketplaces: {
				"workflow-core": { source: { ref: "v1.3.4" } },
			},
		});
		session(repos.plain, "disabled");
		expect(ids(run())).toEqual([]);
	});

	it("counts a seat symlinked at another once, and a session on two seats once, as its larger copy", () => {
		session(repos.core, "shared");
		session(repos.core, "resumed", { seat: seats[0] });
		const bigger = session(repos.core, "resumed", {
			seat: seats[1],
			lines: responses(3, "r"),
		});

		const out = run();
		expect(ids(out).sort()).toEqual(["resumed", "shared"]);
		expect(out.json.pooled).toBe(2);
		expect(
			out.json.sessions.find((s: Row) => s.sessionId === "resumed")?.transcript,
		).toBe(bigger);
	});
});

describe("exclusions", () => {
	it("drops a headless sdk-cli session, the calling session and a session the oracle lists live, but keeps a finished one", () => {
		session(repos.core, "headless", { entrypoint: "sdk-cli" });
		session(repos.core, "caller");
		session(repos.core, "live");
		session(repos.core, "finished");
		session(repos.core, "kept");
		oracleLists([
			{ sessionId: "live", kind: "background", state: "working" },
			{ sessionId: "finished", kind: "background", state: "done" },
		]);

		const out = run();
		expect(out.status).toBe(0);
		expect(ids(out).sort()).toEqual(["finished", "kept"]);
	});

	it("drops a session another seat's registry shows running, which this seat's oracle cannot list", () => {
		session(repos.core, "other-seat", { seat: seats[1] });
		session(repos.core, "finished-here", { seat: seats[0] });
		writeJson(path.join(seats[1], "sessions", "4242.json"), {
			sessionId: "other-seat",
			pid: process.pid,
		});
		writeJson(path.join(seats[0], "sessions", "4243.json"), {
			sessionId: "finished-here",
			pid: process.pid,
		});
		oracleLists([
			{ sessionId: "finished-here", kind: "background", state: "done" },
		]);

		expect(ids(run())).toEqual(["finished-here"]);
	});

	it("skips a session changed within 60 minutes when the oracle cannot be read, and says so", () => {
		fs.writeFileSync(path.join(home, "oracle-down"), "");
		session(repos.core, "old", { changed: NOW - 2 * HOUR });
		session(repos.core, "recent", { changed: NOW - 30 * 60_000 });
		session(repos.core, "recent-subagent", {
			changed: NOW - 2 * HOUR,
			subagents: [[response("s")]],
		});
		const sub = path.join(
			seats[0],
			"projects",
			slug(repos.core),
			"recent-subagent",
			"subagents",
			"agent-0.jsonl",
		);
		fs.utimesSync(sub, (NOW - 10 * 60_000) / 1000, (NOW - 10 * 60_000) / 1000);

		const out = run();
		expect(out.status).toBe(0);
		expect(ids(out)).toEqual(["old"]);
		expect(out.stderr).toMatch(/the liveness oracle could not be read/);
		expect(out.stderr).toMatch(
			/2 session\(s\) whose transcript changed in the last 60 minutes were skipped/,
		);
	});
});

describe("signals and score", () => {
	it("counts all six signals over the main log and its subagent logs", () => {
		const file = session(repos.core, "signals", {
			lines: [
				toolError(),
				denial(),
				stopBlock(),
				compaction(),
				founder("whats the progress?"),
				founder(
					`Great. Next, a brief that mentions progress in passing. ${"x".repeat(200)}`,
				),
				apiError("a1"),
				response("a2"),
			],
			subagents: [
				[
					JSON.stringify({
						type: "user",
						timestamp: later,
						message: { role: "user", content: "check the status of the build" },
					}),
					toolError(),
					response("s1"),
				],
			],
		});

		const [s] = run().json.sessions;
		expect(s.signals).toEqual({
			toolErrors: 2,
			classifierDenials: 1,
			stopBlocks: 1,
			compactions: 1,
			livenessAsks: 1,
			apiErrors: 1,
		});
		expect(s.apiResponses).toBe(3);
		expect(s.score).toBe(7);
		expect(s.subagentDir).toBe(path.join(file.slice(0, -6), "subagents"));
	});

	it("caps each signal at 10, so one runaway signal cannot outrank a broader session", () => {
		session(repos.core, "runaway", {
			lines: Array.from({ length: 25 }, () => toolError()),
		});
		session(repos.core, "broad", {
			lines: [
				...Array.from({ length: 6 }, () => toolError()),
				...Array.from({ length: 5 }, () => stopBlock()),
			],
		});

		const out = run().json.sessions;
		expect(out.map((s: Row) => s.sessionId)).toEqual(["broad", "runaway"]);
		expect(out[0].score).toBe(11);
		expect(out[1].score).toBe(10);
		expect(out[1].signals.toolErrors).toBe(25);
	});

	it("breaks a tie toward the session with more API responses", () => {
		session(repos.core, "a-fewer", {
			lines: [toolError(), toolError(), ...responses(2, "a")],
		});
		session(repos.core, "b-more", {
			lines: [compaction(), compaction(), ...responses(5, "b")],
		});

		const out = run().json.sessions;
		expect(out.map((s: Row) => s.sessionId)).toEqual(["b-more", "a-fewer"]);
		expect(out[0].score).toBe(out[1].score);
	});

	it("--top keeps the first n", () => {
		for (let i = 0; i < 4; i++)
			session(repos.core, `s${i}`, {
				lines: Array.from({ length: i }, () => toolError()),
			});
		const out = run(["--top", "2"]);
		expect(ids(out)).toEqual(["s3", "s2"]);
		expect(out.json.pooled).toBe(4);
	});
});

describe("window", () => {
	it("--week takes a session starting at its first instant and drops one starting at the next week's", () => {
		const start = Date.parse("2026-09-28T00:00:00Z");
		const at = (id: string, first: number) =>
			session(repos.core, id, { first, changed: NOW - DAY });
		at("first-instant", start);
		at("last-instant", start + 7 * DAY - 1);
		at("before", start - 1);
		at("next-week", start + 7 * DAY);

		const out = run(["--week", "2026-09-28"]);
		expect(out.status).toBe(0);
		expect(ids(out).sort()).toEqual(["first-instant", "last-instant"]);
		expect(out.json.window).toEqual({
			start: "2026-09-28T00:00:00.000Z",
			end: "2026-10-05T00:00:00.000Z",
		});
	});

	it("defaults to the 7 days before now, by first timestamp", () => {
		session(repos.core, "edge", {
			first: NOW - 7 * DAY,
			changed: NOW - 2 * HOUR,
		});
		session(repos.core, "too-old", {
			first: NOW - 7 * DAY - 1,
			changed: NOW - 2 * HOUR,
		});
		expect(ids(run())).toEqual(["edge"]);
	});
});

describe("--calibrate", () => {
	it("returns the top 8 as rank and 4 others as control, the same for the same seed", () => {
		for (let i = 0; i < 14; i++)
			session(repos.core, `s${String(i).padStart(2, "0")}`, {
				lines: Array.from({ length: i }, () => toolError()),
			});

		const a = run(["--calibrate", "--seed", "42"]);
		const b = run(["--calibrate", "--seed", "42"]);
		expect(a.status).toBe(0);
		expect(a.stdout).toBe(b.stdout);

		const sessions = a.json.sessions as Array<{
			sessionId: string;
			pick: string;
			rank: number;
		}>;
		const ranked = sessions.filter((s) => s.pick === "rank");
		const controls = sessions.filter((s) => s.pick === "control");
		expect(ranked.map((s) => s.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
		expect(controls).toHaveLength(4);
		expect(new Set(sessions.map((s) => s.sessionId)).size).toBe(12);
		for (const c of controls) expect(c.rank).toBeGreaterThan(8);
	});
});

describe("command line", () => {
	it("answers --help", () => {
		const help = run(["--help"]);
		expect(help.status).toBe(0);
		expect(help.stdout).toMatch(/Usage: node scripts\/pick-retro-sessions\.js/);
	});

	it.each([
		[["--week", "someday"], /--week is not a date \(YYYY-MM-DD\): someday/],
		[
			["--week", "2026-09-28T10:00"],
			/--week is not a date \(YYYY-MM-DD\): 2026-09-28T10:00/,
		],
		[["--week", "2026-10-09"], /--week names a week not yet begun: 2026-10-09/],
		[["--top", "0"], /--top needs a positive whole number: 0/],
		[["--top", "3", "--calibrate"], /--top and --calibrate exclude each other/],
		[["--seed", "1"], /--seed applies only with --calibrate/],
	])("refuses %j, naming the fault and the usage", (args, said) => {
		const out = run(args);
		expect(out.status).toBe(2);
		expect(out.stderr).toMatch(said);
		expect(out.stderr).toMatch(/Usage: node scripts\/pick-retro-sessions\.js/);
	});

	it("refuses a WFC_NOW that is not a date, naming the value", () => {
		const out = run([], { WFC_NOW: "soon" });
		expect(out.status).toBe(2);
		expect(out.stderr).toMatch(/WFC_NOW is not a date: soon/);
	});

	it("ranks a session whose subagent log cannot be read on what was read, and names the log", () => {
		session(repos.core, "partial", {
			lines: [toolError()],
			subagents: [[toolError()]],
		});
		const log = path.join(
			seats[0],
			"projects",
			slug(repos.core),
			"partial",
			"subagents",
			"agent-0.jsonl",
		);
		fs.chmodSync(log, 0o000);

		const out = run();
		expect(out.status).toBe(0);
		expect(out.json.sessions[0].signals.toolErrors).toBe(1);
		expect(out.stderr).toMatch(/1 log\(s\) could not be read/);
		expect(out.stderr).toContain(log);
	});

	// Root lists a 0o000 directory, so the refusal never happens.
	it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)(
		"names a seat whose projects directory cannot be read, and still exits 0 (#1054)",
		() => {
			session(repos.core, "kept", { lines: [toolError()] });
			session(repos.core, "hidden", { seat: seats[1], lines: [toolError()] });
			const projects = path.join(seats[1], "projects");
			fs.chmodSync(projects, 0o000);
			try {
				const out = run();
				expect(out.status).toBe(0);
				expect(ids(out)).toEqual(["kept"]);
				expect(out.stderr).toMatch(/1 director\(ies\) could not be listed/);
				expect(out.stderr).toMatch(/fix the permission, or leave the seat out/);
				expect(out.stderr).toContain(`${projects} (EACCES)`);
			} finally {
				fs.chmodSync(projects, 0o755);
			}
		},
	);

	it("names a seat with no projects directory as holding no session, not as refused (#1054)", () => {
		session(repos.core, "kept", { lines: [toolError()] });
		fs.rmSync(path.join(seats[1], "projects"), {
			recursive: true,
			force: true,
		});
		const out = run();
		expect(out.status).toBe(0);
		expect(out.stderr).toMatch(/1 seat\(s\) have no projects\/ directory/);
		expect(out.stderr).toContain(path.join(seats[1], "projects"));
		expect(out.stderr).not.toMatch(/could not be listed/);
	});

	it("writes nothing under the seats or the repos", () => {
		session(repos.core, "a", { lines: [toolError()] });
		session(repos.adopter, "b", { subagents: [[toolError()]] });
		const snapshot = () => {
			const out: string[] = [];
			const walk = (dir: string) => {
				for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
					const full = path.join(dir, e.name);
					if (full === path.join(home, ".oracle-home")) continue;
					const st = fs.lstatSync(full);
					out.push(`${full} ${st.size} ${st.mtimeMs}`);
					if (e.isDirectory()) walk(full);
				}
			};
			walk(home);
			return out.sort();
		};
		const before = snapshot();
		expect(run().status).toBe(0);
		expect(snapshot()).toEqual(before);
	});
});
