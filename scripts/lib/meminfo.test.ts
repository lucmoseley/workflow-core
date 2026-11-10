// @vitest-environment node
/*
 * The memory-hold add-back (#4862). The declaration is
 * read through `WFC_MEMORY_HOLD` and the holder is this test's own process,
 * so the liveness check crosses the real /proc. Breaking it costs the trial
 * its fixed launches: admission either feels the hold or keeps adding back a
 * hold that has gone.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readProcStartOf } from "./arbiter-proc.js";
import { readMeminfoKb } from "./meminfo.js";
import { buildMeminfo } from "./meminfo-fake";

const AVAILABLE_KB = 2000 * 1024;
let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "meminfo-hold-"));
	fs.writeFileSync(
		path.join(dir, "meminfo"),
		buildMeminfo({ availableMb: 2000, swapTotalMb: 2048, swapFreeMb: 2048 }),
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
const start = () => readProcStartOf(process.pid);

describe("the memory-hold add-back (#4862)", () => {
	it("adds nothing where no hold is declared", () => {
		vi.stubEnv("WFC_MEMORY_HOLD", "");
		expect(available()).toBe(AVAILABLE_KB);
	});

	it("adds a live holder's MB back", () => {
		vi.stubEnv("WFC_MEMORY_HOLD", `668 ${process.pid} ${start()}\n`);
		expect(available()).toBe(AVAILABLE_KB + 668 * 1024);
	});

	it("adds nothing where the pid now carries another start token", () => {
		vi.stubEnv("WFC_MEMORY_HOLD", `668 ${process.pid} ${Number(start()) + 1}`);
		expect(available()).toBe(AVAILABLE_KB);
	});

	it("adds nothing for a holder no longer alive", () => {
		// 2**22 is Linux's PID_MAX_LIMIT, which no pid reaches.
		vi.stubEnv("WFC_MEMORY_HOLD", `668 ${2 ** 22} 1`);
		expect(available()).toBe(AVAILABLE_KB);
	});

	it("adds nothing for a declaration missing its start token", () => {
		vi.stubEnv("WFC_MEMORY_HOLD", `668 ${process.pid}`);
		expect(available()).toBe(AVAILABLE_KB);
	});
});
