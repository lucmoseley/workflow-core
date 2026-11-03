// @vitest-environment node
/*
 * The wsl.exe reader (#4082). Loosened, a wedged wsl.exe hangs `npm run
 * status`, or a failed read loses its reason.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { writeWsl } from "./wsl-fake";

const { readInstalled } = require("./wsl-version.js") as {
	readInstalled: (
		bin: string,
		budgetMs: number,
	) => { version: string } | { why: string };
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wsl-version-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const read = (behaviour: Parameters<typeof writeWsl>[1], budgetMs = 10_000) =>
	readInstalled(writeWsl(dir, behaviour), budgetMs);

describe("readInstalled", () => {
	it("reads the version off the UTF-16LE print", () => {
		expect(read({ version: "2.7.11.0" })).toEqual({ version: "2.7.11.0" });
	});

	it("says so on a print with no WSL version line", () => {
		expect(read({ noVersionLine: true })).toEqual({
			why: "printed no version line",
		});
	});

	it("gives a non-zero exit's code and what it said", () => {
		expect(read({ exits: 1, says: "Wsl/Service/E_ACCESSDENIED" })).toEqual({
			why: "exited 1: Wsl/Service/E_ACCESSDENIED",
		});
	});

	it("gives a binary that will not start its error", () => {
		const r = readInstalled(path.join(dir, "no-wsl.exe"), 10_000);
		expect(r).toEqual({ why: expect.stringContaining("ENOENT") });
	});

	it("gives up on a wedged wsl.exe at its budget", () => {
		expect(read({ hangs: true }, 200)).toEqual({
			why: "no answer within 0.2 s",
		});
	});
});
