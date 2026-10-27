// @vitest-environment node
/*
 * registry-agents.js lists live sessions from each seat's registry and job
 * records, with no `claude agents --json` (#2665). The reaper stops what it
 * lists, so these pin what it must NOT list: a reused pid, a garbled entry, a
 * job record naming someone else.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const load = createRequire(__filename);
// biome-ignore lint/suspicious/noExplicitAny: a CJS module has no types to import
const { buildDriftLines, readRegistryAgents }: any = load(
	"./registry-agents.js",
);
// biome-ignore lint/suspicious/noExplicitAny: a CJS module has no types to import
const { readProcStartOf }: any = load("./arbiter-proc.js");

let root = "";
let seatA = "";
let seatB = "";
const savedEnv = { ...process.env };

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "registry-agents-"));
	seatA = path.join(root, "a");
	seatB = path.join(root, "b");
	Object.assign(process.env, {
		CLAUDE_CONFIG_DIR: seatA,
		WFC_CLAUDE_CONFIG_A: seatA,
		WFC_CLAUDE_CONFIG_B: seatB,
		WFC_CLAUDE_CONFIG_C: seatB,
		WFC_REFILL_DIR: path.join(root, "refill"),
	});
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
	process.env = { ...savedEnv };
});

/** A registry entry on `seat` for this very process, with `over` on top. */
function entry(seat: string, file: string, over: Record<string, unknown> = {}) {
	const dir = path.join(seat, "sessions");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, file),
		JSON.stringify({
			pid: process.pid,
			procStart: readProcStartOf(process.pid),
			sessionId: "s-1",
			jobId: "aaaa0001",
			kind: "bg",
			name: "a session",
			cwd: "/w",
			startedAt: 1,
			...over,
		}),
	);
}

function job(seat: string, jobId: string, rec: unknown) {
	const dir = path.join(seat, "jobs", jobId);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(rec));
}

describe("registryAgents", () => {
	it("lists a pid-verified session as the oracle would, its state off its job record", () => {
		entry(seatA, "1.json");
		job(seatA, "aaaa0001", { sessionId: "s-1", state: "done" });
		expect(readRegistryAgents()).toEqual({
			agents: [
				{
					sessionId: "s-1",
					id: "aaaa0001",
					pid: process.pid,
					name: "a session",
					cwd: "/w",
					kind: "background",
					startedAt: 1,
					state: "done",
				},
			],
			faults: [],
			seats: [seatA],
		});
	});

	it("reads every seat, each session's state off its own seat", () => {
		entry(seatA, "1.json");
		entry(seatB, "2.json", { sessionId: "s-2" });
		job(seatA, "aaaa0001", { sessionId: "s-1", state: "done" });
		job(seatB, "aaaa0001", { sessionId: "s-2", state: "working" });
		const states = readRegistryAgents().agents.map(
			(a: { sessionId: string; state: string }) => `${a.sessionId} ${a.state}`,
		);
		expect(states.sort()).toEqual(["s-1 done", "s-2 working"]);
	});

	it("drops an entry whose process is not the one it recorded", () => {
		entry(seatA, "1.json", { procStart: "1" });
		expect(readRegistryAgents().agents).toEqual([]);
	});

	it("drops an entry of a shape it does not read", () => {
		entry(seatA, "1.json", { pid: "123" });
		entry(seatA, "2.json", { sessionId: "" });
		entry(seatA, "3.json", { procStart: null });
		fs.writeFileSync(path.join(seatA, "sessions", "4.json"), "\0\0\0");
		expect(readRegistryAgents().agents).toEqual([]);
	});

	it("gives no state where the job record is missing, garbled or names another session", () => {
		entry(seatA, "1.json");
		entry(seatA, "2.json", { sessionId: "s-2", jobId: "bbbb0002" });
		entry(seatA, "3.json", { sessionId: "s-3", jobId: "cccc0003" });
		job(seatA, "bbbb0002", { sessionId: "someone-else", state: "done" });
		fs.mkdirSync(path.join(seatA, "jobs", "cccc0003"), { recursive: true });
		fs.writeFileSync(path.join(seatA, "jobs", "cccc0003", "state.json"), "{");
		const states = readRegistryAgents().agents.map(
			(a: { state?: string }) => a.state,
		);
		expect(states).toEqual([undefined, undefined, undefined]);
	});

	it("carries the job record's tempo beside its state (#2980)", () => {
		entry(seatA, "1.json");
		job(seatA, "aaaa0001", {
			sessionId: "s-1",
			state: "done",
			tempo: "active",
		});
		const [a] = readRegistryAgents().agents;
		expect([a.state, a.tempo]).toEqual(["done", "active"]);
	});

	it("reads no job record outside the job store", () => {
		entry(seatA, "1.json", { jobId: "../../x" });
		const [a] = readRegistryAgents().agents;
		expect(a.id).toBeUndefined();
	});

	it("names a seat whose registry will not read, and still reads the others", () => {
		fs.mkdirSync(seatA, { recursive: true });
		fs.writeFileSync(path.join(seatA, "sessions"), "");
		entry(seatB, "1.json");
		const r = readRegistryAgents();
		expect(r.faults).toEqual([
			`${path.join(seatA, "sessions")} would not read (ENOTDIR)`,
		]);
		expect(r.agents).toHaveLength(1);
	});

	it("reads a seat with no registry as no sessions, not a fault, and not read", () => {
		expect(readRegistryAgents()).toEqual({ agents: [], faults: [], seats: [] });
	});
});

describe("buildDriftLines", () => {
	const bg = (over: Record<string, unknown> = {}) => ({
		sessionId: "s-1",
		pid: 10,
		kind: "background",
		state: "done",
		...over,
	});

	it("says nothing where the two listings agree", () => {
		expect(buildDriftLines([bg()], [bg()])).toEqual([]);
	});

	it("names a session listed by one side alone, and one they read differently", () => {
		expect(
			buildDriftLines(
				[bg(), bg({ sessionId: "s-2" })],
				[bg({ state: "working" }), bg({ sessionId: "s-3" })],
			),
		).toEqual([
			"listing drift: s-1 reads pid 10, state done from the CLI but pid 10, state working from the registry",
			"listing drift: s-2 is listed by the CLI alone",
			"listing drift: s-3 is listed by the registry alone",
		]);
	});

	it("compares background sessions alone", () => {
		expect(
			buildDriftLines(
				[bg({ kind: "interactive" })],
				[bg({ kind: "headless" })],
			),
		).toEqual([]);
	});
});
