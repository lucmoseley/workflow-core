// @vitest-environment node
/*
 * The suite ceiling's shared rules (#2696, ruled at #2667): the figure only
 * lowers, and the deadline file bg-run reads names the deadline and the group.
 * Loosen a case and an environment value lifts the ceiling, or bg-run's
 * backstop reads a deadline that is not there.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

const {
	CEILING_ENV,
	CEILING_MS,
	DEADLINE_ENV,
	armCeiling,
	ceilingMs,
} = require("./suite-ceiling.js");

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length > 0)
		fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

it.each([
	[undefined, CEILING_MS],
	["", CEILING_MS],
	["1000", 1000],
	[String(CEILING_MS), CEILING_MS],
	[String(CEILING_MS + 1), CEILING_MS],
	["0", CEILING_MS],
	["-5", CEILING_MS],
	["soon", CEILING_MS],
])("reads %s as a ceiling of %i ms", (value, expected) => {
	expect(ceilingMs(value === undefined ? {} : { [CEILING_ENV]: value })).toBe(
		expected,
	);
});

it("writes the deadline and group where the environment names a file, and drops it on release", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suite-ceiling-"));
	dirs.push(dir);
	const file = path.join(dir, "deadline");

	/* Held for the exit-time kill until released, so released whatever the
	 * read does: a held group is SIGKILLed when the worker exits. */
	const held = armCeiling({
		pgid: 4242,
		ms: 60_000,
		now: 1_000_000,
		onCeiling: () => {
			throw new Error("the ceiling fired");
		},
		env: { [DEADLINE_ENV]: file },
	});
	let written: string;
	try {
		written = fs.readFileSync(file, "utf8");
	} finally {
		held.release();
	}

	expect(written).toBe("1060 4242\n");
	expect(held.error).toBeNull();
	expect(fs.existsSync(file)).toBe(false);
});

it("writes the deadline on CLOCK_MONOTONIC, which a host suspend does not step (#2886)", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suite-ceiling-"));
	dirs.push(dir);
	const file = path.join(dir, "deadline");
	/* The real clock, not an injected `now`: which clock the default reads
	 * is what this case pins. */
	const monoS = () => Math.floor(Number(process.hrtime.bigint()) / 1e9);

	const before = monoS();
	const held = armCeiling({
		pgid: 4242,
		ms: 60_000,
		onCeiling: () => {
			throw new Error("the ceiling fired");
		},
		env: { [DEADLINE_ENV]: file },
	});
	const after = monoS();
	let written: string;
	try {
		written = fs.readFileSync(file, "utf8");
	} finally {
		held.release();
	}

	const deadline = Number(written.split(" ")[0]);
	expect(deadline).toBeGreaterThanOrEqual(before + 60);
	/* +1 for the deadline's round up to the second. */
	expect(deadline).toBeLessThanOrEqual(after + 61);
});

it("writes no deadline for a child with no pid", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suite-ceiling-"));
	dirs.push(dir);
	const file = path.join(dir, "deadline");

	armCeiling({
		pgid: undefined,
		ms: 60_000,
		onCeiling: () => undefined,
		env: { [DEADLINE_ENV]: file },
	}).release();

	expect(fs.existsSync(file)).toBe(false);
});
