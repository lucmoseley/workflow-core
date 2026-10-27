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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readDeclaredSeats } from "./refill-seats.js";
import { runInProcess } from "./run-in-process.js";

const SCRIPT = path.join(__dirname, "refill-seats.js");

let home: string;
beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "refill-seats-"));
	fs.mkdirSync(path.join(home, ".claude"));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const file = () => path.join(home, ".claude", "refill-seats");
const parse = (text: string) => {
	fs.writeFileSync(file(), text);
	return readDeclaredSeats(home);
};
const kind = (seat: string) =>
	runInProcess(SCRIPT, ["kind", seat], { env: { ...process.env, HOME: home } });

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

describe("the kind command", () => {
	it("prints each declared seat's kind, however its dir is spelt", () => {
		parse("~/.claude2\n~/.claude2-api api key=K grant=200 cycle-day=20\n");
		const overflow = kind(`${path.join(home, ".claude2-api")}/`);
		expect(overflow.status).toBe(0);
		expect(overflow.stdout).toBe("overflow\n");
		const plan = kind(path.join(home, ".claude2"));
		expect(plan.status).toBe(0);
		expect(plan.stdout).toBe("plan\n");
	});

	it("takes an undeclared dir as a plan seat", () => {
		parse("~/.claude2-api api key=K grant=200 cycle-day=20\n");
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
