/* #5497 */
import fs from "node:fs";
import path from "node:path";
import { readJsonl } from "./jsonl.js";

export const epoch = () => Math.floor(Date.now() / 1000);

export const awayLoadEvents = (log: string) => readJsonl(log)?.rows ?? [];

export const memwatchReading = (at: number, availMb: number, idleS: number) =>
	`${at} ${availMb} 1 2 60 100 ${idleS}\n`;

export function awayLoadEnv(
	dir: string,
	bins: { testlimit: string; taskkill: string; tasklist: string },
) {
	return {
		WFC_AWAY_LOAD_STATE_DIR: path.join(dir, "state"),
		WFC_AWAY_LOAD_LOG: path.join(dir, "away-load.jsonl"),
		WFC_AWAY_LOAD_POLL_MS: "100",
		MEMWATCH_WIN_OUT: path.join(dir, "memwatch-win"),
		MEMWATCH_MINUTE_LOG: path.join(dir, "minute.jsonl"),
		WFC_TESTLIMIT: bins.testlimit,
		WFC_TASKKILL: bins.taskkill,
		WFC_TASKLIST: bins.tasklist,
	};
}

export const awayLoadGate = {
	ticket: 5473,
	since: "2026-11-24T09:01",
	minutes: 988,
	resetAfter: "2026-11-11T17:26:26",
};

export function writeAwayLoadGate(
	stateDir: string,
	gate: object = awayLoadGate,
) {
	fs.mkdirSync(stateDir, { recursive: true });
	fs.writeFileSync(
		path.join(stateDir, "gate.json"),
		`${JSON.stringify(gate)}\n`,
	);
}
