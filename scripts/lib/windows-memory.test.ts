// @vitest-environment node
/*
 * lib/windows-memory.js (#4557, #4850): Windows' free memory and paging off
 * memwatch's newest minute line, and the hold they put on a launch. Break it and a launch the
 * guest admits pages Windows, as the 6 Nov 2026 freeze did, or a stale reading
 * holds the machine on a figure minutes old.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type WindowsRead =
	| { state: "fresh"; mb: number; ageS: number; pagesIn?: number }
	| { state: "absent" }
	| { state: "stale"; why: string };

const {
	buildWindowsUnreadNote,
	minuteLogPath,
	readWindowsMemory,
	readWindowsRecorded,
	windowsShortfall,
} = require("./windows-memory.js") as {
	buildWindowsUnreadNote: (read: WindowsRead, what: string) => string | null;
	minuteLogPath: () => string;
	readWindowsMemory: (o?: { file?: string; now?: number }) => WindowsRead;
	readWindowsRecorded: (
		read: () => WindowsRead,
		log: (what: string) => void,
		what: string,
	) => WindowsRead;
	windowsShortfall: (
		read: WindowsRead,
	) => { mb: number; pagesIn?: number } | null;
};

const NOW = Date.parse("2026-11-06T05:12:19Z");
let dir: string;
let file: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "windows-memory-"));
	file = path.join(dir, "memwatch-minute.jsonl");
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/** A minute line as memwatch writes it, `secsAgo` before NOW. */
const line = (
	secsAgo: number,
	win: number | null,
	winAgeS: number | null,
	pagesIn?: number,
) =>
	`${JSON.stringify({
		ts: new Date(NOW - secsAgo * 1000).toISOString().replace("Z", "+0000"),
		mem_avail_mb: 6896,
		win_avail_mb: win,
		win_age_s: winAgeS,
		...(pagesIn === undefined ? {} : { win_pages_in: pagesIn }),
	})}\n`;

describe("lib/windows-memory.js", () => {
	it("reads the newest Windows reading, its age the line's plus the reading's own", () => {
		fs.writeFileSync(file, line(120, 2748, 5) + line(60, 2638, 10));
		expect(readWindowsMemory({ file, now: NOW })).toEqual({
			state: "fresh",
			mb: 2638,
			ageS: 70,
		});
	});

	it("carries the newest reading's pages in, where memwatch logged them", () => {
		fs.writeFileSync(file, line(60, 2638, 10, 171_984));
		expect(readWindowsMemory({ file, now: NOW })).toEqual({
			state: "fresh",
			mb: 2638,
			ageS: 70,
			pagesIn: 171_984,
		});
	});

	it("passes over a newest line whose Windows read came back null, as after a freeze", () => {
		fs.writeFileSync(file, line(70, 1944, 5) + line(10, null, null));
		expect(readWindowsMemory({ file, now: NOW })).toMatchObject({
			state: "fresh",
			mb: 1944,
		});
	});

	it("skips a last line memwatch has not finished writing", () => {
		fs.writeFileSync(file, `${line(30, 2000, 0)}{"ts":"2026-11-06T05:12`);
		expect(readWindowsMemory({ file, now: NOW })).toMatchObject({ mb: 2000 });
	});

	it("calls a reading past 180 s stale, failing open with the reason", () => {
		fs.writeFileSync(file, line(170, 900, 11));
		const read = readWindowsMemory({ file, now: NOW });
		expect(read).toEqual({
			state: "stale",
			why: `the newest Windows reading in ${file} is 181 s old, past 180 s`,
		});
		expect(windowsShortfall(read)).toBeNull();
		expect(buildWindowsUnreadNote(read, "a test launch")).toBe(
			`Windows memory unread — the newest Windows reading in ${file} is 181 s old, past 180 s; a test launch not held on it (#4557)`,
		);
	});

	it("records a stale reading's fail-open, and nothing for a fresh or absent one", () => {
		const logged: string[] = [];
		const log = (what: string) => logged.push(what);
		const stale: WindowsRead = { state: "stale", why: "memwatch stopped" };
		expect(readWindowsRecorded(() => stale, log, "sessions")).toBe(stale);
		readWindowsRecorded(() => ({ state: "absent" }), log, "sessions");
		readWindowsRecorded(
			() => ({ state: "fresh", mb: 3000, ageS: 5 }),
			log,
			"sessions",
		);
		expect(logged).toEqual([
			"Windows memory unread — memwatch stopped; sessions not held on it (#4557)",
		]);
	});

	it("calls a log with no Windows reading in its tail stale", () => {
		fs.writeFileSync(file, line(10, null, null));
		expect(readWindowsMemory({ file, now: NOW })).toEqual({
			state: "stale",
			why: `no Windows reading in ${file}'s last lines`,
		});
	});

	it("is silent where no memwatch runs: no log, no hold, nothing to record", () => {
		const read = readWindowsMemory({ file, now: NOW });
		expect(read).toEqual({ state: "absent" });
		expect(windowsShortfall(read)).toBeNull();
		expect(buildWindowsUnreadNote(read, "a test launch")).toBeNull();
	});

	it("reads only the tail of a long log", () => {
		const old = line(4000, 9999, 0).repeat(40_000);
		fs.writeFileSync(file, old + line(20, 1500, 3));
		expect(readWindowsMemory({ file, now: NOW })).toMatchObject({ mb: 1500 });
	});

	/* The floor is 1,000 MB and the paging line 100,000 pages (#4850). */
	it("holds a launch while Windows is under its floor, and admits one at it (#4850)", () => {
		const at = (mb: number): WindowsRead => ({ state: "fresh", mb, ageS: 30 });
		expect(windowsShortfall(at(999))).toEqual({ mb: 999 });
		expect(windowsShortfall(at(1000))).toBeNull();
	});

	it("admits a launch at a median day's 1,700 MB free with Windows not paging (#4850)", () => {
		expect(
			windowsShortfall({ state: "fresh", mb: 1700, ageS: 30, pagesIn: 1500 }),
		).toBeNull();
	});

	it("holds a launch while Windows pages at its line, whatever it has free (#4850)", () => {
		const paging = (pagesIn: number): WindowsRead => ({
			state: "fresh",
			mb: 2638,
			ageS: 30,
			pagesIn,
		});
		expect(windowsShortfall(paging(100_000))).toEqual({
			mb: 2638,
			pagesIn: 100_000,
		});
		expect(windowsShortfall(paging(99_999))).toBeNull();
	});

	it("resolves the log as memwatch does, MEMWATCH_MINUTE_LOG first", () => {
		vi.stubEnv("MEMWATCH_MINUTE_LOG", file);
		expect(minuteLogPath()).toBe(file);
		vi.stubEnv("MEMWATCH_MINUTE_LOG", "");
		expect(minuteLogPath()).toBe(
			path.join(os.homedir(), "memwatch-minute.jsonl"),
		);
	});
});
