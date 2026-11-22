import fs from "node:fs";
import path from "node:path";
import { readCurrentBootId, readProcStartOf } from "./arbiter-proc.js";

export const headlessStore = (refill: string) =>
	path.join(refill, ".headless-runs");

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
