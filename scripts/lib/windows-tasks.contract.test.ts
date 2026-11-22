// @vitest-environment node
/* #5497 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	awayLoadEnv,
	awayLoadEvents,
	epoch,
	memwatchReading,
} from "./away-load-fixture";
import { keptSpawn } from "./kept-spawn.js";
import { runInProcessAsync } from "./run-in-process.js";
import { writeWindowsTasks } from "./windows-tasks-fake";

const AWAY_LOAD = path.join(__dirname, "..", "away-load.js");
const WIN = "/mnt/c/Windows/System32";
const REAL_TESTLIMIT = "/mnt/c/diag/testlimit/Testlimit64.exe";
/* guess: past the time a real Testlimit takes to start and touch 128 MB (#5497) */
const REAL_HOLD_MS = 3000;
/* guess: past the fake's shell start (#5497) */
const FAKE_HOLD_MS = 200;
/* guess: a tenth of a second between reads of the runner's log (#5497) */
const POLL_MS = 100;
/* guess: one chunk of away-load.js's 64 MB, the least a stray need hold (#5497) */
const STRAY_ARGS = ["-accepteula", "-d", "64", "-c", "1"];
/* guess: three holds and Windows' end of them on a loaded machine (#5497) */
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(what: string, test: () => boolean) {
	const deadline = Date.now() + REAL_CASE_MS;
	while (!test()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(POLL_MS);
	}
}

describe.each([
	{
		side: "the fakes",
		bins: () => writeWindowsTasks(path.join(dir, "fake")),
		present: () => true,
		holdMs: FAKE_HOLD_MS,
	},
	{
		side: "the real binaries",
		bins: renamedRealBins,
		present: hasReal,
		holdMs: REAL_HOLD_MS,
	},
])("$side", ({ bins, present, holdMs }) => {
	it(
		"a holder stays with stdin closed, its proxy's end ends it, tasklist counts a stray, and taskkill ends both",
		async ({ skip }) => {
			if (!present()) return skip("no Testlimit64.exe or Windows here");
			const p = bins();
			const env = awayLoadEnv(dir, p);
			const events = () => awayLoadEvents(env.WFC_AWAY_LOAD_LOG);
			const kinds = () => events().map((e) => e.event);
			const image = path.basename(p.testlimit);
			const onWindows = () =>
				spawnSync(
					p.tasklist,
					["/FI", `IMAGENAME eq ${image}`, "/FO", "CSV", "/NH"],
					{ encoding: "utf8" },
				)
					.stdout.split("\n")
					.filter((l) => l.startsWith(`"${image}"`)).length;
			const at = epoch();
			const read = (n: number, availMb: number) =>
				fs.writeFileSync(
					env.MEMWATCH_WIN_OUT,
					memwatchReading(at + n, availMb, 900),
				);
			read(0, 891);
			const runner = keptSpawn("signal").spawn("node", [AWAY_LOAD, "run"], {
				env: { ...process.env, ...env },
				stdio: "ignore",
			});
			const ran = new Promise((r) => runner.on("exit", r));
			let stray: ChildProcess | null = null;
			try {
				await until("the hold", () => kinds().includes("hold"));
				/* #5497 */
				await sleep(holdMs);
				expect(kinds()).toEqual(["start", "hold"]);
				expect(onWindows()).toBe(1);

				read(1, 700);
				await until("the release", () => kinds().includes("release"));
				await until(
					"Windows' end of the released holder",
					() => onWindows() === 0,
				);

				read(2, 891);
				await until("the second hold", () => kinds().length === 4);
				stray = spawn(p.testlimit, STRAY_ARGS, { stdio: "ignore" });
				const strayEnded = new Promise((r) => stray?.on("exit", r));
				await until("the stray on Windows", () => onWindows() === 2);
				read(3, 850);
				await until("the strays", () => kinds().includes("strays"));
				await strayEnded;
				expect(kinds()).toEqual(["start", "hold", "release", "hold", "strays"]);
				expect(events()[2]).toMatchObject({ dropMb: 128, heldMb: 0 });
				expect(events()[4]).toMatchObject({ onWindows: 2, holders: 1 });
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
