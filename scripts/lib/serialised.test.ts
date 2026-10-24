// @vitest-environment node

/*
 * scripts/lib/serialised.sh — the machine-wide lock every shellcheck run takes
 * (#2579, #2627). Its wait and fallback limbs are exercised through the
 * pre-commit gate (precommit-shellcheck-gate.test.ts) and check:sh:changed
 * (check-sh-changed.test.ts); this file pins what neither does: that all three
 * callers name the SAME lock, and that the runner passes its command's status
 * through.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { registerTempCleanup } from "./precommit-gate-harness";
import { ROOT } from "./precommit-gate-testkit";

const temps = registerTempCleanup();

const RUNNER = path.join(ROOT, "scripts", "lib", "serialised.sh");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("every shellcheck caller takes the one lock", () => {
	const callers: [string, string][] = [
		["check:sh", JSON.parse(read("package.json")).scripts["check:sh"]],
		["check:sh:changed", read("scripts/check-sh-changed.sh")],
		["the pre-commit gate", read(".husky/pre-commit")],
	];
	it.each(callers)(
		"%s runs shellcheck through serialised.sh's `shellcheck` lock",
		(_, text) => {
			expect(text).toMatch(
				/serialised\.sh"? \S+ shellcheck\s+(\\\n\s*)?shellcheck -x/,
			);
		},
	);
});

describe("the runner", () => {
	it("passes the command's own exit status through, saying nothing uncontended", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "serialised-"));
		temps.push(tmp);
		const r = spawnSync(
			"sh",
			[RUNNER, "caller", "probe", "sh", "-c", "exit 3"],
			{
				encoding: "utf8",
				env: { ...process.env, TMPDIR: tmp },
			},
		);
		expect(r.status).toBe(3);
		expect(r.stderr).toBe("");
	});
});
