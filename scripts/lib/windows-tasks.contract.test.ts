// @vitest-environment node
/* #5497 */
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { keptSpawn } from "./kept-spawn.js";
import { runInProcessAsync } from "./run-in-process.js";
import { writeWindowsTasks } from "./windows-tasks-fake";

const AWAY_LOAD = path.join(__dirname, "..", "away-load.js");
const WIN = "/mnt/c/Windows/System32";
const REAL_TESTLIMIT = "/mnt/c/diag/testlimit/Testlimit64.exe";
/* guess: past the time a real Testlimit takes to start and touch 128 MB (#5497) */
const REAL_HOLD_MS = 3000;
/* guess: two holds and Windows' end of them on a loaded machine (#5497) */
const REAL_CASE_MS = 30_000;

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "windows-tasks-contract-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const hasReal = () =>
	!process.env.GITHUB_ACTIONS &&
	[REAL_TESTLIMIT, `${WIN}/taskkill.exe`, `${WIN}/tasklist.exe`].every((f) =>
		fs.existsSync(f),
	);

function renamedRealBins() {
	const testlimit = path.join(dir, `TlContract${process.pid}.exe`);
	fs.copyFileSync(REAL_TESTLIMIT, testlimit);
	fs.chmodSync(testlimit, 0o755);
	return {
		testlimit,
		taskkill: `${WIN}/taskkill.exe`,
		tasklist: `${WIN}/tasklist.exe`,
	};
}

const epoch = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(what: string, test: () => boolean) {
	const deadline = Date.now() + REAL_CASE_MS;
	while (!test()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(100);
	}
}

describe.each([
	{
		side: "the fakes",
		bins: () => writeWindowsTasks(path.join(dir, "fake")),
		present: () => true,
		holdMs: 200,
	},
	{
		side: "the real binaries",
		bins: renamedRealBins,
		present: hasReal,
		holdMs: REAL_HOLD_MS,
	},
])("$side", ({ bins, present, holdMs }) => {
	it(
		"a holder stays with stdin closed, tasklist counts a stray beside it, and taskkill ends both",
		async ({ skip }) => {
			if (!present()) return skip("no Testlimit64.exe or Windows here");
			const p = bins();
			const log = path.join(dir, "away-load.jsonl");
			const reading = path.join(dir, "memwatch-win");
			const events = () =>
				fs.existsSync(log)
					? fs
							.readFileSync(log, "utf8")
							.split("\n")
							.filter(Boolean)
							.map((l) => JSON.parse(l))
					: [];
			fs.writeFileSync(reading, `${epoch()} 891 1 2 60 100 900\n`);
			const runner = keptSpawn("signal").spawn("node", [AWAY_LOAD, "run"], {
				env: {
					...process.env,
					WFC_AWAY_LOAD_STATE_DIR: path.join(dir, "state"),
					WFC_AWAY_LOAD_LOG: log,
					WFC_AWAY_LOAD_POLL_MS: "100",
					MEMWATCH_WIN_OUT: reading,
					MEMWATCH_MINUTE_LOG: path.join(dir, "minute.jsonl"),
					WFC_TESTLIMIT: p.testlimit,
					WFC_TASKKILL: p.taskkill,
					WFC_TASKLIST: p.tasklist,
				},
				stdio: "ignore",
			});
			const ran = new Promise((r) => runner.on("exit", r));
			let stray: ChildProcess | null = null;
			try {
				await until("the hold", () => events().some((e) => e.event === "hold"));
				stray = spawn(p.testlimit, ["-accepteula", "-d", "64", "-c", "1"], {
					stdio: "ignore",
				});
				const strayEnded = new Promise((r) => stray?.on("exit", r));
				/* #5497 */
				await sleep(holdMs);
				fs.writeFileSync(reading, `${epoch() + 1} 850 1 2 60 100 900\n`);
				await until("the strays", () =>
					events().some((e) => e.event === "strays"),
				);
				await strayEnded;
				expect(events().map((e) => e.event)).toEqual([
					"start",
					"hold",
					"strays",
				]);
				expect(events()[1]).toMatchObject({ addMb: 128 });
				expect(events()[2]).toMatchObject({ onWindows: 2, holders: 1 });
			} finally {
				runner.kill("SIGTERM");
				await ran;
				stray?.kill("SIGKILL");
			}
		},
		REAL_CASE_MS,
	);

	it(
		"taskkill's refusal of an image with no process reads as swept",
		async ({ skip }) => {
			if (!present()) return skip("no Testlimit64.exe or Windows here");
			const p = bins();
			const r = await runInProcessAsync(AWAY_LOAD, ["sweep"], {
				env: {
					...process.env,
					WFC_TESTLIMIT: p.testlimit,
					WFC_TASKKILL: p.taskkill,
				},
			});
			expect(r).toMatchObject({ status: 0, stderr: "" });
		},
		REAL_CASE_MS,
	);
});
