/*
 * A WFC_SCHED_CLOCK directory for scripts/check-kernel-stall.js (#2779): a
 * `before/` and an `after/` sample, each a `cgroup/` root with two children's
 * `cpu.stat` and a `stat`, in the real files' shape. `runtime` and `busy` are how
 * far the children's summed run time and the busy time move between them, in
 * CPU-seconds. The root's own `cpu.stat` moves with the busy time, as a true root's
 * does (rstat.c), so a reader of it would never see a freeze.
 */
import fs from "node:fs";
import path from "node:path";

const cpuStat = (seconds: number) =>
	`usage_usec ${Math.round(seconds * 1e6)}\nuser_usec 1\nsystem_usec 1\nnice_usec 0\n`;

export function writeCgroupRoot(root: string, runtimeS: number, rootS: number) {
	for (const child of ["user.slice", "system.slice"]) {
		fs.mkdirSync(path.join(root, child), { recursive: true });
		fs.writeFileSync(path.join(root, child, "cpu.stat"), cpuStat(runtimeS / 2));
	}
	fs.writeFileSync(path.join(root, "cpu.stat"), cpuStat(rootS));
	return root;
}

export function writeSchedClock(
	at: string,
	{ runtime, busy }: { runtime: number; busy: number },
): string {
	const sample = (name: string, runtimeS: number, busyS: number) => {
		writeCgroupRoot(path.join(at, name, "cgroup"), runtimeS, busyS);
		// busy split over user, nice and system ticks, at USER_HZ 100.
		const t = Math.round(busyS * 100);
		const third = Math.floor(t / 3);
		fs.writeFileSync(
			path.join(at, name, "stat"),
			`cpu  ${t - 2 * third} ${third} ${third} 900000 7 0 0 0 0 0\ncpu0 0 0 0 0 0 0 0 0 0 0\n`,
		);
	};
	sample("before", 5000, 5000);
	sample("after", 5000 + runtime, 5000 + busy);
	return at;
}
