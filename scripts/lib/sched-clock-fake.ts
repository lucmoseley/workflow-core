import fs from "node:fs";
import path from "node:path";

const USER_HZ = 100;

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
		const busyTicks = Math.round(busyS * USER_HZ);
		const third = Math.floor(busyTicks / 3);
		fs.writeFileSync(
			path.join(at, name, "stat"),
			`cpu  ${busyTicks - 2 * third} ${third} ${third} 900000 7 0 0 0 0 0\ncpu0 0 0 0 0 0 0 0 0 0 0\n`,
		);
	};
	sample("before", 5000, 5000);
	sample("after", 5000 + runtime, 5000 + busy);
	return at;
}
