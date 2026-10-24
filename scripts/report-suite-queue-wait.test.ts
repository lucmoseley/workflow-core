// @vitest-environment node
/*
 * report-suite-queue-wait.test.ts — the daily queue-wait alarm (#1219, ruled
 * at #1157). Break it and a backlog files nothing, a quiet day files an issue,
 * a closed issue re-files on the backlog it already reported, or the reporter
 * reads on every session start.
 *
 * Black-box through `runInProcess` over a temp git repo, because the log's
 * path comes from git's canonical checkout. `gh` is a fake reached through
 * WFC_GH and the body writer one reached through WFC_ISSUE_BODY, each logging
 * its argv, so every case reads what would have reached the tracker.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stubGhScript } from "./lib/gh-stub";
import { guardErrorsLog } from "./lib/guard-errors-log";
import { MARKERS_REL } from "./lib/marker-root";
import { queueExitLogPath } from "./lib/queue-exit-log";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.join(__dirname, "report-suite-queue-wait.js");
/* The issue title and the marker names the script uses, restated so a rename
 * fails here rather than passing unseen. */
const TITLE = "Suite queue wait is over its daily limit";
const STAMP = ".suite-queue-wait-read";
const LOCK = ".suite-queue-wait-read.lock";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-20T12:00:00Z");
const iso = (t: number) => new Date(t).toISOString();

let home: string;
let repo: string;
let markers: string;
/* The log the script reads, through the path its own reader resolves. */
let exitLog: string;

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "queue-wait-"));
	repo = path.join(home, "repo");
	fs.mkdirSync(path.join(repo, ".claude-plugin"), { recursive: true });
	execFileSync("git", ["init", "-q", repo]);
	fs.writeFileSync(
		path.join(repo, ".claude-plugin", "plugin.json"),
		JSON.stringify({ name: "workflow-core" }),
	);
	markers = path.join(repo, MARKERS_REL);
	fs.mkdirSync(markers, { recursive: true });
	exitLog = queueExitLogPath(repo) as string;
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

interface Exit {
	at: number;
	waitS: number;
	reason?: string;
	kind?: string;
	session?: string | null;
	empty?: boolean;
	skipped?: boolean;
}

const exit = (e: Exit) => ({
	reason: "opened",
	kind: "bare",
	session: "s-1",
	empty: false,
	pid: 1,
	...e,
	at: iso(e.at),
});

const log = (...exits: Exit[]) =>
	fs.appendFileSync(
		exitLog,
		exits.map((e) => `${JSON.stringify(exit(e))}\n`).join(""),
	);

/** `hours` of wait, as one run exiting an hour before NOW. */
const waited = (hours: number) => log({ at: NOW - HOUR, waitS: hours * 3600 });

/** A fake `gh` serving `open` to the open listing and `open` then `closed`,
 *  newest first, to the all-states one. */
function stubGh(
	{
		open = [] as { number: number; title: string }[],
		closed = [] as { title: string; closedAt: number }[],
	} = {},
	{ failing = false } = {},
) {
	const argv = path.join(home, "gh-argv.log");
	const openFile = path.join(home, "open.json");
	const allFile = path.join(home, "all.json");
	const openRows = open.map((o) => ({
		...o,
		labels: [{ name: "takes:wayfinder" }],
		closedAt: null,
	}));
	fs.writeFileSync(openFile, JSON.stringify(openRows));
	fs.writeFileSync(
		allFile,
		JSON.stringify([
			...openRows,
			...[...closed]
				.sort((a, b) => b.closedAt - a.closedAt)
				.map((c, i) => ({
					number: 100 - i,
					title: c.title,
					labels: [],
					closedAt: iso(c.closedAt),
				})),
		]),
	);
	const script = [
		"#!/bin/sh",
		`printf '%s\\n' "$*" >> ${JSON.stringify(argv)}`,
		'if [ "$1" = "issue" ] && [ "$2" = "list" ]; then',
		'  case "$*" in',
		`    *"--state all"*) cat ${JSON.stringify(allFile)} ;;`,
		`    *) cat ${JSON.stringify(openFile)} ;;`,
		"  esac",
		'elif [ "$1" = "issue" ] && [ "$2" = "view" ]; then',
		"  echo 'an older body'",
		'elif [ "$1" = "issue" ] && [ "$2" = "create" ]; then',
		"  echo https://github.com/o/r/issues/999",
		"fi",
	].join("\n");
	const bodyLog = path.join(home, "issue-body-argv.log");
	const bodyScript = path.join(home, "issue-body.js");
	fs.writeFileSync(
		bodyScript,
		`require("node:fs").appendFileSync(${JSON.stringify(bodyLog)}, process.argv.slice(2).join(" ") + "\\n");`,
	);
	const read = (f: string) =>
		fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
	return {
		env: {
			...stubGhScript(home, script, { failing }).env,
			WFC_ISSUE_BODY: bodyScript,
		},
		calls: () => read(argv),
		creates: () =>
			read(argv)
				.split("\n")
				.filter((l) => l.startsWith("issue create")),
		bodyCalls: () => read(bodyLog),
	};
}

