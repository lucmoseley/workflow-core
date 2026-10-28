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
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkScratchDir } from "./git-fixture";
import {
	launchEntry,
	loadavgLine,
	makeProcRoot,
	smapsRollup,
	statLine,
	uptimeLine,
	writeCwd,
	writeEnviron,
} from "./proc-fake";
import { parseStatFields } from "./proc-stat.js";
import { ageSeconds, readProcTable, readUptime } from "./proc-table.js";

const { readCarriedWeight } = require("./suite-handoff.js") as {
	readCarriedWeight: (
		pid: number | null,
		proc?: string,
	) => { resolvedFiles: number | null; wholeSlot: boolean } | null;
};

const { readProcCwd } = require("./claude-sessions.js") as {
	readProcCwd: (pid: string, proc?: string) => string | null;
};

const { readTreePssKb } = require("./admission.js") as {
	readTreePssKb: (pid: number) => number;
};

const { sample } = require("./cpu-sample.js") as {
	sample: () => { load1: number | null } | null;
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

describe.skipIf(!hasProc)("a fake cwd link (needs Linux /proc)", () => {
	it("reads back through readProcCwd as a real process's does", () => {
		const fake = mkScratchDir("proc-cwd-");
		try {
			const pid = String(process.pid);
			writeCwd(fake, pid, process.cwd());
			expect(readProcCwd(pid, fake)).toBe(readProcCwd(pid));
			expect(readProcCwd(pid)).toBe(fs.realpathSync(process.cwd()));
		} finally {
			fs.rmSync(fake, { recursive: true, force: true });
		}
	});
});

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

		expect(
			parseStatFields(statLine(process.pid, { comm, ...live })),
		).toHaveLength(parseStatFields(realStat)?.length ?? -1);
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

describe.skipIf(!hasProc)("a fake smaps_rollup (needs Linux /proc)", () => {
	it("writes its lines as the real rollup holds them, in order, and reads back", () => {
		const real = fs.readFileSync(`/proc/${process.pid}/smaps_rollup`, "utf8");
		const kb = (key: string) =>
			Number(real.match(new RegExp(`^${key}:\\s+(\\d+) kB$`, "m"))?.[1]);
		const built = smapsRollup({
			rssKb: kb("Rss"),
			pssKb: kb("Pss"),
			pssDirtyKb: kb("Pss_Dirty"),
			sharedCleanKb: kb("Shared_Clean"),
		});
		const realLines = real.split("\n");
		const [header, ...lines] = built.split("\n").filter(Boolean);
		const rollupHeader = /^[0-9a-f]+-[0-9a-f]+ ---p 0+ 00:00 0 +\[rollup\]$/;

		expect(realLines[0]).toMatch(rollupHeader);
		expect(header).toMatch(rollupHeader);
		const at = lines.map((line) => realLines.indexOf(line));
		expect(at).not.toContain(-1);
		expect(at).toEqual([...at].sort((a, b) => a - b));

		const fake = mkScratchDir("proc-smaps-");
		try {
			fs.mkdirSync(`${fake}/${process.pid}`);
			fs.writeFileSync(`${fake}/${process.pid}/smaps_rollup`, built);
			vi.stubEnv("WFC_PROC", fake);
			expect(readTreePssKb(process.pid)).toBe(kb("Pss"));
		} finally {
			fs.rmSync(fake, { recursive: true, force: true });
		}
	});
});

describe.skipIf(!hasProc)("a fake loadavg line (needs Linux /proc)", () => {
	it("has the real line's shape, and reads back as the real one does", () => {
		const shape = /^\d+\.\d\d \d+\.\d\d \d+\.\d\d \d+\/\d+ \d+\n$/;
		expect(fs.readFileSync("/proc/loadavg", "utf8")).toMatch(shape);
		expect(loadavgLine(3.5)).toMatch(shape);
		vi.stubEnv("WFC_LOADAVG", "");
		expect(Number.isFinite(sample()?.load1)).toBe(true);

		const fake = mkScratchDir("proc-loadavg-");
		try {
			fs.writeFileSync(`${fake}/loadavg`, loadavgLine(3.5));
			vi.stubEnv("WFC_LOADAVG", `${fake}/loadavg`);
			expect(sample()?.load1).toBe(3.5);
		} finally {
			fs.rmSync(fake, { recursive: true, force: true });
		}
	});
});
