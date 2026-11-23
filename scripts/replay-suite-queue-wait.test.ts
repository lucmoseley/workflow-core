// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.join(__dirname, "replay-suite-queue-wait.js");
const SINCE = "2026-10-27T00:00:00.000Z";
const UNTIL = "2026-10-27T01:00:00.000Z";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-cli-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const run = (...args: string[]) =>
	runInProcess(SCRIPT, [
		"--markers",
		dir,
		"--memwatch",
		path.join(dir, "memwatch.log"),
		"--minute-log",
		path.join(dir, "memwatch-minute.jsonl"),
		"--mem-total-mb",
		"10000",
		"--load-ceiling",
		"48",
		...args,
	]);

it("prints the reading over the window, the limb table first", () => {
	fs.writeFileSync(
		path.join(dir, ".suite-queue-exits.jsonl"),
		`${JSON.stringify({
			at: "2026-10-27T00:10:00.000Z",
			waitS: 600,
			reason: "refused",
			kind: "named",
			session: "a",
			pid: 1,
			slotFree: true,
		})}\n`,
	);
	const r = run("--since", SINCE, "--until", UNTIL, "--era", `after=${UNTIL}`);
	expect(r.status).toBe(0);
	expect(r.stdout).toContain(`replay, ${SINCE} to ${UNTIL}`);
	expect(r.stdout).toContain("| open | 0.17 |");
	expect(r.stdout).toContain("| window start | 1.00 | 0.17 |");
});

it("charges a `tsc` wait to the type-check slot's limbs, never a suite's (#3316)", () => {
	fs.writeFileSync(
		path.join(dir, ".suite-queue-exits.jsonl"),
		`${JSON.stringify({
			at: "2026-10-27T00:10:00.000Z",
			waitS: 600,
			reason: "opened",
			kind: "tsc",
			session: "a",
			pid: 1,
		})}\n${JSON.stringify({
			at: "2026-10-27T00:10:00.000Z",
			waitS: 300,
			reason: "opened",
			kind: "tsc",
			session: "b",
			pid: 2,
		})}\n`,
	);
	const r = run("--since", SINCE, "--until", UNTIL);
	expect(r.status).toBe(0);
	expect(r.stdout).toContain("| tsc-fifo | 0.08 |");
	expect(r.stdout).toContain("- tsc-fifo / tsc: 0.08 h");
	expect(r.stdout).toContain("- open / tsc: 0.17 h");
	expect(r.stdout).not.toMatch(/part\?|whole\?/);
});

it("counts a joined `tsc` wait as a wait, out of the fifo, reported apart (#5639)", () => {
	fs.writeFileSync(
		path.join(dir, ".suite-queue-exits.jsonl"),
		`${JSON.stringify({
			at: "2026-10-27T00:10:00.000Z",
			waitS: 600,
			reason: "opened",
			kind: "tsc",
			session: "a",
			pid: 1,
		})}\n${JSON.stringify({
			at: "2026-10-27T00:10:00.000Z",
			waitS: 300,
			reason: "opened",
			kind: "tsc",
			session: "b",
			pid: 2,
			joined: { pid: 1, session: "a" },
		})}\n`,
	);
	const r = run("--since", SINCE, "--until", UNTIL);
	expect(r.status).toBe(0);
	expect(r.stdout).toContain(
		"2 queued waits (2 exits less 0 skipped), 0.25 h inside the window.",
	);
	expect(r.stdout).toContain(
		"1 of the waits joined a queued same-key `tsc` run rather than queue their own, 0.08 h;",
	);
	expect(r.stdout).toContain("| `b` | 1 | 0.08 | 0.08 | 1 | 0.08 |  |");
	expect(r.stdout).toContain("| open | 0.17 |");
	expect(r.stdout).not.toContain("| tsc-fifo |");
});

it.each([
	["holds a wait on the windows limb off a fresh reading", 180, true],
	["holds none off a reading past the live reader's freshness", 181, false],
])(
	"%s in the minute log it is given (#4782, #4785)",
	(_name, winAgeS, held) => {
		fs.writeFileSync(
			path.join(dir, ".suite-queue-exits.jsonl"),
			`${JSON.stringify({
				at: "2026-11-10T00:10:00.000Z",
				waitS: 600,
				reason: "refused",
				kind: "named",
				session: "a",
				pid: 1,
				slotFree: true,
			})}\n`,
		);
		fs.writeFileSync(
			path.join(dir, "memwatch-minute.jsonl"),
			Array.from(
				{ length: 10 },
				(_, m) =>
					`${JSON.stringify({
						ts: `2026-11-10T00:${String(m).padStart(2, "0")}:00Z`,
						win_avail_mb: 100,
						win_age_s: winAgeS,
					})}\n`,
			).join(""),
		);
		const r = run(
			"--since",
			"2026-11-10T00:00:00.000Z",
			"--until",
			"2026-11-10T01:00:00.000Z",
		);
		expect(r.status).toBe(0);
		if (held) expect(r.stdout).toContain("| windows | 0.17 |");
		else expect(r.stdout).not.toMatch(/\| windows \|/);
	},
);

it("models the per-session cap from --cap-from, a window before it landed read against it (#5595)", () => {
	fs.writeFileSync(
		path.join(dir, ".suite-queue-exits.jsonl"),
		[1, 2, 3]
			.map((pid) =>
				JSON.stringify({
					at: "2026-10-27T00:10:00.000Z",
					waitS: 600 - pid,
					reason: "refused",
					kind: "named",
					session: "a",
					pid,
					slotFree: true,
				}),
			)
			.join("\n"),
	);
	expect(run("--since", SINCE, "--until", UNTIL).stdout).not.toContain(
		"session-cap |",
	);
	const r = run("--since", SINCE, "--until", UNTIL, "--cap-from", SINCE);
	expect(r.stdout).toContain("| session-cap | 0.16 |");
});

describe("refuses with exit 2 and the usage", () => {
	it.each([
		["no window", []],
		["an unreadable time", ["--since", "yesterday", "--until", UNTIL]],
		["a window ending before it starts", ["--since", UNTIL, "--until", SINCE]],
		[
			"an era with no label",
			["--since", SINCE, "--until", UNTIL, "--era", `=${SINCE}`],
		],
		[
			"an unreadable --cap-from",
			["--since", SINCE, "--until", UNTIL, "--cap-from", "soon"],
		],
	])("on %s", (_, args) => {
		const r = run(...args);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(
			"usage: node scripts/replay-suite-queue-wait.js",
		);
		expect(r.stdout).toBe("");
	});
});
