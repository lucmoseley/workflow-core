// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.join(__dirname, "check-peak-tripwire.js");

let host: string;
beforeEach(() => {
	host = fs.mkdtempSync(path.join(os.tmpdir(), "peak-tripwire-check-"));
});
afterEach(() => fs.rmSync(host, { recursive: true, force: true }));

const ARMED = {
	state: "armed",
	trip: null,
	liveRuns: [],
	trippedAt: null,
	checkedThrough: "2026-11-17T03:00:00.000Z",
	checkedAt: "2026-11-17T03:00:00.000Z",
	unread: null,
	armedBy: null,
	armedAt: null,
};

function run(state?: object | string) {
	if (state !== undefined) {
		const file = path.join(
			host,
			".claude",
			"tmp",
			"markers",
			"peak-tripwire.json",
		);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(
			file,
			typeof state === "string" ? state : JSON.stringify(state),
		);
	}
	return runInProcess(SCRIPT, ["--json"], {
		cwd: host,
		env: { ...process.env, GITHUB_ACTIONS: "", CLAUDE_PROJECT_DIR: host },
	});
}
const envelope = (r: { stdout: string }) => JSON.parse(r.stdout);

describe("check-peak-tripwire", () => {
	it("is OK, printing no finding, while armed and where no state file exists", () => {
		for (const r of [run(), run(ARMED)]) {
			expect(r.status).toBe(0);
			expect(envelope(r).outcome).toBe("OK");
			expect(r.stdout).not.toContain("ladder");
		}
	});

	it("WARNs on a tripped wire, naming the re-arm route", () => {
		const r = run({
			...ARMED,
			state: "tripped",
			trippedAt: "2026-11-17T03:00:10.000Z",
			trip: {
				at: "2026-11-17T03:00:00.000Z",
				pid: 4242,
				name: "MainThread",
				rssMiB: 900,
				testRun: {
					role: "worker",
					session: null,
					kind: "named",
					argv: [],
					files: [],
					fileCount: 1,
					repo: "workflow-core",
				},
			},
		});
		expect(r.status).toBe(0);
		expect(envelope(r).outcome).toBe("WARN");
		expect(r.stdout).toContain("the peak tripwire is tripped since");
		expect(r.stdout).toContain("peak-tripwire.js status");
		expect(r.stdout).toContain("peak-tripwire.js arm");
	});

	it("WARNs on a blind journal, and on a state file that will not read", () => {
		const blind = run({
			...ARMED,
			unread: {
				at: "2026-11-17T03:00:00.000Z",
				why: "journalctl -u earlyoom: denied",
			},
		});
		expect(envelope(blind).outcome).toBe("WARN");
		expect(blind.stdout).toContain(
			"the peak tripwire is blind, so part-suites are judged on the ladder: journalctl -u earlyoom: denied",
		);
		expect(blind.stdout).toContain("peak-tripwire.js status");
		const torn = run("{ torn");
		expect(envelope(torn).outcome).toBe("WARN");
		expect(torn.stdout).toContain(
			"the peak tripwire's state will not read, so part-suites are judged on the ladder: peak-tripwire.json unreadable",
		);
		expect(torn.stdout).toContain("peak-tripwire.js arm");
	});
});
