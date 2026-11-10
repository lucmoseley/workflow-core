/*
 * A stalled boot's kernel log, a /proc/config.gz, and a run of
 * check-kernel-stall.js on both, for its tests and contracts (#4081).
 */
import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { buildKernelLine } from "./journalctl-fake";
import { runInProcess } from "./run-in-process.js";
import { writeSchedClock } from "./sched-clock-fake";

const KERNEL_STALL = path.join(__dirname, "..", "check-kernel-stall.js");

/** A boot's banner and one stall with its `t`, as `journalctl -k` prints them. */
export const stallBootLines = (
	bootMs: number,
	stallMs: number,
	jiffies: number,
) => [
	buildKernelLine(bootMs, "Booting Linux on physical CPU 0x0"),
	buildKernelLine(stallMs, "rcu: INFO: rcu_preempt self-detected stall on CPU"),
	buildKernelLine(
		stallMs,
		`rcu: \t(t=${jiffies} jiffies g=29441 q=149 ncpus=8)`,
	),
];

/** A gzipped kernel config at `at` naming `hz`. Its path, for WFC_KERNEL_CONFIG. */
export function writeKernelConfig(at: string, hz: number): string {
	fs.writeFileSync(at, gzipSync(`CONFIG_HZ_${hz}=y\nCONFIG_HZ=${hz}\n`));
	return at;
}

/** The figures --json gives for one large stall stamped now, read under `env`. */
export function readStallNow(
	dir: string,
	env: Record<string, string>,
): { tS: number | null; windowsUptimeS: number | null } {
	const now = Date.now();
	const log = path.join(dir, "kernel.log");
	const lines = stallBootLines(now - 60_000, now, 9_435_698);
	fs.writeFileSync(log, `${lines.join("\n")}\n`);
	const r = runInProcess(KERNEL_STALL, ["--json"], {
		env: {
			...process.env,
			WFC_KERNEL_LOG: log,
			WFC_KERNEL_CONFIG: writeKernelConfig(path.join(dir, "config.gz"), 250),
			WFC_WEVTUTIL: path.join(dir, "no-wevtutil"),
			WFC_SCHED_CLOCK: writeSchedClock(path.join(dir, "clock"), {
				runtime: 2,
				busy: 2,
			}),
			...env,
		},
	});
	return JSON.parse(r.stdout).stallFigures[0];
}
