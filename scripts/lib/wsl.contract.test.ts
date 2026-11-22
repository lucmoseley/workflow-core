// @vitest-environment node

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
		return false;
	}
})();

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wsl-contract-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

// #4082 guess
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
