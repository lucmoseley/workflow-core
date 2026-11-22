// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { commandPath } from "./lib/command-path-testkit";
import {
	cutGateFragment,
	expectFixtureSupplies,
	registerTempCleanup,
	stagedRepo,
	type TempRepo,
} from "./lib/precommit-gate-harness";
import {
	LIB,
	LIB_COMMANDS,
	writeCheckerDelegates,
} from "./lib/precommit-gate-testkit";

const temps = registerTempCleanup();

const ANCHOR = "check-swallowed-errors.js";
const CHECKER = "scripts/check-swallowed-errors.js";
const PY = "tools/fetch.py";
const SWALLOW =
	"#!/usr/bin/env python3\ndef fetch():\n    try:\n        return 1\n    except OSError:\n        return None\n";

function fixture(staged: Record<string, string>): TempRepo {
	const r = stagedRepo("swallowed-gate-", temps, {}, staged);
	writeCheckerDelegates(r.root, [path.basename(CHECKER)]);
	return r;
}

function pathWithoutPython(r: TempRepo): string {
	const bin = path.join(r.root, "..", `${path.basename(r.root)}-bin`);
	temps.push(bin);
	fs.mkdirSync(bin);
	for (const cmd of ["sh", "node", ...LIB_COMMANDS]) {
		const abs = commandPath(cmd);
		fs.symlinkSync(abs, path.join(bin, cmd));
	}
	return bin;
}

function runGate(r: TempRepo, Path = process.env.PATH ?? "") {
	const script = `exec 2>&1\n${LIB}\n${cutGateFragment(ANCHOR)}\n:\n`;
	try {
		const output = execFileSync("sh", ["-c", script], {
			cwd: r.root,
			encoding: "utf8",
			env: {
				...process.env,
				PATH: Path,
				WFC_PLUGIN_ROOT: "",
				CLAUDE_PROJECT_DIR: r.root,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { code: 0, output };
	} catch (e) {
		const err = e as { status?: number; stdout?: string; stderr?: string };
		return {
			code: err.status ?? 1,
			output: `${err.stdout ?? ""}${err.stderr ?? ""}`,
		};
	}
}

describe("the pre-commit swallowed-error gate", () => {
	it("is supplied what it invokes by this suite's fixture", () => {
		expectFixtureSupplies(ANCHOR, [CHECKER]);
	});

	it("does not run when the commit stages no Python file", () => {
		const { code, output } = runGate(fixture({ "notes.md": "# x\n" }));
		expect(output).toBe("");
		expect(code).toBe(0);
	});

	it("refuses a staged swallow, naming the rule", () => {
		const { code, output } = runGate(fixture({ [PY]: SWALLOW }));
		expect(output).toMatch(/tools\/fetch\.py:5/);
		expect(output).toMatch(/swallowed-error gate refused.*\n.*base §N5/);
		expect(code).toBe(1);
	});

	it("passes a staged except that hands its error to fail_open", () => {
		const reported = SWALLOW.replace(
			"except OSError:\n",
			"except OSError as e:\n        fail_open(e, 'none')\n",
		).replace("def fetch", "from fail_open import fail_open\ndef fetch");
		const { code, output } = runGate(fixture({ [PY]: reported }));
		expect(output).toMatch(/OK: no swallow introduced/);
		expect(code).toBe(0);
	});

	it("refuses rather than skips where python3 is missing", () => {
		const r = fixture({ [PY]: SWALLOW });
		const { code, output } = runGate(r, pathWithoutPython(r));
		expect(output).toMatch(/cannot run python3/);
		expect(output).toMatch(/install it: sudo apt install python3/);
		expect(output).toMatch(/refused this commit, its checker unable to run/);
		expect(output).not.toMatch(/hand it to fail_open/);
		expect(output).not.toMatch(/own Python paths/);
		expect(code).toBe(2);
	});
});