const config = () => path.join(home, "config");

const run = (
	gh: { env: Record<string, string> },
	at = NOW,
	args: string[] = [],
) =>
	runInProcess(SCRIPT, args, {
		cwd: repo,
		env: {
			...process.env,
			...gh.env,
			CLAUDE_PROJECT_DIR: repo,
			CLAUDE_CONFIG_DIR: config(),
			WFC_CLAUDE_CONFIG_A: config(),
			WFC_CLAUDE_CONFIG_B: config(),
			WFC_CLAUDE_CONFIG_C: config(),
			WFC_NOW: iso(at),
		},
	});

const errorLog = () => guardErrorsLog(config());

/** What a `--dry-run` at NOW prints: the issue body, then the figure. */
const dryRun = () => {
	const r = run(stubGh(), NOW, ["--dry-run"]);
	expect(r.status).toBe(0);
	return r.stdout;
};

describe("the window", () => {
	it("counts only the part of a wait inside it", () => {
		log({ at: NOW, waitS: 2 * 3600 });
		expect(dryRun()).toContain("Dry run: 2.0 h of queue wait in the last 24 h");
	});

	it("counts a wait that began before the 24 h only from the window's start", () => {
		log({ at: NOW - 23 * HOUR, waitS: 3 * 3600 });
		expect(dryRun()).toContain("Dry run: 1.0 h of queue wait in the last 24 h");
	});

	it("splits a wait across the two days it spans, counting the run on each", () => {
		log({ at: Date.parse("2026-10-18T00:30:00Z"), waitS: 3600 });
		const out = dryRun();
		expect(out).toContain("| 2026-10-17 | 1 | 0.5 |");
		expect(out).toContain("| 2026-10-18 | 1 | 0.5 |");
		expect(out).toContain("| 2026-10-19 | 0 | 0.0 |");
	});
});

