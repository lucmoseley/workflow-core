/*
 * The fake of `/proc/meminfo` a program test points `WFC_MEMINFO` or
 * `MEMWATCH_MEMINFO` at, held to the real file and to lib/meminfo.js's parser
 * by lib/meminfo.contract.test.ts (#3093).
 */

export const MEMINFO_KEYS = [
	"MemTotal",
	"MemAvailable",
	"SwapTotal",
	"SwapFree",
] as const;

/* Memory outside every process listing, on memwatch's minute line (#4641). */
export const MEMINFO_BREAKDOWN_KEYS = [
	"AnonPages",
	"Shmem",
	"SUnreclaim",
	"KernelStack",
	"PageTables",
	"Unevictable",
] as const;

/**
 * A meminfo reporting these readings, in MB, with a 10 GB MemTotal: the
 * machine's cap (docs/environment.md). Each breakdown key given, in kB, adds
 * its line; one left out is absent, as from a kernel that omits it.
 */
export function buildMeminfo(
	mb: {
		availableMb: number;
		swapTotalMb: number;
		swapFreeMb: number;
	},
	breakdownKb: Partial<
		Record<(typeof MEMINFO_BREAKDOWN_KEYS)[number], number>
	> = {},
) {
	const kb: Record<(typeof MEMINFO_KEYS)[number], number> = {
		MemTotal: 10_240 * 1024,
		MemAvailable: mb.availableMb * 1024,
		SwapTotal: mb.swapTotalMb * 1024,
		SwapFree: mb.swapFreeMb * 1024,
	};
	const lines: [string, number][] = [
		...MEMINFO_KEYS.map((k): [string, number] => [k, kb[k]]),
		...MEMINFO_BREAKDOWN_KEYS.flatMap((k): [string, number][] =>
			breakdownKb[k] === undefined ? [] : [[k, breakdownKb[k]]],
		),
	];
	return lines.map(([k, v]) => `${k}:${" ".repeat(8)}${v} kB\n`).join("");
}
