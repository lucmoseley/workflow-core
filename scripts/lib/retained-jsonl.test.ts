// @vitest-environment node
/*
 * retained-jsonl.test.ts — the age-pruned logs' append, prune and removal
 * (#4819). Loosen a case and a writer appending while another prunes loses
 * its line: in the pass store, a newer fail, after which an older pass on the
 * same content skips a file that should run.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
	DAY_MS,
	appendRetained,
	removeUntouched,
} = require("./retained-jsonl.js");

let dir: string;
let log: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "retained-"));
	log = path.join(dir, "log.jsonl");
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const RETAIN = 7 * DAY_MS;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const lines = () =>
	fs
		.readFileSync(log, "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l).n);

/* A neighbour mid-append or mid-prune: a fresh lock directory beside the log. */
const holdLock = () => fs.mkdirSync(`${log}.lock`);

/* A clock that runs 3 s per read, so the lock's 2 s wait ends on its first poll. */
const racing = () => {
	let t = Date.now();
	return () => {
		t += 3000;
		return t;
	};
};

const stale = { n: "stale", at: ago(RETAIN + 2 * DAY_MS) };
const fresh = { n: "fresh", at: ago(DAY_MS) };

describe("appendRetained", () => {
	it("prunes the lines past retention once the oldest is a day past it", () => {
		fs.writeFileSync(
			log,
			`${JSON.stringify(stale)}\n${JSON.stringify(fresh)}\n`,
		);
		expect(appendRetained(log, { n: "new", at: ago(0) }, RETAIN)).toBe(true);
		expect(lines()).toEqual(["fresh", "new"]);
		expect(fs.existsSync(`${log}.lock`)).toBe(false);
	});

	it("still lands its line but prunes nothing while a neighbour holds the log", () => {
		fs.writeFileSync(
			log,
			`${JSON.stringify(stale)}\n${JSON.stringify(fresh)}\n`,
		);
		holdLock();
		expect(
			appendRetained(log, { n: "new", at: ago(0) }, RETAIN, { now: racing() }),
		).toBe(true);
		expect(lines()).toEqual(["stale", "fresh", "new"]);
		expect(fs.existsSync(`${log}.lock`)).toBe(true);
	});

	it("takes over a crashed holder's lock and prunes", () => {
		fs.writeFileSync(log, `${JSON.stringify(stale)}\n`);
		holdLock();
		const t = (Date.now() - 60_000) / 1000;
		fs.utimesSync(`${log}.lock`, t, t);
		appendRetained(log, { n: "new", at: ago(0) }, RETAIN);
		expect(lines()).toEqual(["new"]);
	});

	it("empties a log holding a line that will not parse before appending, where asked", () => {
		fs.writeFileSync(log, `${JSON.stringify(fresh)}\n{"n":\n`);
		appendRetained(log, { n: "new", at: ago(0) }, RETAIN, {
			dropOnBadLine: true,
		});
		expect(lines()).toEqual(["new"]);
	});

	it("keeps a line that will not parse where not asked", () => {
		fs.writeFileSync(log, `{"n":\n`);
		appendRetained(log, { n: "new", at: ago(0) }, RETAIN);
		const text = fs.readFileSync(log, "utf8").split("\n");
		expect(text[0]).toBe(`{"n":`);
		expect(JSON.parse(text[1] as string).n).toBe("new");
	});

	it("returns false, never throwing, where the log cannot be written", () => {
		expect(
			appendRetained(path.join(dir, "absent", "log.jsonl"), fresh, RETAIN),
		).toBe(false);
	});
});

describe("removeUntouched", () => {
	const old = (Date.now() - 10 * DAY_MS) / 1000;

	it("deletes a log last written before the cut-off", () => {
		fs.writeFileSync(log, `${JSON.stringify(fresh)}\n`);
		fs.utimesSync(log, old, old);
		removeUntouched(log, Date.now() - 9 * DAY_MS);
		expect(fs.existsSync(log)).toBe(false);
	});

	it("keeps a log written since, as by an append landing first", () => {
		fs.writeFileSync(log, `${JSON.stringify(fresh)}\n`);
		removeUntouched(log, Date.now() - 9 * DAY_MS);
		expect(fs.existsSync(log)).toBe(true);
	});

	it("deletes nothing while a neighbour holds the log", () => {
		fs.writeFileSync(log, `${JSON.stringify(fresh)}\n`);
		fs.utimesSync(log, old, old);
		holdLock();
		removeUntouched(log, Date.now() - 9 * DAY_MS, racing());
		expect(fs.existsSync(log)).toBe(true);
	});
});
