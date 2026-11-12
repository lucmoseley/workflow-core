// @vitest-environment node
/*
 * The wsl-disk-compaction.js program (#5044) at its process boundary: its
 * exit codes on a bad command line, off WSL and with no log, each read
 * crossed through the WFC_PROC and WFC_WSL_COMPACT_LOG seams, so none reaches
 * the hold, the trim or the task. Loosened, the timer's journal and exit stop
 * saying why a night's run did nothing. The run's order is
 * lib/wsl-disk.test.ts's.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";
import { WSL_KERNEL, writeOsrelease } from "./lib/wsl-fake";

const SCRIPT = path.join(__dirname, "wsl-disk-compaction.js");

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "wsl-disk-run-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const run = (args: string[], kernel = WSL_KERNEL) =>
	runInProcess(SCRIPT, args, {
		env: {
			...process.env,
			WFC_PROC: writeOsrelease(dir, kernel),
			WFC_WSL_COMPACT_LOG: path.join(dir, "absent.log"),
		},
	});

describe("wsl-disk-compaction", () => {
	it("exits 2 on a bad command line, printing the usage", () => {
		const r = run(["run", "--later"]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("wsl-disk-compaction.js run [--now]");
	});

	it("exits 0 off WSL, saying there is nothing to compact", () => {
		const r = run(["run", "--now"], "6.8.0-45-generic");
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("not WSL; nothing to compact.");
	});

	it("exits 1 with no log, naming the installer", () => {
		const r = run(["run"]);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("bash scripts/install-interop-watchdog.sh");
	});
});
