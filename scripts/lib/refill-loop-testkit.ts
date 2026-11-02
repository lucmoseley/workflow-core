/*
 * refill-loop-testkit.ts — a live holder of the refill loop's pid lock, for the
 * program cases that read a running loop (#3927). It pins the one shape the lock
 * takes as held: pidLock reads the pid's command line for an argument whose
 * basename is `refill-loop.js`, so a pid file alone, or one naming this test's
 * own process, reads as a stopped loop. Hence a live process carrying that
 * argument. A break here turns every such case into a stopped loop's.
 */

import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** A live process holding the refill loop's pid lock in `refill`; the caller kills it. */
export function spawnLoopHolder(refill: string): ChildProcess {
	const holder = spawn(
		process.execPath,
		["-e", "setInterval(() => {}, 1000)", "refill-loop.js"],
		{ stdio: "ignore" },
	);
	fs.writeFileSync(path.join(refill, ".refill-loop.pid"), String(holder.pid));
	return holder;
}
