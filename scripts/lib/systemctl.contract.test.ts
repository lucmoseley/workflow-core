// @vitest-environment node
/*
 * Holds lib/systemctl-fake.ts to the real systemctl (§G7, #3970): each case
 * runs a call the fake's callers make against the fake and the machine's own,
 * checking shape and exit code, never values. Loosened, every caller's test
 * stays green on the fake while a systemd release prints a read-back the
 * installers misread, a state session-scope.js or start-orphan-sweep-timer.js
 * reads wrongly, or a failure their callers miss.
 *
 * The real side runs where the manager it asks answers, never in CI (§G7 item
 * 2): `show`, `is-enabled` and `is-active` are free reads, and a `restart` of a
 * unit that does not exist changes nothing.
 *
 * Red on the real side after a systemd upgrade: fix the fake or its
 * caller's reader.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { scriptInExecStart } from "../start-orphan-sweep-timer.js";
import { writeSystemctl } from "./systemctl-fake";
import { systemctl } from "./systemd-bins.js";

/* install-user-manager-restart.js's read-back properties. */
const PROPERTIES = ["Restart", "OOMScoreAdjust", "StartLimitIntervalUSec"];
const MANAGER = `user@${os.userInfo().uid}.service`;
const UNKNOWN = "wfc-contract-no-such.service";

const run = (bin: string, args: string[]) => {
	const r = spawnSync(bin, args, { encoding: "utf8", timeout: 5000 });
	if (r.error) throw r.error;
	return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
};

function realUnits(list: string[]): string[] {
	const r = run(systemctl(), ["--user", ...list, "--no-legend", "--plain"]);
	return r.status === 0
		? r.stdout
				.split("\n")
				.map((l) => l.trim().split(/\s+/)[0] ?? "")
				.filter(Boolean)
		: [];
}

function realExecUnit(active: string[]): string | null {
	return (
		active.find((unit) =>
			run(systemctl(), [
				"--user",
				"show",
				unit,
				"-p",
				"ExecStart",
				"--value",
			]).stdout.includes("argv[]="),
		) ?? null
	);
}

/** Null where the manager `scope` reaches answers, else why the real side
 * skips. */
function realSkip(scope: string[], manager: string): string | null {
	if (process.env.CI) return "CI: the live manager is the founder's machine's";
	try {
		return run(systemctl(), [...scope, "show-environment"]).status === 0
			? null
			: `no ${manager} manager answers`;
	} catch (e) {
		return `no systemctl here: ${(e as Error).message}`;
	}
}

function readRealUnits(): Units | string {
	const skip = realSkip(["--user"], "user");
	if (skip) return skip;
	const active = realUnits(["list-units", "--type=service", "--state=active"]);
	return {
		enabled: realUnits(["list-unit-files", "--state=enabled"])[0] ?? null,
		disabled: realUnits(["list-unit-files", "--state=disabled"])[0] ?? null,
		active: active[0] ?? null,
		exec: realExecUnit(active),
	};
}

/** `read`'s answer, read at its first call: the real side's reads take a
 * spawn each, and every case asks. */
