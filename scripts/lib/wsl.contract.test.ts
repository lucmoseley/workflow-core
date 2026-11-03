// @vitest-environment node
/*
 * Holds lib/wsl-fake.ts to the real wsl.exe (§G7, #4082): the production reader
 * runs over the fake and the machine's own, checking shape, never values.
 * Loosened, every check-wsl-currency.js test stays green on the fake while a
 * WSL release prints a version the check cannot read.
 *
 * The real side runs where wsl.exe is reachable, never in CI (§G7 item 2):
 * `wsl.exe --version` is a free read with no side effect.
 *
 * Red on the real side: run `wsl.exe --version` by hand, then fix the fake.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { writeWsl } from "./wsl-fake";

const { WSL_BUDGET_MS, WSL_EXE, readInstalled } =
	require("./wsl-version.js") as {
		WSL_BUDGET_MS: number;
		WSL_EXE: string;
		readInstalled: (
			bin: string,
			budgetMs: number,
		) => { version: string } | { why: string };
	};

const reachable = (() => {
	try {
		fs.accessSync(WSL_EXE, fs.constants.X_OK);
		return !process.env.CI;
	} catch {
		// Not WSL: the real side skips.
		return false;
	}
})();

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wsl-contract-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/* The reader's budget, plus a guessed margin for vitest's own start under load. */
const CASE_MS = WSL_BUDGET_MS + 5000;

const expectFourParts = (bin: string) =>
	expect(readInstalled(bin, WSL_BUDGET_MS)).toEqual({
		version: expect.stringMatching(/^\d+\.\d+\.\d+\.\d+$/),
	});

describe("wsl.exe --version", () => {
	it("the fake reads as a four-part version", () => {
		expectFourParts(writeWsl(dir, { version: "2.7.11.0" }));
	});

	it.runIf(reachable)(
		"the real one reads as a four-part version",
		{ timeout: CASE_MS },
		() => expectFourParts(WSL_EXE),
	);
});
