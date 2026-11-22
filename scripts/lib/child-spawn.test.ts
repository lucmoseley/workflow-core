// @vitest-environment node
import { describe, expect, it } from "vitest";
import { spawnChild } from "./child-spawn.js";

const node = (script: string, timeout: number) =>
	spawnChild(process.execPath, ["-e", script], { timeout });

// guess, #5529
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
		// guess, #5529
		const r = node("setTimeout(() => {}, 60_000)", 300);
		expect(r.status).toBeNull();
		expect(r.failed).toContain("ETIMEDOUT");
	});
});
