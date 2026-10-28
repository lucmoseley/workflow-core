/*
 * proc-fake.ts — the fake `/proc` a program test points its procfs seam at:
 * the carried-weight reader's WFC_PROC (#2948), one directory a process, its
 * `environ` NUL-separated as the kernel's is; and the orphan sweeps'
 * WFC_PROC_ROOT (#3057), each process's stat and cmdline and the machine's
 * uptime; and the spare-pair test's WFC_PROC (#2502), each process's `cwd`
 * link. proc.contract.test.ts holds all three to the kernel's.
 *
 * FOR TESTS ONLY.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FIELD } from "./proc-stat.js";
import { USER_HZ } from "./proc-table.js";

const { launchEnv } = require("./suite-handoff.js") as {
	launchEnv: (launch: object) => Record<string, string>;
};

/** A launch record as an environment entry, `KEY=value`. */
export function launchEntry(launch: object): string {
	const [entry] = Object.entries(launchEnv(launch));
	if (!entry) throw new Error("proc-fake: launchEnv wrote no entry");
	return `${entry[0]}=${entry[1]}`;
}

/** Process `pid` under `proc`, its environment holding `entries`. */
export function writeEnviron(
	proc: string,
	pid: number,
	entries: string[],
): number {
	fs.mkdirSync(path.join(proc, String(pid)), { recursive: true });
	fs.writeFileSync(path.join(proc, String(pid), "environ"), entries.join("\0"));
	return pid;
}

/** Process `pid` under `proc`, its cwd `cwd`, replacing any link before it. */
export function writeCwd(proc: string, pid: string, cwd: string): string {
	fs.mkdirSync(path.join(proc, pid), { recursive: true });
	fs.rmSync(path.join(proc, pid, "cwd"), { force: true });
	fs.symlinkSync(cwd, path.join(proc, pid, "cwd"));
	return pid;
}

/** Process `pid` under `proc`, carrying `launch`'s record, or none. */
export function carrying(
	proc: string,
	pid: number,
	launch: object | null,
): number {
	return writeEnviron(proc, pid, [
		"PATH=/bin",
		...(launch ? [launchEntry(launch)] : []),
	]);
}

/* Fields in a stat line after the comm: proc(5)'s fields 3 to 52. */
const STAT_TAIL = 50;

/* The fake machine's seconds since boot: any figure above every age a test
 * asks for. */
const UPTIME = 200_000;

export interface ProcSpec {
	ppid?: number;
	pgid?: number;
	state?: string;
	comm?: string;
	/** Words joined by NUL, as the kernel writes cmdline; a string splits on spaces. */
	argv?: string | string[];
	/** Seconds since it started. A guess at a typical orphan's: an hour. */
	ageS?: number;
	/** A stat line written as given, in place of the built one. */
	stat?: string;
}

/** One stat line: `pid (comm)`, its state, parent, group and start time, and
 * zeros for every other field. */
export function statLine(
	pid: number,
	{
		comm = "bash",
		state = "S",
		ppid = 1,
		pgid = pid,
		startTicks,
	}: {
		comm?: string;
		state?: string;
		ppid?: number;
		pgid?: number;
		startTicks: number;
	},
) {
	const tail: (string | number)[] = new Array(STAT_TAIL).fill(0);
	tail[FIELD.state] = state;
	tail[FIELD.ppid] = ppid;
	tail[FIELD.pgrp] = pgid;
	tail[FIELD.start] = startTicks;
	return `${pid} (${comm}) ${tail.join(" ")}\n`;
}

/** `seconds` as the kernel writes /proc/uptime: uptime, then idle time. */
export const uptimeLine = (seconds: number) =>
	`${seconds.toFixed(2)} ${seconds.toFixed(2)}\n`;

/** A fresh /proc root on a machine `uptime` seconds up, and its writer. */
export function makeProcRoot(uptime = UPTIME) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "proc-fake-"));
	fs.writeFileSync(path.join(root, "uptime"), uptimeLine(uptime));

	function proc(
		pid: number,
		{ argv = "bash", ageS = 3600, stat, ...fields }: ProcSpec = {},
	) {
		const dir = path.join(root, String(pid));
		fs.mkdirSync(dir, { recursive: true });
		const words = Array.isArray(argv) ? argv : argv.split(" ");
		fs.writeFileSync(path.join(dir, "cmdline"), `${words.join("\0")}\0`);
		const startTicks = Math.round((uptime - ageS) * USER_HZ);
		fs.writeFileSync(
			path.join(dir, "stat"),
			stat ?? statLine(pid, { ...fields, startTicks }),
		);
	}

	/** Show the real process `pid` in the root, read live through /proc. */
	function real(pid: number) {
		fs.symlinkSync(`/proc/${pid}`, path.join(root, String(pid)));
	}

	return {
		root,
		uptime,
		proc,
		real,
		remove: () => fs.rmSync(root, { recursive: true, force: true }),
	};
}
