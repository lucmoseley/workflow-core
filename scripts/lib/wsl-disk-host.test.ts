// @vitest-environment node
/*
 * lib/wsl-disk-host.js (#5044): the reads behind the compaction's verdicts,
 * each crossed for real in a temp directory through its §N7 seam. Loosened,
 * an unread log or timer reads as absent and the status check stays quiet.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	appendCompactLog,
	readCompactLog,
	readFreeGB,
	readKernelRelease,
	readLastTrim,
} from "./wsl-disk-host.js";
import { WSL_KERNEL, writeOsrelease } from "./wsl-fake";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "wsl-disk-host-"));
});
afterEach(() => {
	vi.unstubAllEnvs();
	fs.rmSync(dir, { recursive: true, force: true });
});

/** A systemctl printing `says` and exiting `code`, at WFC_SYSTEMCTL. */
function stubSystemctl(says: string, code = 0) {
	const file = path.join(dir, "systemctl");
	fs.writeFileSync(file, `#!/bin/sh\necho '${says}'\nexit ${code}\n`, {
		mode: 0o755,
	});
	vi.stubEnv("WFC_SYSTEMCTL", file);
}

describe("readLastTrim", () => {
	it("reads systemctl's UTC stamp as epoch ms", () => {
		stubSystemctl("Mon 2026-12-14 00:10:00 UTC");
		expect(readLastTrim()).toBe(Date.parse("2026-12-14T00:10:00Z"));
	});
	it("asks systemctl for UTC, whatever this process's zone", () => {
		vi.stubEnv("TZ", "Europe/Paris");
		const file = path.join(dir, "systemctl");
		fs.writeFileSync(file, '#!/bin/sh\necho "Mon 2026-12-14 00:10:00 $TZ"\n', {
			mode: 0o755,
		});
		vi.stubEnv("WFC_SYSTEMCTL", file);
		expect(readLastTrim()).toBe(Date.parse("2026-12-14T00:10:00Z"));
	});
	it("is null where the timer never fired", () => {
		stubSystemctl("");
		expect(readLastTrim()).toBeNull();
		stubSystemctl("n/a");
		expect(readLastTrim()).toBeNull();
	});
	it("says why on a stamp it cannot read, or a failing systemctl", () => {
		stubSystemctl("Mon 2026-12-14 00:10:00 CET");
		expect(readLastTrim()).toEqual({
			why: "unread timestamp: Mon 2026-12-14 00:10:00 CET",
		});
		stubSystemctl("Failed to connect to bus", 1);
		expect(readLastTrim()).toEqual({
			why: expect.stringContaining("exited 1"),
		});
	});
});

describe("readCompactLog and appendCompactLog", () => {
	it("is absent before the first line, then reads what was appended in CRLF", () => {
		const log = path.join(dir, "wsl-compact.log");
		vi.stubEnv("WFC_WSL_COMPACT_LOG", log);
		expect(readCompactLog()).toEqual({ state: "absent" });
		appendCompactLog(log, "2026-12-20T02:00:00 watched");
		expect(readCompactLog()).toEqual({
			state: "read",
			path: log,
			text: "2026-12-20T02:00:00 watched\r\n",
		});
	});
	it("is unreadable, never absent, on a log it cannot read", () => {
		vi.stubEnv("WFC_WSL_COMPACT_LOG", dir);
		expect(readCompactLog()).toMatchObject({ state: "unreadable" });
	});
});

describe("readKernelRelease and readFreeGB", () => {
	it("reads the kernel release at WFC_PROC", () => {
		vi.stubEnv("WFC_PROC", writeOsrelease(dir, WSL_KERNEL));
		expect(readKernelRelease()).toContain("microsoft");
	});
	it("reads free space on a mount, and says why on a missing one", () => {
		vi.stubEnv("WFC_WIN_C", dir);
		expect(readFreeGB()).toBeGreaterThan(0);
		vi.stubEnv("WFC_WIN_C", path.join(dir, "gone"));
		expect(readFreeGB()).toEqual({ why: expect.stringContaining("ENOENT") });
	});
});
