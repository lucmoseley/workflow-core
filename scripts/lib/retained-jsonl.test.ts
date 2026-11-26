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

const RETAIN_DAYS = 7;
const RETAIN = RETAIN_DAYS * DAY_MS;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const lines = () =>
	fs
		.readFileSync(log, "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l).n);

const holdLock = () => fs.mkdirSync(`${log}.lock`);

const STEP_MS = 3000;
const racing = (start = Date.now()) => {
	let t = start;
	return () => {
		t += STEP_MS;
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

const fresh = { n: "fresh", at: ago(DAY_MS) };
const seed = (...rows: object[]) =>
	fs.writeFileSync(log, rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
const daily = (days: number, endingDaysAgo = 0) =>
	Array.from({ length: days }, (_, i) => ({
		n: `day${days - i}`,
		at: ago((endingDaysAgo + days - i - 0.5) * DAY_MS),
	}));
const kept = (days: number) => daily(days).map((r) => r.n);

describe("appending to a log due a prune", () => {
	it("prunes the lines past retention once the oldest is a day past it", () => {
		seed(...daily(RETAIN_DAYS + 2));
		expect(appendRetained(log, { n: "new", at: ago(0) }, RETAIN)).toBe(true);
		expect(lines()).toEqual([...kept(RETAIN_DAYS), "new"]);
		expect(fs.existsSync(`${log}.lock`)).toBe(false);
	});

	it("prunes on the oldest dated line when the first line is undated (#5790)", () => {
		seed({ n: "undated" }, ...daily(RETAIN_DAYS + 2));
		appendRetained(log, { n: "new", at: ago(0) }, RETAIN);
		expect(lines()).toEqual([...kept(RETAIN_DAYS), "new"]);
	});

	const yearAhead = () => Date.now() + 365 * DAY_MS;
	it("keeps the log's lines when the writer's clock is a year ahead (#5785)", () => {
		seed(...daily(RETAIN_DAYS + 1));
		appendRetained(log, { n: "new", at: ago(0) }, RETAIN, { now: yearAhead });
		expect(lines()).toEqual([...kept(RETAIN_DAYS + 1), "new"]);
	});

	it("keeps the log's lines when that clock also dates the new line (#5785)", () => {
		seed(...daily(RETAIN_DAYS));
		const at = new Date(yearAhead()).toISOString();
		appendRetained(log, { n: "new", at }, RETAIN, { now: yearAhead });
		expect(lines()).toEqual([...kept(RETAIN_DAYS), "new"]);
	});

	it("still prunes on the true clock after a line a stepped clock dated a year ahead (#5785)", () => {
		const [first, ...rest] = daily(RETAIN_DAYS + 2);
		seed(
			first,
			{ n: "ahead", at: new Date(yearAhead()).toISOString() },
			...rest,
		);
		appendRetained(log, { n: "new", at: ago(0) }, RETAIN);
		expect(lines()).toEqual(["ahead", ...kept(RETAIN_DAYS), "new"]);
	});

	it("counts a quiet spell in the log as one day of its age", () => {
		seed(...daily(RETAIN_DAYS, 30));
		appendRetained(log, { n: "new", at: ago(0) }, RETAIN);
		expect(lines()).toEqual([...kept(RETAIN_DAYS), "new"]);
	});

	it("still lands its line but prunes nothing while a neighbour holds the log", () => {
		seed(...daily(RETAIN_DAYS + 2));
		holdLock();
		expect(
			appendRetained(log, { n: "new", at: ago(0) }, RETAIN, { now: racing() }),
		).toBe(true);
		expect(lines()).toEqual([...kept(RETAIN_DAYS + 2), "new"]);
		expect(fs.existsSync(`${log}.lock`)).toBe(true);
	});

	it("keeps a line appended outside the lock while the prune rewrites", () => {
		seed(...daily(RETAIN_DAYS + 2));
		lateWriterAt("renameSync", "late");
		appendRetained(log, { n: "new", at: ago(0) }, RETAIN);
		expect(lines()).toEqual([...kept(RETAIN_DAYS), "new", "late"]);
	});

	it("takes over a crashed holder's lock and prunes", () => {
		seed(...daily(RETAIN_DAYS + 2));
		holdLock();
		const t = (Date.now() - 60_000) / 1000;
		fs.utimesSync(`${log}.lock`, t, t);
		appendRetained(log, { n: "new", at: ago(0) }, RETAIN);
		expect(lines()).toEqual([...kept(RETAIN_DAYS), "new"]);
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

	it("keeps every log when the sweeping clock runs a year ahead, where one the store has written past for longer goes (#5787)", () => {
		seed(fresh);
		touch(log, 2);
		dailyHistory(1);
		sweepRetained(dir, retention, () => Date.now() + 365 * DAY_MS);
		expect(fs.existsSync(log)).toBe(true);
	});

	it("ages the rest by one gap, no more, when a write lands a year ahead, where a log is kept without it (#5787)", () => {
		seed(fresh);
		touch(log, 3.5);
		dailyHistory(5);
		const older = path.join(dir, "older.jsonl");
		fs.writeFileSync(older, "");
		touch(older, 6.5);
		const window = 6.5 * DAY_MS;
		sweepRetained(dir, window);
		expect(fs.existsSync(older)).toBe(true);
		const ahead = path.join(dir, "ahead.jsonl");
		fs.writeFileSync(ahead, "");
		touch(ahead, -365);
		sweepRetained(dir, window, () => Date.now() + 365 * DAY_MS);
		expect(fs.existsSync(older)).toBe(false);
		expect(fs.existsSync(log)).toBe(true);
	});

	it("ages a crashed writer's leftover on the shards' timeline without moving it", () => {
		seed(fresh);
		touch(log, 9);
		dailyHistory(5);
		const leftover = `${log}.lock`;
		fs.mkdirSync(leftover);
		touch(leftover, 7);
		sweepRetained(dir, 6.5 * DAY_MS);
		expect(fs.existsSync(log)).toBe(true);
	});

	it("deletes nothing while a neighbour holds the log", () => {
		seed(fresh);
		ageOut(log);
		holdLock();
		sweepRetained(dir, retention, racing(Date.now() - STEP_MS));
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
