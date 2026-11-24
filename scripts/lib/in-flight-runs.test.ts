// @vitest-environment node

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mkScratchDir } from "./git-fixture";

const { readInFlightRuns, recordRun } = require("./in-flight-runs.js");
const { main } = require("../in-flight-runs.js") as {
	main: (
		argv: string[],
		options: {
			env?: NodeJS.ProcessEnv;
			read?: (session: string) => unknown;
			out?: (s: string) => void;
			err?: (s: string) => void;
			wait?: {
				ceilingS?: number;
				pollMs?: number;
				clock?: () => number;
				sleep?: (ms: number) => Promise<void>;
			};
		},
	) => Promise<number>;
};

const S = "sess-own";
const T = "sess-neighbour";
const AT = Date.parse("2026-11-24T10:00:00.000Z");

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0))
		fs.rmSync(d, { recursive: true, force: true });
});

function queueDir() {
	const d = mkScratchDir("in-flight-");
	dirs.push(d);
	return path.join(d, "wfc-suite-queue");
}

const dead = new Set<number>();
const alive = (pid: number) => !dead.has(pid);

function join(
	dir: string,
	pid: number,
	{
		session = S,
		args = [] as string[],
		at = AT,
	}: { session?: string; args?: string[]; at?: number } = {},
) {
	return recordRun({ session, args, queueDir: dir, pid, clock: () => at });
}

const read = (dir: string, session = S) =>
	readInFlightRuns(session, { queueDir: dir, alive });

afterEach(() => dead.clear());

describe("the session's in-flight test runs, read from the launcher's run records (#5717)", () => {
	it("says so on stderr where its record will not write, and records nothing", () => {
		const dir = queueDir();
		fs.mkdirSync(path.dirname(dir), { recursive: true });
		fs.writeFileSync(dir, "a file where the queue directory goes");
		const warned: string[] = [];
		const drop = recordRun({
			session: S,
			args: [],
			queueDir: dir,
			pid: 11,
			warn: (t: string) => warned.push(t),
		});
		drop();
		expect(warned.join("")).toMatch(
			/^run-vitest: could not write this run's record \(.+\), so a rerun or commit meanwhile is not refused, nor waited on \(#5716\)\.\n$/,
		);
		expect(read(dir)).toBeNull();
	});

	it("returns each live run with its pid, start time, command and lane, oldest first", () => {
		const dir = queueDir();
		join(dir, 12, { args: ["--queue", "a.test.ts"], at: AT + 1000 });
		join(dir, 11, { args: ["--queue"] });
		expect(read(dir)).toEqual([
			{
				pid: 11,
				startedAt: AT,
				command: "npm run test -- --queue",
				lane: "touched",
			},
			{
				pid: 12,
				startedAt: AT + 1000,
				command: "npm run test -- --queue a.test.ts",
				lane: "named",
			},
		]);
	});

	it.each([
		[["--queue", "--full=suite-edit"], "full"],
		[["--queue", "--shared"], "shared"],
		[["--isolated"], "isolated"],
		[["--queue", "--changed"], "changed"],
		[["--retest"], "touched"],
		[[], "touched"],
	])("tells %j's lane", (args, lane) => {
		const dir = queueDir();
		join(dir, 11, { args });
		expect(read(dir)?.map((r: { lane: string }) => r.lane)).toEqual([lane]);
	});

	it("counts nothing for a dead pid, another session's run or a sessionless one", () => {
		const dir = queueDir();
		join(dir, 11);
		dead.add(11);
		join(dir, 12, { session: T });
		join(dir, 13, { session: "" });
		expect(read(dir)).toEqual([]);
	});

	it("deletes a dead run's record, whichever session it was", () => {
		const dir = queueDir();
		join(dir, 11, { session: T });
		dead.add(11);
		expect(read(dir)).toEqual([]);
		expect(fs.readdirSync(dir)).toEqual([]);
	});

	it("keeps a live run's record whose start time will not read, counting it for nothing", () => {
		const dir = queueDir();
		join(dir, process.pid);
		expect(
			readInFlightRuns(S, {
				queueDir: dir,
				alive: () => true,
				startTime: () => 0,
			}),
		).toEqual([]);
		expect(fs.readdirSync(dir)).toHaveLength(1);
	});

	it("drops a run's record when the run ends", () => {
		const dir = queueDir();
		const drop = join(dir, 11);
		expect(read(dir)).toHaveLength(1);
		drop();
		expect(read(dir)).toEqual([]);
	});

	it("never reads a suite-queue place as a run", () => {
		const dir = queueDir();
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "wfc-suite-queue-11.json"),
			JSON.stringify({ pid: 11, at: AT, session: S }),
		);
		expect(read(dir)).toEqual([]);
	});

	it("counts nothing for a stale record whose pid was reused", () => {
		const dir = queueDir();
		join(dir, process.pid);
		expect(
			readInFlightRuns(S, {
				queueDir: dir,
				alive: () => true,
				startTime: () => -1,
			}),
		).toEqual([]);
	});

	it("reads no runs from a queue directory never made", () => {
		expect(read(queueDir())).toEqual([]);
	});

	it("answers null, not no runs, where the directory will not read", () => {
		const dir = queueDir();
		fs.mkdirSync(path.dirname(dir), { recursive: true });
		fs.writeFileSync(dir, "not a directory");
		expect(read(dir)).toBeNull();
	});
});

