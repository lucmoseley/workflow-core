// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endedPid } from "./arbiter-testkit";
import { keptSpawn } from "./kept-spawn.js";
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

	it("refuses a live holder running the script, however old its lock", async () => {
		await plantLiveLock(gate().lock, SCRIPT);
		expect(periodicReading(gate(), () => "read")).toEqual({
			ran: false,
			why: "locked",
		});
		expect(fs.existsSync(gate().stamp)).toBe(false);
	});

	it("takes over a live process that runs another script", async () => {
		await plantLiveLock(gate().lock, "another-report.js");
		expect(periodicReading(gate(), () => "read").ran).toBe(true);
	});

	it("reads once a round with two takers at one instant over a stale lock", async () => {
		// guess, #4016
		const Rounds = 150;
		// guess, #4016
		const HoldMs = 15;
		const GapMs = 40;
		const LoadMs = 500;
		// guess: spin only the wait's tail, #4016
		const SpinMs = 2;
		const taker = path.join(dir, SCRIPT);
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
					keptSpawn("concurrent")
						.spawn(process.execPath, [taker, dir, String(startAt)], {
							stdio: "ignore",
						})
						.on("exit", resolve);
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
