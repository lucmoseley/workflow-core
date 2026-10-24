// @vitest-environment node
/*
 * Pins the probe CLI as the refill loop's stale-seat read calls it (#2306):
 * `--config-dir` names the seat, a fresh cache runs no `claude`, and a stale
 * one hands the probe's printed bars to stdout. The dispatcher's own route
 * through it is pinned in dispatch-sessions.test.ts. Break it and the loop
 * reads a seat it never probed, or probes one it need not.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcessAsync } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "usage-probe.js");

let dir: string;
let seat: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-probe-"));
	seat = path.join(dir, "seat");
	fs.mkdirSync(seat);
	fs.writeFileSync(
		path.join(dir, "claude"),
		[
			"#!/bin/bash",
			`printf '%s %s\\n' "$CLAUDE_CONFIG_DIR" "$*" >> "${path.join(dir, "argv")}"`,
			"printf 'Current session: 12%% used · resets Aug 23, 11:49pm\\n'",
		].join("\n"),
		{ mode: 0o755 },
	);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function cache(fetchedAtMs: number): void {
	const limits = [
		{ kind: "session", percent: 40 },
		{ kind: "weekly_all", percent: 50 },
	];
	fs.writeFileSync(
		path.join(seat, ".claude.json"),
		JSON.stringify({
			cachedUsageUtilization: { fetchedAtMs, utilization: { limits } },
		}),
	);
}

function run() {
	return runInProcessAsync(SCRIPT, ["--config-dir", seat], {
		env: { ...process.env, WFC_CLAUDE_BIN: path.join(dir, "claude") },
	});
}

const calls = () =>
	fs.existsSync(path.join(dir, "argv"))
		? fs.readFileSync(path.join(dir, "argv"), "utf8").trim().split("\n")
		: [];

describe("the usage probe CLI (#2306)", () => {
	it("exits 3 and runs no claude on the named seat while its cache is fresh", async () => {
		cache(Date.now());
		const r = await run();
		expect(r.status).toBe(3);
		expect(r.stdout).toBe("");
		expect(r.stderr).toBe("usage probe: cached\n");
		expect(calls()).toEqual([]);
	});

	it("probes the named seat on a stale cache and prints what it printed", async () => {
		cache(Date.now() - 10 * 60 * 1000);
		const r = await run();
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("Current session: 12% used");
		expect(r.stderr).toBe("usage probe: finished\n");
		expect(calls()).toEqual([`${seat} -p /usage --permission-mode manual`]);
	});
});
