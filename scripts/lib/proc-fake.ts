/*
 * proc-fake.ts — the fake `/proc` a program test points WFC_PROC at: one
 * directory a process, with the carried-weight reader's `environ`
 * NUL-separated as the kernel's is (#2948); the orphan sweeps' stat and
 * cmdline and the machine's uptime (#3057); the spare-pair test's `cwd` link
 * (#2502); and admission's `smaps_rollup`, with WFC_LOADAVG the machine's
 * load (#3342). proc.contract.test.ts holds them all
 * to the kernel's.
 *
 * FOR TESTS ONLY.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REAL_PROC } from "./proc-root.js";
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

/** A `smaps_rollup` as the kernel writes it: the rollup's header, then its
 * Rss, Pss, Pss_Dirty and Shared_Clean lines in the kernel's order. The
 * default Rss is one no test charges and the Pss_Dirty line follows Pss, so a
 * reader taking Rss, the last line or a `Pss`-prefixed line in place of Pss
 * fails. */
export const smapsRollup = ({
	rssKb = 999_999,
	pssKb,
	pssDirtyKb = 0,
	sharedCleanKb = 0,
}: {
	rssKb?: number;
	pssKb: number;
	pssDirtyKb?: number;
	sharedCleanKb?: number;
}) =>
	[
		"00400000-ffffffffffff ---p 00000000 00:00 0                          [rollup]",
		...Object.entries({
			Rss: rssKb,
			Pss: pssKb,
			Pss_Dirty: pssDirtyKb,
			Shared_Clean: sharedCleanKb,
		}).map(
			([key, kb]) => `${`${key}:`.padEnd(16)}${String(kb).padStart(8)} kB`,
		),
		"",
	].join("\n");

/** Process `pid` under `proc`, its `smaps_rollup` charging `pssKb`. */
export function writeSmapsRollup(proc: string, pid: string, pssKb: number) {
	fs.mkdirSync(path.join(proc, pid), { recursive: true });
	fs.writeFileSync(
		path.join(proc, pid, "smaps_rollup"),
		smapsRollup({ pssKb }),
	);
}

/** `load1` as the kernel writes /proc/loadavg: three loads, the running and
 * total task counts, and the newest pid. */
export const loadavgLine = (load1: number) =>
	`${load1.toFixed(2)} 1.00 1.00 2/300 1\n`;

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
		fs.symlinkSync(`${REAL_PROC}/${pid}`, path.join(root, String(pid)));
	}

	return {
		root,
		uptime,
		proc,
		real,
		remove: () => fs.rmSync(root, { recursive: true, force: true }),
	};
}
