// @vitest-environment node
/* #5497 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startHolder, stopHolder, windowsHolders } from "../away-load.js";
import { runInProcessAsync } from "./run-in-process.js";
import { writeWindowsTasks } from "./windows-tasks-fake";

const AWAY_LOAD = path.join(__dirname, "..", "away-load.js");
const WIN = "/mnt/c/Windows/System32";
const REAL_TESTLIMIT = "/mnt/c/diag/testlimit/Testlimit64.exe";
/* guess: past the time the real Testlimit takes to touch 64 MB (#5497) */
const HOLD_MS = 3000;
/* guess: the hold and Windows' end of it on a loaded machine (#5497) */
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

async function until(what: string, test: () => boolean) {
	const deadline = Date.now() + REAL_CASE_MS;
	while (!test()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 200));
	}
}

describe.each([
	{
		side: "the fakes",
		bins: () => writeWindowsTasks(path.join(dir, "fake")),
		present: () => true,
	},
	{ side: "the real binaries", bins: renamedRealBins, present: hasReal },
])("$side", ({ bins, present }) => {
	it(
		"Testlimit holds with stdin closed, tasklist counts it, and its proxy's end ends it",
		async ({ skip }) => {
			if (!present()) return skip("no Testlimit64.exe or Windows here");
			const p = bins();
			expect(windowsHolders(p)).toBe(0);
			const exits: (number | null)[] = [];
			const holder = startHolder(p, 64, (_h, code) => exits.push(code));
			/* #5497 */
			await new Promise((r) => setTimeout(r, HOLD_MS));
			expect(exits).toEqual([]);
			expect(windowsHolders(p)).toBe(1);
			stopHolder(holder);
			await until("Windows' end of the holder", () => windowsHolders(p) === 0);
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
