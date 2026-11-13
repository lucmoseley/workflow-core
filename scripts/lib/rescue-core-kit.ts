/*
 * rescue-core-kit.ts — the module cases' fixtures for rescue-sessions' cores
 * (#5157): each core called in-process on lib/rescue-ports-fake.ts's ports,
 * a fake /proc from lib/proc-fake.ts, and the holder's transcript and job
 * record on disk, as lib/rescue-testkit.ts writes them for the program cases.
 *
 * The clock is the fake's: a probe's sleep between samples and a takeover's
 * confirmation polls advance it and return at once.
 */

import fs from "node:fs";
import { afterEach, beforeEach } from "vitest";
import type { Sandbox } from "./arbiter-testkit";
import { makeProcRoot } from "./proc-fake";
import { createRescuePorts } from "./rescue-ports-fake";
import { holderRow, type Row, type Run, rescueKit } from "./rescue-testkit";

const { ENTRIES, parseArgs } = require("./rescue-cli.js") as {
	ENTRIES: Record<string, () => (args: object, ports: object) => Promise<Run>>;
	parseArgs: (argv: string[]) => object;
};

export function rescueCoreKit(sb: Sandbox) {
	const files = rescueKit(sb);
	const { plan } = files;
	/* Minted per case, in beforeEach. */
	let proc = {} as ReturnType<typeof makeProcRoot>;
	let world = {} as ReturnType<typeof createRescuePorts>;
	const argvOf = new Map<number, { ppid: number; argv: string }>();

	beforeEach(() => {
		proc = makeProcRoot();
		world = createRescuePorts(proc.root);
		argvOf.clear();
	});
	afterEach(() => proc.remove());

	/** What `dir` lists, this session first; once stopped where `after`. */
	const lists = (rows: Row[], dir = plan(), after = false) =>
		world.lists(dir, rows, after);

	/** Process `pid` under `ppid`, `ticks` of user CPU spent, running `argv`. */
	const writeProc = (
		pid: number,
		ppid: number,
		ticks: number,
		argv: string,
	) => {
		argvOf.set(pid, { ppid, argv });
		proc.proc(pid, { ppid, utime: ticks, argv, comm: "x y" });
	};

	/** `pid` having spent `ticks` of user CPU by now. */
	const cpuTo = (pid: number, ticks: number) => {
		const was = argvOf.get(pid);
		if (!was) throw new Error(`no process ${pid} to spend CPU`);
		writeProc(pid, was.ppid, ticks, was.argv);
	};

	const removeProc = (pid: number) =>
		fs.rmSync(`${proc.root}/${pid}`, { recursive: true, force: true });

	/** files.ghostJob's job that never started, an hour old on the fake clock, listed through the fake. */
	const ghostJob = (
		intent: string,
		rows: Row[] = [holderRow({ pid: undefined })],
	) => {
		files.ghostJob(intent, rows, world.ports.now());
		lists([
			...rows,
			{ sessionId: "neighbour", kind: "background", state: "working", pid: 7 },
		]);
	};

	/** The core behind `sub`, given `argv` as the shell parses it, on the fake ports. */
	const run = (sub: string, argv: string[]): Promise<Run> => {
		const entry = ENTRIES[sub];
		if (!entry) throw new Error(`no core for ${sub}`);
		return entry()(parseArgs([sub, ...argv]), world.ports);
	};

	return {
		plan,
		transcript: files.transcript,
		writeTranscript: files.writeTranscript,
		jobState: files.jobState,
		procRoot: () => proc.root,
		world: () => world,
		lists,
		proc: writeProc,
		cpuTo,
		removeProc,
		ghostJob,
		run,
	};
}
