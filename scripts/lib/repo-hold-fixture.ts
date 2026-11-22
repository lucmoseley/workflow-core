import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { defineTemplate, initGitRepo } from "./git-fixture";

export const LOGGED_OUT = path.join(__dirname, "fixtures/gh/logged-out.json");
export const ISSUE = 77;
export const NOW = 1_800_000_000_000;
export const MIN = 60_000;

export const GUARD_HOOKS_JSON = JSON.stringify({
	hooks: {
		PreToolUse: [
			{
				matcher: "Bash|Read",
				hooks: [
					{
						type: "command",
						command: `node "\${CLAUDE_PLUGIN_ROOT}"/../scripts/guard-dispatch.js`,
					},
				],
			},
		],
	},
});

export const parseHoldId = (stdout: string) => {
	const id = /raised: ([0-9a-f]+) /.exec(stdout)?.[1];
	if (!id) throw new Error(`no hold id in: ${stdout}`);
	return id;
};

export const probedCheckout = defineTemplate((root) => {
	const hooks = path.join(root, ".no-hooks");
	fs.mkdirSync(hooks);
	initGitRepo(root, hooks);
	const origin = path.join(root, ".origin.git");
	execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
	execFileSync("git", ["remote", "add", "origin", origin], { cwd: root });
	execFileSync("git", ["push", "-q", "origin", "main"], { cwd: root });
});
