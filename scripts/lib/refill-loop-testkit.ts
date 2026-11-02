import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** A live process holding the refill loop's pid lock in `refill`; the caller kills it. */
export function spawnLoopHolder(refill: string): ChildProcess {
	/* pidLock takes a holder by an argument's basename. */
	const holder = spawn(
		process.execPath,
		["-e", "setInterval(() => {}, 1000)", "refill-loop.js"],
		{ stdio: "ignore" },
	);
	fs.writeFileSync(path.join(refill, ".refill-loop.pid"), String(holder.pid));
	return holder;
}
