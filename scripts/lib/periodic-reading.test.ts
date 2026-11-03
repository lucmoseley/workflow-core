// @vitest-environment node
/*
 * The gate a session-start reporter reads behind: its lock (#4016).
 *
 * Loosen it and two starts both read and both file, a live reading loses its
 * lock to age, or a dead holder's lock stops the reporter for good.
 *
 * spawn-kept: two processes at once, since the race is between two takers'
 * syscalls and one process cannot interleave them.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endedPid } from "./arbiter-testkit";
import { periodicReading } from "./periodic-reading.js";
import { plantDeadLock, plantLiveLock } from "./pid-lock-testkit";

const SCRIPT = "report-under-test.js";
const DAY_MS = 86_400_000;

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "periodic-reading-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const gate = () => ({
	stamp: path.join(dir, "stamp"),
	lock: path.join(dir, "lock"),
	script: SCRIPT,
	nowMs: Date.now(),
	everyMs: DAY_MS,
});

describe("periodicReading's lock", () => {
	it("takes over a lock naming an ended process, and releases its own", () => {
		plantDeadLock(gate().lock);
		expect(periodicReading(gate(), () => "read")).toEqual({
			ran: true,
			value: "read",
		});
		expect(fs.existsSync(gate().lock)).toBe(false);
	});

	it("refuses a live holder running the script, however old its lock", () => {
		plantLiveLock(gate().lock, SCRIPT);
		expect(periodicReading(gate(), () => "read")).toEqual({
			ran: false,
			why: "locked",
		});
		expect(fs.existsSync(gate().stamp)).toBe(false);
	});

	it("takes over a live process that runs another script", () => {
		plantLiveLock(gate().lock, "another-report.js");
		expect(periodicReading(gate(), () => "read").ran).toBe(true);
	});

	it("reads once a round with two takers at one instant over a stale lock", async () => {
		/* #4016's criterion. */
		const Rounds = 150;
		/* Guesses: a round's hold of 15 ms, a gap wide enough that a late taker
		 * stays in its round, and half a second for both processes to load. */
		const HoldMs = 15;
		const GapMs = 40;
		const LoadMs = 500;
		/* Spins only for the last of the wait, so the barrier stays sharp without
		 * two cores spinning for the whole test. */
		const SpinMs = 2;
		const taker = path.join(dir, SCRIPT);
		/* Each taker waits for its round's instant, then reads for HoldMs behind
		 * the gate; `inside` is created exclusively, so an overlap cannot pass
		 * unseen, whatever either clock says. */
		fs.writeFileSync(
			taker,
			`const fs = require("node:fs");
const path = require("node:path");
const { periodicReading } = require(${JSON.stringify(require.resolve("./periodic-reading.js"))});
const { sleepSync } = require(${JSON.stringify(require.resolve("./sleep-sync.js"))});
const [root, startAt] = process.argv.slice(2);
for (let round = 0; round < ${Rounds}; round++) {
	const at = Number(startAt) + round * ${GapMs};
	const rest = at - Date.now() - ${SpinMs};
	if (rest > 0) sleepSync(rest);
	while (Date.now() < at);
	const dir = path.join(root, String(round));
	periodicReading(
		{ stamp: path.join(dir, "stamp"), lock: path.join(dir, "lock"), script: ${JSON.stringify(SCRIPT)}, nowMs: Date.now(), everyMs: ${DAY_MS} },
		() => {
			try {
				fs.writeFileSync(path.join(dir, "inside"), "", { flag: "wx" });
			} catch {
				fs.appendFileSync(path.join(root, "overlaps"), round + "\\n");
			}
			fs.appendFileSync(path.join(dir, "reads"), "x");
			sleepSync(${HoldMs});
			fs.rmSync(path.join(dir, "inside"), { force: true });
		},
	);
}
`,
		);
		const dead = endedPid();
		for (let round = 0; round < Rounds; round++) {
			fs.mkdirSync(path.join(dir, String(round)));
			fs.writeFileSync(path.join(dir, String(round), "lock"), dead);
		}
		const startAt = Date.now() + LoadMs;
		const finished = [0, 1].map(
			() =>
				new Promise<number | null>((resolve) => {
					spawn(process.execPath, [taker, dir, String(startAt)], {
						stdio: "ignore",
					}).on("exit", resolve);
				}),
		);
		expect(await Promise.all(finished)).toEqual([0, 0]);
		expect(fs.existsSync(path.join(dir, "overlaps"))).toBe(false);
		for (let round = 0; round < Rounds; round++)
			expect(
				fs.readFileSync(path.join(dir, String(round), "reads"), "utf8"),
			).toBe("x");
	}, 60_000);
});
