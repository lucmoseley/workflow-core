// @vitest-environment node
/*
 * The single-instance pidfile lock (#2402).
 *
 * Loosen it and two landers, or two refill loops, run at once, or a dead
 * holder's pidfile locks every later start out.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	onTestFinished,
	vi,
} from "vitest";
import { readCurrentBootId, readProcStartOf } from "./arbiter-proc.js";
import { endedPid } from "./arbiter-testkit";
import { NotALock, pidLock } from "./pid-lock.js";

let dir: string;
let file: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "pid-lock-"));
	file = path.join(dir, ".daemon.pid");
});
afterEach(() => {
	vi.restoreAllMocks();
	fs.rmSync(dir, { recursive: true, force: true });
});

const buildOwnRecord = () => ({
	pid: process.pid,
	procStart: readProcStartOf(process.pid),
	bootId: readCurrentBootId(),
});
const readRecord = () => JSON.parse(fs.readFileSync(file, "utf8"));

/* The lock pins the real /proc, so WFC_PROC's fake cannot reach it, and these
 * reads fail only in a race no test can time: the spy is the one seam. */
function failRead(failing: string, then?: () => void) {
	const read = fs.readFileSync;
	vi.spyOn(fs, "readFileSync").mockImplementation(((
		...args: Parameters<typeof read>
	) => {
		if (args[0] !== failing) return read(...args);
		then?.();
		throw new Error("unreadable");
	}) as typeof read);
}

/* spawn-kept: a live process other than this one, whose command line carries
 * the marker. */
function liveMarkerProcess(script: string) {
	const proc = spawn(
		process.execPath,
		["-e", "setInterval(() => {}, 1000)", script],
		{ stdio: "ignore" },
	);
	onTestFinished(() => {
		proc.kill();
	});
	return proc.pid as number;
}

