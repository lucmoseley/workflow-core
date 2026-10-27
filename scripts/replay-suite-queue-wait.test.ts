// @vitest-environment node
/*
 * replay-suite-queue-wait.test.ts — the replay's command line (#3060). Break
 * it and a bad window prints a reading over nothing, or a good one prints
 * none. The replay itself is pinned in lib/suite-queue-replay.test.ts.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.join(__dirname, "replay-suite-queue-wait.js");
const SINCE = "2026-10-27T00:00:00.000Z";
const UNTIL = "2026-10-27T01:00:00.000Z";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-cli-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const run = (...args: string[]) =>
	runInProcess(SCRIPT, [
		"--markers",
		dir,
		"--memwatch",
		path.join(dir, "memwatch.log"),
		"--mem-total-mb",
		"10000",
		"--load-ceiling",
		"48",
		...args,
	]);

it("prints the reading over the window, the limb table first", () => {
	fs.writeFileSync(
		path.join(dir, ".suite-queue-exits.jsonl"),
		`${JSON.stringify({
			at: "2026-10-27T00:10:00.000Z",
			waitS: 600,
			reason: "refused",
			kind: "named",
			session: "a",
			pid: 1,
			slotFree: true,
		})}\n`,
	);
	const r = run("--since", SINCE, "--until", UNTIL, "--era", `after=${UNTIL}`);
	expect(r.status).toBe(0);
	expect(r.stdout).toContain(`replay, ${SINCE} to ${UNTIL}`);
	expect(r.stdout).toContain("| open | 0.17 |");
	expect(r.stdout).toContain("| window start | 1.00 | 0.17 |");
});

describe("refuses with exit 2 and the usage", () => {
	it.each([
		["no window", []],
		["an unreadable time", ["--since", "yesterday", "--until", UNTIL]],
		["a window ending before it starts", ["--since", UNTIL, "--until", SINCE]],
		[
			"an era with no label",
			["--since", SINCE, "--until", UNTIL, "--era", `=${SINCE}`],
		],
	])("on %s", (_, args) => {
		const r = run(...args);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(
			"usage: node scripts/replay-suite-queue-wait.js",
		);
		expect(r.stdout).toBe("");
	});
});
