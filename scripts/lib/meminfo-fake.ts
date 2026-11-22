export const MEMINFO_KEYS = [
	"MemTotal",
	"MemFree",
	"MemAvailable",
	"SwapTotal",
	"SwapFree",
] as const;

export const MEMINFO_BREAKDOWN_KEYS = [
	"AnonPages",
	"Cached",
	"Buffers",
	"Shmem",
	"SReclaimable",
	"SUnreclaim",
	"KernelStack",
	"PageTables",
	"Unevictable",
] as const;

const MACHINE_CAP_MB = 10_240;

export function buildMeminfo(
	mb: {
		availableMb: number;
		swapTotalMb: number;
		swapFreeMb: number;
		freeMb?: number;
	},
	breakdownKb: Partial<
		Record<(typeof MEMINFO_BREAKDOWN_KEYS)[number], number>
	> = {},
) {
	const kb: Record<(typeof MEMINFO_KEYS)[number], number> = {
		MemTotal: MACHINE_CAP_MB * 1024,
		MemFree: (mb.freeMb ?? 0) * 1024,
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
