/*
 * The fake of a headless `claude -p` run (#4586), the one every suite's
 * `claude` stub execs for `-p`: a Node program that reads its argv against the
 * installed harness's options as recorded (scripts/fixtures/headless-run.json,
 * re-recorded by `node scripts/record-headless-run.js`), refusing an unknown
 * flag in the binary's words; runs the apiKeyHelper its `--settings` names, as
 * the binary does; appends what it saw to a log; then holds or ends, ending
 * on the recorded `result` row re-keyed to its session. The contract,
 * lib/headless-run.contract.test.ts, holds the fixture to the binary.
 */

import fs from "node:fs";
import path from "node:path";
import type { HelpOption } from "./headless-options.js";
import { readJsonl } from "./jsonl.js";
import { shellQuote } from "./sh-quote.js";
import { TEST_TIMEOUT_MS } from "./test-ceiling.js";

export const recorded: {
	harness: string;
	options: HelpOption[];
	result: Record<string, unknown>;
} = JSON.parse(
	fs.readFileSync(
		path.join(__dirname, "..", "fixtures", "headless-run.json"),
		"utf8",
	),
);

/** The recorded `result` row with `over` laid on it. */
export const buildResultRow = (over: Record<string, unknown> = {}) => ({
	...recorded.result,
	...over,
});

/**
 * `hold` runs on with a grandchild in its group, `stubborn` also ignores
 * SIGTERM, `orphan` leaves the grandchild behind and exits, `end` prints its
 * rows and exits 0.
 */
export type HeadlessMode = "hold" | "stubborn" | "orphan" | "end";

/** One run's record in the fake's log. */
export interface HeadlessCall {
	argv: string[];
	flags: Record<string, string | true>;
	prompt: string | null;
	sessionId: string | null;
	env: Record<string, string>;
	cwd: string;
	/** What the apiKeyHelper printed, null where none ran or it failed. */
	helped: string | null;
	grandchild: number | null;
	stdin: string;
}

/**
 * Write the fake program at `file`, logging to `log`. A held run ends itself
 * and its grandchild once `log`'s directory is gone or `holdMs` passes,
 * checked each second (a guess): the launch detaches it, so no case's
 * teardown is its parent (#2678 (the leaked fakes)). `rows` are the stream
 * `end` prints, each `session_id` set to the run's session.
 */
export function writeHeadlessFake(
	file: string,
	{
		log,
		mode = "hold",
		rows = [buildResultRow()],
		holdMs = 2 * TEST_TIMEOUT_MS,
	}: {
		log: string;
		mode?: HeadlessMode;
		rows?: Record<string, unknown>[];
		holdMs?: number;
	},
) {
	const program = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { execSync, spawn } = require("node:child_process");
const { readArgv } = require(${JSON.stringify(path.join(__dirname, "headless-options.js"))});
const LOG = ${JSON.stringify(log)};
const MODE = ${JSON.stringify(mode)};
const HOLD_MS = ${holdMs};
const argv = process.argv.slice(2);
const read = readArgv(${JSON.stringify(recorded.options)}, argv);
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
const grandchild = MODE === "end" ? null : spawn("sleep", [String(Math.ceil(HOLD_MS / 1000))], { stdio: "ignore" }).pid;
if (MODE === "stubborn") process.on("SIGTERM", () => {});
fs.appendFileSync(LOG, JSON.stringify({
	argv, flags: Object.fromEntries(read.flags), prompt: read.positionals.at(-1) ?? null,
	sessionId, env: process.env, cwd: process.cwd(), helped, grandchild,
	stdin: fs.readlinkSync("/proc/self/fd/0"),
}) + "\\n");
if (MODE === "end") {
	for (const row of ${JSON.stringify(rows)})
		process.stdout.write(JSON.stringify("session_id" in row ? { ...row, session_id: sessionId } : row) + "\\n");
	process.exit(0);
}
if (MODE === "orphan") process.exit(0);
const end = Date.now() + HOLD_MS;
setInterval(() => {
	if (Date.now() < end && fs.existsSync(path.dirname(LOG))) return;
	try {
		process.kill(grandchild, "SIGKILL");
	} catch {
		/* already gone */
	}
	process.exit(0);
}, 1000);
`;
	fs.writeFileSync(file, program, { mode: 0o755 });
	return file;
}

/** A bash `claude` stub's `-p` branch: runs the shell `onLaunch`, then
 * becomes the fake at `fake`. */
export const buildHeadlessBranch = (fake: string, onLaunch = "") =>
	`if [ "$1" = "-p" ]; then ${onLaunch} exec ${shellQuote(fake)} "$@"; fi`;

/** Every run the fake logged to `log`, in order; none where it never ran. */
export const readHeadlessCalls = (log: string) =>
	(readJsonl(log)?.rows ?? []) as unknown as HeadlessCall[];
