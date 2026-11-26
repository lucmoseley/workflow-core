// @vitest-environment node
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
	DAY_MS,
	appendRetained,
	sweepRetained,
} = require("./retained-jsonl.js");

let dir: string;
let log: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "retained-"));
	log = path.join(dir, "log.jsonl");
});

afterEach(() => {
	vi.restoreAllMocks();
	fs.rmSync(dir, { recursive: true, force: true });
});

const RETAIN = 7 * DAY_MS;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const lines = () =>
	fs
		.readFileSync(log, "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l).n);

const holdLock = () => fs.mkdirSync(`${log}.lock`);

const racing = () => {
	let t = Date.now();
	return () => {
		t += 3000;
		return t;
	};
};

function lateWriterAt(step: "renameSync" | "rmSync", n: string) {
	const real = fs[step] as (...a: unknown[]) => void;
	let fired = false;
	vi.spyOn(fs, step).mockImplementation((...args: unknown[]) => {
		if (!fired) {
			fired = true;
			fs.appendFileSync(log, `${JSON.stringify({ n, at: ago(0) })}\n`);
		}
		real.apply(fs, args);
	});
}

const stale = { n: "stale", at: ago(RETAIN + 2 * DAY_MS) };
const fresh = { n: "fresh", at: ago(DAY_MS) };
const seed = (...rows: object[]) =>
	fs.writeFileSync(log, rows.map((r) => `${JSON.stringify(r)}\n`).join(""));

describe("appending to a log due a prune", () => {
	it("prunes the lines past retention once the oldest is a day past it", () => {
		seed(stale, fresh);
		expect(appendRetained(log, { n: "new", at: ago(0) }, RETAIN)).toBe(true);
		expect(lines()).toEqual(["fresh", "new"]);
		expect(fs.existsSync(`${log}.lock`)).toBe(false);
	});

	it("still lands its line but prunes nothing while a neighbour holds the log", () => {
		seed(stale, fresh);
		holdLock();
		expect(
			appendRetained(log, { n: "new", at: ago(0) }, RETAIN, { now: racing() }),
		).toBe(true);
		expect(lines()).toEqual(["stale", "fresh", "new"]);
		expect(fs.existsSync(`${log}.lock`)).toBe(true);
	});

	it("keeps a line appended outside the lock while the prune rewrites", () => {
		seed(stale, fresh);
		lateWriterAt("renameSync", "late");
		appendRetained(log, { n: "new", at: ago(0) }, RETAIN);
		expect(lines()).toEqual(["fresh", "new", "late"]);
	});

	it("takes over a crashed holder's lock and prunes", () => {
		seed(stale);
		holdLock();
		const t = (Date.now() - 60_000) / 1000;
		fs.utimesSync(`${log}.lock`, t, t);
		appendRetained(log, { n: "new", at: ago(0) }, RETAIN);
		expect(lines()).toEqual(["new"]);
	});
});

describe("appending to a log holding a line that will not parse", () => {
	it("empties the log first where asked", () => {
		fs.writeFileSync(log, `${JSON.stringify(fresh)}\n{"n":\n`);
		appendRetained(log, { n: "new", at: ago(0) }, RETAIN, {
			dropOnBadLine: true,
		});
		expect(lines()).toEqual(["new"]);
	});

	it("empties a log holding a record zeroed by a crash first where asked (#5775)", () => {
		fs.writeFileSync(
			log,
			`${JSON.stringify(fresh)}\n\0\0\0${JSON.stringify(fresh)}\n`,
		);
		appendRetained(log, { n: "new", at: ago(0) }, RETAIN, {
			dropOnBadLine: true,
		});
		expect(lines()).toEqual(["new"]);
	});

	it("keeps a line appended outside the lock while the log is emptied", () => {
		fs.writeFileSync(log, `{"n":\n`);
		lateWriterAt("rmSync", "late");
		appendRetained(log, { n: "new", at: ago(0) }, RETAIN, {
			dropOnBadLine: true,
		});
		expect(lines()).toEqual(["late", "new"]);
	});

	it("keeps the line where not asked", () => {
		fs.writeFileSync(log, `{"n":\n`);
		appendRetained(log, { n: "new", at: ago(0) }, RETAIN);
		const text = fs.readFileSync(log, "utf8").split("\n");
		expect(text[0]).toBe(`{"n":`);
		expect(JSON.parse(text[1] as string).n).toBe("new");
	});
});

describe("appending where the log cannot be written", () => {
	it("returns false, never throwing", () => {
		expect(
			appendRetained(path.join(dir, "absent", "log.jsonl"), fresh, RETAIN),
		).toBe(false);
	});
});

describe("sweeping logs untouched past the store's own retention", () => {
	const retention = 9 * DAY_MS;
	const touch = (p: string, days: number) => {
		const at = (Date.now() - days * DAY_MS) / 1000;
		fs.utimesSync(p, at, at);
	};
	const dailyHistory = (from: number) => {
		for (let days = from; days >= 0; days--) {
			const shard = path.join(dir, `daily-${days}.jsonl`);
			fs.writeFileSync(shard, "");
			touch(shard, days);
		}
	};
	const ageOut = (p: string) => {
		touch(p, 10);
		dailyHistory(9);
	};

	it("deletes a log the store has written past for longer", () => {
		seed(fresh);
		ageOut(log);
		sweepRetained(dir, retention);
		expect(fs.existsSync(log)).toBe(false);
	});

	it("keeps a log written since", () => {
		seed(fresh);
		dailyHistory(9);
		sweepRetained(dir, retention);
		expect(fs.existsSync(log)).toBe(true);
	});

	it("keeps every log when the sweeping clock runs a year ahead", () => {
		seed(fresh);
		touch(log, 2);
		dailyHistory(1);
		sweepRetained(dir, retention, () => Date.now() + 365 * DAY_MS);
		expect(fs.existsSync(log)).toBe(true);
	});

	it("ages the rest by one gap when a write lands a year ahead", () => {
		seed(fresh);
		touch(log, 2);
		dailyHistory(1);
		touch(path.join(dir, "daily-0.jsonl"), -365);
		sweepRetained(dir, retention, () => Date.now() + 365 * DAY_MS);
		expect(fs.existsSync(log)).toBe(true);
	});

	it("deletes nothing while a neighbour holds the log", () => {
		seed(fresh);
		ageOut(log);
		holdLock();
		sweepRetained(dir, retention, racing());
		expect(fs.existsSync(log)).toBe(true);
	});

	it("keeps a line appended outside the lock as the log goes", () => {
		seed(fresh);
		ageOut(log);
		lateWriterAt("rmSync", "late");
		sweepRetained(dir, retention);
		expect(lines()).toEqual(["late"]);
	});

	it("clears a crashed writer's lock and rewrite aside, and nothing else", () => {
		const leftovers = [`${log}.lock`, `${log}.123.abcdef01.tmp`];
		fs.mkdirSync(leftovers[0] as string);
		fs.writeFileSync(leftovers[1] as string, "");
		const other = path.join(dir, "notes.txt");
		fs.writeFileSync(other, "");
		for (const p of [...leftovers, other]) touch(p, 10);
		dailyHistory(9);
		sweepRetained(dir, retention);
		expect(leftovers.filter((p) => fs.existsSync(p))).toEqual([]);
		expect(fs.existsSync(other)).toBe(true);
	});
});
