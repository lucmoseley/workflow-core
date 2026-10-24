/*
 * rescue-testkit.ts — shared fixtures for the `rescue-sessions.js` probe and takeover suites
 * (#647): the fake `claude` oracle, the plan listings it serves, the fake
 * `/proc`, and the holder's transcript. Each suite still writes its own holder
 * and its own assertions.
 *
 * The fake `claude` counts its `agents` calls per config dir and, on a plan's
 * second call — the probe's second sample — runs that plan's `between.sh`. A
 * `fail` file makes the listing fail. On `stop` it runs the caller's `onStop`
 * lines, fails where `stop-fails` exists, swaps in `agents-after-stop.json`,
 * then runs `on-stop.sh`.
 *
 * The fake `gh` serves ticket <n> open, or closed where `closed-<n>` exists in
 * the sandbox; `gh-fails` there fails every call.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Sandbox } from "./arbiter-testkit";
import { stubGhScript } from "./gh-stub";

export const SCRIPT = path.join(__dirname, "..", "rescue-sessions.js");
export const SID = "abcd1234-0000-4000-8000-000000000001";
export const SHORT = SID.slice(0, 8);
export const PID = 4242;

/** The exit codes rescue-sessions.js documents above PROBE_EXIT, restated
 * rather than read from it: the skill branches on these numbers, so a
 * renumbering must fail here. */
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

/** The lines a session blocked at its seat's limit carries (#2128), or at a
 * model's own (#2380). */
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

/** A `/proc/<pid>/stat` line; `ticks` is utime, the only CPU field set. */
export const statLine = (pid: number, ppid: number, ticks: number) =>
	`${pid} (x y) S ${ppid} 0 0 0 0 0 0 0 0 0 ${ticks} 0 0 0 0 0 0 0 ${pid}00\n`;

const assistant = (content: object[]) =>
	JSON.stringify({ type: "assistant", message: { content } });
export const said = (text: string) => assistant([{ type: "text", text }]);

/** freshSandbox's setUp: a tracker for the scripts' `gh` reads to name. */
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
	/** A plan's config dir; `.claude` is the sandbox's own, `sb.home`. */
	const plan = (name = ".claude") => path.join(sb.dir, "home", name);
	const procRoot = () => path.join(sb.dir, "proc");
	const transcript = (dir = plan()) =>
		path.join(dir, "projects", "p", `${SID}.jsonl`);

	const fakeClaude = (onStop: string[] = []) => {
		const bin = path.join(sb.dir, "claude");
		fs.writeFileSync(
			bin,
			[
				"#!/bin/sh",
				'd="$CLAUDE_CONFIG_DIR"',
				'if [ "$1" = stop ]; then',
				...onStop.map((l) => `  ${l}`),
				'  [ -f "$d/stop-fails" ] && { echo "no such job" >&2; exit 1; }',
				'  [ -f "$d/agents-after-stop.json" ] && cp "$d/agents-after-stop.json" "$d/agents.json"',
				'  [ -f "$d/on-stop.sh" ] && sh "$d/on-stop.sh"',
				"  echo stopped; exit 0",
				"fi",
				'n=$(cat "$d/oracle-calls" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$d/oracle-calls"',
				'[ -f "$d/fail" ] && { echo down >&2; exit 1; }',
				'[ "$n" = 2 ] && [ -f "$d/between.sh" ] && sh "$d/between.sh"',
				'cat "$d/agents.json"',
			].join("\n"),
		);
		fs.chmodSync(bin, 0o755);
		return bin;
	};

	/** What `dir` lists; this session ("sandbox") always, for the self-test. */
	const lists = (rows: Row[], dir = plan(), file = "agents.json") => {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, file),
			JSON.stringify([{ sessionId: "sandbox", state: "working" }, ...rows]),
		);
	};

	/** A shell line the fake `claude` runs between the probe's two samples. */
	const between = (sh: string, dir = plan()) =>
		fs.writeFileSync(path.join(dir, "between.sh"), `${sh}\n`);

	const proc = (pid: number, ppid: number, ticks: number, argv: string) => {
		const d = path.join(procRoot(), String(pid));
		fs.mkdirSync(d, { recursive: true });
		fs.writeFileSync(path.join(d, "stat"), statLine(pid, ppid, ticks));
		fs.writeFileSync(
			path.join(d, "cmdline"),
			`${argv.split(" ").join("\0")}\0`,
		);
	};

	const writeTranscript = (lines: string[], dir = plan()) => {
		fs.mkdirSync(path.dirname(transcript(dir)), { recursive: true });
		fs.writeFileSync(transcript(dir), `${lines.join("\n")}\n`);
	};

	/** The holder's `state.json` on `dir`, pointing at its transcript there. */
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

	/**
	 * A job that never started (#1989): its record still `working` /
	 * `starting…` an hour on — past GHOST_AFTER_MINUTES' 30 — no transcript, and `rows` listed beside a live
	 * neighbour — whose pid keeps the listing's shape readable.
	 */
	const ghostJob = (
		intent: string,
		rows: Row[] = [holderRow({ pid: undefined })],
	) => {
		lists([
			...rows,
			{ sessionId: "neighbour", kind: "background", state: "working", pid: 7 },
		]);
		jobState({
			state: "working",
			detail: "starting…",
			intent,
			updatedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
			respawnFlags: ["--advisor", "opus", "--model", "opus"],
		});
	};

	/** How many times the fake oracle has listed `dir`. */
	const oracleCalls = (dir = plan()) =>
		Number(fs.readFileSync(path.join(dir, "oracle-calls"), "utf8"));

	/** `before`: shell lines run ahead of the serving, e.g. to log a call. */
	const fakeGh = (before: string[] = []) =>
		stubGhScript(
			sb.dir,
			[
				"#!/bin/sh",
				...before,
				`[ -f '${path.join(sb.dir, "gh-fails")}' ] && { echo "HTTP 502" >&2; exit 1; }`,
				'if [ "$1" = api ]; then',
				'  n=$(basename "$2"); st=open',
				`  [ -f '${sb.dir}/closed-'"$n" ] && st=closed`,
				`  printf '{"number":%s,"title":"Takeover","state":"%s","labels":[],"body":"b"}' "$n" "$st"`,
				"fi",
				"exit 0",
			].join("\n"),
		).env;

	/**
	 * `rescue-sessions.js <sub> …args` at a 0.05 s probe interval, against the
	 * fake oracle, /proc and `gh`. SPAWNED, not runInProcess (§X3): the script
	 * exports no `main` to await.
	 */
	const run = (
		sub: string,
		args: string[],
		{
			onStop = [],
			ghBefore = [],
		}: { onStop?: string[]; ghBefore?: string[] } = {},
	): Promise<Run> =>
		new Promise((resolve) => {
			execFile(
				process.execPath,
				[SCRIPT, sub, ...args, "--interval", "0.05"],
				{
					env: {
						...process.env,
						...fakeGh(ghBefore),
						CLAUDE_PROJECT_DIR: sb.repo,
						WFC_CLAUDE_BIN: fakeClaude(onStop),
						WFC_PROC: procRoot(),
					},
					encoding: "utf8",
				},
				(err, stdout, stderr) =>
					resolve({ status: err ? Number(err.code) : 0, stdout, stderr }),
			);
		});

	return {
		plan,
		procRoot,
		transcript,
		lists,
		between,
		proc,
		writeTranscript,
		jobState,
		ghostJob,
		oracleCalls,
		run,
	};
}
