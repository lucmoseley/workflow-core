// @vitest-environment node
/*
 * The points-per-dollar instrument, run end to end over a fixture seat: each
 * bar's window, every project and subagent file on the seat, and the line it
 * prints (#370, #380).
 *
 * The seat is a temp config dir built per test and the script runs
 * in-process, so no live seat's usage reading or transcripts are read.
 *
 * Its rates are copied by hand into `lib/allowance.js#POINTS_PER_USD`, which
 * the capped launch in `scripts/dispatch-sessions.sh` sizes a set by: a wrong
 * rate launches more sessions than a bar has room for, or fewer.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "measure-points-per-usd.js");
const HOUR = 60 * 60 * 1000;

let dir: string;
let seat: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppu-"));
	seat = path.join(dir, "seat");
	fs.mkdirSync(seat);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const now = Date.now();

/** $10 at Sonnet 5's $10/Mtok output, written under `root/projects/rel`. */
function tenDollars(root: string, rel: string, atMs: number) {
	const file = path.join(root, "projects", rel);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(
		file,
		JSON.stringify({
			type: "assistant",
			requestId: "r1",
			timestamp: new Date(atMs).toISOString(),
			message: {
				model: "claude-sonnet-5",
				usage: { output_tokens: 1_000_000 },
			},
		}),
	);
}

function reading() {
	fs.writeFileSync(
		path.join(seat, ".claude.json"),
		JSON.stringify({
			cachedUsageUtilization: {
				fetchedAtMs: now - 60_000,
				utilization: {
					limits: [
						{
							kind: "session",
							percent: 10,
							resets_at: new Date(now + HOUR).toISOString(),
						},
						{
							kind: "weekly_all",
							percent: 20,
							resets_at: new Date(now + 24 * HOUR).toISOString(),
						},
					],
				},
			},
		}),
	);
}

const run = () =>
	runInProcess(SCRIPT, ["--config-dir", seat], {
		env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
	});

describe("measure-points-per-usd.js", () => {
	it("divides each bar's percent by the seat's all-project spend in its window", () => {
		reading();
		tenDollars(seat, "p1/a.jsonl", now - HOUR);
		tenDollars(seat, "p1/a/subagents/agent-x.jsonl", now - HOUR / 2);
		// Before the 5-hour window, inside the week's.
		tenDollars(seat, "p2/b.jsonl", now - 48 * HOUR);
		const r = run();
		expect(r.status).toBe(0);
		expect(r.stdout).toBe(
			`${seat} session: 10% on $20.00 = 0.500 pts/$ (reading 1 min old, 0 unpriced requests, 0 linked project dirs skipped)\n` +
				`${seat} weekly_all: 20% on $30.00 = 0.667 pts/$ (reading 1 min old, 0 unpriced requests, 0 linked project dirs skipped)\n`,
		);
	});

	it("skips a project directory linked into another seat's, which would charge this seat for that one's spend", () => {
		reading();
		tenDollars(seat, "p1/a.jsonl", now - HOUR);
		const other = path.join(dir, "other");
		tenDollars(other, "shared/c.jsonl", now - HOUR);
		fs.symlinkSync(
			path.join(other, "projects", "shared"),
			path.join(seat, "projects", "shared"),
		);
		const r = run();
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(
			`${seat} session: 10% on $10.00 = 1.00 pts/$ (reading 1 min old, 0 unpriced requests, 1 linked project dirs skipped)\n`,
		);
	});

	it("exits 1 where the seat has no reading, and says how to get one", () => {
		const r = run();
		expect(r.status).toBe(1);
		expect(r.stdout).toBe(
			`${seat} session: no reading in .claude.json — run /usage in a session on this seat, then re-run\n` +
				`${seat} weekly_all: no reading in .claude.json — run /usage in a session on this seat, then re-run\n`,
		);
	});

	it("refuses an unknown flag before reading any seat, naming it with usage and printing nothing on stdout", () => {
		const r = runInProcess(SCRIPT, ["--config-dirs", seat], {
			env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
		});
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("unknown flag: --config-dirs");
		expect(r.stderr).toContain("usage:");
		expect(r.stdout).toBe("");
	});
});
