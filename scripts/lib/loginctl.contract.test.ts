// @vitest-environment node
/*
 * Holds lib/loginctl-fake.ts to the real loginctl (§G7, #4594): each case runs
 * a read install-refill-boot-unit.js makes against the fake and the machine's
 * own, checking shape and exit code, never values. Loosened, the installer's
 * tests stay green on the fake while a systemd release prints a Linger
 * read-back the installer misreads, or a failed read it misses.
 *
 * The real side runs where logind answers, never in CI (§G7 item 2):
 * `enable-linger` changes state, so no case runs it.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { writeLoginctl } from "./loginctl-fake";
import { loginctl, MANAGER_TIMEOUT_MS } from "./systemd-bins.js";

const USER = os.userInfo().username;
const UNKNOWN = "wfc-contract-no-such-user";

const run = (bin: string, args: string[]) => {
	const r = spawnSync(bin, args, {
		encoding: "utf8",
		timeout: MANAGER_TIMEOUT_MS,
	});
	if (r.error) throw r.error;
	return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
};

function realSkip(): string | null {
	if (process.env.CI) return "CI: the live logind is the founder's machine's";
	try {
		return run(loginctl(), ["show-user", USER, "--property=Name"]).status === 0
			? null
			: "logind does not know this user here";
	} catch (e) {
		return `no loginctl here: ${(e as Error).message}`;
	}
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loginctl-contract-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const SIDES: [string, string, () => string | null][] = [
	["the fake", writeLoginctl(dir), () => null],
	["the real loginctl", loginctl(), realSkip],
];

describe.each(SIDES)("%s", (_name, bin, skipWhy) => {
	it("show-user --property=Linger prints Linger=yes or Linger=no alone, exiting 0", ({
		skip,
	}) => {
		const why = skipWhy();
		if (why) return skip(why);
		const r = run(bin, ["show-user", USER, "--property=Linger"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/^Linger=(yes|no)$/);
	});

	it("show-user of an unknown user exits non-zero, naming it on stderr alone", ({
		skip,
	}) => {
		const why = skipWhy();
		if (why) return skip(why);
		const r = run(bin, ["show-user", UNKNOWN, "--property=Linger"]);
		expect(r.status).not.toBe(0);
		expect(r.stdout).toBe("");
		expect(r.stderr).toContain(UNKNOWN);
	});
});
