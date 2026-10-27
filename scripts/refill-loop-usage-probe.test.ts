// @vitest-environment node
/*
 * Pins the refill loop's stale-seat read to the shared usage probe (#2317,
 * from #2306): a `dry-run` tick over two seats, against a fake `claude`, `gh`,
 * memory reading and reap, sees a stale seat probed through usage-probe.js
 * and the routine it runs, "lib/usage-probe.js" (from `/`, stdin on
 * /dev/null, `--permission-mode manual`, the seat named by --config-dir),
 * and a fresh one not probed at all.
 *
 * Every bar reads 100%, so no seat has room: the tick sizes no cap and reads
 * no shortlist, and so makes no GitHub call.
 *
 * Break it and the loop's stale-seat read leaves the shared probe: a stale
 * seat costs a full `/usage` run per tick again, and a fresh one is probed
 * for nothing.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writePsStub } from "./lib/ps-stub.js";
import { runInProcessAsync } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "refill-loop.js");
const PROBE_CLI = path.resolve(__dirname, "usage-probe.js");
const SESSION_ID = "refill-loop-usage-probe";

let dir: string;
let seats: string[];
let probeLog: string;
let ghLog: string;

/** A seat's usage cache at `fetchedAtMs`, a number or a printf placeholder. */
const cacheJson = (fetchedAtMs: string) =>
	`{"cachedUsageUtilization":{"fetchedAtMs":${fetchedAtMs},"utilization":{"limits":[{"kind":"session","percent":100},{"kind":"weekly_all","percent":100}]}}}`;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "refill-loop-usage-probe-"));
	seats = ["a", "b"].map((s) => path.join(dir, s));
	for (const s of seats) fs.mkdirSync(s);
	probeLog = path.join(dir, "probes");
	ghLog = path.join(dir, "gh-calls");
	fs.writeFileSync(
		path.join(dir, ".refill-loop-control.json"),
		JSON.stringify({ startedAt: Date.now(), stopRequested: false, seats }),
	);
	// Any figure over admission's memory floor for one slot.
	fs.writeFileSync(path.join(dir, "meminfo"), "MemAvailable: 20000000 kB\n");
	fs.writeFileSync(
		path.join(dir, "reap.js"),
		"process.stdout.write(JSON.stringify({ reaped: [] }));\n",
	);
	fs.writeFileSync(
		path.join(dir, "gh"),
		`#!/bin/bash\nprintf '%s\\n' "$*" >> '${ghLog}'\nexit 1\n`,
		{ mode: 0o755 },
	);
	/* A probe records its parent's command line and where and how it ran, then refreshes the caches of the
	 * seats FAKE_REFRESH names, or, under FAKE_ABORT, SIGTERMs its parent
	 * usage-probe.js, which then exits 1. */
	fs.writeFileSync(
		path.join(dir, "claude"),
		[
			"#!/bin/bash",
			`if [ "$1" = "agents" ]; then printf '%s\\n' '${JSON.stringify([{ sessionId: SESSION_ID, pid: 1 }])}'; exit 0; fi`,
			`printf '%s|%s|%s|%s|%s\\n' "$(tr '\\0' ' ' < /proc/$PPID/cmdline)" "$PWD" "$CLAUDE_CONFIG_DIR" "$*" "$(readlink /proc/self/fd/0)" >> '${probeLog}'`,
			'if [ -n "$FAKE_ABORT" ]; then kill -TERM "$PPID"; sleep 5; exit 0; fi',
			"now=$(($(date +%s%N) / 1000000))",
			`for s in $FAKE_REFRESH; do printf '${cacheJson("%s")}' "$now" > "$s/.claude.json"; done`,
		].join("\n"),
		{ mode: 0o755 },
	);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function cacheAll(fetchedAtMs: number) {
	for (const s of seats)
		fs.writeFileSync(
			path.join(s, ".claude.json"),
			cacheJson(String(fetchedAtMs)),
		);
}

function dryRun(fake: { refresh?: string[]; abort?: boolean } = {}) {
	return runInProcessAsync(SCRIPT, ["dry-run"], {
		cwd: dir,
		env: {
			...process.env,
			WFC_REFILL_DIR: dir,
			CLAUDE_PROJECT_DIR: dir,
			HOME: dir,
			// No seat's: a probe that drops --config-dir shows here.
			CLAUDE_CONFIG_DIR: path.join(dir, "home-seat"),
			CLAUDE_CODE_SESSION_ID: SESSION_ID,
			WFC_CLAUDE_BIN: path.join(dir, "claude"),
			WFC_GH: path.join(dir, "gh"),
			WFC_MEMINFO: path.join(dir, "meminfo"),
			WFC_PS: writePsStub(dir, []),
			WFC_REAP_SCRIPT: path.join(dir, "reap.js"),
			GITHUB_ACTIONS: "",
			FAKE_REFRESH: (fake.refresh ?? seats).join(" "),
			FAKE_ABORT: fake.abort ? "1" : "",
		},
	});
}

const readProbes = () =>
	fs.existsSync(probeLog)
		? fs.readFileSync(probeLog, "utf8").trim().split("\n")
		: [];

const buildProbeLine = (seat: string) =>
	`${process.execPath} ${PROBE_CLI} --config-dir ${seat} |/|${seat}|-p /usage --permission-mode manual|/dev/null`;

describe("the refill loop's stale-seat read (#2317)", () => {
	it("probes each stale seat through usage-probe.js, from / with stdin on /dev/null", async () => {
		cacheAll(1);
		const r = await dryRun({ refresh: [seats[0]] });
		expect(r.status).toBe(0);
		expect(readProbes()).toEqual([
			buildProbeLine(seats[0]),
			buildProbeLine(seats[1]),
		]);
		expect(fs.existsSync(ghLog)).toBe(false);
	});

	it("logs no failed /usage for a seat whose probe found its cache fresh", async () => {
		cacheAll(1);
		const r = await dryRun();
		expect(r.status).toBe(0);
		expect(readProbes()).toEqual([buildProbeLine(seats[0])]);
		expect(r.stdout).not.toContain("/usage on");
	});

	it("logs a probe that failed", async () => {
		cacheAll(1);
		const r = await dryRun({ abort: true });
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(`/usage on ${seats[0]}: exit 1`);
	});

	it("runs no probe while every seat's cache is fresh", async () => {
		cacheAll(Date.now());
		const r = await dryRun();
		expect(r.status).toBe(0);
		expect(readProbes()).toEqual([]);
		expect(r.stdout).toContain("dry run: ");
	});
});
