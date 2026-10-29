// @vitest-environment node
/*
 * presence.js tells the refill loop whether the founder is at the laptop
 * (#2004): a typed prompt within the last 30 minutes.
 *
 * WHAT BREAKING IT COSTS: read as away while he is present, the loop takes
 * the slot kept for him; read as present while he sleeps, a slot idles all
 * night. The marker's seat line (#3731) names the seat he typed on; read
 * wrong, the loop launches into an agents view he is not watching.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { markPresent, presenceAt, readLastTyped } from "./presence";
import { readDeclaredSeats } from "./refill-seats";

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
	let seatA: string;
	let seatB: string;
	const list = (text: string) => ({
		seats: text
			.split("\n")
			.filter(Boolean)
			.map((seat) => ({ dir: seat, kind: "plan" as const })),
		errors: [] as string[],
	});
	let plans: ReturnType<typeof list>;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "presence-"));
		seatA = path.join(dir, "seat-a");
		seatB = path.join(dir, "seat-b");
		plans = list(`${seatA}\n${seatB}`);
		env = {
			WFC_PRESENCE_MARKER: path.join(dir, "marker"),
			CLAUDE_CONFIG_DIR: `${seatB}/`,
		};
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("reads back the time and the typing session's seat", () => {
		markPresent(NOW, env);
		expect(readLastTyped(plans, env)).toEqual({
			at: NOW.getTime(),
			seat: seatB,
		});
		expect(fs.readdirSync(dir)).toEqual(["marker"]);
	});

	it("matches a seat file's spelling of the dir typed on", () => {
		fs.mkdirSync(path.join(dir, ".claude"));
		fs.writeFileSync(
			path.join(dir, ".claude", "refill-seats"),
			"~/seat-a/\n~/.claude\n",
		);
		const declared = readDeclaredSeats(dir);
		markPresent(NOW, { ...env, HOME: dir, CLAUDE_CONFIG_DIR: seatA });
		expect(readLastTyped(declared, env).seat).toBe(seatA);
		const { CLAUDE_CONFIG_DIR: _, ...unset } = env;
		markPresent(NOW, { ...unset, HOME: dir });
		expect(readLastTyped(declared, env).seat).toBe(path.join(dir, ".claude"));
	});

	it("reads a time-only marker as a time with no seat", () => {
		fs.writeFileSync(env.WFC_PRESENCE_MARKER, `${NOW.toISOString()}\n`);
		expect(readLastTyped(plans, env)).toEqual({
			at: NOW.getTime(),
			seat: null,
		});
	});

	it("reads a seat the seat file does not list as a plan seat as none", () => {
		markPresent(NOW, env);
		expect(readLastTyped(list(seatA), env).seat).toBeNull();
		const overflow = {
			seats: [
				{
					dir: seatB,
					kind: "overflow" as const,
					keyVar: "K",
					grantUsd: 1,
					cycleDay: 1,
				},
			],
			errors: [],
		};
		expect(readLastTyped(overflow, env).seat).toBeNull();
	});

	it("reads every seat as none while the seat file refuses", () => {
		markPresent(NOW, env);
		expect(readLastTyped({ ...plans, errors: ["bad"] }, env).seat).toBeNull();
	});

	it("reads a missing or garbled marker as no record", () => {
		expect(readLastTyped(plans, env)).toEqual({ at: null, seat: null });
		fs.writeFileSync(env.WFC_PRESENCE_MARKER, "not a time\n");
		expect(readLastTyped(plans, env).at).toBeNull();
	});

	it("lives in ~/.claude, one per machine", () => {
		fs.mkdirSync(path.join(dir, ".claude"));
		markPresent(NOW, { HOME: dir, CLAUDE_CONFIG_DIR: seatA });
		expect(
			fs.readFileSync(path.join(dir, ".claude", ".founder-presence"), "utf8"),
		).toBe(`${NOW.toISOString()}\n${seatA}\n`);
		expect(() => markPresent(NOW, { HOME: "rel" })).toThrow();
	});
});
