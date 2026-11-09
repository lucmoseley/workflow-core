// @vitest-environment node
/*
 * Holds lib/net-probe.js's reading of its probe child (#4815): exit 0 is
 * reachable, any other exit is the child's stderr as the reason, and a child
 * that will not start is a reason of its own. Loosen it and a down network
 * reads as up, so the loop spends its resumes into the outage.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { probeNetwork } from "./net-probe.js";

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "net-probe-"));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/** A probe stand-in printing the line `stderr`, if any, and exiting `code`. */
function probe(code: number, stderr = "") {
	const file = path.join(dir, "probe");
	fs.writeFileSync(
		file,
		`#!/bin/bash\n${stderr ? `echo ${JSON.stringify(stderr)} >&2\n` : ""}exit ${code}\n`,
		{ mode: 0o755 },
	);
	return { ...process.env, WFC_NET_PROBE: file };
}

it("reads exit 0 as reachable", () => {
	expect(probeNetwork(probe(0))).toBeNull();
});

it("gives the child's stderr as the reason, else its exit", () => {
	expect(
		probeNetwork(probe(1, "api.anthropic.com did not resolve: EAI_AGAIN")),
	).toBe("api.anthropic.com did not resolve: EAI_AGAIN");
	expect(probeNetwork(probe(3))).toBe("the probe exited 3");
});

it("reads a probe that will not start as unreachable, saying so", () => {
	expect(
		probeNetwork({ ...process.env, WFC_NET_PROBE: path.join(dir, "none") }),
	).toMatch(/^the probe did not run: /);
});
