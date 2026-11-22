import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REFILL_STATE_FILE } from "./refill-dir.js";
import { type LoopState, readState } from "./refill-state.js";
import { withStubbedEnv } from "./scoped-env-testkit";

export function loopStateOf(
	raw: unknown,
	log: (line: string) => void = () => undefined,
): LoopState {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "refill-state-of-"));
	try {
		fs.writeFileSync(path.join(dir, REFILL_STATE_FILE), JSON.stringify(raw));
		return withStubbedEnv({ WFC_REFILL_DIR: dir }, () => readState(log));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}
