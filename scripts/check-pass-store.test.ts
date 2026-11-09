// @vitest-environment node
/*
 * Pins check-pass-store.js, the `npm run status` reading of the pass store's
 * hits and misses (#4790): the files cached and the files run over the last
 * week's runs that looked the store up, a run that looked nothing up and an
 * older one counting toward neither.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.join(__dirname, "check-pass-store.js");
const DAY_MS = 86_400_000;

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-pass-store-"));
	spawnSync("git", ["init", "-q", dir]);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function writeLedger(rows: object[]) {
	const file = path.join(dir, ".claude/tmp/markers/.test-runs.jsonl");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
}

function json() {
	const res = runInProcess(SCRIPT, ["--json"], {
		cwd: dir,
		env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
	});
	return JSON.parse(res.stdout) as {
		outcome: string;
		runs: number;
		hits: number;
		misses: number;
	};
}

describe("check-pass-store", () => {
	it("counts the last week's cached and run files over the runs that looked the store up", () => {
		const ago = (days: number) =>
			new Date(Date.now() - days * DAY_MS).toISOString();
		writeLedger([
			{ at: ago(1), cachedFiles: 3, ranFiles: 1 },
			{ at: ago(2), cachedFiles: 0, ranFiles: 4 },
			{ at: ago(2), cachedFiles: null, ranFiles: 200 },
			{ at: ago(9), cachedFiles: 50, ranFiles: 0 },
		]);
		expect(json()).toMatchObject({
			outcome: "OK",
			runs: 2,
			hits: 3,
			misses: 5,
		});
	});

	it("reads no ledger as nothing looked up", () => {
		expect(json()).toMatchObject({ outcome: "OK", runs: 0, hits: 0 });
	});
});
