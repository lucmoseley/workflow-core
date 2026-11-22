// @vitest-environment node

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

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "adopter-consent-cli-"));
	vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(dir, "claude"));
	vi.stubEnv("WFC_CLAUDE_CONFIG_A", undefined);
	vi.stubEnv("WFC_CLAUDE_CONFIG_B", undefined);
	vi.stubEnv("WFC_CLAUDE_CONFIG_C", undefined);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const REPO = "/home/founder/fantasy-books";

describe("decline", () => {
	it("writes a decline record the lib can read back", () => {
		expect(cliMain(["decline", REPO, "v1.1.11"])).toBe(0);
		expect(isDeclined(REPO, "v1.1.11")).toBe(true);
	});
});

const realWriteSync = fs.writeSync;
const spyWrites = () =>
	vi
		.spyOn(fs, "writeSync")
		.mockImplementation((fd, data, ...rest) =>
			fd === 1 || fd === 2
				? Buffer.byteLength(data as string | Buffer)
				: Reflect.apply(realWriteSync, fs, [fd, data, ...rest]),
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
