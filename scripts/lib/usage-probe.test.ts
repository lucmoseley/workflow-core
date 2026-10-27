// @vitest-environment node
/*
 * Pins how lib/usage-probe.js ends a probe that will not end itself (#2306):
 * at its ceiling, on its caller's abort, or not at all where it never
 * started. Each stops a real process group, so each crosses the real clock
 * (§X9): the ceiling is shortened through `timeoutMs`, never asserted as
 * elapsed time. Break it and a hung probe holds the dispatcher or the loop's
 * tick with nothing to stop it, or outlives the caller that started it.
 * The fresh-cache, early-stop and run-to-end cases are pinned through the
 * dispatcher's CLI in dispatch-sessions.test.ts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { probeUsage } from "./usage-probe.js";
import { buildUsageBranch } from "./usage-probe-fake";

let dir: string;
let hanging: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-probe-lib-"));
	hanging = path.join(dir, "claude");
	fs.writeFileSync(
		hanging,
		[
			"#!/bin/bash",
			buildUsageBranch({ session: 12, week: 3 }),
			"sleep 30",
			`echo ended > "${path.join(dir, "ended")}"`,
		].join("\n"),
		{ mode: 0o755 },
	);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const seat = () => path.join(dir, "no-cache");
const ended = () => fs.existsSync(path.join(dir, "ended"));

describe("a probe that will not end itself (#2306)", () => {
	it("is killed at its ceiling, keeping what it printed", async () => {
		const r = await probeUsage({
			configDir: seat(),
			claudeBin: hanging,
			timeoutMs: 300,
		});
		expect(r.outcome).toBe("timed-out");
		expect(r.text).toContain("Current session: 12% used");
		expect(ended()).toBe(false);
	});

	it("is stopped when its caller aborts", async () => {
		const abort = new AbortController();
		const pending = probeUsage({
			configDir: seat(),
			claudeBin: hanging,
			signal: abort.signal,
		});
		abort.abort();
		const r = await pending;
		expect(r.outcome).toBe("aborted");
		expect(ended()).toBe(false);
	});

	it("reads as failed where the binary will not start", async () => {
		const r = await probeUsage({
			configDir: seat(),
			claudeBin: path.join(dir, "no-such-claude"),
		});
		expect(r.outcome).toBe("failed");
		expect(r.error).toContain("ENOENT");
	});
});
