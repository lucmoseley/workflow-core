// @vitest-environment node
/*
 * dir-lock.test.ts — the scratch stores' read-modify-write lock (#2787).
 * Loosen a case and a crashed holder's lock blocks every later write for good,
 * a held lock is left behind to stall the next caller, or a store write is
 * skipped for want of the lock where it should go ahead unserialised.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { sweepFiles, withDirLock } = require("./dir-lock.js") as {
	sweepFiles: (dir: string, ageMs: number) => void;
	withDirLock: <T>(lock: string, fn: () => T, now?: () => number) => T;
};

let dir: string;
let lock: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "dir-lock-"));
	lock = path.join(dir, "store.dlock");
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const age = (p: string, seconds: number) => {
	const t = Date.now() / 1000 - seconds;
	fs.utimesSync(p, t, t);
};

describe("withDirLock", () => {
	it("holds the lock while fn runs, then removes it", () => {
		const during = withDirLock(lock, () => fs.existsSync(lock));
		expect(during).toBe(true);
		expect(fs.existsSync(lock)).toBe(false);
	});

	it("removes the lock when fn throws", () => {
		expect(() =>
			withDirLock(lock, () => {
				throw new Error("boom");
			}),
		).toThrow("boom");
		expect(fs.existsSync(lock)).toBe(false);
	});

	it("takes over a lock older than its stale age", () => {
		fs.mkdirSync(lock);
		age(lock, 11);
		expect(withDirLock(lock, () => "ran")).toBe("ran");
		expect(fs.existsSync(lock)).toBe(false);
	});

	it("runs fn unserialised once the wait runs out, leaving the holder's lock", () => {
		fs.mkdirSync(lock);
		// Each read of the clock moves it a second on, so the 2 s wait runs out
		// in two polls, long before the lock would read as 10 s stale.
		let t = Date.now();
		const clock = () => {
			t += 1000;
			return t;
		};
		expect(withDirLock(lock, () => "ran", clock)).toBe("ran");
		expect(fs.existsSync(lock)).toBe(true);
	});
});

describe("sweepFiles", () => {
	it("deletes a file past the age and keeps a newer one and any directory", () => {
		const old = path.join(dir, "old");
		const fresh = path.join(dir, "fresh");
		fs.writeFileSync(old, "x");
		fs.writeFileSync(fresh, "x");
		age(old, 120);
		fs.mkdirSync(lock);
		age(lock, 120);
		sweepFiles(dir, 60_000);
		expect(fs.existsSync(old)).toBe(false);
		expect(fs.existsSync(fresh)).toBe(true);
		expect(fs.existsSync(lock)).toBe(true);
	});
});
