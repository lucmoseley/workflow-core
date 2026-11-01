// @vitest-environment node
/*
 * lib/child-spawn.js (#3814): the spawn and verdict the refill loop's children
 * and its review runner share. Break it and the loop misreads why a child failed.
 * It runs real node children, since spawnSync's exit and timeout are what it pins.
 */
import { describe, expect, it } from "vitest";
import { spawnChild } from "./child-spawn.js";

const node = (script: string, timeout: number) =>
	spawnChild(process.execPath, ["-e", script], { timeout });

/* A guess: far past a node start, so only a failure waits on it. */
const AMPLE_MS = 30_000;

describe("spawnChild (#3814)", () => {
	it("returns a clean child's output, with no failure", () => {
		expect(node(`process.stdout.write("done\\n")`, AMPLE_MS)).toMatchObject({
			status: 0,
			stdout: "done\n",
			stderr: "",
			failed: null,
			out: "done",
		});
	});

	it("names a failed child's exit, and keeps what it printed", () => {
		expect(
			node(`console.error("why"); process.exit(3)`, AMPLE_MS),
		).toMatchObject({ status: 3, failed: "exit 3", out: "why" });
	});

	it("names the timeout that ended a child", () => {
		/* The real clock: the timeout is spawnSync's own, and no seam reaches it.
		 * A guess: short enough to keep the case quick; any bound under the
		 * child's minute-long wait pins the same limb. */
		const r = node("setTimeout(() => {}, 60_000)", 300);
		expect(r.status).toBeNull();
		expect(r.failed).toContain("ETIMEDOUT");
	});
});
