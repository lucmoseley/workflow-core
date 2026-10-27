/*
 * process-fixture.ts — starting a real orphan, and reading a real process's
 * fate, in a test that kills one (#2922, #3057).
 *
 * FOR TESTS ONLY.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { isInit } from "./orphan-hooks.js";
import { FIELD, readStatFields } from "./proc-stat.js";
import { readProcTable } from "./proc-table.js";

/** A process's state letter and process group, or null where it is gone. */
function readStat(pid: number | string) {
	const fields = readStatFields(pid);
	if (!fields) return null;
	return { state: fields[FIELD.state], pgrp: Number(fields[FIELD.pgrp]) };
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
	return fs.readdirSync("/proc").every((pid) => {
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

/** Start `script` orphaned in a group of its own — `&` then exit orphans it,
 * setsid leads it, as Claude Code leads every hook — and return its pid. */
export function startOrphan(script: string) {
	const res = spawnSync(
		"bash",
		["-c", `setsid bash ${script} </dev/null >/dev/null 2>&1 & echo $!`],
		{ encoding: "utf8" },
	);
	const pid = Number(res.stdout.trim());
	/* A pid of 0 or 1 would turn a caller's group kill on this test's own
	 * group, or on init. */
	if (!Number.isInteger(pid) || pid <= 1)
		throw new Error(`no orphan started: ${res.stdout}${res.stderr}`);
	return pid;
}

let reapsToInit: boolean | undefined;

/** Whether this runner's orphans reparent to an init. One whose orphans go to
 * a subreaper that is no init leaves nothing the orphan sweeps judge orphaned. */
export function orphansReapToInit() {
	if (reapsToInit !== undefined) return reapsToInit;
	const pid = startOrphan("-c 'sleep 5'");
	const table = readProcTable("/proc")?.procs;
	const ppid = table?.get(pid)?.ppid ?? 0;
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		/* gone */
	}
	reapsToInit = isInit(ppid, table?.get(ppid)?.argv[0]);
	return reapsToInit;
}
