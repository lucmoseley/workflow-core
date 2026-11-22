// @vitest-environment node

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
