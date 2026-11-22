import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { ignoreFailure } from "./caught.js";
import { isInit } from "./orphan-hooks.js";
import { REAL_PROC } from "./proc-root.js";
import { FIELD, readStatFields } from "./proc-stat.js";
import { readProcTable } from "./proc-table.js";
import { shellQuote } from "./sh-quote.js";

export function readStat(pid: number | string) {
	const fields = readStatFields(pid, REAL_PROC);
	if (!fields) return null;
	return {
		state: fields[FIELD.state],
		ppid: Number(fields[FIELD.ppid]),
		pgrp: Number(fields[FIELD.pgrp]),
	};
}

export function isDead(pid: number) {
	const stat = readStat(pid);
	return stat === null || stat.state === "Z";
}

export function isGroupDead(pgid: number) {
	return fs.readdirSync(REAL_PROC).every((pid) => {
		if (!/^\d+$/.test(pid)) return true;
		const stat = readStat(pid);
		return stat === null || stat.pgrp !== pgid || stat.state === "Z";
	});
}

export function waitFor(done: () => boolean) {
	// guess, #2922
	for (let i = 0; i < 50 && !done(); i++) spawnSync("sleep", ["0.1"]);
	return done();
}

export function startOrphan(...argv: string[]) {
	const inner = `echo $$; exec ${argv.map(shellQuote).join(" ")} </dev/null >/dev/null 2>&1`;
	const res = spawnSync(
		"sh",
		["-c", `setsid sh -c ${shellQuote(inner)} </dev/null 2>/dev/null &`],
		{ encoding: "utf8" },
	);
	const pid = Number(res.stdout.trim());
	if (!Number.isInteger(pid) || pid <= 1)
		throw new Error(`no orphan started: ${res.stdout}${res.stderr}`);
	const stat = readStat(pid);
	if (!stat) throw new Error(`orphan ${pid} exited before it was read`);
	if (stat.pgrp !== pid) {
		ignoreFailure(() => process.kill(pid, "SIGKILL"));
		throw new Error(`orphan ${pid} does not lead its group: pgrp ${stat.pgrp}`);
	}
	return pid;
}

export function killGroup(pgid: number) {
	ignoreFailure(() => process.kill(-pgid, "SIGKILL"));
}

let reapsToInit: boolean | undefined;

export function orphansReapToInit() {
	if (reapsToInit !== undefined) return reapsToInit;
	const pid = startOrphan("sleep", "5");
	const table = readProcTable(REAL_PROC)?.procs;
	const ppid = table?.get(pid)?.ppid ?? 0;
	killGroup(pid);
	reapsToInit = isInit(ppid, table?.get(ppid)?.argv[0]);
	return reapsToInit;
}
