// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SETTINGS_PATH = path.join(__dirname, "..", ".claude", "settings.json");

describe("autoMemoryEnabled", () => {
	it("stays false in .claude/settings.json", () => {
		const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));

		expect(
			settings.autoMemoryEnabled,
			"autoMemoryEnabled is not false — auto-memory writing, recall and " +
				"index auto-load are back on. The store it re-enables is " +
				"unversioned and machine-local: one WSL reset loses it (#636).",
		).toBe(false);
	});
});
