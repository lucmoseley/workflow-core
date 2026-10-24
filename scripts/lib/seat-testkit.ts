/*
 * A fake home's three seats, for tests of the readers that take arbiter-store's
 * `configDirs()` as their seat set.
 */

import path from "node:path";

/** The fake home's three seats, in `configDirs()`' default order. */
export const seatDirs = (home: string): string[] =>
	[".claude", ".claude2", ".claude3"].map((d) => path.join(home, d));

/** A spawned script's env for the same seats: `configDirs()` reads
 *  CLAUDE_CONFIG_DIR and the three knobs, never HOME. */
export const seatEnv = (home: string): Record<string, string> => ({
	CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
	WFC_CLAUDE_CONFIG_A: "",
	WFC_CLAUDE_CONFIG_B: "",
	WFC_CLAUDE_CONFIG_C: "",
});