function once<T>(read: () => T): () => T {
	let value: { v: T } | undefined;
	return () => {
		value ??= { v: read() };
		return value.v;
	};
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "systemctl-contract-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const FAKE_CGROUP = "/user.slice/a.service";
const fake = writeSystemctl(dir, {
	units: {
		[MANAGER]: {
			properties: {
				Restart: "no",
				OOMScoreAdjust: "0",
				StartLimitIntervalUSec: "10s",
			},
		},
		"a.service": {
			enabled: "enabled",
			active: "active",
			properties: {
				ControlGroup: FAKE_CGROUP,
				ExecStart:
					"{ path=/usr/bin/node ; argv[]=/usr/bin/node /y/scripts/reap-orphan-hooks.js --notify ; ignore_errors=no }",
			},
		},
		"b.timer": { enabled: "disabled" },
	},
	fails: {
		restart: { exit: 5, says: `Failed to restart ${UNKNOWN}: not found.` },
	},
});

interface Units {
	/** A unit enabled, one disabled, one active and one with an ExecStart
	 * record, where the side has one. */
	enabled: string | null;
	disabled: string | null;
	active: string | null;
	exec: string | null;
}

interface Side {
	bin: string;
	units: () => Units | string;
	systemSkip: () => string | null;
}

const SIDES: [string, Side][] = [
	[
		"the fake",
		{
			bin: fake,
			units: () => ({
				enabled: "a.service",
				disabled: "b.timer",
				active: "a.service",
				exec: "a.service",
			}),
			systemSkip: () => null,
		},
	],
	[
		"the real systemctl",
		{
			bin: systemctl(),
			units: once(readRealUnits),
			systemSkip: once(() => realSkip([], "system")),
		},
	],
];

describe.each(SIDES)("%s", (_name, { bin, units, systemSkip }) => {
	const userUnits = (skip: (why: string) => never): Units => {
		const u = units();
		return typeof u === "string" ? skip(u) : u;
	};

	it("show prints each asked property once as Name=value, exiting 0", ({
		skip,
	}) => {
		const why = systemSkip();
		if (why) return skip(why);
		const r = run(bin, ["show", MANAGER, `--property=${PROPERTIES.join(",")}`]);
		expect(r.status).toBe(0);
		const lines = r.stdout.split("\n");
		expect(lines.map((l) => l.split("=")[0]).sort()).toEqual(
			[...PROPERTIES].sort(),
		);
		for (const l of lines) expect(l).toMatch(/^\w+=\S*$/);
	});

	it("show -p --value prints the bare value, and nothing for an unknown unit", ({
		skip,
	}) => {
		const { active } = userUnits(skip);
		if (!active) return skip("no active user unit here");
		const value = (unit: string) =>
			run(bin, ["--user", "show", "-p", "ControlGroup", "--value", unit]);
		const known = value(active);
		expect(known.status).toBe(0);
		expect(known.stdout).toMatch(/^\/\S+$/);
		expect(value(UNKNOWN)).toMatchObject({ status: 0, stdout: "" });
	});

	it("is-enabled prints enabled, exiting 0", ({ skip }) => {
		const { enabled } = userUnits(skip);
		if (!enabled) return skip("no enabled user unit here");
		expect(run(bin, ["--user", "is-enabled", enabled])).toMatchObject({
			status: 0,
			stdout: "enabled",
		});
	});

	it("is-enabled prints disabled, exiting 1", ({ skip }) => {
		const { disabled } = userUnits(skip);
		if (!disabled) return skip("no disabled user unit here");
		expect(run(bin, ["--user", "is-enabled", disabled])).toMatchObject({
			status: 1,
			stdout: "disabled",
		});
	});

	it("is-enabled prints not-found for an unknown unit, exiting 4", ({
		skip,
	}) => {
		userUnits(skip);
		expect(run(bin, ["--user", "is-enabled", UNKNOWN])).toMatchObject({
			status: 4,
			stdout: "not-found",
		});
	});

	it("is-active prints active, exiting 0, and --quiet prints nothing", ({
		skip,
	}) => {
		const { active } = userUnits(skip);
		if (!active) return skip("no active user unit here");
		expect(run(bin, ["--user", "is-active", active])).toMatchObject({
			status: 0,
			stdout: "active",
		});
		expect(run(bin, ["--user", "is-active", "--quiet", active])).toMatchObject({
			status: 0,
			stdout: "",
		});
	});

	it("is-active prints inactive for an unknown unit, exiting non-zero", ({
		skip,
	}) => {
		userUnits(skip);
		const r = run(bin, ["--user", "is-active", UNKNOWN]);
		expect(r.stdout).toBe("inactive");
		expect(r.status).not.toBe(0);
	});

	it("a failed restart exits non-zero, saying why on stderr alone", ({
		skip,
	}) => {
		userUnits(skip);
		const r = run(bin, ["--user", "restart", UNKNOWN]);
		expect(r.status).not.toBe(0);
		expect(r.stdout).toBe("");
		expect(r.stderr).toContain(UNKNOWN);
	});

	it("show -p ExecStart --value prints the record start-orphan-sweep-timer.js reads", ({
		skip,
	}) => {
		const { exec } = userUnits(skip);
		if (!exec) return skip("no user service with an ExecStart here");
		const record = run(bin, [
			"--user",
			"show",
			exec,
			"-p",
			"ExecStart",
			"--value",
		]).stdout;
		const argv0 = /argv\[\]=(\S+) /.exec(record)?.[1] ?? "";
		expect(argv0).not.toBe("");
		const planted = record.replace(
			/argv\[\]=[^;]*;/,
			`argv[]=${argv0} /x/scripts/reap-orphan-hooks.js ;`,
		);
		expect(scriptInExecStart(planted)).toBe("/x/scripts/reap-orphan-hooks.js");
	});
});
