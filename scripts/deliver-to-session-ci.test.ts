// @vitest-environment node
/*
 * Pins deliver-to-session.js's --ci source, the mid-session CI re-check: one
 * gh call while the newest run is unchanged, the full check only when it
 * changes, each text delivered once, and never a sweep fired.
 *
 * It runs the real script and check-ci-status.js in a sandbox repo, with gh a
 * logging stub serving canned runs, so a test can count every call and catch
 * a `workflow run` the re-check must never make.
 *
 * Breaking it either keeps a red sweep from the running session, or spends
 * the 3-a-day sweep budget every ten minutes (#856).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { freshSandbox } from "./lib/arbiter-testkit";
import { GH_FAILING_SCRIPT, stubGhScript } from "./lib/gh-stub";
import { runInProcess } from "./lib/run-in-process";

const DELIVER = path.resolve(__dirname, "deliver-to-session.js");
const CHECK = path.resolve(__dirname, "check-ci-status.js");

// biome-ignore lint/suspicious/noExplicitAny: a CJS module has no types to import
const notify: any = createRequire(__filename)("./lib/notify-report.js");

const sb = freshSandbox();

const NOW = "2026-08-21T21:30:00Z";
const OTHER = "0123456789abcdef0123456789abcdef01234567";
const at = (hm: string) => `2026-08-21T${hm}:00Z`;

let file: (name: string) => string;
/** A commit HEAD sits one past, so a sweep there leaves HEAD untested. */
let behind = "";

const run_ = (over: Record<string, unknown> = {}) => ({
	databaseId: 200,
	headSha: OTHER,
	status: "completed",
	conclusion: "success",
	workflowName: "CI",
	event: "schedule",
	url: "https://example.invalid/200",
	createdAt: at("20:00"),
	updatedAt: at("20:10"),
	...over,
});
const sweep = (hm: string) =>
	run_({
		workflowName: "scheduled-checks",
		headSha: behind,
		createdAt: at(hm),
	});

const write = (name: string, value: unknown) =>
	fs.writeFileSync(file(name), JSON.stringify(value));
const setRuns = (runs: unknown[]) => write("runs.json", runs);
/** Every slot of the last day fired: the check has nothing to say. */
const sweepsCurrent = () =>
	write("sweeps.json", ["03:00", "09:00", "15:00", "21:00"].map(sweep));
/** Twelve hours old, past the 8 h a --notify run fires a sweep at. */
const sweepsStale = () => write("sweeps.json", ["03:00", "09:00"].map(sweep));

const calls = () =>
	fs.existsSync(file("calls"))
		? fs.readFileSync(file("calls"), "utf8").trim().split("\n")
		: [];
const resetCalls = () => fs.rmSync(file("calls"), { force: true });
const fires = () => calls().filter((c) => c.startsWith("workflow run"));

const deliver = (session = "mine") => {
	const r = runInProcess(DELIVER, ["--ci"], {
		env: { ...process.env, CLAUDE_CODE_SESSION_ID: session },
		cwd: sb.repo,
	});
	return { status: r.status, out: r.stdout };
};

beforeEach(() => {
	file = (name) => path.join(sb.dir, name);
	const g = (...args: string[]) =>
		execFileSync("git", args, { cwd: sb.repo, stdio: "ignore" });
	g("init", "-q", "-b", "main");
	g("config", "user.email", "t@example.invalid");
	g("config", "user.name", "Test");
	fs.mkdirSync(path.join(sb.repo, ".github", "workflows"), { recursive: true });
	fs.writeFileSync(
		path.join(sb.repo, ".github", "workflows", "scheduled-checks.yml"),
		"",
	);
	g("add", "-A");
	g("commit", "-q", "-m", "init");
	behind = execFileSync("git", ["rev-parse", "HEAD"], { cwd: sb.repo })
		.toString()
		.trim();
	g("commit", "-q", "--allow-empty", "-m", "next");
	process.env.WFC_REPO_DIR = sb.repo;
	process.env.WFC_NOW = NOW;
	delete process.env.WFC_NOTIFY_PERSIST;
	write("workflows.json", [
		{
			name: "scheduled-checks",
			state: "active",
			path: ".github/workflows/scheduled-checks.yml",
		},
	]);
	setRuns([run_()]);
	sweepsCurrent();
	/* The gate's query asks for `updatedAt`; the check's never does. The
	 * `hang` file stalls every call but the gate's. */
	process.env.WFC_GH = stubGhScript(
		sb.dir,
		"#!/bin/sh\n" +
			`echo "$*" >> ${file("calls")}\n` +
			`case "$*" in *updatedAt*) exec cat ${file("runs.json")};; esac\n` +
			`[ -f ${file("hang")} ] && sleep 3\n` +
			'[ "$1" = "workflow" ] && [ "$2" = "run" ] && exit 0\n' +
			'[ "$1" = "issue" ] && exec echo "[]"\n' +
			'for a in "$@"; do\n' +
			'  [ "$a" = "view" ] && exit 1\n' +
			`  [ "$a" = "workflow" ] && exec cat ${file("workflows.json")}\n` +
			`  [ "$a" = "--workflow" ] && exec cat ${file("sweeps.json")}\n` +
			"done\n" +
			`exec cat ${file("runs.json")}\n`,
	).gh;
});

