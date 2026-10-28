// @vitest-environment node
/*
 * The single-instance pidfile lock (#2402).
 *
 * Loosen it and two landers, or two refill loops, run at once, or a dead
 * holder's pidfile locks every later start out.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pidLock } from "./pid-lock.js";

let dir: string;
let file: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "pid-lock-"));
	file = path.join(dir, ".daemon.pid");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A pid whose process has ended. */
const endedPid = () =>
	spawnSync("sh", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim();

describe("pidLock", () => {
	it("creates the pidfile holding this pid, leaving no aside, and releases it", () => {
		const lock = pidLock(file, "node");
		expect(lock.acquire()).toBe(true);
		expect(fs.readdirSync(dir)).toEqual([".daemon.pid"]);
		expect(fs.readFileSync(file, "utf8")).toBe(String(process.pid));
		expect(lock.holder()).toBe(process.pid);
		lock.release();
		expect(fs.existsSync(file)).toBe(false);
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
		fs.writeFileSync(file, String(process.pid));
		expect(pidLock(file, "node").acquire()).toBe(true);
		expect(fs.readFileSync(file, "utf8")).toBe(String(process.pid));
	});

	it.each([
		["has ended", endedPid],
		["is unparseable", () => "not a pid"],
	])("takes over a pidfile whose holder %s", (_, content) => {
		fs.writeFileSync(file, content());
		expect(pidLock(file, "node").acquire()).toBe(true);
		expect(fs.readFileSync(file, "utf8")).toBe(String(process.pid));
		expect(fs.readdirSync(dir)).toEqual([".daemon.pid"]);
	});

	it("takes over a live pid whose command line is not the daemon's", () => {
		fs.writeFileSync(file, String(process.pid));
		const lock = pidLock(file, "no-such-marker-2402");
		expect(lock.holder()).toBeNull();
		expect(lock.acquire()).toBe(true);
	});

	it.each([
		["start-lander.js", "is no holder", false],
		["lander.js", "is the holder", true],
	])(
		"a live `node …/%s` %s for marker lander.js (#2675)",
		(script, _, holds) => {
			const scriptPath = path.join(dir, "scripts", script);
			fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
			fs.writeFileSync(scriptPath, "setInterval(() => {}, 1000);\n");
			// spawn-kept: two processes at once — a live holder whose command line the lock reads.
			const proc = spawn(process.execPath, [scriptPath], { stdio: "ignore" });
			try {
				fs.writeFileSync(file, String(proc.pid));
				expect(pidLock(file, "lander.js").holder()).toBe(
					holds ? proc.pid : null,
				);
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
