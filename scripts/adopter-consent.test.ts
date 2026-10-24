// @vitest-environment node
/*
 * adopter-consent.test.ts — the CLI over lib/adopter-consent.js (#245).
 *
 * Pins that each command writes or reads the record the lib reads back, what
 * it prints, and that bad usage exits 2.
 *
 * `main` is called in process with CLAUDE_CONFIG_DIR pointed at a temp
 * directory, so the founder's real consent store is never touched, and
 * `fs.writeSync` is spied on to read what the CLI prints and to which stream.
 *
 * A session runs this CLI on the founder's yes or no to an upgrade; the
 * adopter's SessionStart check-plugin-gap.js and session-end
 * reconcile-plugin.js act on what it writes. Loosen a case and an accepted
 * upgrade is never applied, or a declined one is nagged about every session.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main as cliMain } from "./adopter-consent.js";
import {
	decline,
	isDeclined,
	readPendingConsent,
} from "./lib/adopter-consent.js";

let dir = "";
const savedEnv = { ...process.env };

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "adopter-consent-cli-"));
	process.env.CLAUDE_CONFIG_DIR = path.join(dir, "claude");
	delete process.env.WFC_CLAUDE_CONFIG_A;
	delete process.env.WFC_CLAUDE_CONFIG_B;
	delete process.env.WFC_CLAUDE_CONFIG_C;
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
	process.env = { ...savedEnv };
});

const REPO = "/home/founder/fantasy-books";

describe("decline", () => {
	it("writes a decline record the lib can read back", () => {
		expect(cliMain(["decline", REPO, "v1.1.11"])).toBe(0);
		expect(isDeclined(REPO, "v1.1.11")).toBe(true);
	});
});

/* Answers each write to stdout or stderr as wholly taken: writeFd counts a
 * 0-byte answer toward its stall ceiling (#1676). Any other fd is a file
 * write, which writeFileSync may route through writeSync, and goes through
 * for real. */
const realWriteSync = fs.writeSync;
const spyWrites = () =>
	vi.spyOn(fs, "writeSync").mockImplementation((fd, data, ...rest) =>
		fd === 1 || fd === 2
			? Buffer.byteLength(data as string | Buffer)
			: // biome-ignore lint/suspicious/noExplicitAny: passthrough to the real overloaded call
				(realWriteSync as any)(fd, data, ...rest),
	);

describe("accept", () => {
	it("writes a pending consent and tells the founder this session stays as-is", () => {
		const spy = spyWrites();
		expect(cliMain(["accept", REPO, "v1.1.11"])).toBe(0);
		const printed = spy.mock.calls.find(([fd]) => fd === 1)?.[1];
		spy.mockRestore();
		expect(readPendingConsent(REPO, "v1.1.11")).not.toBeNull();
		expect(String(printed)).toMatch(/keeps the plugin it started with/);
	});
});

describe("status", () => {
	it("reports both flags as JSON", () => {
		decline(REPO, "v1.1.11");
		const spy = spyWrites();
		expect(cliMain(["status", REPO, "v1.1.11"])).toBe(0);
		const [[fd, raw]] = spy.mock.calls;
		spy.mockRestore();
		expect(fd).toBe(1);
		const printed = JSON.parse(String(raw));
		expect(printed.declined).toBe(true);
		expect(printed.pending).toBeNull();
	});
});

describe("bad usage", () => {
	it("refuses an unknown command and prints the usage line to stderr", () => {
		const spy = spyWrites();
		expect(cliMain(["frobnicate", REPO, "v1.1.11"])).toBe(2);
		const [[fd, printed]] = spy.mock.calls;
		spy.mockRestore();
		expect(fd).toBe(2);
		expect(String(printed)).toMatch(/usage: adopter-consent\.js/);
	});

	it("refuses a missing tag", () => {
		const spy = spyWrites();
		expect(cliMain(["decline", REPO])).toBe(2);
		spy.mockRestore();
	});
});
