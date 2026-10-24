// @vitest-environment node
/*
 * Pins `autoMemoryEnabled` at `false` in the checked-in .claude/settings.json.
 *
 * mantahostels#642 set `"autoMemoryEnabled": false` in .claude/settings.json to stop
 * Claude Code's auto-memory writing, recall and index auto-load together
 * (mantahostels#636). Nothing else asserts it: a `claude` upgrade rewriting the settings
 * file, or a hand edit, can flip it back to true (or drop the key, which
 * re-enables it the same way — the default is on) and it reads identically
 * to auto-memory that was never disabled.
 *
 * It reads the real file, not a fixture, because the value in that file is
 * the whole subject: a fixture would stay false through any flip. Loosen it
 * and auto-memory comes back on in every session here, into an unversioned,
 * machine-local store that one WSL reset loses (mantahostels#636); this test,
 * red in CI, is the only thing that would notice.
 *
 * **Residual:** settings resolution also reads `.claude/settings.local.json`
 * (gitignored) and `~/.claude/settings.json`, and a local override wins over
 * this checked-in file.
 */
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
