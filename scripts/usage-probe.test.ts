// @vitest-environment node
/*
 * Pins the probe CLI as the refill loop's stale-seat read calls it (#2306):
 * `--config-dir` names the seat, even an empty one (#2095), a fresh cache runs
 * no `claude`, and a stale one hands the probe's printed bars to stdout. The
 * dispatcher's own route through it is pinned in dispatch-sessions.test.ts.
 * Break it and the loop reads a seat it never probed, or probes one it need
 * not.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAuthStatusBranch } from "./lib/auth-status-fake";
import { runInProcessAsync } from "./lib/run-in-process.js";
import { buildUsageBranch, buildUsageCache } from "./lib/usage-probe-fake";

const SCRIPT = path.resolve(__dirname, "usage-probe.js");

let dir: string;
let seat: string;
let argv: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-probe-"));
	seat = path.join(dir, "seat");
	argv = path.join(dir, "argv");
	fs.mkdirSync(seat);
	fs.writeFileSync(
		path.join(dir, "claude"),
		[
			"#!/bin/bash",
			buildAuthStatusBranch(),
			`printf '%s %s\\n' "$CLAUDE_CONFIG_DIR" "$*" >> "${argv}"`,
			buildUsageBranch({ session: 12, week: 3 }),
		].join("\n"),
		{ mode: 0o755 },
	);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function cache(fetchedAtMs: number): void {
	fs.writeFileSync(
		path.join(seat, ".claude.json"),
		JSON.stringify(buildUsageCache({ session: 40, week: 50 }, fetchedAtMs)),
	);
}

function run(configDir = seat, env: NodeJS.ProcessEnv = {}) {
	return runInProcessAsync(SCRIPT, ["--config-dir", configDir], {
		env: { ...process.env, ...env, WFC_CLAUDE_BIN: path.join(dir, "claude") },
		// An empty seat reads `.claude.json` against the cwd: keep it off the repo's.
		cwd: dir,
	});
}

const readCalls = () =>
	fs.existsSync(argv) ? fs.readFileSync(argv, "utf8").trim().split("\n") : [];

describe("the usage probe CLI (#2306)", () => {
	it("exits 3 and runs no claude on the named seat while its cache is fresh", async () => {
		cache(Date.now());
		const r = await run();
		expect(r.status).toBe(3);
		expect(r.stdout).toBe("");
		expect(r.stderr).toBe("usage probe: cached\n");
		expect(readCalls()).toEqual([]);
	});

	it("probes the named seat on a stale cache and prints what it printed", async () => {
		cache(Date.now() - 10 * 60 * 1000);
		const r = await run();
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("Current session: 12% used");
		expect(r.stderr).toBe("usage probe: finished\n");
		expect(readCalls()).toEqual([`${seat} -p /usage --permission-mode manual`]);
	});

	it("keeps an empty --config-dir set over CLAUDE_CONFIG_DIR's seat (#2095, #3355)", async () => {
		// A fresh cache on CLAUDE_CONFIG_DIR's seat: falling through to it would exit 3.
		cache(Date.now());
		const r = await run("", { CLAUDE_CONFIG_DIR: seat });
		expect(r.status).toBe(0);
		expect(r.stderr).toBe("usage probe: finished\n");
		// Raw, since readCalls' trim would eat the leading space an empty seat prints.
		expect(fs.readFileSync(argv, "utf8")).toBe(
			" -p /usage --permission-mode manual\n",
		);
	});
});
