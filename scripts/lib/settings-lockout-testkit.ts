/*
 * settings-lockout-testkit.ts — a main checkout holding the canary, its
 * marker writer and their shell libraries, with this repo's own
 * `.claude/settings.json` hooks committed and `origin/main` at that commit,
 * for lib/settings-lockout.js's cases, its port's contract and the start
 * routes' own cases (#4752).
 *
 * The real scripts and the real hook lines, never stand-ins: the check runs
 * the line as the harness does, so a fixture of its own would test nothing
 * a broken canary line could break.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { SELF_PLUGIN_DIR } from "./core-hooks.js";
import { cutWorktree, initGitRepo } from "./git-fixture";

const ROOT = path.resolve(__dirname, "..", "..");
export const SETTINGS = ".claude/settings.json";
const LANDED_HOOKS = JSON.parse(
	fs.readFileSync(path.join(ROOT, SETTINGS), "utf8"),
).hooks;

const git = (at: string, ...args: string[]) => {
	const r = spawnSync("git", ["-C", at, ...args], { encoding: "utf8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
	return r.stdout;
};

/**
 * Writes the canary, its marker writer, their shell libraries and this
 * repo's settings hooks into `checkout`, uncommitted.
 * @returns the paths written, relative to `checkout`
 */
export function seedCanary(checkout: string) {
	fs.mkdirSync(path.join(checkout, SELF_PLUGIN_DIR), { recursive: true });
	const libs = fs
		.readdirSync(path.join(ROOT, "scripts", "lib"))
		.filter((f) => f.endsWith(".sh"))
		.map((f) => path.join("scripts", "lib", f));
	for (const rel of [
		"scripts/self-plugin-canary.sh",
		"scripts/write-self-plugin-marker.sh",
		...libs,
	]) {
		fs.mkdirSync(path.dirname(path.join(checkout, rel)), { recursive: true });
		fs.copyFileSync(path.join(ROOT, rel), path.join(checkout, rel));
	}
	fs.mkdirSync(path.join(checkout, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(checkout, SETTINGS),
		`${JSON.stringify({ hooks: LANDED_HOOKS }, null, 2)}\n`,
	);
	return ["scripts", SETTINGS];
}

/**
 * Builds the main checkout at `<dir>/main`, the canary seeded and committed.
 * @param dir an existing empty directory
 */
export function buildLockoutRepo(dir: string) {
	const main = path.join(dir, "main");
	const hooks = path.join(dir, "no-hooks");
	fs.mkdirSync(hooks);
	initGitRepo(main, hooks);
	git(main, "add", ...seedCanary(main));
	git(main, "commit", "-qm", "hooks");
	git(main, "update-ref", "refs/remotes/origin/main", "HEAD");

	/**
	 * A worktree of `main` under its worktrees folder.
	 */
	const cut = (name: string, edit?: (text: string) => string) => {
		const at = cutWorktree(main, name);
		if (edit) editSettings(at, edit);
		return at;
	};
	return { main, cutWorktree: cut };
}

export function editSettings(at: string, edit: (text: string) => string) {
	const file = path.join(at, SETTINGS);
	fs.writeFileSync(file, edit(fs.readFileSync(file, "utf8")));
}

/** `text` with the canary's script path misspelt, a line that cannot start. */
export const breakCanaryPath = (text: string) =>
	text.replace("self-plugin-canary.sh", "self-plugin-canray.sh");
