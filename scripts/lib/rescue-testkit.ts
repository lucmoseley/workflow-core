import fs from "node:fs";
import path from "node:path";
import { buildStopBranch } from "./agents-stop-fake";
import type { Sandbox } from "./arbiter-testkit";
import { writeClaudeStub } from "./claude-stub";
import { stubGhScript } from "./gh-stub";
import { buildStatLine } from "./proc-fake";
import { listed } from "./rescue-ports-fake";
import { runInProcessAsync } from "./run-in-process";
import { shellQuote } from "./sh-quote.js";

export const SCRIPT = path.join(__dirname, "..", "rescue-sessions.js");
export const SID = "abcd1234-0000-4000-8000-000000000001";
export const SHORT = SID.slice(0, 8);
export const PID = 4242;

export const EXIT: Record<string, number> = {
	REFUSED: 2,
	UNKNOWN: 3,
	ENDED: 4,
	ASKING: 5,
	DONE: 6,
	SLOW: 7,
	FROZEN: 8,
	GHOST: 9,
	LIMITED: 10,
};

export const SESSION_LIMIT_LINE =
	"You've hit your session limit · resets 8:30pm (Asia/Singapore)";
export const WEEKLY_LIMIT_LINE =
	"You've hit your weekly limit · resets Oct 24, 9am (Asia/Singapore)";
export const MODEL_LIMIT_LINE =
	"You've reached your Fable limit. Run /usage-credits to continue or switch models with /model.";

export interface Row {
	sessionId: string;
	id?: string;
	state?: string;
	kind?: string;
	pid?: number;
}

export const holderRow = (over: Partial<Row> = {}): Row => ({
	sessionId: SID,
	kind: "background",
	state: "working",
	pid: PID,
	...over,
});

const assistant = (content: object[]) =>
	JSON.stringify({ type: "assistant", message: { content } });
export const said = (text: string) => assistant([{ type: "text", text }]);

export const withTracker = (s: Sandbox) => {
	fs.mkdirSync(path.join(s.repo, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(s.repo, ".claude", "workflow-core.json"),
		JSON.stringify({ contract: 1, founder: "T", tracker: "acme/widgets" }),
	);
};

export interface Run {
	status: number;
	stdout: string;
	stderr: string;
}

export function rescueKit(sb: Sandbox) {
	const plan = (name = ".claude") => path.join(sb.dir, "home", name);
	const procRoot = () => path.join(sb.dir, "proc");
	const transcript = (dir = plan()) =>
		path.join(dir, "projects", "p", `${SID}.jsonl`);

	const fakeClaude = (onStop: string[] = []) =>
		writeClaudeStub(path.join(sb.dir, "claude"), [
			'd="$CLAUDE_CONFIG_DIR"',
			'if [ "$1" = stop ]; then',
			...onStop.map((l) => `  ${l}`),
			'  [ -f "$d/stop-fails" ] && { echo "no such job" >&2; exit 1; }',
			'  [ -f "$d/agents-after-stop.json" ] && cp "$d/agents-after-stop.json" "$d/agents.json"',
			"fi",
			buildStopBranch(path.join(sb.dir, "stops")),
			'if [ "$1" = agents ]; then',
			'  [ -f "$d/fail" ] && { echo down >&2; exit 1; }',
			'  cat "$d/agents.json"; exit 0',
			"fi",
		]);

	const lists = (rows: Row[], dir = plan(), file = "agents.json") => {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, file),
			JSON.stringify(
				[{ sessionId: "sandbox", state: "working" }, ...rows].map(listed),
			),
		);
	};

	const proc = (pid: number, ppid: number, ticks: number, argv: string) => {
		const d = path.join(procRoot(), String(pid));
		fs.mkdirSync(d, { recursive: true });
		fs.writeFileSync(
			path.join(d, "stat"),
			buildStatLine(pid, {
				comm: "x y",
				ppid,
				utime: ticks,
				startTicks: pid * 100,
			}),
		);
		fs.writeFileSync(
			path.join(d, "cmdline"),
			`${argv.split(" ").join("\0")}\0`,
		);
	};

	const writeTranscript = (lines: string[], dir = plan()) => {
		fs.mkdirSync(path.dirname(transcript(dir)), { recursive: true });
		fs.writeFileSync(transcript(dir), `${lines.join("\n")}\n`);
	};

	const jobState = (fields: object, dir = plan()) => {
		const d = path.join(dir, "jobs", SHORT);
		fs.mkdirSync(d, { recursive: true });
		fs.writeFileSync(
			path.join(d, "state.json"),
			JSON.stringify({
				sessionId: SID,
				linkScanPath: transcript(dir),
				...fields,
			}),
		);
	};

	const ghostJob = (
		intent: string,
		rows: Row[] = [holderRow({ pid: undefined })],
		now = Date.now(),
	) => {
		lists([
			...rows,
			{ sessionId: "neighbour", kind: "background", state: "working", pid: 7 },
		]);
		jobState({
			state: "working",
			detail: "starting…",
			intent,
			updatedAt: new Date(now - 60 * 60_000).toISOString(),
			respawnFlags: ["--advisor", "opus", "--model", "opus"],
		});
	};

	const fakeGh = (before: string[] = []) =>
		stubGhScript(
			sb.dir,
			[
				"#!/bin/sh",
				...before,
				`[ -f ${shellQuote(path.join(sb.dir, "gh-fails"))} ] && { echo "HTTP 502" >&2; exit 1; }`,
				'if [ "$1" = api ]; then',
				'  n=$(basename "$2"); st=open',
				`  [ -f ${shellQuote(`${sb.dir}/closed-`)}"$n" ] && st=closed`,
				`  printf '{"number":%s,"title":"Takeover","state":"%s","labels":[],"body":"b"}' "$n" "$st"`,
				"fi",
				"exit 0",
			].join("\n"),
		).env;

	const run = (
		sub: string,
		args: string[],
		{
			onStop = [],
			ghBefore = [],
		}: { onStop?: string[]; ghBefore?: string[] } = {},
	): Promise<Run> =>
		runInProcessAsync(SCRIPT, [sub, ...args, "--interval", "0.05"], {
			env: {
				...process.env,
				...fakeGh(ghBefore),
				CLAUDE_PROJECT_DIR: sb.repo,
				WFC_CLAUDE_BIN: fakeClaude(onStop),
				WFC_PROC: procRoot(),
			},
		});

	return {
		plan,
		procRoot,
		transcript,
		lists,
		proc,
		writeTranscript,
		jobState,
		ghostJob,
		run,
	};
}
