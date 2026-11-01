// @vitest-environment node
/*
 * Holds ruff-testkit.ts's failing stub to the real ruff (§G7, #3825): each case
 * runs `ruff format --check` over a blob and an empty one, against both, and
 * checks exit and a stderr that says something. Loosened, check-format-staged's
 * stub cases stay green on CI while a new ruff exits differently on a broken
 * config or a syntax error, and the gate blames the wrong party.
 *
 * Red on the real side after a ruff upgrade: run the case's command by hand,
 * then fix readRuffToolFault in check-format-staged.js or the stub's body.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { REAL_RUFF, writeFailingRuffStub } from "./ruff-testkit";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruff-contract-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const CASES = [
	{
		name: "a config it cannot load",
		failure: "config",
		config: "not toml [[[\n",
		blob: "x = 1\n",
		emptyStatus: 2,
	},
	{
		name: "a blob with a syntax error",
		failure: "syntax",
		config: "line-length = 88\n",
		blob: "def (:\n",
		emptyStatus: 0,
	},
] as const;

function runFormatCheck(ruff: string, cwd: string, input: string) {
	return spawnSync(
		ruff,
		["format", "--check", "--stdin-filename", "a.py", "-"],
		{ cwd, input, encoding: "utf8" },
	);
}

describe.each([
	{ side: "the real ruff", real: true },
	{ side: "the stub", real: false },
])("$side", ({ side, real }) => {
	describe.skipIf(real && !REAL_RUFF).each(CASES)(
		"on $name",
		({ name, failure, config, blob, emptyStatus }) => {
			const cwd = path.join(dir, `${real}-${failure}`);
			const ruff = () => {
				if (real) return REAL_RUFF;
				const file = path.join(cwd, "ruff-stub");
				writeFailingRuffStub(file, failure);
				return file;
			};
			const setUp = () => {
				fs.mkdirSync(cwd, { recursive: true });
				fs.writeFileSync(path.join(cwd, "ruff.toml"), config);
				return ruff();
			};

			it(`${side} exits 2 with a reason on ${name}`, () => {
				const r = runFormatCheck(setUp(), cwd, blob);
				expect(r.status).toBe(2);
				expect(r.stderr.trim()).not.toBe("");
			});

			it(`${side} exits ${emptyStatus} on an empty blob`, () => {
				const r = runFormatCheck(setUp(), cwd, "");
				expect(r.status).toBe(emptyStatus);
				expect(r.stderr.trim() !== "").toBe(emptyStatus !== 0);
			});
		},
	);
});
