/*
 * The refill loop's state as its one reader parses it (#4232): `raw` written
 * to a state file of its own and read back through readState, so a test builds
 * a LoopState by the route the loop reads one.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REFILL_STATE_FILE } from "./refill-dir.js";
import { type LoopState, readState } from "./refill-state.js";

export function loopStateOf(
	raw: unknown,
	log: (line: string) => void = () => undefined,
): LoopState {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "refill-state-of-"));
	const before = process.env.WFC_REFILL_DIR;
	try {
		fs.writeFileSync(path.join(dir, REFILL_STATE_FILE), JSON.stringify(raw));
		process.env.WFC_REFILL_DIR = dir;
		return readState(log);
	} finally {
		if (before === undefined) delete process.env.WFC_REFILL_DIR;
		else process.env.WFC_REFILL_DIR = before;
		fs.rmSync(dir, { recursive: true, force: true });
	}
}
