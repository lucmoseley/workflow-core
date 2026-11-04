// @vitest-environment node
/*
 * Pins lib/refill-seats.js, the one reader of `~/.claude/refill-seats`: plan
 * and overflow lines, the malformed lines it refuses by name, and the
 * dispatcher's `kind` command. The parse is read through readDeclaredSeats() over
 * a seat file in a temp home; `kind` is driven as the dispatcher drives it,
 * through its CLI, since that is its only caller.
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
	isSameSeat,
	readDeclaredSeats,
	readOmittedDirs,
	seatIdOf,
	seatOfLaunch,
	unlistedSeats,
} from "./refill-seats.js";
import { runInProcess } from "./run-in-process.js";

const SCRIPT = path.join(__dirname, "refill-seats.js");

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
const kind = (...identity: string[]) =>
	runInProcess(SCRIPT, ["kind", ...identity], {
		env: { ...process.env, HOME: home },
	});

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

	it("treats a symlink to a seat as declared", () => {
		seatDir(".claude2", true);
		fs.symlinkSync(path.join(home, ".claude2"), path.join(home, ".claude9"));
		expect(readOmittedDirs(parse("~/.claude2\n"), home)).toEqual([]);
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
				`${home}/.claude2\n~/.claude3\n~/.claude2 api key=WFC_KEY_2 grant=200 cycle-day=20\n`,
			),
		).toEqual({
			seats: [
				{ dir: path.join(home, ".claude2"), kind: "plan" },
				{ dir: path.join(home, ".claude3"), kind: "plan" },
				{
					dir: path.join(home, ".claude2"),
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
		expect(parse("/h/o\n/h/o api cycle-day=28 grant=12.5 key=K").seats).toEqual(
			[
				{ dir: "/h/o", kind: "plan" },
				{
					dir: "/h/o",
					kind: "overflow",
					keyVar: "K",
					grantUsd: 12.5,
					cycleDay: 28,
				},
			],
		);
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

describe("the kind command", () => {
	it("prints each declared seat's kind, however its dir is spelt", () => {
		parse("~/.claude2\n~/.claude2 api key=K grant=200 cycle-day=20\n");
		const overflow = kind(`${path.join(home, ".claude2")}/`, "K");
		expect(overflow.status).toBe(0);
		expect(overflow.stdout).toBe("overflow\n");
		const plan = kind(path.join(home, ".claude2"));
		expect(plan.status).toBe(0);
		expect(plan.stdout).toBe("plan\n");
	});

	it("takes an undeclared dir as a plan seat", () => {
		parse("~/.claude2\n~/.claude2 api key=K grant=200 cycle-day=20\n");
		const r = kind(path.join(home, ".claude"));
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("plan\n");
	});

	it("refuses a malformed seat file, naming the line", () => {
		parse("~/.claude2\n~/.claude2-api api key=K grant=200\n");
		const r = kind(path.join(home, ".claude2"));
		expect(r.status).toBe(2);
		expect(r.stdout).toBe("");
		expect(r.stderr).toContain(`${file()}:2: missing cycle-day=`);
	});
});

describe("a seat's identity (#3693)", () => {
	const shared = () =>
		parse(
			"~/.claude2\n~/.claude2 api key=K2 grant=200 cycle-day=20\n~/.claude3\n~/.claude3 api key=K3 grant=100 cycle-day=28\n",
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
		expect(findOverflowSeat(list, "K3")?.dir).toBe(path.join(home, ".claude3"));
		expect(findOverflowSeat(list, "NOPE")).toBeNull();
	});

	it("prints each kind on a shared dir through the kind command", () => {
		shared();
		const dir = path.join(home, ".claude2");
		const plan = kind(dir);
		expect(plan.status).toBe(0);
		expect(plan.stdout).toBe("plan\n");
		const overflow = kind(dir, "K2");
		expect(overflow.status).toBe(0);
		expect(overflow.stdout).toBe("overflow\n");
	});

	it("refuses a key no line declares, or one on another dir", () => {
		shared();
		const dir = path.join(home, ".claude2");
		const none = kind(dir, "NOPE");
		expect(none.status).toBe(2);
		expect(none.stderr).toContain("no overflow seat has key=NOPE");
		const other = kind(dir, "K3");
		expect(other.status).toBe(2);
		expect(other.stderr).toContain(
			`key=K3 is ${path.join(home, ".claude3")}'s overflow seat, not ${dir}'s`,
		);
	});

	it("refuses an overflow line naming a dir no plan line declares, by name (#3701)", () => {
		const line = "~/.claude2-api api key=K grant=200 cycle-day=20";
		const r = parse(`~/.claude2\n${line}\n`);
		expect(r.errors).toEqual([
			`${file()}:2: ~/.claude2-api has no plan seat line, and an overflow seat launches under its plan seat's config dir: ${line}`,
		]);
		const k = kind(path.join(home, ".claude2"));
		expect(k.status).toBe(2);
		expect(k.stderr).toContain("~/.claude2-api has no plan seat line");
	});

	it("takes a plan line after its overflow line", () => {
		expect(
			parse("~/.claude2 api key=K grant=200 cycle-day=20\n~/.claude2\n").errors,
		).toEqual([]);
	});

	it("refuses two overflow lines with one key by name", () => {
		const r = parse(
			"~/.claude2\n~/.claude3\n~/.claude2 api key=K grant=200 cycle-day=20\n~/.claude3 api key=K grant=200 cycle-day=28\n",
		);
		expect(r.errors).toHaveLength(1);
		expect(r.errors[0]).toContain(`${file()}:4: key=K is already line 3's`);
		expect(r.errors[0]).toContain("~/.claude3 api");
	});
});

describe("a seat's identity as one value (#4218)", () => {
	const plan = { seat: "/h/.claude2" };
	const overflow = { seat: "/h/.claude2", keyVar: "K2" };
	it.each([
		["a plan seat and itself", plan, { seat: "/h/.claude2" }, true],
		["an overflow seat and itself", overflow, { ...overflow }, true],
		[
			"a plan seat and the overflow seat on its dir (#4147)",
			plan,
			overflow,
			false,
		],
		["two keys on one dir", overflow, { ...overflow, keyVar: "K3" }, false],
		[
			"one key on two dirs",
			overflow,
			{ ...overflow, seat: "/h/.claude3" },
			false,
		],
		["two plan seats", plan, { seat: "/h/.claude3" }, false],
		["an empty key and none", { ...plan, keyVar: "" }, plan, true],
		["a null key and none", { ...plan, keyVar: null }, plan, true],
	])("reads %s as one seat: %s", (_case, a, b, same) => {
		expect(isSameSeat(a, b)).toBe(same);
		expect(isSameSeat(b, a)).toBe(same);
	});

	it("carries no key field on a plan seat's, whatever else rides along", () => {
		expect(seatIdOf({ seat: "/h/.claude2", keyVar: "" })).toEqual(plan);
		expect(seatIdOf({ seat: "/h/.claude2" })).not.toHaveProperty("keyVar");
		expect(seatIdOf({ ...overflow, jobId: "j1" } as never)).toEqual(overflow);
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
