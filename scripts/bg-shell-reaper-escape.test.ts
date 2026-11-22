// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SETTINGS_PATH = path.join(__dirname, "..", ".claude", "settings.json");

describe("CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP", () => {
	it('stays "1" in .claude/settings.json', () => {
		const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));

		expect(
			settings.env?.CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP,
			'env.CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP is not "1" — the ' +
				"harness reaper is back on, so an idle session's backgrounded " +
				"jobs can be SIGTERMed mid-run (#2763, #2851).",
		).toBe("1");
	});
});
