// @vitest-environment node
/*
 * The wsl.exe reader (#4082), which must read a format and a bridge the core
 * never sees. Loosened, a wedged wsl.exe hangs `npm run status`, a one-call
 * stall reads as an unread machine, or a failed read loses its reason.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { writeWsl, wslCallLogPath } from "./wsl-fake";

const { readInstalled } = require("./wsl-version.js") as {
	readInstalled: (
		bin: string,
		budgetMs: number,
	) => { version: string } | { why: string };
};

/* Far over a bash stub's start under load, a guess. */
const AMPLE_BUDGET_MS = 10_000;

/* Far under the fake's hang, so every try must expire. */
const WEDGED_BUDGET_MS = 200;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wsl-version-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const read = (
	behaviour: Parameters<typeof writeWsl>[1],
	budgetMs = AMPLE_BUDGET_MS,
) => readInstalled(writeWsl(dir, behaviour), budgetMs);

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
		const r = readInstalled(path.join(dir, "no-wsl.exe"), AMPLE_BUDGET_MS);
		expect(r).toEqual({ why: expect.stringContaining("ENOENT") });
	});

	it("reads through a stall that fails one call", () => {
		const stalling = path.join(dir, "stalling");
		const bin = writeWsl(stalling, { stallsOnce: true, version: "3.0.3.0" });
		expect(readInstalled(bin, AMPLE_BUDGET_MS)).toEqual({ version: "3.0.3.0" });
		expect(fs.readFileSync(wslCallLogPath(stalling), "utf8")).toBe(
			"--version\n--version\n",
		);
	});

	it("does not retry a print with no version line", () => {
		const noLine = path.join(dir, "no-line");
		readInstalled(writeWsl(noLine, { noVersionLine: true }), AMPLE_BUDGET_MS);
		expect(fs.readFileSync(wslCallLogPath(noLine), "utf8")).toBe("--version\n");
	});

	it("gives up on a wedged wsl.exe after three tries at its budget", () => {
		// §X9: crosses the real clock — the spawn's own timeout is under test.
		const wedged = path.join(dir, "wedged");
		const bin = writeWsl(wedged, { hangs: true });
		expect(readInstalled(bin, WEDGED_BUDGET_MS)).toEqual({
			why: "no answer within 0.2 s",
		});
		expect(fs.readFileSync(wslCallLogPath(wedged), "utf8")).toBe(
			"--version\n--version\n--version\n",
		);
	});
});
