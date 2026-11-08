/*
 * process-fixture.ts — starting a real orphan, and reading a real process's
 * fate, in a test that kills one (#2922, #3057).
 *
 * Every read is of REAL_PROC: the processes it starts and kills are real,
 * so never an inherited WFC_PROC fixture root's.
 *
 * FOR TESTS ONLY.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { isInit } from "./orphan-hooks.js";
import { REAL_PROC } from "./proc-root.js";
import { FIELD, readStatFields } from "./proc-stat.js";
import { readProcTable } from "./proc-table.js";
import { shellQuote } from "./sh-quote.js";

/** A process's state letter, parent and process group, or null where it is
 * gone. */
export function readStat(pid: number | string) {
	const fields = readStatFields(pid, REAL_PROC);
	if (!fields) return null;
	return {
		state: fields[FIELD.state],
		ppid: Number(fields[FIELD.ppid]),
		pgrp: Number(fields[FIELD.pgrp]),
	};
}

/** Gone, or a zombie: a Linux zombie still answers a signal 0, and a
 * SIGKILLed orphan may wait on its reaper. */
export function isDead(pid: number) {
	const stat = readStat(pid);
	return stat === null || stat.state === "Z";
}

/** No member of process group `pgid` alive but as a zombie: one whose leader
 * died first waits on its reaper, and answers a signal 0 to the group. */
export function isGroupDead(pgid: number) {
	return fs.readdirSync(REAL_PROC).every((pid) => {
		if (!/^\d+$/.test(pid)) return true;
		const stat = readStat(pid);
		return stat === null || stat.pgrp !== pgid || stat.state === "Z";
	});
}

/* A fork landing and a SIGKILLed group dying run on the kernel's clock, which
 * no test can inject. The 5 s ceiling is a guess. */
export function waitFor(done: () => boolean) {
	for (let i = 0; i < 50 && !done(); i++) spawnSync("sleep", ["0.1"]);
	return done();
}

/** Run `argv` orphaned in a session and group of its own — `&` then exit
 * orphans it, setsid leads it, as Claude Code leads every hook — and return
 * its pid once it leads that group. A `$!` read outside would come back
 * before the child's setsid() ran, and a group kill in that window reaches no
 * one (#4643). */
export function startOrphan(...argv: string[]) {
	const inner = `echo $$; exec ${argv.map(shellQuote).join(" ")} </dev/null >/dev/null 2>&1`;
	const res = spawnSync(
		"sh",
		["-c", `setsid sh -c ${shellQuote(inner)} </dev/null 2>/dev/null &`],
		{ encoding: "utf8" },
	);
	const pid = Number(res.stdout.trim());
	/* A pid of 0 or 1 would turn a caller's group kill on this test's own
	 * group, or on init. */
	if (!Number.isInteger(pid) || pid <= 1)
		throw new Error(`no orphan started: ${res.stdout}${res.stderr}`);
	const stat = readStat(pid);
	if (!stat) throw new Error(`orphan ${pid} exited before it was read`);
	if (stat.pgrp !== pid) {
		/* Its group may be this test's own: kill the orphan alone. */
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			/* gone */
		}
		throw new Error(`orphan ${pid} does not lead its group: pgrp ${stat.pgrp}`);
	}
	return pid;
}

/** SIGKILL process group `pgid`, one already gone included. */
export function killGroup(pgid: number) {
	try {
		process.kill(-pgid, "SIGKILL");
	} catch {
		/* gone */
	}
}

let reapsToInit: boolean | undefined;

/** Whether this runner's orphans reparent to an init. One whose orphans go to
 * a subreaper that is no init leaves nothing the orphan sweeps judge orphaned. */
export function orphansReapToInit() {
	if (reapsToInit !== undefined) return reapsToInit;
	const pid = startOrphan("sleep", "5");
	const table = readProcTable(REAL_PROC)?.procs;
	const ppid = table?.get(pid)?.ppid ?? 0;
	killGroup(pid);
	reapsToInit = isInit(ppid, table?.get(ppid)?.argv[0]);
	return reapsToInit;
}
