// @vitest-environment node
/*
 * The panel's command line (#3873): what it refuses and when it exits at once. The
 * terminal path needs a pty, which vitest
 * has not; lib/refill-panel-terminal.test.ts covers it over injected streams.
 * Broken, a launcher's mistyped pid opens a panel nothing ever closes.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "refill-panel.js");
const run = (...args: string[]) => runInProcess(SCRIPT, args);

describe("refill-panel.js", () => {
	it("refuses a missing pid with its usage", () => {
		const r = run();
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("<agents-view-pid>");
	});

	it("refuses a malformed pid with its usage", () => {
		const r = run("abc");
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("not a pid: abc");
		expect(r.stderr).toContain("<agents-view-pid>");
	});

	it("refuses a route no split passes, with its usage", () => {
		const r = run(String(process.pid), "kitty");
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("not a route: kitty");
		expect(r.stderr).toContain("[windows-terminal|tmux]");
	});

	it.each(["windows-terminal", "tmux"])(
		"takes the %s route a split passes",
		(route) => {
			const r = run(String(process.pid), route);
			expect(r.status).toBe(1);
			expect(r.stderr).toContain("needs a terminal");
		},
	);

	it("exits 0 where the pid is already gone", () => {
		const gone = spawnSync("true").pid;
		expect(run(String(gone)).status).toBe(0);
	});

	it("refuses to open with no terminal", () => {
		const r = run(String(process.pid));
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("needs a terminal");
	});
});
