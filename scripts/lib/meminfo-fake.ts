/*
 * The fake of `/proc/meminfo` a program test points `WFC_MEMINFO` at, held to
 * the real file and to lib/meminfo.js's parser by
 * lib/meminfo.contract.test.ts (#3093).
 */

export const MEMINFO_KEYS = [
	"MemTotal",
	"MemAvailable",
	"SwapTotal",
	"SwapFree",
] as const;

/**
 * A meminfo reporting these readings, in MB, with a 10 GB MemTotal: the
 * machine's cap (docs/environment.md).
 */
export function buildMeminfo(mb: {
	availableMb: number;
	swapTotalMb: number;
	swapFreeMb: number;
}) {
	const kb: Record<(typeof MEMINFO_KEYS)[number], number> = {
		MemTotal: 10_240 * 1024,
		MemAvailable: mb.availableMb * 1024,
		SwapTotal: mb.swapTotalMb * 1024,
		SwapFree: mb.swapFreeMb * 1024,
	};
	return MEMINFO_KEYS.map((k) => `${k}:${" ".repeat(8)}${kb[k]} kB\n`).join("");
}
