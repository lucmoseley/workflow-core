// @vitest-environment node
/*
 * Holds lib/systemctl-fake.ts to the real systemctl (§G7, #3970): each case
 * runs the reads the installers and refill-loop.js make against the fake and
 * the machine's own, checking shape and exit code, never values. Loosened,
 * every installer test stays green on the fake while a systemd release prints
 * a read-back the installers misread as a failed install, or a passed one.
 *
 * The real side runs where a systemd manager answers, never in CI (§G7 item
 * 2): `show` and `is-enabled` are free reads with no side effect.
 *
 * Red on the real side after a systemd upgrade: run the case's command by
 * hand, then fix the fake or the installer's reader.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { writeSystemctl } from "./systemctl-fake";

const { systemctl } = require("./systemd-bins.js") as {
	systemctl: () => string;
};

/* install-user-manager-restart.js's read-back properties. */
const PROPERTIES = ["Restart", "OOMScoreAdjust", "StartLimitIntervalUSec"];
const MANAGER = `user@${os.userInfo().uid}.service`;
const UNKNOWN = "wfc-contract-no-such.service";

const run = (bin: string, args: string[]) => {
	const r = spawnSync(bin, args, { encoding: "utf8", timeout: 5000 });
	if (r.error) throw r.error;
	return { status: r.status, stdout: r.stdout.trim() };
};

/** A user unit file in `state`, or null where this manager has none. */
function realUnitIn(state: string): string | null {
	const r = run(systemctl(), [
		"--user",
		"list-unit-files",
		"--no-legend",
		"--plain",
		`--state=${state}`,
	]);
	return r.status === 0 ? (r.stdout.split(/\s+/)[0] ?? null) || null : null;
}

const realSkip = (() => {
	if (process.env.CI) return "CI: the live manager is the founder's machine's";
	try {
		return run(systemctl(), ["--user", "show-environment"]).status === 0
			? null
			: "no user manager answers";
	} catch (e) {
		return `no systemctl here: ${(e as Error).message}`;
	}
})();

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "systemctl-contract-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const fake = writeSystemctl(dir, {
	unitStates: { "a.service": "enabled", "b.timer": "disabled" },
	properties: {
		Restart: "no",
		OOMScoreAdjust: "0",
		StartLimitIntervalUSec: "10s",
	},
});

interface Side {
	bin: string;
	enabled: string | null;
	disabled: string | null;
}

const sides = (): [string, () => Side | string][] => [
	[
		"the fake",
		() => ({ bin: fake, enabled: "a.service", disabled: "b.timer" }),
	],
	[
		"the real systemctl",
		() =>
			realSkip ?? {
				bin: systemctl(),
				enabled: realUnitIn("enabled"),
				disabled: realUnitIn("disabled"),
			},
	],
];

describe.each(sides())("%s", (_name, side) => {
	const get = (skip: (why: string) => void): Side => {
		const s = side();
		if (typeof s === "string") {
			skip(s);
			throw new Error("unreachable");
		}
		return s;
	};

	it("show prints each asked property once as Name=value, exiting 0", ({
		skip,
	}) => {
		const { bin } = get(skip);
		const r = run(bin, ["show", MANAGER, `--property=${PROPERTIES.join(",")}`]);
		expect(r.status).toBe(0);
		const lines = r.stdout.split("\n");
		expect(lines.map((l) => l.split("=")[0]).sort()).toEqual(
			[...PROPERTIES].sort(),
		);
		for (const l of lines) expect(l).toMatch(/^\w+=\S*$/);
	});

	it("is-enabled prints enabled, exiting 0", ({ skip }) => {
		const { bin, enabled } = get(skip);
		if (!enabled) return skip("no enabled user unit here");
		expect(run(bin, ["--user", "is-enabled", enabled])).toEqual({
			status: 0,
			stdout: "enabled",
		});
	});

	it("is-enabled prints disabled, exiting 1", ({ skip }) => {
		const { bin, disabled } = get(skip);
		if (!disabled) return skip("no disabled user unit here");
		expect(run(bin, ["--user", "is-enabled", disabled])).toEqual({
			status: 1,
			stdout: "disabled",
		});
	});

	it("is-enabled prints not-found for an unknown unit, exiting 4", ({
		skip,
	}) => {
		const { bin } = get(skip);
		expect(run(bin, ["--user", "is-enabled", UNKNOWN])).toEqual({
			status: 4,
			stdout: "not-found",
		});
	});
});
