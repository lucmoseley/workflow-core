// @vitest-environment node
/*
 * Cases for scripts/lib/shell-dirs.js, the directory model the walk's `cd`s
 * and a run's chdirs both step (#5074), at its own interface: moves handed in
 * classified and resolved.
 */

import { describe, expect, it } from "vitest";
import type { Dirs, Move } from "./shell-dirs.js";
import {
	dirsAfter,
	moveDir,
	settleDirs,
	startDirs,
	stepDirs,
} from "./shell-dirs.js";

const there = new Set(["/h", "/a", "/a/b"]);
const isDir = (p: string) => there.has(p);
const to = (path: string, holds: Move["holds"], more: Partial<Move> = {}) =>
	({ resolved: { path }, holds, ...more }) as Move;
const standAfter = (cwds: Dirs, ...moves: Move[]) =>
	dirsAfter(cwds, moves, isDir);

describe("moveDir", () => {
	it.each([
		["/h", { path: "/a" }, "/a"],
		["/h", { path: "b" }, "/h/b"],
		["/h", { empty: true as const }, "/h"],
		["", { path: "b" }, ""],
		["/h", null, ""],
	])("moves %s by %j to %s (#4869)", (at, resolved, want) => {
		expect(moveDir(at, resolved)).toBe(want);
	});
});

describe("stepDirs", () => {
	it("holds an always move outright", () => {
		expect(standAfter(["/h"], to("/nope", "always"))).toEqual(["/nope"]);
	});

	it("holds an if-dir move only where its directory is there", () => {
		expect(standAfter(["/h"], to("/a", "if-dir"))).toEqual(["/a"]);
		expect(standAfter(["/h"], to("/nope", "if-dir"))).toEqual(["/nope", "/h"]);
		expect(standAfter(["/h"], { resolved: null, holds: "if-dir" })).toEqual([
			"",
			"/h",
		]);
	});

	it("leaves a maybe move unmade, but not one that stays put", () => {
		expect(standAfter(["/h"], to("/a", "maybe"))).toEqual(["/a", "/h"]);
		expect(
			standAfter(["/h"], { resolved: { empty: true }, holds: "maybe" }),
		).toEqual(["/h"]);
	});

	it("moves each doubted directory too, each once (#4980)", () => {
		expect(standAfter(["/h", "/a"], to("b", "maybe"))).toEqual([
			"/h/b",
			"/a/b",
			"/h",
			"/a",
		]);
		expect(standAfter(["/h", "/a"], to("/a", "if-dir"))).toEqual(["/a"]);
	});

	it("keeps a chained move's unmade for after its chain (#4009)", () => {
		const chained = stepDirs(
			startDirs(["/h"]),
			to("/nope", "if-dir", { chained: true }),
			isDir,
		);
		expect(chained.dirs).toEqual(["/nope"]);
		expect(chained.pending).toEqual(["/h"]);
		expect(settleDirs(chained)).toMatchObject({
			dirs: ["/nope", "/h"],
			pending: [],
		});
	});

	it("holds a move after a failed one from all but where that one went (#5010)", () => {
		const failed = stepDirs(startDirs(["/h", "/a"]), to("b", "if-dir"), isDir);
		expect(failed.dirs).toEqual(["/h/b", "/a/b", "/h"]);
		const second = stepDirs(
			failed,
			to("/a", "if-dir", { afterFailed: true }),
			isDir,
		);
		expect(second.dirs).toEqual(["/a", "/h/b", "/a/b"]);
	});

	it("holds no move after a failed one that went somewhere unnamed (#5010)", () => {
		const failed = stepDirs(
			startDirs(["/h"]),
			{ resolved: null, holds: "if-dir" },
			isDir,
		);
		const second = stepDirs(
			failed,
			to("/a", "if-dir", { afterFailed: true }),
			isDir,
		);
		expect(second.dirs).toEqual(["/a", "", "/h"]);
	});
});

describe("dirsAfter", () => {
	it("holds a cd sure for its && chain, else as it would alone (#4863)", () => {
		/* `cd /nope && git x`: x runs only where the move was made. */
		expect(
			standAfter(["/h"], to("/nope", "if-dir", { chained: true })),
		).toEqual(["/nope"]);
		/* `cd /nope && git x; git y`: the chain has ended at y. */
		expect(standAfter(["/h"], to("/nope", "if-dir"))).toEqual(["/nope", "/h"]);
		/* `true && cd /a; git x`, or one inside `if`: it may not have run. */
		expect(standAfter(["/h"], to("/a", "maybe"))).toEqual(["/a", "/h"]);
	});
});
