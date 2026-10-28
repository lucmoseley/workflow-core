// @vitest-environment node
/*
 * Pins how lib/usage-probe.js ends a probe that will not end itself (#2306):
 * at its ceiling, on its caller's abort, or not at all where it never
 * started. Each stops a real process group, so each crosses the real clock
 * (§X9): the ceiling is shortened through `timeoutMs`, never asserted as
 * elapsed time. Break it and a hung probe holds the dispatcher or the loop's
 * tick with nothing to stop it, or outlives the caller that started it.
 * A launch whose auth would not bill the subscription fails before it
 * spawns (lib/launch-auth.js, #2236).
 * The fresh-cache, early-stop and run-to-end cases are pinned through the
 * dispatcher's CLI in dispatch-sessions.test.ts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ADMITTED_AUTH,
	buildAuthStatusBranch,
	REFUSED_AUTH,
	writeSeatHelper,
} from "./auth-status-fake";
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
			buildAuthStatusBranch(),
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
		/* Answers `auth status`, then is gone before the probe spawns. */
		const vanishing = path.join(dir, "vanishing");
		fs.writeFileSync(
			vanishing,
			`#!/bin/bash\nif [ "$1" = "auth" ]; then rm -- "$0"; fi\n${buildAuthStatusBranch()}\n`,
			{ mode: 0o755 },
		);
		const r = await probeUsage({ configDir: seat(), claudeBin: vanishing });
		expect(r.outcome).toBe("failed");
		expect(r.error).toContain("ENOENT");
		expect(r.error).not.toContain("auth status");
	});
});

describe("the probe's auth (#2236)", () => {
	let quick = "";
	const saved: Record<string, string | undefined> = {};
	const launched = () => fs.existsSync(path.join(dir, "launched"));

	beforeEach(() => {
		quick = path.join(dir, "claude-quick");
		fs.writeFileSync(
			quick,
			[
				"#!/bin/bash",
				buildAuthStatusBranch(),
				`touch "${path.join(dir, "launched")}"`,
				buildUsageBranch({ session: 12, week: 3 }),
			].join("\n"),
			{ mode: 0o755 },
		);
	});

	/** `env` set on this process, which the probe hands its child, for one call. */
	async function probeUnder(env: Record<string, string>) {
		for (const [k, v] of Object.entries(env)) {
			saved[k] = process.env[k];
			process.env[k] = v;
		}
		try {
			return await probeUsage({ configDir: seat(), claudeBin: quick });
		} finally {
			for (const k of Object.keys(env)) {
				if (saved[k] === undefined) delete process.env[k];
				else process.env[k] = saved[k];
			}
		}
	}

	it.each(REFUSED_AUTH)(
		"fails under %s, launching nothing",
		async (name, env) => {
			const r = await probeUnder(env);
			expect(r.outcome).toBe("failed");
			expect(r.error).toContain(`${name} is set`);
			expect(launched()).toBe(false);
		},
	);

	it("fails under an apiKeyHelper in the seat's settings", async () => {
		writeSeatHelper(seat());
		const r = await probeUnder({});
		expect(r.error).toContain("apiKeyHelper");
		expect(launched()).toBe(false);
	});

	it.each(ADMITTED_AUTH)("probes on %s", async (_name, env) => {
		const r = await probeUnder(env);
		expect(r.outcome).toBe("finished");
		expect(launched()).toBe(true);
	});
});
