// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.join(__dirname, "measure-implement-carveout.js");
const STARTED = "2026-09-10T00:00:00Z";

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "measure-carveout-"));
	const session = [
		{
			type: "user",
			timestamp: STARTED,
			message: {
				content: [
					{ type: "text", text: "<command-name>/implement</command-name>" },
				],
			},
		},
		{ type: "assistant", message: { model: "claude-opus-4", content: [] } },
	];
	fs.writeFileSync(
		path.join(dir, "s1.jsonl"),
		session.map((r) => JSON.stringify(r)).join("\n"),
	);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const run = (...args: string[]) =>
	runInProcess(SCRIPT, ["--dir", dir, ...args]);

describe("measure-implement-carveout window", () => {
	it.each([
		["--since", ["--since", "garbage"]],
		["--until", ["--until", "garbage"]],
		["--until", ["--since", "2026-09-01", "--until", "2026-13-45x"]],
	])(
		"refuses an unparseable %s, naming the flag and the value (#1521)",
		(flag, args) => {
			const r = run(...args);
			const bad = args.at(-1);
			expect(r.status).toBe(2);
			expect(r.stderr).toContain(
				`${flag} needs an ISO date or timestamp, not "${bad}"`,
			);
			expect(r.stdout).toBe("");
		},
	);

	it("counts the session inside a valid window and drops it outside", () => {
		const inside = run("--since", "2026-09-01", "--until", "2026-09-11");
		expect(inside.status).toBe(0);
		expect(inside.stdout).toContain("/implement sessions: 1 (1 opus)");

		const outside = run("--since", "2026-09-11");
		expect(outside.status).toBe(0);
		expect(outside.stdout).toContain("/implement sessions: 0 (0 opus)");
	});

	it("applies the default --since when none is given, naming it in the Window line", () => {
		const r = run();
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("Window: since 2026-08-25T04:48:06Z\n");
		expect(r.stdout).toContain("/implement sessions: 1 (1 opus)");
	});
});
