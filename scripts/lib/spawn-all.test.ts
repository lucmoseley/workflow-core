// @vitest-environment node
/*
 * lib/spawn-all.js (#4297): several children at once for a synchronous
 * caller, each result in spawnSync's shape. It runs real children, since the
 * concurrency is what it pins.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawnAllSync } from "./spawn-all.js";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0))
		fs.rmSync(d, { recursive: true, force: true });
});

const node = (script: string) => ({
	file: process.execPath,
	args: ["-e", script],
});

const markDir = () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-all-"));
	dirs.push(dir);
	return dir;
};

/*
 * A child that leaves the mark `mine`, then waits until `count` marks are
 * there. The wait is a real-clock bound on the failure alone, never the
 * assertion (§X9): untraced, far past a node start, so only a run that never
 * starts its partner reaches it.
 */
const WAIT_CEILING_MS = 20_000;
const markThenWait = (dir: string, mine: string, count: number) => `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(path.join(dir, mine))}, "");
const end = Date.now() + ${WAIT_CEILING_MS};
while (fs.readdirSync(${JSON.stringify(dir)}).length < ${count}) {
	if (Date.now() > end) process.exit(1);
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}`;

describe("spawnAllSync (#4297)", () => {
	it.skipIf(os.availableParallelism() < 2)(
		"returns each child's status and output in the jobs' order, whichever finishes first",
		() => {
			const dir = markDir();
			/* The first job ends only once the second has left its mark, so it
			 * always finishes last. */
			const r = spawnAllSync([
				node(`${markThenWait(dir, "first", 2)}\nprocess.stdout.write("first")`),
				node(
					`${markThenWait(dir, "second", 1)}\nprocess.stderr.write("why"); process.exit(3)`,
				),
				{
					...node(`process.stdout.write(process.env.SIDE ?? "unset")`),
					env: { ...process.env, SIDE: "baseline" },
				},
			]);
			expect(r).toEqual([
				{ status: 0, signal: null, stdout: "first", stderr: "" },
				{ status: 3, signal: null, stdout: "", stderr: "why" },
				{ status: 0, signal: null, stdout: "baseline", stderr: "" },
			]);
		},
	);

	it("reports a child that cannot start as spawnSync does, with a null status and an error", () => {
		const [r] = spawnAllSync([
			{ file: "/nonexistent/spawn-all-probe", args: [] },
		]);
		expect(r?.status).toBeNull();
		expect(r?.error?.message).toContain("ENOENT");
	});

	it.skipIf(os.availableParallelism() < 2)(
		"runs two children at once, each waiting on the other's mark",
		() => {
			const dir = markDir();
			const r = spawnAllSync([
				node(markThenWait(dir, "a", 2)),
				node(markThenWait(dir, "b", 2)),
			]);
			expect(r.map((x) => x.status)).toEqual([0, 0]);
		},
	);

	it("starts no process for an empty list", () => {
		expect(spawnAllSync([])).toEqual([]);
	});
});
