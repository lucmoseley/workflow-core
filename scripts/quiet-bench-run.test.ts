// @vitest-environment node
/*
 * The quiet bench runner end to end against a stub bench and a stub `gh`
 * (#3852): it runs the bench's command with the OUTDIR it keeps, posts the rows
 * to the bench's issue and leaves no pidfile. Loosen one and rows are lost with
 * the run, or a held pidfile reads as a live bench and keeps the fleet paused.
 *
 * spawn-kept: the pidfile names this process's pid and its command line's script,
 * so only a process of its own holds it and a second runner meets it.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { GH_FAILING_SCRIPT, stubGhScript } from "./lib/gh-stub";
import { liveScriptProcess } from "./lib/pid-lock-testkit";
import { LADDER_BENCH, LADDER_STAMP } from "./lib/quiet-bench.js";

const RUNNER = path.join(__dirname, "quiet-bench-run.js");

let sandbox: string;
let checkout: string;
let refill: string;
let posted: string;
let gh: string;

const stubBench = (body: string) => {
	const file = path.join(checkout, LADDER_BENCH.script);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, body);
};

const runner = (...words: string[]) =>
	spawnSync(process.execPath, [RUNNER, ...words], {
		cwd: checkout,
		encoding: "utf8",
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: checkout,
			WFC_REFILL_DIR: refill,
			WFC_GH: gh,
			POSTED: posted,
		},
	});

const runOk = () => {
	const r = runner("run");
	expect(r.status, r.stderr).toBe(0);
	return r;
};

const onlyRun = () => {
	const [id] = fs.readdirSync(path.join(refill, "quiet-bench-runs"));
	return path.join(refill, "quiet-bench-runs", String(id));
};

beforeEach(() => {
	sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "quiet-bench-run-"));
	checkout = path.join(sandbox, "checkout");
	refill = path.join(sandbox, "refill");
	posted = path.join(sandbox, "posted");
	fs.mkdirSync(path.join(checkout, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(checkout, ".claude", "workflow-core.json"),
		JSON.stringify({ tracker: "owner/tracker" }),
	);
	gh = stubGhScript(sandbox, '#!/bin/sh\nprintf "%s\\n" "$@" > "$POSTED"\n').gh;
});

afterEach(() => {
	fs.rmSync(sandbox, { recursive: true, force: true });
});

it("runs the bench's own command, keeps its rows and posts them", () => {
	stubBench(`import json, os, sys
with open(os.environ["OUTDIR"] + "/results.json", "w") as f:
    json.dump([{"suites": 1, "wall_s": 9, "baseline_stationary": True, "all_green": True, "ceiling_killed": 0}], f)
print(" ".join(sys.argv[1:]))
`);
	runOk();
	const dir = onlyRun();
	expect(fs.readFileSync(path.join(dir, "bench.log"), "utf8").trim()).toBe(
		LADDER_BENCH.args.join(" "),
	);
	const body = fs.readFileSync(posted, "utf8");
	expect(body).toContain(
		`comment\n${LADDER_BENCH.issue}\n--repo\nowner/tracker`,
	);
	expect(body).toContain("finished");
	expect(body).toContain("| 1 | 1 | 9 s |");
	expect(body).toMatch(/before the bench: available \d+ MB/);
	expect(body).toMatch(/load1 \d/);
	expect(fs.existsSync(path.join(refill, ".refill-quiet-bench.pid"))).toBe(
		false,
	);
	expect(fs.existsSync(path.join(dir, "posted"))).toBe(true);
	expect(runner("rows").stdout).toContain("usable rows per suite count 1:1");
});

it("posts a bench's refusal with its reason, and keeps it as no rows", () => {
	stubBench(`import sys
sys.exit("refused: 9 sessions live, above the --require-quiet=3 this run demands")
`);
	runOk();
	expect(fs.readFileSync(posted, "utf8")).toContain(
		"exit 1: refused: 9 sessions live",
	);
	expect(runner("rows").stdout).toBe("no usable bench rows kept\n");
});

it("keeps the rows unmarked where the post fails", () => {
	stubBench(`import json, os
with open(os.environ["OUTDIR"] + "/results.json", "w") as f:
    json.dump([{"suites": 2, "baseline_stationary": True, "all_green": True, "ceiling_killed": 0}], f)
`);
	gh = stubGhScript(sandbox, GH_FAILING_SCRIPT).gh;
	const r = runOk();
	expect(r.stderr).toContain(`not posted to #${LADDER_BENCH.issue}`);
	expect(fs.existsSync(path.join(onlyRun(), "posted"))).toBe(false);
	expect(runner("rows").stdout).toContain("2:1");
});

it("reads a run kept before ceiling_killed from its logs, never rewriting it (#4608)", () => {
	const dir = path.join(refill, "quiet-bench-runs", "2026-11-03T19-53-27.124Z");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "ladder.txt"), LADDER_STAMP);
	const row = (suites: number) => ({
		suites,
		baseline_stationary: true,
		all_green: false,
		wall_s: 840,
		samples: [
			{ t: 300, avail_mb: 6400 },
			{ t: 839, avail_mb: 6500 },
		],
	});
	const results = JSON.stringify([1, 2, 3, 1, 2, 3].map(row));
	fs.writeFileSync(path.join(dir, "results.json"), results);
	[1, 2, 3, 1, 2, 3].forEach((n, seq) => {
		for (let i = 0; i < n; i++)
			fs.writeFileSync(
				path.join(dir, `run-${n}-${seq}-${i}.log`),
				"passing\nSUITE CEILING — killed 840s after vitest spawned\n",
			);
	});
	expect(runner("rows").stdout).toBe(
		"2026-11-03T19-53-27.124Z: usable rows per suite count 1:0 2:0 3:0, lower-bound rows 1:2 2:2 3:2, lower bound\n",
	);
	expect(fs.readFileSync(path.join(dir, "results.json"), "utf8")).toBe(results);
});

it("leaves a kept row's ceiling unknown where a suite's log is gone, so it counts as nothing (#4031)", () => {
	const dir = path.join(refill, "quiet-bench-runs", "2026-11-03T19-53-27.124Z");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "ladder.txt"), LADDER_STAMP);
	fs.writeFileSync(
		path.join(dir, "results.json"),
		JSON.stringify([
			{ suites: 2, baseline_stationary: true, all_green: true, wall_s: 300 },
		]),
	);
	fs.writeFileSync(path.join(dir, "run-2-0-0.log"), "passing\n");
	expect(runner("rows").stdout).toBe("no usable bench rows kept\n");
});

it("reads no rows with no run kept", () => {
	expect(runner("rows").stdout).toBe("no usable bench rows kept\n");
});

it("exits 2 on an unknown command", () => {
	expect(runner("nonsense").status).toBe(2);
});

it("exits 1 where its directory cannot be made", () => {
	fs.writeFileSync(refill, "a file");
	const r = runner("run");
	expect(r.status).toBe(1);
	expect(r.stderr).not.toBe("");
});

it("exits at once and runs no bench beside a live runner", async () => {
	stubBench('open("ran", "w").close()\n');
	const pid = await liveScriptProcess("quiet-bench-run.js");
	fs.mkdirSync(refill, { recursive: true });
	fs.writeFileSync(path.join(refill, ".refill-quiet-bench.pid"), String(pid));
	expect(runner("run").status).toBe(0);
	expect(fs.existsSync(path.join(checkout, "ran"))).toBe(false);
	expect(fs.readdirSync(path.join(refill, "quiet-bench-runs"))).toEqual([]);
});
