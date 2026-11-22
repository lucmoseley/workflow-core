// @vitest-environment node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildKernelLine, writeJournalctl } from "./journalctl-fake";

let dir: string;
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("writeJournalctl", () => {
	it("serves both halves of a line holding a newline under its own time", () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "journalctl-fake-"));
		const ms = Date.parse("2026-11-01T10:00:00Z");
		const bin = writeJournalctl(dir, [buildKernelLine(ms, "first\nsecond")]);
		const read = (since: number) =>
			spawnSync(bin, ["--since", `@${since}`, "-o", "cat"], {
				encoding: "utf8",
			}).stdout;
		expect(read(ms / 1000 - 1)).toBe("first\nsecond\n");
		expect(read(ms / 1000 + 1)).toBe("");
	});
});
