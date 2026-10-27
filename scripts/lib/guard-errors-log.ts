/*
 * guard-errors-log.ts — every guard-errors.log record gl_log wrote under a
 * test's CLAUDE_CONFIG_DIR, joined (#965).
 *
 * FOR TESTS ONLY. It reads every project directory rather than deriving the
 * one slug lib/guard-log.sh files under, so a case need not restate the slug.
 */

import fs from "node:fs";
import path from "node:path";

export const readGuardErrorsLog = (configDir: string): string => {
	const projects = path.join(configDir, "projects");
	if (!fs.existsSync(projects)) return "";
	return fs
		.readdirSync(projects)
		.map((p) => path.join(projects, p, "guard-errors.log"))
		.filter((f) => fs.existsSync(f))
		.map((f) => fs.readFileSync(f, "utf8"))
		.join("");
};