describe("the body carries #1157 Q7's breakdown", () => {
	let printed = "";
	const body = () => printed;
	beforeEach(() => {
		const at = (h: number) => NOW - h * HOUR;
		log(
			{ at: at(1), waitS: 1800, kind: "bare", session: "a" },
			{ at: at(2), waitS: 1200, kind: "changed", session: "b" },
			{ at: at(3), waitS: 900, kind: "full", session: "c" },
			{ at: at(4), waitS: 600, kind: "named", session: "d" },
			{ at: at(5), waitS: 300, kind: "bare", session: "e" },
			{ at: at(6), waitS: 360, kind: "bare", session: "f", empty: true },
			{ at: at(7), waitS: 60, kind: "other", session: "e" },
			{ at: at(7), waitS: 720, reason: "killed", session: null },
			/* Never queued (#1221), so in none of the figures below but its own. */
			{
				at: at(8),
				waitS: 0,
				reason: "left",
				session: "g",
				empty: true,
				skipped: true,
			},
			{ at: NOW - 3 * DAY, waitS: 3600 },
		);
		fs.appendFileSync(exitLog, 'not json\n{"at":"2026-10-20"}\n');
		printed = dryRun();
	});

	it("states the figure and the limit", () => {
		expect(body()).toMatch(
			/\*\*1\.6 h\*\* of suite queue wait .* over 8 queued run/,
		);
		expect(body()).toContain("The limit is 2 h, fixed in hours");
		expect(body()).toContain("the session that takes this issue may make");
	});

	it("gives 14 days of daily wait, today last", () => {
		const days = body().match(/^\| 2026-\d\d-\d\d.*$/gm) ?? [];
		expect(days).toHaveLength(14);
		expect(days[0]).toContain("2026-10-07");
		expect(days[13]).toContain("2026-10-20 (to now) | 8 |");
		expect(days[10]).toBe("| 2026-10-17 | 1 | 1.0 |");
	});

	it("splits the window by run kind", () => {
		expect(body()).toContain("| `bare` | 4 | 0.9 |");
		expect(body()).toContain("| `changed` | 1 | 0.3 |");
		expect(body()).toContain("| `full` | 1 | 0.3 |");
		expect(body()).toContain("| `named` | 1 | 0.2 |");
		expect(body()).toContain("| `other` | 1 | 0.0 |");
	});

	it("names the five sessions with most wait, most first", () => {
		const rows = body()
			.split("## The 5 launching sessions")[1]
			.split("##")[0]
			.match(/^\| `.*$/gm);
		expect(rows?.map((r) => r.split("`")[1])).toEqual([
			"a",
			"b",
			"c",
			"(no session)",
			"d",
		]);
	});

	it("counts the empty-selection and killed waits", () => {
		expect(body()).toContain(
			"1 run(s) left the queue with an empty selection, after 0.1 h of wait. 1 more skipped it at once",
		);
		expect(body()).toContain("1 wait(s) ended by a signal, after 0.2 h");
	});

	it("says how many lines would not parse", () => {
		expect(body()).toContain("2 log line(s) would not parse");
	});

	it("names the map's deferred fog as candidate questions", () => {
		expect(body()).toContain("suite growth budget");
		expect(body()).toContain("Hub fan-out");
		expect(body()).toContain("per-session run cap");
		expect(body()).toContain("deferred (#1152)");
	});
});

