/*
 * A WFC_SCHED_CLOCK directory for scripts/check-kernel-stall.js (#2779): a
 * `before/` and an `after/` sample, each a `schedstat` and a `stat` in /proc's
 * shape, two CPUs. `rq` and `busy` are how far the summed run-queue clocks and
 * the busy time move between them, in CPU-seconds.
 */
import fs from "node:fs";
import path from "node:path";

export function writeSchedClock(
	at: string,
	{ rq, busy }: { rq: number; busy: number },
): string {
	const sample = (name: string, rqS: number, busyS: number) => {
		fs.mkdirSync(path.join(at, name), { recursive: true });
		const ns = (rqS * 1e9) / 2;
		fs.writeFileSync(
			path.join(at, name, "schedstat"),
			`version 17\ntimestamp 1\ncpu0 0 0 0 0 0 0 ${ns} 0 0\ndomain0 PKG 3 0 0\ncpu1 0 0 0 0 0 0 ${ns} 0 0\n`,
		);
		// busy split over user, nice and system ticks, at USER_HZ 100.
		const t = Math.round(busyS * 100);
		const third = Math.floor(t / 3);
		fs.writeFileSync(
			path.join(at, name, "stat"),
			`cpu  ${t - 2 * third} ${third} ${third} 900000 7 0 0 0 0 0\ncpu0 0 0 0 0 0 0 0 0 0 0\n`,
		);
	};
	sample("before", 5000, 5000);
	sample("after", 5000 + rq, 5000 + busy);
	return at;
}