describe("pidLock", () => {
	it("creates the pidfile holding this process's record, leaving no aside, and releases it", () => {
		const lock = pidLock(file, "node");
		expect(lock.acquire()).toBe(true);
		expect(fs.readdirSync(dir)).toEqual([".daemon.pid"]);
		expect(readRecord()).toEqual(buildOwnRecord());
		expect(lock.holder()).toBe(process.pid);
		lock.release();
		expect(fs.existsSync(file)).toBe(false);
	});

	it.each([
		["a directory", () => fs.mkdirSync(file)],
		["a FIFO", () => execFileSync("mkfifo", [file])],
	])(
		"throws NotALock on %s at the lock's path, moving nothing (#3663)",
		(_l, make) => {
			make();
			expect(() => pidLock(file, "node").acquire()).toThrow(NotALock);
			expect(fs.readdirSync(dir)).toEqual([".daemon.pid"]);
		},
	);

	it.each([
		["a FIFO", () => execFileSync("mkfifo", [path.join(dir, "target")])],
		["a directory", () => fs.mkdirSync(path.join(dir, "target"))],
		["/dev/zero", () => fs.symlinkSync("/dev/zero", path.join(dir, "target"))],
	])(
		"throws NotALock on a symlink to %s at the lock's path, never blocking on its read (#3715)",
		(_l, make) => {
			make();
			fs.symlinkSync(path.join(dir, "target"), file);
			expect(() => pidLock(file, "node").acquire()).toThrow(NotALock);
			expect(fs.readdirSync(dir).sort()).toEqual([".daemon.pid", "target"]);
		},
	);

	it("takes over a symlink to a regular file as a stale pidfile, leaving its target (#3715)", () => {
		const target = path.join(dir, "target");
		fs.writeFileSync(target, endedPid());
		fs.symlinkSync(target, file);
		expect(pidLock(file, "node").acquire()).toBe(true);
		expect(fs.lstatSync(file).isFile()).toBe(true);
		expect(readRecord()).toEqual(buildOwnRecord());
		expect(fs.readFileSync(target, "utf8")).not.toContain(String(process.pid));
		expect(fs.readdirSync(dir).sort()).toEqual([".daemon.pid", "target"]);
	});

	it("takes over a dangling symlink at the lock's path as a stale pidfile (#3663)", () => {
		fs.symlinkSync(path.join(dir, "elsewhere"), file);
		expect(pidLock(file, "node").acquire()).toBe(true);
		expect(fs.lstatSync(file).isFile()).toBe(true);
		expect(fs.readdirSync(dir)).toEqual([".daemon.pid"]);
	});

	it("refuses while the holder's process lives", () => {
		const holder = spawn(
			process.execPath,
			["-e", "setInterval(() => {}, 1000)"],
			{
				stdio: "ignore",
			},
		);
		try {
			fs.writeFileSync(file, String(holder.pid));
			expect(pidLock(file, "node").acquire()).toBe(false);
			expect(fs.readFileSync(file, "utf8")).toBe(String(holder.pid));
		} finally {
			holder.kill();
		}
	});

	it("holds a pidfile already naming this process, as a daemon re-exec'd under its pid finds it (#2361)", () => {
		fs.writeFileSync(file, JSON.stringify(buildOwnRecord()));
		expect(pidLock(file, "node").acquire()).toBe(true);
		expect(readRecord()).toEqual(buildOwnRecord());
	});

	it("rewrites this process's bare pid as its record once it re-acquires (#4083)", () => {
		fs.writeFileSync(file, String(process.pid));
		expect(pidLock(file, "node").acquire()).toBe(true);
		expect(readRecord()).toEqual(buildOwnRecord());
		expect(fs.readdirSync(dir)).toEqual([".daemon.pid"]);
	});

	describe("a recycled pid (#4083)", () => {
		it.each([
			[
				"another process's start time",
				(pid: number) => ({ pid, procStart: "1", bootId: readCurrentBootId() }),
			],
			[
				"its start time on another boot",
				(pid: number) => ({
					pid,
					procStart: readProcStartOf(pid),
					bootId: "another",
				}),
			],
		])(
			"a record of %s, naming a live marker process, has no holder and is taken over",
			(_, record) => {
				const pid = liveMarkerProcess("refill-loop.js");
				fs.writeFileSync(file, JSON.stringify(record(pid)));
				const lock = pidLock(file, "refill-loop.js");
				expect(lock.holder()).toBeNull();
				expect(lock.acquire()).toBe(true);
				expect(readRecord()).toEqual(buildOwnRecord());
			},
		);

		it("a matching record still refuses a second taker", () => {
			const pid = liveMarkerProcess("refill-loop.js");
			const text = JSON.stringify({
				pid,
				procStart: readProcStartOf(pid),
				bootId: readCurrentBootId(),
			});
			fs.writeFileSync(file, text);
			const lock = pidLock(file, "refill-loop.js");
			expect(lock.holder()).toBe(pid);
			expect(lock.acquire()).toBe(false);
			expect(fs.readFileSync(file, "utf8")).toBe(text);
		});

		it("a bare pid naming a live marker process still refuses", () => {
			const pid = liveMarkerProcess("refill-loop.js");
			fs.writeFileSync(file, String(pid));
			expect(pidLock(file, "refill-loop.js").acquire()).toBe(false);
			expect(fs.readFileSync(file, "utf8")).toBe(String(pid));
		});

		it("a start time unreadable for a live pid keeps the marker test", () => {
			const pid = liveMarkerProcess("refill-loop.js");
			failRead(`/proc/${pid}/stat`);
			fs.writeFileSync(
				file,
				JSON.stringify({ pid, procStart: "1", bootId: null }),
			);
			expect(pidLock(file, "refill-loop.js").holder()).toBe(pid);
		});

		it("a holder ended between the check and its cmdline's read is no holder", () => {
			const pid = liveMarkerProcess("refill-loop.js");
			const kill = process.kill.bind(process);
			failRead(`/proc/${pid}/cmdline`, () => {
				vi.spyOn(process, "kill").mockImplementation((target, signal) => {
					if (target !== pid) return kill(target, signal);
					throw Object.assign(new Error("gone"), { code: "ESRCH" });
				});
			});
			fs.writeFileSync(file, String(pid));
			expect(pidLock(file, "refill-loop.js").holder()).toBeNull();
		});

		it("release leaves a record of another process on this pid", () => {
			const text = JSON.stringify({ ...buildOwnRecord(), bootId: "another" });
			fs.writeFileSync(file, text);
			pidLock(file, "node").release();
			expect(fs.readFileSync(file, "utf8")).toBe(text);
		});
	});

	it.each([
		["has ended", endedPid],
		["is unparseable", () => "not a pid"],
	])("takes over a pidfile whose holder %s", (_, content) => {
		fs.writeFileSync(file, content());
		expect(pidLock(file, "node").acquire()).toBe(true);
		expect(readRecord()).toEqual(buildOwnRecord());
		expect(fs.readdirSync(dir)).toEqual([".daemon.pid"]);
	});

	it("takes over a live pid whose command line is not the daemon's", () => {
		fs.writeFileSync(file, String(process.pid));
		const lock = pidLock(file, "no-such-marker-2402");
		expect(lock.holder()).toBeNull();
		expect(lock.acquire()).toBe(true);
	});

	it.each([
		["start-lander.js", "queue-lander.js", "is no holder", false],
		["queue-lander.js", "queue-lander.js", "is the holder", true],
		[
			"queue-lander.js",
			["queue-lander.js", "other-entry.js"],
			"is the holder",
			true,
		],
		[
			"other-entry.js",
			["queue-lander.js", "other-entry.js"],
			"is the holder",
			true,
		],
		[
			"start-lander.js",
			["queue-lander.js", "other-entry.js"],
			"is no holder",
			false,
		],
	])(
		"a live `node …/%s`, for marker %j, %s (#2675, #3815)",
		(script, marker, _, holds) => {
			const scriptPath = path.join(dir, "scripts", script);
			fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
			fs.writeFileSync(scriptPath, "setInterval(() => {}, 1000);\n");
			// spawn-kept: two processes at once — a live holder whose command line the lock reads.
			const proc = spawn(process.execPath, [scriptPath], { stdio: "ignore" });
			try {
				fs.writeFileSync(file, String(proc.pid));
				expect(pidLock(file, marker).holder()).toBe(holds ? proc.pid : null);
			} finally {
				proc.kill();
			}
		},
	);

	it("releases nothing another holder took", () => {
		const lock = pidLock(file, "node");
		fs.writeFileSync(file, "1");
		lock.release();
		expect(fs.readFileSync(file, "utf8")).toBe("1");
	});
});
