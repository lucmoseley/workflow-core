/*
 * headless-runs-testkit.ts — a headless run's `run.json` written straight into
 * a refill dir's store (lib/headless-sessions.js), for a suite that needs a
 * run listed live or ended without launching one (#2608).
 */

import fs from "node:fs";
import path from "node:path";
import { readCurrentBootId, readProcStartOf } from "./arbiter-proc.js";

/** The run store under a refill dir, as lib/headless-sessions.js places it. */
export const headlessStore = (refill: string) =>
	path.join(refill, ".headless-runs");

/**
 * A run live as this very process, or ended (its start time no longer
 * matches); `over` replaces any record field. Returns the run's directory.
 */
export function writeHeadlessRun(
	refill: string,
	jobId: string,
	sessionId: string,
	{ live = true, ...over }: { live?: boolean } & Record<string, unknown> = {},
) {
	const dir = path.join(headlessStore(refill), jobId);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "run.json"),
		JSON.stringify({
			jobId,
			sessionId,
			pid: process.pid,
			procStart: live ? readProcStartOf(process.pid) : "0",
			bootId: readCurrentBootId(),
			pgid: process.pid,
			cwd: refill,
			launchedAt: 1000,
			...over,
		}),
	);
	return dir;
}
