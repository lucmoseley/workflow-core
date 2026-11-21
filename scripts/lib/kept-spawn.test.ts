// @vitest-environment node
/*
 * kept-spawn.js hands back child_process's own spawners for a listed reason,
 * and throws on any other (#5483). Loosen it and a JavaScript test spawns node under a
 * reason check-test-spawn.js never listed.
 */

import childProcess from "node:child_process";
import { describe, expect, it } from "vitest";
import { keptSpawn, REASONS } from "./kept-spawn.js";

describe("keptSpawn", () => {
	it("returns child_process's own four spawners for every listed reason", () => {
		expect(REASONS).toEqual([
			"timeout",
			"signal",
			"concurrent",
			"fd",
			"boundary",
		]);
		for (const reason of REASONS)
			expect(keptSpawn(reason)).toEqual({
				spawn: childProcess.spawn,
				spawnSync: childProcess.spawnSync,
				execFile: childProcess.execFile,
				execFileSync: childProcess.execFileSync,
			});
	});

	it("throws on a reason it does not list, naming the ones it does", () => {
		expect(() => keptSpawn("slow" as never)).toThrow(
			'keptSpawn: "slow" is not a spawn reason; one of timeout, signal, concurrent, fd, boundary.',
		);
	});
});
