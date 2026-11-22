import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REAL_PROC } from "./proc-root.js";
import { FIELD } from "./proc-stat.js";
import { USER_HZ } from "./proc-table.js";

const { launchEnv } = require("./suite-handoff.js") as {
	launchEnv: (launch: object) => Record<string, string>;
};

export function buildLaunchEntry(launch: object): string {
	const [entry] = Object.entries(launchEnv(launch));
	if (!entry) throw new Error("proc-fake: launchEnv wrote no entry");
	return `${entry[0]}=${entry[1]}`;
}

export function writeEnviron(
	proc: string,
	pid: number,
	entries: string[],
): number {
	fs.mkdirSync(path.join(proc, String(pid)), { recursive: true });
	fs.writeFileSync(path.join(proc, String(pid), "environ"), entries.join("\0"));
	return pid;
}

export function writeCwd(proc: string, pid: string, cwd: string): string {
	fs.mkdirSync(path.join(proc, pid), { recursive: true });
	fs.rmSync(path.join(proc, pid, "cwd"), { force: true });
	fs.symlinkSync(cwd, path.join(proc, pid, "cwd"));
	return pid;
}

export function carrying(
	proc: string,
	pid: number,
	launch: object | null,
): number {
	return writeEnviron(proc, pid, [
		"PATH=/bin",
		...(launch ? [buildLaunchEntry(launch)] : []),
	]);
}

// https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html
const STAT_TAIL = 50;

const UPTIME = 200_000;

export interface ProcSpec {
	ppid?: number;
	pgid?: number;
	state?: string;
	comm?: string;
	argv?: string | string[];
	ageS?: number;
	utime?: number;
	stat?: string;
}

export function buildStatLine(
	pid: number,
	{
		comm = "bash",
		state = "S",
		ppid = 1,
		pgid = pid,
		utime = 0,
		startTicks,
	}: {
		comm?: string;
		state?: string;
		ppid?: number;
		pgid?: number;
		utime?: number;
		startTicks: number;
	},
) {
	const tail: (string | number)[] = new Array(STAT_TAIL).fill(0);
	tail[FIELD.state] = state;
	tail[FIELD.ppid] = ppid;
	tail[FIELD.pgrp] = pgid;
	tail[FIELD.utime] = utime;
	tail[FIELD.start] = startTicks;
	return `${pid} (${comm}) ${tail.join(" ")}\n`;
}

export const buildSmapsRollup = ({
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

export function writeSmapsRollup(proc: string, pid: string, pssKb: number) {
	fs.mkdirSync(path.join(proc, pid), { recursive: true });
	fs.writeFileSync(
		path.join(proc, pid, "smaps_rollup"),
		buildSmapsRollup({ pssKb }),
	);
}

export const buildLoadavgLine = (load1: number) =>
	`${load1.toFixed(2)} 1.00 1.00 2/300 1\n`;

export const buildUptimeLine = (seconds: number) =>
	`${seconds.toFixed(2)} ${seconds.toFixed(2)}\n`;

export function writeGuestDisk(
	proc: string,
	sizeBytes: number,
	device = "sdd",
): void {
	fs.mkdirSync(path.join(proc, "self"), { recursive: true });
	fs.writeFileSync(
		path.join(proc, "self/mountinfo"),
		[
			"72 1 0:30 / /usr/lib/modules rw - overlay none rw",
			`88 72 8:48 / / rw,relatime - ext4 /dev/${device} rw,discard`,
			"",
		].join("\n"),
	);
	fs.writeFileSync(
		path.join(proc, "partitions"),
		`major minor  #blocks  name\n\n   8       32    2097156 sdc\n   8       48 ${sizeBytes / 1024} ${device}\n`,
	);
}

export function makeProcRoot(uptime = UPTIME) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "proc-fake-"));
	fs.writeFileSync(path.join(root, "uptime"), buildUptimeLine(uptime));

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
			stat ?? buildStatLine(pid, { ...fields, startTicks }),
		);
	}

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
