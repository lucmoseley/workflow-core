// @vitest-environment node
/*
 * The check-wsl-disk.js program (#5044), its reads crossed through the
 * WFC_PROC, WFC_WSL_COMPACT_LOG, WFC_WIN_C, WFC_SYSTEMCTL and WFC_NOW seams,
 * so each outcome is seen as `npm run status` sees it. Loosened, a missed
 * compaction or an idle fstrim.timer reads as clean. The judging itself is
 * lib/wsl-disk.test.ts's.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";
import { WSL_KERNEL, writeOsrelease } from "./lib/wsl-fake";

const SCRIPT = path.join(__dirname, "check-wsl-disk.js");
const NOW = "2026-12-20T12:00:00";
const RECENT_TRIM = "Mon 2026-12-14 00:10:00 UTC";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "wsl-disk-check-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A systemctl answering `show` with `says`. Its path, for WFC_SYSTEMCTL. */
function writeSystemctl(says: string) {
	const file = path.join(dir, "systemctl");
	fs.writeFileSync(file, `#!/bin/sh\necho '${says}'\n`, { mode: 0o755 });
	return file;
}

function run({
	kernel = WSL_KERNEL,
	log,
	trim = RECENT_TRIM,
}: {
	kernel?: string;
	log?: string;
	trim?: string;
}) {
	const logPath = path.join(dir, "wsl-compact.log");
	if (log !== undefined) fs.writeFileSync(logPath, log);
	return runInProcess(SCRIPT, ["--json"], {
		env: {
			...process.env,
			GITHUB_ACTIONS: "",
			WFC_NOW: NOW,
			WFC_PROC: writeOsrelease(dir, kernel),
			WFC_WSL_COMPACT_LOG:
				log === undefined ? path.join(dir, "absent.log") : logPath,
			// A temp dir has room: C: free never warns here.
			WFC_WIN_C: dir,
			WFC_SYSTEMCTL: writeSystemctl(trim),
			WFC_FSTRIM_DROPIN: path.join(dir, "absent.conf"),
		},
	});
}
const envelope = (r: { stdout: string }) => JSON.parse(r.stdout);
const OK =
	"2026-12-17T02:30:00 ok before_gb=120 after_gb=110 c_free_gb=200\r\n";

describe("check-wsl-disk", () => {
	it("SKIPs off WSL", () => {
		const r = run({ kernel: "6.8.0-45-generic" });
		expect(r.status).toBe(0);
		expect(envelope(r).outcome).toBe("SKIP");
	});

	it("is OK on a recent success and a recent trim, naming the sizes", () => {
		const r = run({ log: OK });
		expect(r.status).toBe(0);
		expect(envelope(r).outcome).toBe("OK");
		expect(r.stdout).toContain("last compaction 2026-12-17 (120 to 110 GB)");
	});

	it("WARNs, exit 0, on a stale success, naming the remedy", () => {
		const r = run({ log: "2026-11-10T02:30:00 ok after_gb=110\r\n" });
		expect(r.status).toBe(0);
		expect(envelope(r).outcome).toBe("WARN");
		expect(r.stdout).toContain("succeeded 40 days ago");
		expect(r.stdout).toContain("wsl-disk-compaction.js run --now");
	});

	it("WARNs on a missing log as not installed", () => {
		const r = run({});
		expect(envelope(r).outcome).toBe("WARN");
		expect(r.stdout).toContain("bash scripts/install-interop-watchdog.sh");
	});

	it("WARNs where fstrim.timer has never fired and its fix is absent, naming its installer", () => {
		const r = run({ log: OK, trim: "" });
		expect(envelope(r).outcome).toBe("WARN");
		expect(r.stdout).toContain("its WSL fix is not installed");
		expect(r.stdout).toContain("sudo bash scripts/install-fstrim-wsl.sh");
	});
});
