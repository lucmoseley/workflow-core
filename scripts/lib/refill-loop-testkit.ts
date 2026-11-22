import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function spawnLoopHolder(refill: string): ChildProcess {
	const holder = spawn(
		process.execPath,
		["-e", "setInterval(() => {}, 1000)", "refill-loop.js"],
		{ stdio: "ignore" },
	);
	fs.writeFileSync(path.join(refill, ".refill-loop.pid"), String(holder.pid));
	return holder;
}
