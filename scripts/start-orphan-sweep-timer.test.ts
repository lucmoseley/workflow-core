// @vitest-environment node
/*
 * Pins start-orphan-sweep-timer.js against stand-in `systemctl` and
 * `systemd-run` at WFC_SYSTEMCTL and WFC_SYSTEMD_RUN (#4342): it starts the
 * reaper's timer where none runs, leaves one running a live script alone,
 * replaces one whose script is gone, and stays green where no user manager
 * answers. Each stand-in logs its argv, one call a line.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.join(__dirname, "start-orphan-sweep-timer.js");

let dir: string;
let calls: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "orphan-sweep-timer-"));
	calls = path.join(dir, "calls");
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/** A stand-in binary that logs its argv and runs `body`. */
function standIn(name: string, body: string) {
	const file = path.join(dir, name);
	fs.writeFileSync(
		file,
		`#!/bin/sh\nprintf '%s ' ${name} "$@" >> ${calls}; echo >> ${calls}\n${body}\n`,
		{ mode: 0o755 },
	);
	return file;
}

/** `systemctl` answering a timer `active` or not, its service running `exec`. */
function systemctl(active: boolean, exec = "") {
	return standIn(
		"systemctl",
		`case "$2" in
  is-active) echo ${active ? "active" : "inactive"}; exit ${active ? 0 : 3} ;;
  show) echo '${exec}' ;;
esac`,
	);
}

function run(env: Record<string, string>) {
	return runInProcess(SCRIPT, [], { env: { ...process.env, ...env } });
}

const logged = () =>
	fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n") : [];

describe("start-orphan-sweep-timer", () => {
	it("starts the reaper's timer where none runs, persisting its report from the host root", () => {
		const res = run({
			WFC_SYSTEMCTL: systemctl(false),
			WFC_SYSTEMD_RUN: standIn("systemd-run", "exit 0"),
		});

		expect(res.status).toBe(0);
		const start = logged().find((l) => l.startsWith("systemd-run"));
		expect(start).toContain("--unit=wfc-orphan-sweep ");
		expect(start).toContain("--on-active=5min ");
		expect(start).toContain("--on-unit-inactive=5min ");
		expect(start).toContain("--setenv=WFC_NOTIFY_PERSIST=1 ");
		expect(start).toMatch(/--working-directory=\/\S+ /);
		expect(start).toMatch(
			/ -- \S+node\S* \S+\/scripts\/reap-orphan-hooks\.js --notify/,
		);
		const named = /(\S+\/reap-orphan-hooks\.js)/.exec(start ?? "")?.[1] ?? "";
		expect(fs.existsSync(named)).toBe(true);
	});

	it("leaves a timer alone whose script still exists", () => {
		const live = path.join(__dirname, "reap-orphan-hooks.js");
		const res = run({
			WFC_SYSTEMCTL: systemctl(
				true,
				`{ path=/usr/bin/node ; argv[]=/usr/bin/node ${live} --notify ; ignore_errors=no }`,
			),
			WFC_SYSTEMD_RUN: standIn("systemd-run", "exit 0"),
		});

		expect(res.status).toBe(0);
		expect(logged().some((l) => l.startsWith("systemd-run"))).toBe(false);
		expect(logged().some((l) => l.includes(" stop "))).toBe(false);
	});

	it("replaces a timer whose script is gone, a pruned worktree's", () => {
		const res = run({
			WFC_SYSTEMCTL: systemctl(
				true,
				"{ path=/usr/bin/node ; argv[]=/usr/bin/node /gone/scripts/reap-orphan-hooks.js --notify ; ignore_errors=no }",
			),
			WFC_SYSTEMD_RUN: standIn("systemd-run", "exit 0"),
		});

		expect(res.status).toBe(0);
		const order = logged().map((l) => l.split(" ").slice(0, 3).join(" "));
		expect(order).toEqual([
			"systemctl --user is-active",
			"systemctl --user show",
			"systemctl --user stop",
			"systemctl --user reset-failed",
			expect.stringMatching(/^systemd-run --user /),
		]);
	});

	it("stays green where no user manager answers, and where a concurrent start won", () => {
		for (const refusal of [
			"Failed to connect to bus: No medium found",
			"Unit wfc-orphan-sweep.timer was already loaded or has a fragment file.",
		]) {
			fs.rmSync(calls, { force: true });
			const res = run({
				WFC_SYSTEMCTL: systemctl(false),
				WFC_SYSTEMD_RUN: standIn(
					"systemd-run",
					`echo '${refusal}' >&2; exit 1`,
				),
			});
			expect(res.status).toBe(0);
		}
	});

	it("exits 1, saying why, on any other refusal", () => {
		const res = run({
			WFC_SYSTEMCTL: systemctl(false),
			WFC_SYSTEMD_RUN: standIn(
				"systemd-run",
				"echo 'Invalid property' >&2; exit 1",
			),
		});

		expect(res.status).toBe(1);
		expect(res.stderr).toContain("wfc-orphan-sweep.timer not started");
		expect(res.stderr).toContain("Invalid property");
	});
});
