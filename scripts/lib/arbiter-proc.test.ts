// @vitest-environment node
/*
 * arbiter-proc.js calls a claim's holder alive only while its pid and kernel
 * start-time token still match a live /proc entry — a recycled pid, a zombie
 * and a pre-reboot lock all read dead (mantahostels#104, mantahostels#158).
 *
 * Nothing here touches the store, so these tests need no sandbox. The /proc
 * cases spawn real processes — one named by a symlink, one left a zombie —
 * because a stat line's comm and state are the kernel's to write.
 *
 * They exist ALONGSIDE the proving run (scripts/proving-run.test.ts), which
 * covers the same subsystem end to end, because the harness reaches only one of
 * the two liveness paths. Its simulated sessions have a jobs state file and no
 * `~/.claude/sessions/<pid>.json` entry, so every claim it makes is proved live
 * by the state file. Real sessions are the other way round — mantahostels#104 measured 0 of
 * 6 interactive sessions with a job directory — so the pid + procStart pair that
 * production actually runs on is untested there.
 *
 * Every claim the file-claim guard refuses on is judged live here: loosen a
 * case and a dead holder's claim blocks its file indefinitely, or a
 * live session's claim is broken and its work clobbered.
 */

import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { proc } from "./arbiter-testkit";

describe("procStart — the kernel token that makes a recycled pid detectable", () => {
	it("reads field 22 for a live process", () => {
		const mine = proc.readProcStartOf(process.pid);
		expect(mine).toMatch(/^\d+$/);
		// Field 22 counted from the last ')', because comm is parenthesised and may
		// itself contain spaces or brackets.
		const stat = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8");
		expect(stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19]).toBe(mine);
	});

	it("returns null for a pid with no process", () => {
		expect(proc.readProcStartOf(4_194_303)).toBeNull();
	});
});

describe("what /proc calls alive", () => {
	/** `pid`, or the child's own, once its /proc stat matches `ready`. */
	const started = async (child: ChildProcess, ready: RegExp, pid?: number) => {
		for (let tries = 0; tries < 100; tries += 1) {
			const who = pid ?? child.pid;
			try {
				if (ready.test(fs.readFileSync(`/proc/${who}/stat`, "utf8")))
					return who as number;
			} catch {
				/* not exec'd yet */
			}
			await new Promise((r) => setTimeout(r, 20));
		}
		throw new Error(`no ${ready} in /proc after 2s`);
	};

	it("reads the start token past a comm full of traps", async () => {
		// comm is parenthesised and may itself contain spaces and brackets, so
		// fields count from the LAST ')'. A symlink's name becomes the comm.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proc-comm-"));
		const trap = path.join(dir, "w) x (y");
		fs.symlinkSync("/bin/sleep", trap);
		const child = spawn(trap, ["5"]);
		try {
			const pid = await started(child, /\(w\) x \(y\) /);
			const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
			const known = `${pid} (w) x (y) `;
			expect(proc.readProcStartOf(pid)).toBe(
				stat.slice(known.length).split(" ")[19],
			);
		} finally {
			child.kill();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("counts a ZOMBIE as no process at all", async () => {
		// A zombie keeps its stat entry, start time intact, until its parent reaps
		// it — possibly never — and writes nothing, so counting it alive holds files
		// for a session that no longer exists. The shell's exec'd sleep inherits
		// the exited child and never waits on it.
		const parent = spawn("sh", ["-c", "sleep 0 & echo $!; exec sleep 5"]);
		try {
			const zpid = await new Promise<number>((resolve) =>
				parent.stdout.once("data", (d) => resolve(Number(String(d).trim()))),
			);
			await started(parent, /^\d+ \(sleep\) Z /, zpid);
			expect(proc.readProcStartOf(zpid)).toBeNull();
		} finally {
			parent.kill();
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
		// mantahostels#104's decisive measurement: pid 909 was found recycled onto an unrelated
		// process, so a bare "/proc/<pid> exists" test would have called a dead
		// holder alive and refused to break its lock forever.
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
		// mantahostels#104 rule 4's "unknown = holding" is right only where the pid check can
		// still clear the lock later. With no pid nothing ever can, so holding would
		// mean holding for good — and a wedge is unrecoverable where an over-eager
		// break is not.
		expect(proc.holderAlive({ sessionId: "ancient" })).toBe(false);
	});

	it("a vanished job directory does NOT release a holder whose process lives", () => {
		// CLAUDE_JOB_DIR is temporary and gets cleaned under a session that is still
		// running, so treating its absence as proof of death released a live holder
		// and left two sessions each believing they held the file.
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
	// pid and procStart are both boot-relative and locks in ~/.claude outlive the
	// boot, so the recorded pair can recur on a stranger after a reboot — a wedge
	// lasting as long as the stranger runs.
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
