// @vitest-environment node
/*
 * proc-fake.ts's contract (§G7). For the carried-weight reader (#2948), each
 * case's environment is given to a real `sleep` and written to the fake
 * `/proc`, and `readCarriedWeight` must read the same weight off both. A fake
 * that drifts from the kernel's `environ` keeps every weigher test green while
 * production reads nothing.
 *
 * For the orphan sweeps (#3057), this process, written into a fake root with
 * the fields the real /proc gives it, reads back through lib/proc-table.js
 * exactly as it reads from /proc — and those fields are checked against what
 * Node knows of this process, so a field the parser and the fake both
 * misplace still fails.
 */

import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { mkScratchDir } from "./git-fixture";
import {
	launchEntry,
	makeProcRoot,
	statLine,
	uptimeLine,
	writeEnviron,
} from "./proc-fake";
import { statFields } from "./proc-stat.js";
import { ageSeconds, readProcTable, readUptime } from "./proc-table.js";

const { readCarriedWeight } = require("./suite-handoff.js") as {
	readCarriedWeight: (
		pid: number | null,
		proc?: string,
	) => { resolvedFiles: number | null; wholeSlot: boolean } | null;
};

const PATH = `PATH=${process.env.PATH ?? "/bin"}`;

const CASES: [string, string[]][] = [
	["a part-suite", [PATH, launchEntry({ resolvedFiles: 7, wholeSlot: false })]],
	[
		"a whole run",
		[PATH, launchEntry({ resolvedFiles: null, wholeSlot: true })],
	],
	["no record", [PATH]],
	["a record carrying no weight", [PATH, launchEntry({ isolated: true })]],
];

const hasProc = fs.existsSync("/proc/self/environ");

describe.skipIf(!hasProc)(
	"the fake /proc against a real process's (needs Linux /proc)",
	() => {
		const fake = mkScratchDir("proc-");
		const children: ChildProcess[] = [];
		afterEach(() => {
			for (const child of children.splice(0)) child.kill();
		});
		afterAll(() => fs.rmSync(fake, { recursive: true, force: true }));

		it.each(CASES)("reads %s the same off both", async (_what, entries) => {
			const env = Object.fromEntries(
				entries.map((e) => [
					e.slice(0, e.indexOf("=")),
					e.slice(e.indexOf("=") + 1),
				]),
			);
			const child = spawn("sleep", ["30"], { env, stdio: "ignore" });
			children.push(child);
			await new Promise((resolve) => child.once("spawn", resolve));
			const pid = child.pid as number;
			expect(readCarriedWeight(writeEnviron(fake, pid, entries), fake)).toEqual(
				readCarriedWeight(pid, "/proc"),
			);
		});
	},
);

const realStat = hasProc
	? fs.readFileSync(`/proc/${process.pid}/stat`, "utf8")
	: "";
const comm = realStat.slice(
	realStat.indexOf("(") + 1,
	realStat.lastIndexOf(")"),
);

function readLive() {
	const live = readProcTable("/proc")?.procs.get(process.pid);
	const uptime = readUptime("/proc");
	if (!live || uptime === null) throw new Error("/proc did not read");
	return { live, uptime };
}

describe.skipIf(!hasProc)("a fake /proc entry for this process", () => {
	let fake: ReturnType<typeof makeProcRoot>;
	afterEach(() => fake.remove());

	it("reads its parent and age from the fields Node reports", () => {
		fake = makeProcRoot();
		const { live, uptime } = readLive();

		expect(live.ppid).toBe(process.ppid);
		/* Pins the start-time field and USER_HZ: a second covers the time
		 * between vitest's spawn of this worker and its first line. */
		expect(Math.abs(ageSeconds(live, uptime) - process.uptime())).toBeLessThan(
			2,
		);
	});

	it("writes stat and uptime lines shaped as the kernel writes them", () => {
		fake = makeProcRoot();
		const { live } = readLive();
		const realUptime = fs.readFileSync("/proc/uptime", "utf8");

		expect(statFields(statLine(process.pid, { comm, ...live }))).toHaveLength(
			statFields(realStat)?.length ?? -1,
		);
		expect(uptimeLine(Number.parseFloat(realUptime))).toMatch(
			/^\d+\.\d\d \d+\.\d\d\n$/,
		);
		expect(realUptime).toMatch(/^\d+\.\d\d \d+\.\d\d\n$/);
	});

	it("reads back through readProcTable as it reads from /proc", () => {
		const { live, uptime } = readLive();
		fake = makeProcRoot(uptime);
		const { ppid, pgid, argv } = live;
		fake.proc(process.pid, {
			ppid,
			pgid,
			comm,
			argv,
			ageS: ageSeconds(live, uptime),
		});

		expect(readProcTable(fake.root)?.procs.get(process.pid)).toEqual(live);
		expect(readUptime(fake.root)).toBe(uptime);
	});
});
