// @vitest-environment node
/*
 * findResumedCopy (#4157): the copy a `--bg --resume` started, off a seat's job
 * store and transcripts in a temp seat. Loosen it and the loop adopts a job
 * that is no copy of the session, so the session is never resumed, or misses
 * the copy, so it starts a second.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { findResumedCopy } from "./resumed-copy.js";

const SINCE = Date.parse("2026-11-03T12:00:00Z");
const CWD = "/home/u/repo";
let seat: string;

const writeTranscript = (session: string, firstUuid: string) => {
	const file = path.join(seat, "projects", "repo", `${session}.jsonl`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(
		file,
		[
			{ type: "custom-title", sessionId: session },
			{ type: "user", uuid: firstUuid, sessionId: session },
			{ type: "user", uuid: `${session}-later`, sessionId: session },
		]
			.map((r) => JSON.stringify(r))
			.join("\n"),
	);
};

const writeJob = (
	jobId: string,
	session: string,
	{ cwd = CWD, at = SINCE + 1000, first = "u-first", state = "working" } = {},
) => {
	fs.mkdirSync(path.join(seat, "jobs", jobId), { recursive: true });
	fs.writeFileSync(
		path.join(seat, "jobs", jobId, "state.json"),
		JSON.stringify({
			sessionId: session,
			state,
			cwd,
			createdAt: new Date(at).toISOString(),
		}),
	);
	writeTranscript(session, first);
};

const find = (past: string[] = []) =>
	findResumedCopy(seat, { sessionId: "s-source", cwd: CWD }, SINCE, past);

beforeEach(() => {
	seat = fs.mkdtempSync(path.join(os.tmpdir(), "resumed-copy-"));
	writeJob("s-source", "s-source", { at: SINCE - 60_000 });
});

describe("findResumedCopy", () => {
	it("finds the job created since that opens on the source's first user row", () => {
		writeJob("c0de7a11", "c0de7a11-s");
		expect(find()).toEqual({ jobId: "c0de7a11", sessionId: "c0de7a11-s" });
	});

	it("takes the earliest of two", () => {
		writeJob("late", "late-s", { at: SINCE + 5000 });
		writeJob("early", "early-s", { at: SINCE + 2000 });
		expect(find()).toMatchObject({ jobId: "early" });
	});

	it.each([
		["opens on another row", { first: "u-other" }],
		["was created before the resume", { at: SINCE - 1 }],
		["runs in another cwd", { cwd: "/home/u/other" }],
		["failed", { state: "failed" }],
	])("passes over a job that %s", (_, over) => {
		writeJob("c0de7a11", "c0de7a11-s", over);
		expect(find()).toBeNull();
	});

	it("passes over an earlier resume's copy, a session the launch ran under before", () => {
		writeJob("earlier", "earlier-s", { at: SINCE + 500 });
		writeJob("c0de7a11", "c0de7a11-s");
		expect(find(["earlier-s"])).toMatchObject({ jobId: "c0de7a11" });
	});

	it("reads a first row past a multibyte character split across chunks", () => {
		const file = path.join(seat, "projects", "repo", "s-source.jsonl");
		const pad = JSON.stringify({ type: "note", text: "é".repeat(40_000) });
		fs.writeFileSync(
			file,
			`${pad}\n${JSON.stringify({ type: "user", uuid: "u-first" })}\n`,
		);
		writeJob("c0de7a11", "c0de7a11-s");
		expect(find()).toMatchObject({ jobId: "c0de7a11" });
	});

	it("says it could not tell where the source's transcript is missing", () => {
		writeJob("c0de7a11", "c0de7a11-s");
		fs.rmSync(path.join(seat, "projects", "repo", "s-source.jsonl"));
		expect(find()).toMatchObject({
			unread: expect.stringContaining("s-source"),
		});
	});

	it("finds none where the seat has no job store", () => {
		fs.rmSync(path.join(seat, "jobs"), { recursive: true });
		expect(find()).toBeNull();
	});

	it("says it could not tell where the job store will not read", () => {
		fs.rmSync(path.join(seat, "jobs"), { recursive: true });
		fs.writeFileSync(path.join(seat, "jobs"), "");
		expect(find()).toMatchObject({ unread: expect.any(String) });
	});
});
