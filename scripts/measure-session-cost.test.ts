// @vitest-environment node
/*
 * The cost-table instrument, run end to end over a fixture ledger and seat:
 * job-id matching on either ledger spelling, the dominant-model filter, and
 * the summary it prints without `--write` (#371, #372).
 *
 * The ledger and seats are temp dirs built per test and the script runs
 * in-process as its CLI, so no real ledger or transcript is read and
 * `docs/data/session-cost-table.json` is never written.
 *
 * That table is what the capped launch in `scripts/dispatch-sessions.sh`
 * projects running sessions' spend from: a mismatched or mis-filtered row
 * sizes a set against the wrong remaining spend.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "measure-session-cost.js");

let dir: string;
let seat: string;
beforeEach(() => {
	dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "msc-")));
	seat = path.join(dir, "seat");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const turn = (requestId: string, model: string, output: number) =>
	JSON.stringify({
		type: "assistant",
		requestId,
		message: { model, usage: { output_tokens: output } },
	});

function transcript(id: string, lines: string[], at = seat) {
	const project = path.join(at, "projects", dir.replace(/[^a-zA-Z0-9]/g, "-"));
	fs.mkdirSync(project, { recursive: true });
	fs.writeFileSync(path.join(project, `${id}.jsonl`), lines.join("\n"));
}

function ledger(jobIds: string[]) {
	const file = path.join(
		dir,
		".claude",
		"tmp",
		"markers",
		".pick-next",
		"dispatched.jsonl",
	);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(
		file,
		jobIds.map((jobId) => JSON.stringify({ jobId })).join("\n"),
	);
}

const run = (seats = [seat], form = (s: string) => ["--config-dir", s]) =>
	runInProcess(SCRIPT, seats.flatMap(form), {
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: dir,
			WFC_DISPATCH_ROOT: dir,
		},
	});

describe("measure-session-cost.js", () => {
	it("prices every matched session on either ledger spelling, skipping an unpriced model", () => {
		// $10/Mtok Sonnet output: 100k → $1, 300k → $3.
		transcript("aaaaaa11-0000", [turn("r1", "claude-sonnet-5", 100_000)]);
		transcript("bbbbbb22-0000", [turn("r1", "claude-sonnet-5", 300_000)]);
		transcript("cccccc33-0000", [turn("r1", "claude-haiku-4-5", 900_000)]);
		ledger([
			"backgrounded·\u001b[36maaaaaa11\u001b[39m",
			"bbbbbb22",
			"cccccc33",
			"dddddd44",
		]);
		const r = run();
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("n=2 mean=$2 median=$3 p90=$3 max=$3\n");
	});

	it("prices a session held on two seats once, from the larger copy (#382)", () => {
		const seat2 = path.join(dir, "seat2");
		transcript("aaaaaa11-0000", [turn("r1", "claude-sonnet-5", 100_000)]);
		// Resumed on the second seat: its copy holds the whole session.
		transcript(
			"aaaaaa11-0000",
			[
				turn("r1", "claude-sonnet-5", 100_000),
				turn("r2", "claude-sonnet-5", 200_000),
			],
			seat2,
		);
		ledger(["aaaaaa11"]);
		const r = run([seat, seat2]);
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("n=1 mean=$3 median=$3 p90=$3 max=$3\n");
	});

	/* #1391 */
	it("measures only the seat given as --config-dir=<dir>", () => {
		const other = path.join(dir, "other");
		transcript("aaaaaa11-0000", [turn("r1", "claude-sonnet-5", 100_000)]);
		transcript(
			"bbbbbb22-0000",
			[turn("r1", "claude-sonnet-5", 300_000)],
			other,
		);
		ledger(["aaaaaa11", "bbbbbb22"]);
		const r = run([seat], (s) => [`--config-dir=${s}`]);
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("n=1 mean=$1 median=$1 p90=$1 max=$1\n");
	});

	it("exits 1 where no ledger entry matches a transcript", () => {
		ledger(["eeeeee55"]);
		const r = run();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("no ledger entry matched a transcript");
	});

	it("exits 1 naming the missing ledger, rather than crashing, in a repo that has dispatched nothing (#1734)", () => {
		const r = run();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("no dispatch ledger yet at");
		expect(r.stderr).toContain("nothing to table");
	});
});
