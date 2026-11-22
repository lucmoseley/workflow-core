// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeGuestDisk } from "./proc-fake";
import {
	appendCompactLog,
	readCompactLog,
	readFreeGB,
	readGuestDisk,
	readKernelRelease,
	readLastTrim,
	readTrimFixedAt,
} from "./wsl-disk-host.js";
import { WSL_KERNEL, writeOsrelease } from "./wsl-fake";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "wsl-disk-host-"));
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	fs.rmSync(dir, { recursive: true, force: true });
});

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

describe("readTrimFixedAt", () => {
	it("is the drop-in's mtime, or null where it is absent", () => {
		const dropIn = path.join(dir, "wsl.conf");
		vi.stubEnv("WFC_FSTRIM_DROPIN", dropIn);
		expect(readTrimFixedAt()).toBeNull();
		fs.writeFileSync(dropIn, "[Unit]\n");
		expect(readTrimFixedAt()).toBe(fs.statSync(dropIn).mtimeMs);
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

describe("readGuestDisk", () => {
	const diskBytes = 224 * 2 ** 30;
	const guestRootOnFakeDisk = () => {
		const proc = writeOsrelease(dir, WSL_KERNEL);
		writeGuestDisk(proc, diskBytes);
		vi.stubEnv("WFC_PROC", proc);
		vi.stubEnv("WFC_GUEST_ROOT", dir);
	};
	it("counts a pinned reading's used bytes as blocks less free, in block-size bytes", () => {
		guestRootOnFakeDisk();
		const real = fs.statfsSync;
		// #5570
		vi.spyOn(fs, "statfsSync").mockImplementation(((
			p: fs.PathLike,
			...rest: [never]
		) =>
			p === dir
				? { ...real(p, ...rest), bsize: 4096, blocks: 1000, bfree: 300 }
				: real(p, ...rest)) as typeof fs.statfsSync);
		expect(readGuestDisk()).toEqual({
			usedBytes: 700 * 4096,
			sizeBytes: diskBytes,
		});
	});
	it("reads a real root's used bytes, within its filesystem's size", () => {
		guestRootOnFakeDisk();
		const s = fs.statfsSync(dir);
		const disk = readGuestDisk();
		expect(disk).toEqual({
			usedBytes: expect.any(Number),
			sizeBytes: diskBytes,
		});
		const { usedBytes } = disk as { usedBytes: number };
		expect(usedBytes).toBeGreaterThanOrEqual(0);
		expect(usedBytes).toBeLessThanOrEqual(s.blocks * s.bsize);
		expect(usedBytes % s.bsize).toBe(0);
	});
	it("says why where /proc lacks the files or the root will not stat", () => {
		vi.stubEnv("WFC_PROC", writeOsrelease(dir, WSL_KERNEL));
		vi.stubEnv("WFC_GUEST_ROOT", dir);
		expect(readGuestDisk()).toEqual({
			why: expect.stringContaining("mountinfo: absent"),
		});
		vi.stubEnv("WFC_GUEST_ROOT", path.join(dir, "gone"));
		expect(readGuestDisk()).toEqual({ why: expect.stringContaining("ENOENT") });
	});
});
