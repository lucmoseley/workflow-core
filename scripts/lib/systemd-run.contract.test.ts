// @vitest-environment node
/*
 * Holds lib/systemd-run-fake.ts to the real systemd-run (§G7): each case runs
 * a call the outliving launch makes (#4706) against the fake and the
 * machine's own, checking exit code and what reaches the command, never
 * values. Loosened, the launch's tests stay green on the fake while a systemd
 * release stops a scope's command seeing its argv or environment, or a probe
 * reads a manager that is not there.
 *
 * The real side runs where a user manager answers, never in CI (§G7 item 2).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MANAGER_TIMEOUT_MS, systemdRun } from "./systemd-bins.js";
import { writeSystemdRun } from "./systemd-run-fake";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "systemd-run-contract-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
const fake = writeSystemdRun(dir).bin;

const call = (bin: string, args: string[]) => {
	const r = spawnSync(bin, args, {
		encoding: "utf8",
		timeout: MANAGER_TIMEOUT_MS,
		env: { ...process.env, WFC_REPORT_OWNER: "contract-owner" },
	});
	return { status: r.status, stdout: r.stdout.trim() };
};

const CASES: [string, string[]][] = [
	["the probe", ["--user", "--scope", "--quiet", "--", "true"]],
	[
		"a capped scope's command, its argv and environment",
		[
			"--user",
			"--scope",
			"--quiet",
			"-p",
			"RuntimeMaxSec=60",
			"--",
			"sh",
			"-c",
			'echo "$0 $1 $WFC_REPORT_OWNER"',
			"x",
			"y",
		],
	],
];

const realAnswers =
	call(systemdRun(), ["--user", "--scope", "--quiet", "--", "true"]).status ===
	0;

describe("systemd-run-fake against the real systemd-run", () => {
	for (const [name, args] of CASES)
		it.runIf(realAnswers)(`agrees on ${name}`, () => {
			expect(call(fake, args)).toEqual(call(systemdRun(), args));
		});

	it("fails every call where no manager answers, as the real one does", () => {
		const none = writeSystemdRun(fs.mkdtempSync(path.join(dir, "none-")), {
			answers: false,
		}).bin;
		for (const [, args] of CASES) expect(call(none, args).status).not.toBe(0);
	});
});
