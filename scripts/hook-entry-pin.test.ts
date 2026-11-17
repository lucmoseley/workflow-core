// @vitest-environment node
/*
 * The always-on hook entries the plugin ships, counted per per-tool-call
 * event (base §G13 (2), #5335). An entry with no `if` filter starts a
 * process on every call its event's matcher admits, so a new guard
 * registered as its own entry, rather than as a core of the dispatcher,
 * adds a process to every tool call (#2711). Exact equality: a removal
 * fails too, so the table always states the real count.
 *
 * It reads the generated manifest, the one an install runs;
 * generate-plugin-hooks.js --check holds it to self-plugin/hooks/hooks.json.
 * Entries carrying an `if` are not counted: each program they run is held by
 * its own pin when a change adds or rewrites it.
 */

import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { allRegistrations } from "./lib/hook-wiring";

const CHECKOUT = path.resolve(__dirname, "..");

it("ships one always-on PreToolUse entry, two PostToolUse, two PostToolUseFailure and one PostToolBatch", () => {
	const manifest = JSON.parse(
		fs.readFileSync(path.join(CHECKOUT, "hooks/hooks.json"), "utf8"),
	);
	const alwaysOn = (event: string) =>
		allRegistrations(manifest).filter((r) => r.event === event && !r.if).length;
	expect({
		PreToolUse: alwaysOn("PreToolUse"),
		PostToolUse: alwaysOn("PostToolUse"),
		PostToolUseFailure: alwaysOn("PostToolUseFailure"),
		PostToolBatch: alwaysOn("PostToolBatch"),
	}).toEqual({
		PreToolUse: 1,
		PostToolUse: 2,
		PostToolUseFailure: 2,
		PostToolBatch: 1,
	});
});
