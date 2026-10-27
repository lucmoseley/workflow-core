// @vitest-environment node
/*
 * lib/suite-handoff.js's two hand-offs (#1491): the launch record's round
 * trip and its per-field fail-shut reading, and the run report's one take.
 * Both are driven in-process, never through a spawn: `run-vitest.test.ts`
 * covers the launcher's side through a fake child, and this file is the one
 * place a record is encoded and decoded end to end.
 *
 * Every certificate's launch facts pass through here. A field that stops
 * failing shut lets a forged launch mint an admissible certificate; a take
 * that stops clearing lets a later run's certificate carry an earlier run's
 * verdict or closure.
 */

import fs from "node:fs";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { mkScratchDir } from "./git-fixture";
import { carrying } from "./proc-fake";
import {
	fillRunReport,
	launchEnv,
	readCarriedWeight,
	readLaunch,
	takeRunReport,
} from "./suite-handoff.js";

/* The one key the module writes, read off it rather than restated. */
const [KEY] = Object.keys(launchEnv({}));

const LAUNCH = {
	admissible: true,
	isolated: true,
	viaChanged: true,
	touched: true,
	full: "flag",
	fullCause: "coverage",
	argv: ["--full=coverage"],
	resolvedFiles: 485,
	wholeSlot: true,
	changedPaths: ["lib/a.js", "docs/b.md"],
	base: "b".repeat(40),
};

const ABSENT = {
	admissible: false,
	isolated: false,
	viaChanged: false,
	touched: false,
	full: null,
	fullCause: null,
	argv: null,
	resolvedFiles: null,
	wholeSlot: false,
	changedPaths: null,
	base: null,
};

/** The launch a child reads off a record whose fields were written as given. */
const readRaw = (fields: Record<string, unknown>) =>
	readLaunch({ [KEY]: JSON.stringify({ ...LAUNCH, ...fields }) });

describe("the launch record", () => {
	it("round-trips every field through launchEnv and readLaunch", () => {
		expect(readLaunch(launchEnv(LAUNCH))).toEqual(LAUNCH);
	});

	it("writes one key, so the spawn always overwrites an outer run's record", () => {
		expect(Object.keys(launchEnv({}))).toEqual([KEY]);
		expect(readLaunch(launchEnv({}))).toEqual(ABSENT);
	});

	it("reads a missing key, and any value that is not a JSON object, as every field absent", () => {
		expect(readLaunch({})).toEqual(ABSENT);
		expect(readLaunch({ [KEY]: "" })).toEqual(ABSENT);
		expect(readLaunch({ [KEY]: "{" })).toEqual(ABSENT);
		expect(readLaunch({ [KEY]: "null" })).toEqual(ABSENT);
		expect(readLaunch({ [KEY]: '"admissible"' })).toEqual(ABSENT);
	});

	it.each([
		["admissible", "1"],
		["admissible", 1],
		["isolated", "true"],
		["viaChanged", "1"],
		["touched", "true"],
		["full", "everything"],
		["full", true],
		["fullCause", "because"],
		["fullCause", 3],
		["argv", "--full"],
		["argv", [1]],
		["resolvedFiles", -1],
		["resolvedFiles", 2.5],
		["resolvedFiles", "40"],
		["wholeSlot", "true"],
		["changedPaths", "lib/a.js"],
		["changedPaths", ["lib/a.js", null]],
		["base", 42],
		["base", "   "],
	])(
		"reads a forged %s (%j) as absent and leaves the rest standing",
		(field, value) => {
			expect(readRaw({ [field]: value })).toEqual({
				...LAUNCH,
				[field]: ABSENT[field as keyof typeof ABSENT],
			});
		},
	);

	it("trims the base", () => {
		expect(readRaw({ base: " abc123\n" }).base).toBe("abc123");
	});

	it("never writes a field the reader would refuse", () => {
		expect(
			readLaunch(launchEnv({ full: "everything", argv: [1] } as never)),
		).toEqual(ABSENT);
	});
});

describe("the weight a running process carries (#2931)", () => {
	const proc = mkScratchDir("proc-");
	afterAll(() => fs.rmSync(proc, { recursive: true, force: true }));

	it("reads the resolved count and slot off the launch record", () => {
		const pid = carrying(proc, 11, { resolvedFiles: 40, wholeSlot: false });
		expect(readCarriedWeight(pid, proc)).toEqual({
			resolvedFiles: 40,
			wholeSlot: false,
		});
	});

	it("reads an unresolved whole run as carried", () => {
		const pid = carrying(proc, 12, { resolvedFiles: null, wholeSlot: true });
		expect(readCarriedWeight(pid, proc)).toEqual({
			resolvedFiles: null,
			wholeSlot: true,
		});
	});

	it.each([
		["no record", 13, null],
		["a record carrying no weight", 14, { isolated: true }],
	])("reads %s as none, for the argv to weigh", (_what, pid, launch) => {
		expect(readCarriedWeight(carrying(proc, pid, launch), proc)).toBeNull();
	});

	it("reads an unreadable or absent process as none", () => {
		expect(readCarriedWeight(99, proc)).toBeNull();
		expect(readCarriedWeight(null, proc)).toBeNull();
	});
});

describe("the run report", () => {
	afterEach(() => {
		takeRunReport();
	});

	const filled = {
		outcome: true,
		scope: { modulesRun: 1, modulesTotal: 1 },
		attestation: { closure: "*" },
		startedAtMs: 1000,
		elapsedMs: 1000,
		machineStart: { jiffies: { user: 1 }, total: 1, load1: null },
		machineEnd: { jiffies: { user: 2 }, total: 2, load1: null },
		endedAtMs: 2000,
		slowest: [{ file: "a.test.ts", seconds: 1 }],
	};

	it("gives one take every field filled, and a second take nothing", () => {
		fillRunReport({ startedAtMs: 1000, machineStart: filled.machineStart });
		fillRunReport({
			endedAtMs: 2000,
			elapsedMs: 1000,
			machineEnd: filled.machineEnd,
		});
		fillRunReport({ outcome: true });
		fillRunReport({ scope: filled.scope as never });
		fillRunReport({ attestation: filled.attestation as never });
		fillRunReport({ slowest: filled.slowest });
		expect(takeRunReport()).toEqual(filled);
		expect(Object.values(takeRunReport()).every((v) => v === null)).toBe(true);
	});

	it("gives a null outcome where nothing filled it", () => {
		expect(takeRunReport().outcome).toBeNull();
	});

	it("keeps the last fill of a field, as a watch session's last re-run", () => {
		fillRunReport({ startedAtMs: 1000 });
		fillRunReport({ startedAtMs: 2000 });
		expect(takeRunReport().startedAtMs).toBe(2000);
	});

	it("refuses a field the report does not carry", () => {
		expect(() => fillRunReport({ outcom: true } as never)).toThrow(/outcom/);
	});
});
