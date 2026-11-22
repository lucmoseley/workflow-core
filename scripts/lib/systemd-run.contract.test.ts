// @vitest-environment node

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
