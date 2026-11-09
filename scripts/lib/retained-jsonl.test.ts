// @vitest-environment node
/*
 * retained-jsonl.test.ts — the age-pruned logs' append, prune and sweep
 * (#4819). Loosen a case and a writer appending while another prunes loses
 * its line: in the pass store, a newer fail, after which an older pass on the
 * same content skips a file that should run.
 *
 * A neighbour is a lock directory made by hand, and a clock that runs 3 s a
 * read ends the lock's 2 s wait at once; a writer racing a stalled holder is
 * a line appended from inside the holder's own rename or removal.
 */
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

/* A writer outside the lock appending `n` the moment `step` first runs. */
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
		// Past lib/dir-lock.js's 10 s stale age.
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

describe("sweeping logs untouched past a cut-off", () => {
	const old = (Date.now() - 10 * DAY_MS) / 1000;
	const cutoff = () => Date.now() - 9 * DAY_MS;
	const ageOut = (p: string) => fs.utimesSync(p, old, old);

	it("deletes a log last written before it", () => {
		seed(fresh);
		ageOut(log);
		sweepRetained(dir, cutoff());
		expect(fs.existsSync(log)).toBe(false);
	});

	it("keeps a log written since", () => {
		seed(fresh);
		sweepRetained(dir, cutoff());
		expect(fs.existsSync(log)).toBe(true);
	});

	it("deletes nothing while a neighbour holds the log", () => {
		seed(fresh);
		ageOut(log);
		holdLock();
		sweepRetained(dir, cutoff(), racing());
		expect(fs.existsSync(log)).toBe(true);
	});

	it("keeps a line appended outside the lock as the log goes", () => {
		seed(fresh);
		ageOut(log);
		lateWriterAt("rmSync", "late");
		sweepRetained(dir, cutoff());
		expect(lines()).toEqual(["late"]);
	});

	it("clears a crashed writer's lock and rewrite aside, and nothing else", () => {
		const leftovers = [`${log}.lock`, `${log}.123.abcdef01.tmp`];
		fs.mkdirSync(leftovers[0] as string);
		fs.writeFileSync(leftovers[1] as string, "");
		const other = path.join(dir, "notes.txt");
		fs.writeFileSync(other, "");
		for (const p of [...leftovers, other]) ageOut(p);
		sweepRetained(dir, cutoff());
		expect(leftovers.filter((p) => fs.existsSync(p))).toEqual([]);
		expect(fs.existsSync(other)).toBe(true);
	});
});
