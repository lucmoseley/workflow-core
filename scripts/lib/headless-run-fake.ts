import fs from "node:fs";
import path from "node:path";
import type { HelpOption } from "./headless-options.js";
import { readJsonl } from "./jsonl.js";
import { shellQuote } from "./sh-quote.js";
import { TEST_TIMEOUT_MS } from "./test-ceiling.js";

export const recorded: {
	harness: string;
	options: HelpOption[];
	hidden: HelpOption[];
	result: Record<string, unknown>;
	interrupt: {
		controlResponse: { response: Record<string, unknown> };
		result: Record<string, unknown>;
	};
} = JSON.parse(
	fs.readFileSync(
		path.join(__dirname, "..", "fixtures", "headless-run.json"),
		"utf8",
	),
);

export const buildResultRow = (over: Record<string, unknown> = {}) => ({
	...recorded.result,
	...over,
});

export type HeadlessMode = "hold" | "stubborn" | "orphan" | "end" | "stream";

export type StreamEvent =
	| { stdin: Record<string, unknown> }
	| { signal: string }
	| { stdinClosed: true };

export interface HeadlessCall {
	argv: string[];
	flags: Record<string, string | true>;
	prompt: string | null;
	sessionId: string | null;
	env: Record<string, string>;
	cwd: string;
	helped: string | null;
	grandchild: number | null;
	stdin: string;
	stdinText: string | null;
}

// guess, #2678
const HOLD_POLL_MS = 1000;

export function writeHeadlessFake(
	file: string,
	{
		log,
		mode = "hold",
		rows = [buildResultRow()],
		text,
		exit = 0,
		// guess, #4586
		holdMs = 2 * TEST_TIMEOUT_MS,
		turns = [],
		interruptRows = [recorded.interrupt.result],
		ignoreInterrupt = false,
		ignoreTerm = false,
		events,
	}: {
		log: string;
		mode?: HeadlessMode;
		rows?: Record<string, unknown>[];
		text?: string;
		exit?: number;
		holdMs?: number;
		turns?: Record<string, unknown>[][];
		interruptRows?: Record<string, unknown>[];
		ignoreInterrupt?: boolean;
		ignoreTerm?: boolean;
		events?: string;
	},
) {
	const program = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { execSync, spawn } = require("node:child_process");
const { parseArgv } = require(${JSON.stringify(path.join(__dirname, "headless-argv-fake.js"))});
const LOG = ${JSON.stringify(log)};
const MODE = ${JSON.stringify(mode)};
const HOLD_MS = ${holdMs};
const argv = process.argv.slice(2);
const read = parseArgv(${JSON.stringify([...recorded.options, ...recorded.hidden])}, argv);
if ("error" in read) {
	process.stderr.write(read.error + "\\n");
	process.exit(1);
}
const flag = (name) => {
	const v = read.flags.get(name);
	return typeof v === "string" ? v : null;
};
let helped = null;
try {
	const raw = flag("--settings");
	const settings = JSON.parse(raw.trim().startsWith("{") ? raw : fs.readFileSync(raw, "utf8"));
	helped = execSync(settings.apiKeyHelper, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
} catch {
	/* no settings, no helper in them, or a helper that failed */
}
const sessionId = flag("--session-id") ?? flag("--resume");
const grandchild = MODE === "end" || MODE === "stream" ? null : spawn("sleep", [String(Math.ceil(HOLD_MS / 1000))], { stdio: "ignore" }).pid;
if (MODE === "stubborn") process.on("SIGTERM", () => {});
fs.appendFileSync(LOG, JSON.stringify({
	argv, flags: Object.fromEntries(read.flags), prompt: read.positionals.at(-1) ?? null,
	sessionId, env: process.env, cwd: process.cwd(), helped, grandchild,
	stdin: fs.readlinkSync("/proc/self/fd/0"),
	stdinText: fs.fstatSync(0).isFile() ? fs.readFileSync(0, "utf8") : null,
}) + "\\n");
if (MODE === "end") {
	const text = ${JSON.stringify(text ?? null)};
	if (text !== null) process.stdout.write(text);
	else
		for (const row of ${JSON.stringify(rows)})
			process.stdout.write(JSON.stringify("session_id" in row ? { ...row, session_id: sessionId } : row) + "\\n");
	process.exit(${exit});
}
if (MODE === "orphan") process.exit(0);
if (MODE === "stream") {
	const EVENTS = ${JSON.stringify(events ?? null)};
	const TURNS = ${JSON.stringify(turns)};
	const event = (e) => EVENTS && fs.appendFileSync(EVENTS, JSON.stringify(e) + "\\n");
	const emit = (rows) => {
		for (const row of rows)
			process.stdout.write(JSON.stringify("session_id" in row ? { ...row, session_id: sessionId } : row) + "\\n");
	};
	for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"])
		process.on(sig, () => {
			event({ signal: sig });
			if (sig === "SIGTERM" && ${ignoreTerm}) return;
			process.removeAllListeners(sig);
			process.kill(process.pid, sig);
		});
	let turn = 0;
	const lines = require("node:readline").createInterface({ input: process.stdin });
	lines.on("line", (line) => {
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}
		event({ stdin: message });
		if (message.type === "user")
			emit(TURNS[turn++] ?? [${JSON.stringify(buildResultRow())}]);
		else if (message.type === "control_request" && message.request?.subtype === "interrupt" && !${ignoreInterrupt})
			emit([{ ...${JSON.stringify(recorded.interrupt.controlResponse)}, response: { ...${JSON.stringify(recorded.interrupt.controlResponse.response)}, request_id: message.request_id } }, ...${JSON.stringify(interruptRows)}]);
	});
	lines.on("close", () => {
		event({ stdinClosed: true });
		process.exit(${exit});
	});
}
const end = Date.now() + HOLD_MS;
setInterval(() => {
	if (Date.now() < end && fs.existsSync(path.dirname(LOG))) return;
	try {
		if (grandchild) process.kill(grandchild, "SIGKILL");
	} catch {
		/* already gone */
	}
	process.exit(0);
}, ${HOLD_POLL_MS});
`;
	fs.writeFileSync(file, program, { mode: 0o755 });
	return file;
}

export const buildHeadlessBranch = (fake: string, onLaunch = "") =>
	`if [ "$1" = "-p" ]; then ${onLaunch} exec ${shellQuote(fake)} "$@"; fi`;

export const readStreamEvents = (events: string) =>
	(readJsonl(events)?.rows ?? []) as unknown as StreamEvent[];

export const readHeadlessCalls = (log: string) =>
	(readJsonl(log)?.rows ?? []) as unknown as HeadlessCall[];
