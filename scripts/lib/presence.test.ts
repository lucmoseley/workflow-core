// @vitest-environment node
/*
 * presence.js tells the refill loop whether the founder is at the laptop
 * (#2004): a typed prompt within the last 30 minutes.
 *
 * WHAT BREAKING IT COSTS: read as away while he is present, the loop takes
 * the slot kept for him; read as present while he sleeps, a slot idles all
 * night.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { markPresent, presenceAt, readLastTypedAt } from "./presence";

const NOW = new Date("2026-10-18T09:00:00.000Z");
const ago = (ms: number) => NOW.getTime() - ms;
const WINDOW_MS = 30 * 60 * 1000;

describe("presenceAt", () => {
	it("reads a prompt inside the window as present", () => {
		expect(presenceAt(ago(0), NOW)).toBe("present");
		expect(presenceAt(ago(WINDOW_MS - 1), NOW)).toBe("present");
	});

	it("reads one at or past 30 minutes as away", () => {
		expect(presenceAt(ago(WINDOW_MS), NOW)).toBe("away");
		expect(presenceAt(ago(8 * 3600 * 1000), NOW)).toBe("away");
	});

	it("reads no record as away", () => {
		expect(presenceAt(null, NOW)).toBe("away");
	});

	it("reads a record later than the clock as away", () => {
		expect(presenceAt(ago(-60 * 1000), NOW)).toBe("away");
	});
});

describe("the marker", () => {
	let dir: string;
	let env: Record<string, string>;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "presence-"));
		env = { WFC_PRESENCE_MARKER: path.join(dir, "marker") };
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("reads back the time written", () => {
		markPresent(NOW, env);
		expect(readLastTypedAt(env)).toBe(NOW.getTime());
		expect(fs.readdirSync(dir)).toEqual(["marker"]);
	});

	it("reads a missing or garbled marker as no record", () => {
		expect(readLastTypedAt(env)).toBeNull();
		fs.writeFileSync(env.WFC_PRESENCE_MARKER, "not a time\n");
		expect(readLastTypedAt(env)).toBeNull();
	});

	it("lives in ~/.claude, one per machine", () => {
		fs.mkdirSync(path.join(dir, ".claude"));
		markPresent(NOW, { HOME: dir });
		expect(
			fs.readFileSync(path.join(dir, ".claude", ".founder-presence"), "utf8"),
		).toBe(`${NOW.toISOString()}\n`);
		expect(() => markPresent(NOW, { HOME: "rel" })).toThrow();
	});
});
