// @vitest-environment node
/*
 * Pins lib/refill-seats.js, the one reader of `~/.claude/refill-seats`: plan
 * and overflow lines, the malformed lines it refuses by name, and which seat
 * a launch resolves to. The parse is read through readDeclaredSeats() over a
 * seat file in a temp home. The dispatcher's seat gate is
 * lib/dispatch-gates.test.ts's.
 *
 * Loosen one and a mistyped overflow line launches as a plan seat, or the loop
 * and the dispatcher disagree about which seats exist (#2605).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	findOverflowSeat,
	readDeclaredSeats,
	readOmittedDirs,
	seatOfLaunch,
	unlistedSeats,
} from "./refill-seats.js";

let home: string;
beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "refill-seats-"));
	fs.mkdirSync(path.join(home, ".claude"));
});
afterEach(() => {
	vi.unstubAllEnvs();
	fs.rmSync(home, { recursive: true, force: true });
});

const file = () => path.join(home, ".claude", "refill-seats");
const parse = (text: string) => {
	fs.writeFileSync(file(), text);
	return readDeclaredSeats(home);
};

describe("readOmittedDirs (#3767)", () => {
	const seatDir = (name: string, credentials: boolean) => {
		fs.mkdirSync(path.join(home, name), { recursive: true });
		if (credentials)
			fs.writeFileSync(path.join(home, name, ".credentials.json"), "{}");
	};

	it("names config dirs holding credentials that the seat file omits", () => {
		seatDir(".claude2", true);
		seatDir(".claude3", true);
		seatDir(".claude3-api", false);
		seatDir(".claude-exp", true);
		seatDir("other", true);
		fs.writeFileSync(path.join(home, ".claude.json"), "{}");
		expect(readOmittedDirs(parse("~/.claude2\n"), home)).toEqual([
			path.join(home, ".claude-exp"),
			path.join(home, ".claude3"),
		]);
	});

	it("treats a declared overflow seat, or a symlink to a seat, as declared", () => {
		seatDir(".claude2", true);
		seatDir(".claude2-api", true);
		fs.symlinkSync(path.join(home, ".claude2"), path.join(home, ".claude9"));
		expect(
			readOmittedDirs(
				parse("~/.claude2\n~/.claude2-api api key=K grant=200 cycle-day=20\n"),
				home,
			),
		).toEqual([]);
	});

	it("reads no dirs from a home that is not there", () => {
		expect(
			readOmittedDirs({ seats: [], errors: [] }, path.join(home, "gone")),
		).toEqual([]);
	});
});

describe("readDeclaredSeats", () => {
	it("reads a bare path as a plan seat and an api line as an overflow seat, in order", () => {
		expect(
			parse(
				`${home}/.claude2\n~/.claude3\n~/.claude2-api api key=WFC_KEY_2 grant=200 cycle-day=20\n`,
			),
		).toEqual({
			seats: [
				{ dir: path.join(home, ".claude2"), kind: "plan" },
				{ dir: path.join(home, ".claude3"), kind: "plan" },
				{
					dir: path.join(home, ".claude2-api"),
					kind: "overflow",
					keyVar: "WFC_KEY_2",
					grantUsd: 200,
					cycleDay: 20,
				},
			],
			errors: [],
		});
	});

	it("takes an overflow line's fields in any order", () => {
		expect(parse("/h/o api cycle-day=28 grant=12.5 key=K").seats).toEqual([
			{
				dir: "/h/o",
				kind: "overflow",
				keyVar: "K",
				grantUsd: 12.5,
				cycleDay: 28,
			},
		]);
	});

	it("skips comments and blank lines", () => {
		expect(parse("# failover order\n\n   \n/h/.claude2\n  # aside\n")).toEqual({
			seats: [{ dir: "/h/.claude2", kind: "plan" }],
			errors: [],
		});
	});

	it("reads no seats from an absent file", () => {
		expect(readDeclaredSeats(home)).toEqual({ seats: [], errors: [] });
	});

	it.each([
		["/h/o key=K grant=200 cycle-day=20", 'expected "api"'],
		["/h/o api key=K grant=200", "missing cycle-day="],
		["/h/o api key=K grant=200 cycle-day=29", "cycle-day=29 is not a day"],
		["/h/o api key=K grant=200 cycle-day=0", "cycle-day=0 is not a day"],
		["/h/o api key=K grant=0 cycle-day=1", "grant=0 is not a positive"],
		["/h/o api key=K grant=lots cycle-day=1", "grant=lots is not a positive"],
		["/h/o api key=1K grant=1 cycle-day=1", "key=1K is not an environment"],
		["/h/o api key=K key=L grant=1 cycle-day=1", '"key=" given twice'],
		["/h/o api key=K grant=1 cycle-day=1 model=x", 'unknown field "model=x"'],
	])("refuses %j by line, never as a plan seat", (line, why) => {
		const r = parse(`/h/.claude2\n${line}\n`);
		expect(r.seats).toEqual([{ dir: "/h/.claude2", kind: "plan" }]);
		expect(r.errors).toHaveLength(1);
		expect(r.errors[0]).toContain(`${file()}:2: ${why}`);
		expect(r.errors[0]).toContain(line);
	});
});

describe("a seat's identity (#3693)", () => {
	const shared = () =>
		parse(
			"~/.claude2\n~/.claude2 api key=K2 grant=200 cycle-day=20\n~/.claude3-api api key=K3 grant=100 cycle-day=28\n",
		);

	it("reads a plan and an overflow seat on one dir as two seats", () => {
		const { seats, errors } = shared();
		expect(errors).toEqual([]);
		expect(seats.slice(0, 2)).toEqual([
			{ dir: path.join(home, ".claude2"), kind: "plan" },
			{
				dir: path.join(home, ".claude2"),
				kind: "overflow",
				keyVar: "K2",
				grantUsd: 200,
				cycleDay: 20,
			},
		]);
	});

	it("resolves the seat each launch asked for on a shared dir", () => {
		const list = shared();
		const dir = path.join(home, ".claude2");
		expect(seatOfLaunch(list, { dir }, home)).toEqual({ dir, kind: "plan" });
		expect(seatOfLaunch(list, { dir, keyVar: "K2" }, home)).toMatchObject({
			kind: "overflow",
			keyVar: "K2",
		});
		expect(findOverflowSeat(list, "K3")?.dir).toBe(
			path.join(home, ".claude3-api"),
		);
		expect(findOverflowSeat(list, "NOPE")).toBeNull();
	});

	it("refuses two overflow lines with one key by name", () => {
		const r = parse(
			"~/.claude2-api api key=K grant=200 cycle-day=20\n~/.claude3-api api key=K grant=200 cycle-day=28\n",
		);
		expect(r.errors).toHaveLength(1);
		expect(r.errors[0]).toContain(`${file()}:2: key=K is already line 1's`);
		expect(r.errors[0]).toContain("~/.claude3-api");
	});
});

describe("unlistedSeats", () => {
	it("names only the seats arbiter-core's sessionDirs() leaves out", () => {
		const own = path.join(home, ".claude");
		const b = path.join(home, "plan-b");
		const outside = path.join(home, "plan-elsewhere");
		vi.stubEnv("CLAUDE_CONFIG_DIR", own);
		vi.stubEnv("WFC_CLAUDE_CONFIG_B", b);

		expect(unlistedSeats([own, b, outside])).toEqual([outside]);
	});
});