describe("filing (#1157 Q8)", () => {
	it("files and touches nothing under 2 h, and makes no gh call", () => {
		waited(1.9);
		const gh = stubGh({ open: [{ number: 5, title: TITLE }] });
		const r = run(gh);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("1.9 h of queue wait");
		expect(gh.calls()).toBe("");
	});

	it("files one takes:wayfinder issue at 2 h with none open", () => {
		waited(2);
		const gh = stubGh();
		const r = run(gh);
		expect(r.status).toBe(0);
		expect(gh.creates()).toHaveLength(1);
		expect(gh.creates()[0]).toContain(`--title ${TITLE}`);
		expect(gh.creates()[0]).toContain("--label takes:wayfinder");
		expect(gh.calls()).toContain("## Killed waits");
		expect(r.stdout).toContain("Filed https://github.com/o/r/issues/999");
	});

	it("refreshes the open issue's body and files nothing new", () => {
		waited(3);
		const gh = stubGh({ open: [{ number: 5, title: TITLE }] });
		const r = run(gh);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("Refreshed #5.");
		expect(gh.creates()).toHaveLength(0);
		expect(gh.bodyCalls()).toMatch(/^replace 5 --file /);
	});

	it("finds the open issue by title, whatever the taking session relabelled it", () => {
		waited(3);
		const gh = stubGh({ open: [{ number: 5, title: TITLE }] });
		const r = run(gh);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("Refreshed #5.");
		expect(gh.calls()).not.toMatch(/issue list .*--label/);
	});

	it("does not re-file on a window that started before the close", () => {
		waited(3);
		const gh = stubGh({ closed: [{ title: TITLE, closedAt: NOW - 2 * HOUR }] });
		const r = run(gh);
		expect(r.status).toBe(0);
		expect(gh.creates()).toHaveLength(0);
		expect(r.stdout).toContain("inside this window");
	});

	it("re-files on a window that starts after the close", () => {
		waited(3);
		const gh = stubGh({
			closed: [
				{ title: TITLE, closedAt: NOW - DAY - 1 },
				{ title: `${TITLE} (not this one)`, closedAt: NOW - HOUR },
			],
		});
		const r = run(gh);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("Filed https://github.com/o/r/issues/999");
		expect(gh.creates()).toHaveLength(1);
	});

	it("prints the reading and files nothing on --dry-run", () => {
		waited(3);
		const gh = stubGh();
		const r = run(gh, NOW, ["--dry-run"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("Dry run: 3.0 h");
		expect(gh.calls()).toBe("");
		expect(fs.existsSync(path.join(markers, STAMP))).toBe(false);
	});
});

describe("at most hourly", () => {
	it("reads nothing within the hour of the last reading, and reads again past it", () => {
		waited(3);
		const gh = stubGh({ open: [{ number: 5, title: TITLE }] });
		run(gh);
		const after = gh.bodyCalls();
		const r = run(gh, NOW + 59 * 60_000);
		expect(r.stdout).toContain("under an hour ago");
		expect(gh.bodyCalls()).toBe(after);
		run(gh, NOW + HOUR);
		expect(gh.bodyCalls().split("\n").filter(Boolean)).toHaveLength(2);
	});

	it("reads nothing while another run holds a live lock", () => {
		waited(3);
		fs.writeFileSync(path.join(markers, LOCK), "1");
		const gh = stubGh();
		const r = run(gh);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("Another run is reading");
		expect(gh.calls()).toBe("");
	});

	it("takes over a lock a dead run left, and releases its own", () => {
		waited(3);
		const lock = path.join(markers, LOCK);
		fs.writeFileSync(lock, "1");
		const old = new Date(Date.now() - 11 * 60_000);
		fs.utimesSync(lock, old, old);
		const gh = stubGh();
		const r = run(gh);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("Filed https://github.com/o/r/issues/999");
		expect(gh.creates()).toHaveLength(1);
		expect(fs.existsSync(lock)).toBe(false);
	});
});

describe("fails open, recorded", () => {
	it("records an unreadable log and exits 0", () => {
		fs.mkdirSync(exitLog);
		const gh = stubGh();
		const r = run(gh);
		expect(r.status).toBe(0);
		expect(r.stderr).toMatch(/FAILED OPEN: .*will not read — EISDIR/);
		expect(errorLog()).toContain("report-suite-queue-wait");
		expect(gh.calls()).toBe("");
	});

	it("records an unreadable stamp and exits 0, rather than reading unseen", () => {
		waited(3);
		fs.mkdirSync(path.join(markers, STAMP));
		const gh = stubGh();
		const r = run(gh);
		expect(r.status).toBe(0);
		expect(r.stderr).toMatch(/FAILED OPEN: EISDIR/);
		expect(errorLog()).toContain("report-suite-queue-wait");
		expect(gh.calls()).toBe("");
	});

	it("records a gh failure and exits 0", () => {
		waited(3);
		const gh = stubGh({}, { failing: true });
		const r = run(gh);
		expect(r.status).toBe(0);
		expect(r.stderr).toMatch(
			/FAILED OPEN: Command failed: .*gh issue list[\s\S]*gh auth login/,
		);
		expect(errorLog()).toContain("report-suite-queue-wait");
	});

	it("reads no log as no wait, not a failure", () => {
		const gh = stubGh();
		const r = run(gh);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("0.0 h of queue wait");
		expect(errorLog()).toBe("");
	});
});

describe("in an adopter (#1454)", () => {
	beforeEach(() =>
		fs.writeFileSync(
			path.join(repo, ".claude-plugin", "plugin.json"),
			JSON.stringify({ name: "mantahostels" }),
		),
	);

	it("files one issue in the host's tracker with suites on", () => {
		waited(3);
		const gh = stubGh();
		const r = run(gh);
		expect(r.status).toBe(0);
		expect(gh.creates()).toHaveLength(1);
		expect(gh.calls()).not.toContain("--repo");
		expect(r.stdout).toContain("Filed https://github.com/o/r/issues/999");
	});

	it("qualifies every core citation and routes to the host's own /wayfinder", () => {
		waited(3);
		const body = dryRun();
		expect(body).not.toMatch(/(?<![\w$&{#])#\d+/);
		expect(body).toContain("(workflow-core#1152)");
		expect(body).toContain("this repo's own `/wayfinder`");
		expect(body).toContain("a ruling filed in workflow-core");
		expect(body).not.toContain("scripts/session-arbiter.js");
	});

	it("prints a SKIP and makes no gh call with suites off", () => {
		waited(3);
		const gh = stubGh();
		const r = run({ env: { ...gh.env, WFC_MODULES: "roadmap" } });
		expect(r.status).toBe(0);
		expect(r.stderr).toContain('SKIP: module "suites" is off');
		expect(gh.calls()).toBe("");
	});
});
