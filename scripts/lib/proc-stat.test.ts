// @vitest-environment node
/*
 * proc-stat.js is the shared parser of `/proc/<pid>/stat` (#3056): loosen its
 * count-from-the-last-`)` rule and a comm holding a space or bracket shifts
 * every field, so the queue, the arbiter and the admission gate each misread
 * a pid's parent or start time. The parse is pinned on synthetic lines, the
 * read on this process's own real stat and on a fixture root, and the walk's
 * stop conditions through an injected `parentOf`, since no real process tree
 * holds a cycle.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	ancestorsOf,
	FIELD,
	readParentOf,
	readStatFields,
	statFields,
} from "./proc-stat.js";

const line = (comm: string, ppid: number) =>
	`42 (${comm}) S ${ppid} 7 7 0 -1 4194304 1 0 0 0 5 6 0 0 20 0 1 0 999 0 0\n`;

describe("statFields", () => {
	it("counts from the last `)`, so a comm with spaces and brackets reads", () => {
		const f = statFields(line("a) (b c", 17));
		expect(f?.[FIELD.state]).toBe("S");
		expect(f?.[FIELD.ppid]).toBe("17");
		expect(f?.[FIELD.utime]).toBe("5");
		expect(f?.[FIELD.stime]).toBe("6");
		expect(f?.[FIELD.start]).toBe("999");
	});

	it("is null on a line with no `)`", () => {
		expect(statFields("garbage")).toBeNull();
	});
});

describe("readStatFields and readParentOf", () => {
	it("read this process's own parent off the real procfs", () => {
		expect(readParentOf(process.pid)).toBe(process.ppid);
		expect(readStatFields(process.pid)?.[FIELD.state]).toMatch(/^[A-Z]$/);
	});

	it("read 0 and null for a pid that is not running", () => {
		expect(readParentOf(2 ** 30)).toBe(0);
		expect(readStatFields(2 ** 30)).toBeNull();
	});

	it("read a fixture procfs root", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "proc-stat-"));
		try {
			fs.mkdirSync(path.join(root, "42"));
			fs.writeFileSync(path.join(root, "42", "stat"), line("x", 9));
			expect(readParentOf(42, root)).toBe(9);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("ancestorsOf", () => {
	it("walks nearest first and stops at a parent that reads 0", () => {
		const tree: Record<number, number> = { 30: 20, 20: 10, 10: 1, 1: 0 };
		expect(ancestorsOf(30, { parentOf: (p) => tree[p] ?? 0 })).toEqual([
			20, 10, 1,
		]);
	});

	it("stops at a pid already seen", () => {
		const tree: Record<number, number> = { 30: 20, 20: 30 };
		expect(ancestorsOf(30, { parentOf: (p) => tree[p] ?? 0 })).toEqual([20]);
	});

	it("stops on a chain that never ends", () => {
		expect(ancestorsOf(1e6, { parentOf: (p) => p + 1 }).length).toBeLessThan(
			1000,
		);
	});

	it("reaches this process's parent off the real procfs", () => {
		expect(ancestorsOf(process.pid)[0]).toBe(process.ppid);
	});
});
