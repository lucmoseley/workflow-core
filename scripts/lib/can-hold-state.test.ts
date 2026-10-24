// @vitest-environment node
/*
 * can-hold-state.test.ts — the predicate mantahostels#1997 extracted, asserted directly:
 * a directory may hold state unless a permission bit or a dangling symlink
 * says otherwise, and a pinned directory wins wherever it can hold it.
 *
 * The dangling-symlink branch is included, which no caller's fixtures reach.
 * Each case builds real directories, links and permission bits in a temp dir,
 * because the predicate is a question about the filesystem and a stub would
 * only restate its answer.
 *
 * check-hook-liveness.js, adopter-consent.js and notify-report.js pick their
 * state directory through it: loosen a case here and one of them writes into a
 * directory it cannot use, and its notify stamps or consent records fail to
 * persist.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { canHoldState, pinnedOrFirstUsable } = require("./can-hold-state.js");

let root: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "can-hold-state-"));
});

afterEach(() => {
	fs.chmodSync(root, 0o755);
	fs.rmSync(root, { recursive: true, force: true });
});

describe("canHoldState", () => {
	it("accepts a directory that exists and is readable and writable", () => {
		expect(canHoldState(root)).toBe(true);
	});

	it("accepts one that does not exist yet, its parent being writable", () => {
		expect(canHoldState(path.join(root, "a", "b", "c"))).toBe(true);
	});

	it("refuses one whose nearest existing ancestor refuses to be written", () => {
		fs.chmodSync(root, 0o555);
		expect(canHoldState(path.join(root, "a", "b"))).toBe(false);
	});

	it("refuses a dangling symlink sitting where a directory should be", () => {
		const at = path.join(root, "link");
		fs.symlinkSync(path.join(root, "nothing-here"), at);
		expect(canHoldState(at)).toBe(false);
	});

	it("refuses a path whose absent components run up to an unwritable root", () => {
		// Answered by the EACCES arm at `/`, not by the walk's fixed-point guard —
		// that guard is unreachable on any filesystem whose root exists, and is
		// kept as a non-termination stop rather than as a branch under test.
		expect(canHoldState(path.join("/", "no-such-root-dir", "x"))).toBe(false);
	});
});

describe("pinnedOrFirstUsable", () => {
	const dangling = () => {
		const at = path.join(root, "pinned");
		fs.symlinkSync(path.join(root, "nothing-here"), at);
		return at;
	};

	it("takes the pinned directory where it can hold state, over a sorted-earlier candidate", () => {
		const pinned = path.join(root, "z");
		expect(pinnedOrFirstUsable(pinned, [path.join(root, "a"), pinned])).toBe(
			pinned,
		);
	});

	it("falls to the sorted-first usable candidate where the pinned one cannot", () => {
		const b = path.join(root, "b");
		const a = path.join(root, "a");
		fs.symlinkSync(path.join(root, "nothing-here"), a);
		expect(pinnedOrFirstUsable(dangling(), [b, a])).toBe(b);
	});

	it("keeps the pinned directory where no candidate can hold state either", () => {
		const pinned = dangling();
		expect(pinnedOrFirstUsable(pinned, [pinned])).toBe(pinned);
	});
});
