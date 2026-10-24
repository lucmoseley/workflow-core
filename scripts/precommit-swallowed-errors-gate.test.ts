// @vitest-environment node

/*
 * The pre-commit swallowed-error gate (#1830), exercised as the shell it is.
 *
 * How the checker judges is scripts/check-swallowed-errors.test.ts's; this
 * suite owns the shell: when it runs, that a refusal stops the commit, and
 * that a missing python3 refuses rather than skips. Loosen a case and an
 * uncited swallow lands unrefused in every repo the plugin runs in.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
// A shebang makes it a program by base §0's default map, the fixture
// declaring no `pythonRoutes`.
const SWALLOW =
	"#!/usr/bin/env python3\ndef fetch():\n    try:\n        return 1\n    except OSError:\n        return None\n";

function fixture(staged: Record<string, string>): TempRepo {
	const r = stagedRepo("swallowed-gate-", temps, {}, staged);
	writeCheckerDelegates(r.root, [path.basename(CHECKER)]);
	return r;
}

/**
 * A PATH holding `sh`, `node` and the library's commands, and no python3, so
 * the checker's spawn of it fails as on a machine without one.
 */
function pathWithoutPython(r: TempRepo): string {
	const bin = path.join(r.root, "..", `${path.basename(r.root)}-bin`);
	temps.push(bin);
	fs.mkdirSync(bin);
	for (const cmd of ["sh", "node", ...LIB_COMMANDS]) {
		const abs = execFileSync("sh", ["-c", `command -v ${cmd}`], {
			encoding: "utf8",
		}).trim();
		fs.symlinkSync(abs, path.join(bin, cmd));
	}
	return bin;
}

function runGate(r: TempRepo, Path = process.env.PATH ?? "") {
	// The trailing no-op stands in for the rest of the hook, so the fragment's
	// own exit is not the checker's and the `|| { … exit 1; }` block is pinned.
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

	it("refuses a staged uncited swallow, naming the rule", () => {
		const { code, output } = runGate(fixture({ [PY]: SWALLOW }));
		expect(output).toMatch(/tools\/fetch\.py:5/);
		expect(output).toMatch(/swallowed-error gate refused.*\n.*base §N5/);
		expect(code).toBe(1);
	});

	it("passes a staged swallow that cites a ticket", () => {
		const cited = SWALLOW.replace("None\n", "None  # host gone (#12)\n");
		const { code, output } = runGate(fixture({ [PY]: cited }));
		expect(output).toMatch(/OK: no uncited swallow introduced/);
		expect(code).toBe(0);
	});

	it("refuses rather than skips where python3 is missing", () => {
		const r = fixture({ [PY]: SWALLOW });
		const { code, output } = runGate(r, pathWithoutPython(r));
		expect(output).toMatch(/cannot run python3/);
		expect(code).toBe(1);
	});
});