describe("the CI re-check (#856)", () => {
	it("spends exactly one gh call and prints nothing while the newest run is unchanged", () => {
		setRuns([run_({ conclusion: "failure" })]);
		expect(deliver().out).toContain("CI is red");
		resetCalls();

		const again = deliver();
		expect(again.out).toBe("");
		expect(again.status).toBe(0);
		expect(calls()).toHaveLength(1);
	});

	it("runs the full check when the newest run changes, and prints its text", () => {
		deliver();
		setRuns([
			run_({
				databaseId: 201,
				conclusion: "failure",
				url: "https://example.invalid/201",
			}),
		]);
		resetCalls();

		const r = deliver();
		expect(r.out).toContain("▸ ci-recheck\n");
		expect(r.out).toContain("CI is red");
		expect(r.out).toContain("https://example.invalid/201");
		expect(calls().length).toBeGreaterThan(1);
	});

	it("prints one text once, though the run it came from changes", () => {
		sweepsStale();
		expect(deliver().out).toContain("Newest sweep is");
		setRuns([run_({ databaseId: 201 })]);
		resetCalls();

		expect(deliver().out).toBe("");
		expect(calls().length).toBeGreaterThan(1);
	});

	it("is silent when the newest run is green and current", () => {
		expect(deliver().out).toBe("");
	});

	it("never fires a sweep where the session-start form would", () => {
		sweepsStale();
		runInProcess(CHECK, ["--notify"], { env: process.env, cwd: sb.repo });
		expect(fires()).toHaveLength(1);
		fs.rmSync(path.join(sb.repo, ".git", ".sweep-autofire"), { force: true });
		resetCalls();

		expect(deliver().out).toContain("Newest sweep is");
		expect(fires()).toEqual([]);
	});

	it("leaves the replay's delivery stamp unwritten", () => {
		setRuns([run_({ conclusion: "failure" })]);
		expect(deliver().out).toContain("CI is red");
		expect(fs.existsSync(path.join(notify.base(), "ci-status.notified"))).toBe(
			false,
		);
	});

	it("delivers nothing from a timed-out check, and asks again next time", () => {
		setRuns([run_({ conclusion: "failure" })]);
		fs.writeFileSync(file("hang"), "");
		process.env.WFC_RECHECK_TIMEOUT_MS = "300";
		const timedOut = deliver();
		expect(timedOut.out).toBe("");
		expect(timedOut.status).toBe(0);

		fs.rmSync(file("hang"));
		delete process.env.WFC_RECHECK_TIMEOUT_MS;
		expect(deliver().out).toContain("CI is red");
	});

	it("takes a run its own start already reported as seen, without the full check", () => {
		setRuns([run_({ conclusion: "failure" })]);
		notify.writeReport("ci-status", {
			outcome: "FAIL",
			text: "CI is red\n",
			finishedAt: at("20:30"),
			durationMs: 5000,
			owner: "mine",
		});

		expect(deliver().out).toBe("");
		expect(calls()).toHaveLength(1);
	});

	it.each([
		["SKIP", ""],
		["BROKEN", "this check is broken\n"],
	] as const)(
		"runs the full check where its own start's check was %s, which saw no runs (#890)",
		(outcome, text) => {
			setRuns([run_({ conclusion: "failure" })]);
			notify.writeReport("ci-status", {
				outcome,
				text,
				finishedAt: at("20:30"),
				durationMs: 5000,
				owner: "mine",
			});

			expect(deliver().out).toContain("CI is red");
		},
	);

	it("runs the full check where the start's report is another session's", () => {
		setRuns([run_({ conclusion: "failure" })]);
		notify.writeReport("ci-status", {
			outcome: "FAIL",
			text: "CI is red\n",
			finishedAt: at("20:30"),
			owner: "theirs",
		});

		expect(deliver().out).toContain("CI is red");
	});

	it("runs the full check where the run finished after its own start's check", () => {
		setRuns([run_({ conclusion: "failure", updatedAt: at("20:40") })]);
		notify.writeReport("ci-status", {
			outcome: "OK",
			finishedAt: at("20:30"),
			owner: "mine",
		});

		expect(deliver().out).toContain("CI is red");
	});

	it("prints nothing, and logs, when the gate's gh call fails", () => {
		fs.writeFileSync(process.env.WFC_GH as string, GH_FAILING_SCRIPT);
		const r = deliver();
		expect(r.out).toBe("");
		expect(r.status).toBe(0);
		expect(fs.readFileSync(sb.errorLog(), "utf8")).toContain(
			"deliver-to-session ci gate",
		);
	});

	it("records nothing seen when the check skips, so a red is not lost", () => {
		// A spent budget: the check skips, exiting 0 with nothing printed.
		setRuns([run_({ conclusion: "failure" })]);
		process.env.WFC_NOTIFY_BUDGET_MS = "1";
		expect(deliver().out).toBe("");

		delete process.env.WFC_NOTIFY_BUDGET_MS;
		expect(deliver().out).toContain("CI is red");
	});

	it("runs the full check when an older run at the newest sha finishes red", () => {
		setRuns([
			run_({ databaseId: 201 }),
			run_({ databaseId: 200, status: "in_progress", conclusion: null }),
		]);
		deliver();
		setRuns([
			run_({ databaseId: 201 }),
			run_({ databaseId: 200, conclusion: "failure" }),
		]);

		expect(deliver().out).toContain("CI is red");
	});
});
