// @vitest-environment node
/*
 * verify-persist-replay.js's own refusals (mantahostels#1977): an `--only` key it
 * does not know must stop the run, never select nothing and print the success
 * line over an empty table.
 *
 * Run as a child `node`, the way it is hand-run, rooted in a throwaway repo
 * whose settings wire the two producers the live one does. Only the refusals
 * are reached here: a run that gets past them launches every persisting
 * producer for real, the reaper stopping sessions among them. What the
 * harness makes of those runs is lib/persist-replay.test.ts's.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcessAsync } from "./lib/run-in-process.js";

const SELF = path.join(__dirname, "verify-persist-replay.js");

let root = "";
beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "verify-persist-replay-"));
	fs.mkdirSync(path.join(root, ".claude"));
	const hook = (script: string) => ({
		type: "command",
		command: `WFC_NOTIFY_PERSIST=1 node "$CLAUDE_PROJECT_DIR"/scripts/${script} --notify`,
	});
	fs.writeFileSync(
		path.join(root, ".claude", "settings.json"),
		JSON.stringify({
			hooks: {
				SessionStart: [
					{
						hooks: [
							hook("check-ci-status.js"),
							hook("reap-finished-sessions.js"),
						],
					},
				],
			},
		}),
	);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const run = (args: string[]) =>
	runInProcessAsync(SELF, args, {
		cwd: root,
		env: { ...process.env, CLAUDE_PROJECT_DIR: root },
	});

describe("verify-persist-replay", () => {
	it("refuses an --only key it does not know, rather than reporting success over an empty table", async () => {
		const r = await run(["--only", "no-such-checker"]);
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/no such producer: no-such-checker\./);
		expect(r.stdout).not.toMatch(/^OK:/m);
	});

	it("reads --only as a comma-separated set, naming only the keys it does not know", async () => {
		const r = await run(["--only", "ci-status,no-such-checker"]);
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/no such producer: no-such-checker\./);
	});
});
