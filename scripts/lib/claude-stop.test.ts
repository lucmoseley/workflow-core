// @vitest-environment node
/*
 * lib/claude-stop.js is the one `claude stop` (#2697). Pinned against a fake
 * `claude` (WFC_CLAUDE_BIN) over three sandbox seats: each seat's `answer` file
 * says how its daemon answers a stop, and every stop it takes is logged with
 * the seat it ran on. Breaking it stops a job on a seat whose record names
 * another session, or reports a stop that failed on one seat as nothing to stop.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stopOn, stopSession } from "./claude-stop.js";

let root: string;
let seats: string[];

/** @param answers  "ok", "nojob" or "busy" per seat, in seat order */
function seatsAnswering(...answers: string[]) {
	answers.forEach((a, i) => {
		fs.writeFileSync(path.join(seats[i], "answer"), a);
	});
}

function recordJob(i: number, id: string, sessionId: string) {
	const dir = path.join(seats[i], "jobs", id);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ sessionId }));
}

const readStopsTaken = () => {
	try {
		return fs
			.readFileSync(path.join(root, "stops"), "utf8")
			.split("\n")
			.filter(Boolean);
	} catch {
		return [];
	}
};

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-stop-"));
	seats = ["a", "b", "c"].map((s) => path.join(root, s));
	for (const s of seats) fs.mkdirSync(s);
	const bin = path.join(root, "claude");
	fs.writeFileSync(
		bin,
		[
			"#!/bin/sh",
			'd="$CLAUDE_CONFIG_DIR"',
			`echo "$(basename "$d") $2" >> "${path.join(root, "stops")}"`,
			'case "$(cat "$d/answer" 2>/dev/null)" in',
			'  nojob) echo "warning: retrying" >&2; echo "No job matching \'$2\'." >&2; exit 1 ;;',
			'  busy) echo "daemon socket is busy" >&2; exit 1 ;;',
			"esac",
			'echo "stopped $2"',
		].join("\n"),
		{ mode: 0o755 },
	);
	vi.stubEnv("WFC_CLAUDE_BIN", bin);
	vi.stubEnv("CLAUDE_CONFIG_DIR", seats[0]);
	vi.stubEnv("WFC_CLAUDE_CONFIG_A", seats[0]);
	vi.stubEnv("WFC_CLAUDE_CONFIG_B", seats[1]);
	vi.stubEnv("WFC_CLAUDE_CONFIG_C", seats[2]);
});

afterEach(() => {
	vi.unstubAllEnvs();
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
		seatsAnswering("nojob", "ok", "ok");
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
		seatsAnswering("nojob", "nojob", "nojob");
		const r = stopSession("aaaa1111", "s-1");
		expect(r.ok).toBe(false);
		expect(!r.ok && r.why).toBe(
			"exit 1: No job matching 'aaaa1111'. (on all 3 seats)",
		);
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
		seatsAnswering("nojob");
		expect(stopOn(seats[0], "aaaa1111")).toMatchObject({
			ok: false,
			said: "No job matching 'aaaa1111'.",
		});
	});
});
