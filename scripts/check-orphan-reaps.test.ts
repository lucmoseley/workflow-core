// @vitest-environment node
/*
 * Pins check-orphan-reaps.js, the `npm run status` view of the reaper's kill
 * log (#4342): it names each kill of the last week with its argv and, for a
 * dead session's process, the session; leaves an older one out; and is
 * all-clear where no log exists yet.
 *
 * Loosen a case and an overnight kill reaches no surface the founder reads.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.join(__dirname, "check-orphan-reaps.js");
const DAY_MS = 86_400_000;

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-orphan-reaps-"));
	spawnSync("git", ["init", "-q", dir]);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function writeLog(rows: object[]) {
	const markers = path.join(dir, ".claude/tmp/markers");
	fs.mkdirSync(markers, { recursive: true });
	fs.writeFileSync(
		path.join(markers, ".orphan-hook-reaps.jsonl"),
		rows.map((r) => `${JSON.stringify(r)}\n`).join(""),
	);
}

function json() {
	const res = runInProcess(SCRIPT, ["--json"], {
		cwd: dir,
		env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
	});
	return JSON.parse(res.stdout) as {
		outcome: string;
		kills: { pid: number }[];
		findings: { tag: string; message: string }[];
	};
}

describe("check-orphan-reaps", () => {
	it("names each kill of the last week, a dead session's with its session", () => {
		const now = Date.now();
		writeLog([
			{ at: new Date(now - 8 * DAY_MS).toISOString(), pid: 1, argv: "old" },
			{
				at: new Date(now - DAY_MS).toISOString(),
				pid: 2,
				argv: "node forks.js",
				killed: [2, 3],
				session: { id: "sess-a", leader: 77 },
			},
			{
				at: new Date(now - DAY_MS).toISOString(),
				pid: 4,
				argv: "bash scripts/guard-x.sh",
				killed: [4],
			},
		]);

		const out = json();

		expect(out.outcome).toBe("WARN");
		expect(out.kills.map((k) => k.pid)).toEqual([2, 4]);
		const text = JSON.stringify(out);
		expect(text).toContain(
			"outlived session sess-a (leader pid 77), 2 killed: node forks.js",
		);
		expect(text).toContain("a hook run past its timeout, 1 killed");
		expect(text).not.toContain('"old"');
	});

	it("is all-clear where no log exists yet", () => {
		expect(json().outcome).toBe("OK");
	});
});
