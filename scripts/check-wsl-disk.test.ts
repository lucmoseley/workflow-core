// @vitest-environment node
/*
 * The check-wsl-disk.js program (#5044), its reads crossed through the
 * WFC_PROC, WFC_WSL_COMPACT_LOG and WFC_WIN_C seams, so each outcome is seen as
 * `npm run status` sees it. Loosened, a missed compaction reads as clean. The
 * judging itself is lib/wsl-disk.test.ts's.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";
import { WSL_KERNEL, writeOsrelease } from "./lib/wsl-fake";

const SCRIPT = path.join(__dirname, "check-wsl-disk.js");

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "wsl-disk-check-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function stamp(daysAgo: number) {
	const d = new Date(Date.now() - daysAgo * 86_400_000);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function run({ kernel = WSL_KERNEL, log }: { kernel?: string; log?: string }) {
	const logPath = path.join(dir, "wsl-compact.log");
	if (log !== undefined) fs.writeFileSync(logPath, log);
	return runInProcess(SCRIPT, ["--json"], {
		env: {
			...process.env,
			GITHUB_ACTIONS: "",
			WFC_PROC: writeOsrelease(dir, kernel),
			WFC_WSL_COMPACT_LOG:
				log === undefined ? path.join(dir, "absent.log") : logPath,
			// A temp dir has room: C: free never warns here.
			WFC_WIN_C: dir,
		},
	});
}
const envelope = (r: { stdout: string }) => JSON.parse(r.stdout);

describe("check-wsl-disk", () => {
	it("SKIPs off WSL", () => {
		expect(envelope(run({ kernel: "6.8.0-45-generic" })).outcome).toBe("SKIP");
	});

	it("is OK on a recent success", () => {
		const r = run({
			log: `${stamp(3)} ok before_gb=120 after_gb=110 c_free_gb=200\r\n`,
		});
		expect(r.status).toBe(0);
		expect(envelope(r).outcome).toBe("OK");
	});

	it("WARNs, exit 0, on a stale success", () => {
		const r = run({ log: `${stamp(40)} ok after_gb=110\r\n` });
		expect(r.status).toBe(0);
		expect(envelope(r).outcome).toBe("WARN");
		expect(JSON.stringify(envelope(r).warnings)).toContain("COMPACT-STALE");
	});

	it("WARNs on an unreadable log path as not installed", () => {
		const r = run({});
		expect(JSON.stringify(envelope(r).warnings)).toContain(
			"COMPACT-UNINSTALLED",
		);
	});
});
