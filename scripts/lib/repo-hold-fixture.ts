import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { defineTemplate, initGitRepo } from "./git-fixture";

/* What a logged-out gh answers: the stub's answer to any call a case leaves unserved. */
export const LOGGED_OUT = path.join(__dirname, "fixtures/gh/logged-out.json");
/* The issue number every stubbed filing answers with. */
export const ISSUE = 77;
/* A fixed clock, so windows read as offsets from it. */
export const NOW = 1_800_000_000_000;
export const MIN = 60_000;

/* A self-plugin hooks.json whose guard hook line runs the checkout's own
 * scripts/guard-dispatch.js, spelt off the plugin root as the real lines are,
 * for the guard-load probe to run (#4226, #4228, #4716). */
export const GUARD_HOOKS_JSON = JSON.stringify({
	hooks: {
		PreToolUse: [
			{
				matcher: "Bash|Read",
				hooks: [
					{
						type: "command",
						command:
							// biome-ignore lint/suspicious/noTemplateCurlyInString: shell text
							'node "${CLAUDE_PLUGIN_ROOT}"/../scripts/guard-dispatch.js',
					},
				],
			},
		],
	},
});

/* The id in the line `repo-hold.js raise` prints. */
export const parseHoldId = (stdout: string) => {
	const id = /raised: ([0-9a-f]+) /.exec(stdout)?.[1];
	if (!id) throw new Error(`no hold id in: ${stdout}`);
	return id;
};

/* A served checkout whose shared `.git` the refill tick's probe passes (#3860):
 * `main`, and an origin it fetches from, kept inside the copy so each case has
 * its own. */
export const probedCheckout = defineTemplate((root) => {
	const hooks = path.join(root, ".no-hooks");
	fs.mkdirSync(hooks);
	initGitRepo(root, hooks);
	const origin = path.join(root, ".origin.git");
	execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
	execFileSync("git", ["remote", "add", "origin", origin], { cwd: root });
	execFileSync("git", ["push", "-q", "origin", "main"], { cwd: root });
});
