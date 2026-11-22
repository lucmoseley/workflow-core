// @vitest-environment node

import { spawn } from "node:child_process";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { proc } from "./arbiter-testkit";
import { ignoreFailure } from "./caught.js";

describe("procStart — the kernel token that makes a recycled pid detectable", () => {
	it("returns null for a pid with no process", () => {
		expect(proc.readProcStartOf(4_194_303)).toBeNull();
	});

	it("reads field 22 for a live process, past a comm full of traps", () => {
		const comm = "/proc/self/comm";
		const saved = fs.readFileSync(comm, "utf8").trim();
		fs.writeFileSync(comm, "w) x (y");
		try {
			const stat = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8");
			const known = `${process.pid} (w) x (y) `;
			expect(stat.startsWith(known)).toBe(true);
			expect(proc.readProcStartOf(process.pid)).toMatch(/^\d+$/);
			expect(proc.readProcStartOf(process.pid)).toBe(
				stat.slice(known.length).split(" ")[19],
			);
		} finally {
			fs.writeFileSync(comm, saved);
		}
	});
});

describe("what /proc calls alive", () => {
	const waitForStat = async (pid: number, ready: RegExp) => {
		let stat = "";
		// guess, #5529
		for (const deadline = Date.now() + 20_000; Date.now() < deadline; ) {
			stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
			if (ready.test(stat)) return;
			await new Promise((r) => setTimeout(r, 20));
		}
		throw new Error(`no ${ready} in /proc/${pid}/stat, last: ${stat}`);
	};

	it("counts a ZOMBIE as no process at all", async () => {
		const parent = spawn("sh", ["-c", "sleep 600 & echo $!; exec sleep 600"]);
		let zpid: number | undefined;
		try {
			zpid = await new Promise<number>((resolve) =>
				parent.stdout.once("data", (d) => resolve(Number(String(d).trim()))),
			);
			await waitForStat(parent.pid as number, /^\d+ \(sleep\) /);
			process.kill(zpid);
			await waitForStat(zpid, /^\d+ \(\w+\) Z /);
			expect(proc.readProcStartOf(zpid)).toBeNull();
		} finally {
			parent.kill();
			ignoreFailure(() => {
				if (zpid) process.kill(zpid);
			});
		}
	});
});

describe("liveness — the production path the proving harness cannot reach", () => {
	it("a lock whose pid and procStart still match is held", () => {
		expect(
			proc.holderAlive({
				pid: process.pid,
				procStart: proc.readProcStartOf(process.pid),
			}),
		).toBe(true);
	});

	it("a recycled pid does NOT read as the original holder", () => {
		expect(proc.holderAlive({ pid: process.pid, procStart: "999999999" })).toBe(
			false,
		);
	});

	it("a dead pid releases the lock", () => {
		expect(proc.holderAlive({ pid: 4_194_303, procStart: "12345" })).toBe(
			false,
		);
	});

	it("a lock with no pid at all is breakable, not permanent", () => {
		expect(proc.holderAlive({ sessionId: "ancient" })).toBe(false);
	});

	it("a vanished job directory does NOT release a holder whose process lives", () => {
		expect(
			proc.holderAlive({
				pid: process.pid,
				procStart: proc.readProcStartOf(process.pid),
				stateFile: "/nonexistent/gone.json",
			}),
		).toBe(true);
	});
});

describe("a lock minted before a reboot", () => {
	const pair = () => ({
		pid: process.pid,
		procStart: proc.readProcStartOf(process.pid),
	});

	it("reads dead even when this boot has the same pair live", () => {
		expect(proc.holderAlive({ ...pair(), bootId: "another-boot" })).toBe(false);
	});

	it("reads alive on its own boot, and on a lock minted with no boot id to read", () => {
		expect(
			proc.holderAlive({ ...pair(), bootId: proc.readCurrentBootId() }),
		).toBe(true);
		expect(proc.holderAlive(pair())).toBe(true);
	});
});
