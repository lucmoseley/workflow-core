// @vitest-environment node
/*
 * lib/claude-stop.js is the one `claude stop` (#2697). Pinned against the
 * shared `claude stop` fake (lib/agents-stop-fake.ts, held to the harness by
 * agents-stop.contract.test.ts) at WFC_CLAUDE_BIN over three sandbox seats,
 * each answering a stop as the test sets it. Breaking it stops a job on a
 * seat whose record names another session, or reports a stop that failed on
 * one seat as nothing to stop.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildStopBranch, recorded, type StopAnswer } from "./agents-stop-fake";
import { stopOn, stopSession } from "./claude-stop.js";
import { writeClaudeStub } from "./claude-stub";

let root: string;
let seats: string[];

const at = (name: string) => path.join(root, name);

/** Point WFC_CLAUDE_BIN at the fake, each seat answering as `answers` says
 * in seat order, a seat past its end answering `ok`. */
function seatsAnswering(...answers: StopAnswer[]) {
	const bySeat = Object.fromEntries(answers.map((a, i) => [seats[i], a]));
	writeClaudeStub(at("claude"), [
		buildStopBranch(at("stops"), bySeat, at("env")),
	]);
	vi.stubEnv("WFC_CLAUDE_BIN", at("claude"));
}

function recordJob(i: number, id: string, sessionId: string) {
	const dir = path.join(seats[i], "jobs", id);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ sessionId }));
}

const readLines = (name: string) => {
	try {
		return fs.readFileSync(at(name), "utf8").split("\n").filter(Boolean);
	} catch {
		return [];
	}
};

/** `<seat letter> <job id>` per stop taken, in order. */
const readStopsTaken = () => {
	const argvs = readLines("stops");
	return readLines("env").map(
		(line, i) =>
			`${path.basename(line.split(" ")[0])} ${argvs[i].split(" ")[1]}`,
	);
};

const buildNoJobLine = (id: string) =>
	recorded.stops.noJob.stderr.trim().replaceAll(recorded.stops.noJob.id, id);

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-stop-"));
	seats = ["a", "b", "c"].map((s) => path.join(root, s));
	for (const s of seats) fs.mkdirSync(s);
	seatsAnswering();
	vi.stubEnv("CLAUDE_CONFIG_DIR", seats[0]);
	vi.stubEnv("WFC_CLAUDE_CONFIG_A", seats[0]);
	vi.stubEnv("WFC_CLAUDE_CONFIG_B", seats[1]);
	vi.stubEnv("WFC_CLAUDE_CONFIG_C", seats[2]);
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("stopSession", () => {
	it("stops the job on the seat whose record names its session, asking no other", () => {
		recordJob(1, "aaaa1111", "s-1");
		recordJob(0, "aaaa1111", "someone-else");
		recordJob(2, "aaaa1111", "someone-else");
		expect(stopSession("aaaa1111", "s-1")).toEqual({
			ok: true,
			said: "stopped aaaa1111",
		});
		expect(readStopsTaken()).toEqual(["b aaaa1111"]);
	});

	it("moves to the next seat on 'No job matching', and stops it there", () => {
		seatsAnswering("noJob", "ok", "ok");
		expect(stopSession("aaaa1111", "s-1").ok).toBe(true);
		expect(readStopsTaken()).toEqual(["a aaaa1111", "b aaaa1111"]);
	});

	it("reports any other failure from the seat that gave it, trying no further", () => {
		seatsAnswering("busy", "ok", "ok");
		expect(stopSession("aaaa1111", "s-1")).toEqual({
			ok: false,
			why: "exit 1: daemon socket is busy",
			said: "daemon socket is busy",
			timedOut: false,
			noJob: false,
		});
		expect(readStopsTaken()).toEqual(["a aaaa1111"]);
	});

	it("fails naming every seat where no seat has the job", () => {
		seatsAnswering("noJob", "noJob", "noJob");
		const r = stopSession("aaaa1111", "s-1");
		expect(r.ok).toBe(false);
		expect(!r.ok && r.why).toBe(
			`exit 1: ${buildNoJobLine("aaaa1111")} (on all 3 seats)`,
		);
	});

	it("asks a seat whose record will not read after the seat that names the session (#4704)", () => {
		recordJob(0, "aaaa1111", "someone-else");
		recordJob(1, "aaaa1111", "s-1");
		recordJob(2, "aaaa1111", "s-1");
		const rec = path.join(seats[2], "jobs", "aaaa1111", "state.json");
		fs.chmodSync(rec, 0o000);
		seatsAnswering("ok", "noJob", "ok");
		try {
			expect(stopSession("aaaa1111", "s-1").ok).toBe(true);
		} finally {
			fs.chmodSync(rec, 0o644);
		}
		expect(readStopsTaken()).toEqual(["b aaaa1111", "c aaaa1111"]);
	});

	it("stops nothing where every seat's record names another session", () => {
		for (const i of [0, 1, 2]) recordJob(i, "aaaa1111", "someone-else");
		expect(stopSession("aaaa1111", "s-1")).toMatchObject({
			ok: false,
			why: "every seat's record of aaaa1111 names another session",
		});
		expect(readStopsTaken()).toEqual([]);
	});
});

describe("stopOn", () => {
	it("stops on the seat it is given and says what claude said", () => {
		expect(stopOn(seats[2], "aaaa1111")).toEqual({
			ok: true,
			said: "stopped aaaa1111",
		});
		expect(readStopsTaken()).toEqual(["c aaaa1111"]);
	});

	it("reads the daemon's reason off its last line, under any warning", () => {
		seatsAnswering("warnedNoJob");
		expect(stopOn(seats[0], "aaaa1111")).toMatchObject({
			ok: false,
			said: buildNoJobLine("aaaa1111"),
			noJob: true,
		});
	});

	it("reports a claude that cannot start as ENOENT", () => {
		expect(stopOn(seats[0], "aaaa1111", at("absent"))).toEqual({
			ok: false,
			why: "ENOENT",
			said: null,
			timedOut: false,
			noJob: false,
		});
	});

	it("reports a spawn that throws as an outcome, never a throw", () => {
		expect(stopOn(seats[0], "aaaa\u00001111")).toMatchObject({
			ok: false,
			why: "ERR_INVALID_ARG_VALUE",
		});
	});

	it("reports a claude killed by a signal, with its last line", () => {
		seatsAnswering("killed");
		expect(stopOn(seats[0], "aaaa1111")).toMatchObject({
			ok: false,
			why: "exit on a signal: going down",
			timedOut: false,
		});
	});

	it("runs without the caller's session identity", () => {
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", "caller-session");
		vi.stubEnv("CLAUDE_JOB_DIR", at("caller-job"));
		stopOn(seats[0], "aaaa1111");
		expect(readLines("env")).toEqual([`${seats[0]} none none`]);
	});
});