describe("the background-job wait (#5716)", () => {
	const said = () => {
		const out: string[] = [];
		const err: string[] = [];
		return {
			out,
			err,
			io: {
				out: (s: string) => out.push(s),
				err: (s: string) => err.push(s),
			},
		};
	};
	const env = { CLAUDE_CODE_SESSION_ID: S };

	it("waits until the session holds no live touched, named or isolated run, then exits 0 saying so", async () => {
		const dir = queueDir();
		join(dir, 11);
		join(dir, 12, { args: ["a.test.ts"] });
		join(dir, 13, { args: ["--full=suite-edit"] });
		join(dir, 14, { args: ["--isolated"] });
		let polls = 0;
		const s = said();
		const code = await main(["wait"], {
			env,
			read: (session) => readInFlightRuns(session, { queueDir: dir, alive }),
			...s.io,
			wait: {
				sleep: async () => {
					polls += 1;
					for (const pid of polls === 1 ? [11, 14] : [12]) dead.add(pid);
				},
			},
		});
		expect(code).toBe(0);
		expect(polls).toBe(2);
		expect(s.out.join("")).toBe(
			"DONE: this session holds no live touched, named, changed or isolated test run; read each run's notification for its verdict.\n",
		);
	});

	it("exits 5 at its ceiling, naming the run still held and saying to re-run the wait", async () => {
		const dir = queueDir();
		join(dir, 11, { args: ["--queue"] });
		let now = 0;
		const s = said();
		const code = await main(["wait"], {
			env,
			read: (session) => readInFlightRuns(session, { queueDir: dir, alive }),
			...s.io,
			wait: {
				clock: () => now,
				sleep: async (ms) => {
					now += ms;
				},
			},
		});
		expect(code).toBe(5);
		expect(now).toBe(540_000);
		expect(s.out.join("")).toBe(
			"CEILING: after 540 s this session still holds PID 11, started 2026-11-24T10:00:00.000Z, `npm run test -- --queue`; re-run this wait to keep waiting.\n",
		);
	});

	it("exits 4 where the queue will not read", async () => {
		const s = said();
		expect(await main(["wait"], { env, read: () => null, ...s.io })).toBe(4);
		expect(s.err.join("")).toMatch(/^UNREAD: the run records would not read/);
	});

	it("exits 2 on an unknown command, naming the usage", async () => {
		const s = said();
		expect(await main(["bogus"], { env, read: () => [], ...s.io })).toBe(2);
	});

	it("exits 2 with no session id", async () => {
		const s = said();
		expect(await main(["wait"], { env: {}, read: () => [], ...s.io })).toBe(2);
		expect(s.err.join("")).toContain("no session id");
	});
});
