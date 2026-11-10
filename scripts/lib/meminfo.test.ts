// @vitest-environment node
/*
 * The memory-hold add-back (#4862): a declared hold whose holder is alive
 * is added back to MemAvailable; a dead holder, or a malformed declaration,
 * adds nothing.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readMeminfoKb } from "./meminfo.js";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "meminfo-hold-"));
	fs.writeFileSync(
		path.join(dir, "meminfo"),
		"MemTotal: 10000000 kB\nMemAvailable: 2048000 kB\nSwapTotal: 2097152 kB\nSwapFree: 2097152 kB\n",
	);
	vi.stubEnv("WFC_MEMINFO", path.join(dir, "meminfo"));
});
afterEach(() => {
	vi.unstubAllEnvs();
	fs.rmSync(dir, { recursive: true, force: true });
});

const available = () => {
	const read = readMeminfoKb();
	if (!read.ok) throw new Error(read.error);
	return read.availableKb;
};

describe("the memory-hold add-back (#4862)", () => {
	it("adds nothing where no hold is declared", () => {
		vi.stubEnv("WFC_MEMORY_HOLD", "");
		expect(available()).toBe(2_048_000);
	});

	it("adds a live holder's MB back", () => {
		vi.stubEnv("WFC_MEMORY_HOLD", `668 ${process.pid}\n`);
		expect(available()).toBe(2_048_000 + 668 * 1024);
	});

	it("adds nothing for a holder no longer alive", () => {
		// 2**22 is Linux's PID_MAX_LIMIT, which no pid reaches.
		vi.stubEnv("WFC_MEMORY_HOLD", `668 ${2 ** 22}`);
		expect(available()).toBe(2_048_000);
	});

	it("adds nothing for a declaration missing its pid", () => {
		vi.stubEnv("WFC_MEMORY_HOLD", "668");
		expect(available()).toBe(2_048_000);
	});
});
