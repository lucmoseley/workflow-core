// @vitest-environment node
/*
 * mantahostels#2763 set `"CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP": "1"` in
 * .claude/settings.json's `env` block, turning off the harness's
 * idle-triggered reaper that SIGTERMs a background shell's whole process
 * group under memory pressure (mantahostels#2690, mantahostels#2694 w2).
 *
 * Two documents rest on that one line across four sites —
 * docs/agents/rules/killed-background-job.txt, printed to every session by
 * scripts/guard-bg-job.sh, and docs/environment.md:146, :250 and :376 — and
 * each tells a session the cost of backgrounding a job is nil (mantahostels#2851).
 * Lose this case and the line can flip back unseen, the reaper killing
 * background jobs again while both documents still tell every session it is
 * off.
 *
 * **Residual, three parts.** This reads the checked-in file, not the running
 * session: `.claude/settings.local.json` (gitignored) and
 * `~/.claude/settings.json` both override it, and a session launched with a
 * cwd outside this repo reads none of the three. It fires only under the
 * suite — `npm run test`, `test:changed`, CI — never at commit, since
 * .husky/pre-commit and pre-push run no vitest. mantahostels#2851 priced an in-session
 * guard limb that would close the first two and left it untaken.
 *
 * An instrumented run that unsets the variable needs no exemption here —
 * docs/environment.md:146, :152.
 */
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
