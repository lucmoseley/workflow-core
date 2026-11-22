// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	isAbsentSinceSwitch,
	markPresent,
	presenceAt,
	readLastTypedAt,
	readLastTypedSeat,
} from "./presence";
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

describe("isAbsentSinceSwitch (#4846, #4976)", () => {
	const Switched = ago(8 * 3600 * 1000);

	it("reads him away once the later of the last prompt and the switch is a window old", () => {
		expect(isAbsentSinceSwitch(Switched, Switched - 60 * 1000, NOW)).toBe(true);
		expect(isAbsentSinceSwitch(Switched, ago(WINDOW_MS), NOW)).toBe(true);
	});

	it("reads him present for a prompt inside the window", () => {
		expect(isAbsentSinceSwitch(Switched, ago(WINDOW_MS - 1), NOW)).toBe(false);
	});

	it("reads a switch inside the window as presence, however old the last prompt (#4184)", () => {
		expect(isAbsentSinceSwitch(ago(60 * 1000), ago(8 * 3600 * 1000), NOW)).toBe(
			false,
		);
		expect(isAbsentSinceSwitch(ago(60 * 1000), null, NOW)).toBe(false);
		expect(isAbsentSinceSwitch(ago(WINDOW_MS), null, NOW)).toBe(true);
	});

	it("reads the last prompt alone where the control holds no readable switch", () => {
		expect(isAbsentSinceSwitch(null, ago(WINDOW_MS), NOW)).toBe(true);
		expect(isAbsentSinceSwitch(null, ago(0), NOW)).toBe(false);
		expect(isAbsentSinceSwitch(null, null, NOW)).toBe(true);
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
		expect(readLastTypedAt(env)).toBe(NOW.getTime());
		expect(readLastTypedSeat(plans, env)).toBe(seatB);
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
		expect(readLastTypedSeat(declared, env)).toBe(seatA);
		const { CLAUDE_CONFIG_DIR: _, ...unset } = env;
		markPresent(NOW, { ...unset, HOME: dir });
		expect(readLastTypedSeat(declared, env)).toBe(path.join(dir, ".claude"));
	});

	it("reads a time-only marker as a time with no seat", () => {
		fs.writeFileSync(env.WFC_PRESENCE_MARKER, `${NOW.toISOString()}\n`);
		expect(readLastTypedAt(env)).toBe(NOW.getTime());
		expect(readLastTypedSeat(plans, env)).toBeNull();
	});

	it("reads a seat the seat file does not list as a plan seat as none", () => {
		markPresent(NOW, env);
		expect(readLastTypedSeat(list(seatA), env)).toBeNull();
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
		expect(readLastTypedSeat(overflow, env)).toBeNull();
	});

	it("reads every seat as none while the seat file refuses", () => {
		markPresent(NOW, env);
		expect(readLastTypedSeat({ ...plans, errors: ["bad"] }, env)).toBeNull();
	});

	it("reads a missing or garbled marker as no record", () => {
		expect(readLastTypedAt(env)).toBeNull();
		expect(readLastTypedSeat(plans, env)).toBeNull();
		fs.writeFileSync(env.WFC_PRESENCE_MARKER, "not a time\n");
		expect(readLastTypedAt(env)).toBeNull();
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
