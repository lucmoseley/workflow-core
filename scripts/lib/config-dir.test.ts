// @vitest-environment node
/*
 * lib/config-dir.js's configDir() and lib/guard-root.sh's gr_config_dir name
 * the same config dir (#2095), an empty CLAUDE_CONFIG_DIR counting as set as
 * Claude Code reads it.
 *
 * Three parts, each spawned with a built env: the cases unset HOME, which this
 * worker's own process.env must keep. The third is guard-log.sh's copy, which a
 * guard-log.sh detached from guard-root.sh falls back to. Compared as a file
 * joined under the dir, since the shell spells the empty value `.` where JS
 * keeps "". The shell out-variable is `dir`, name-issue-session.sh's, so a
 * local of that name inside gr_config_dir fails here.
 *
 * A divergence sends the shell guards' arbiter seat and settings reads to a
 * different dir than the JS arbiter writes, silently.
 *
 * configDirFrom runs in-process, as it reads no environment: it pins the
 * null-versus-"" contract reconcile-plugin.js's readConfigDirOf hands it from
 * another process's environ.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configDirFrom } from "./config-dir.js";

const LIB = __dirname;
const PASSWD_HOME = os.userInfo().homedir;

let detached: string;
beforeAll(() => {
	detached = fs.mkdtempSync(path.join(os.tmpdir(), "config-dir-lone-"));
	fs.copyFileSync(
		path.join(LIB, "guard-log.sh"),
		path.join(detached, "guard-log.sh"),
	);
});
afterAll(() => fs.rmSync(detached, { recursive: true, force: true }));

const shell = (lib: string, env: NodeJS.ProcessEnv) => {
	const r = spawnSync(
		"bash",
		[
			"-c",
			`set -u; source ${JSON.stringify(lib)}; gr_config_dir dir; printf '%s' "$dir"`,
		],
		{ env, encoding: "utf8" },
	);
	expect(r.status, r.stderr).toBe(0);
	return r.stdout;
};

const run = (env: NodeJS.ProcessEnv) => {
	const js = spawnSync(
		process.execPath,
		[
			"-e",
			`process.stdout.write(require(${JSON.stringify(path.join(LIB, "config-dir.js"))}).configDir())`,
		],
		{ env, encoding: "utf8" },
	);
	expect(js.status, js.stderr).toBe(0);
	return {
		js: js.stdout,
		shells: [
			shell(path.join(LIB, "guard-root.sh"), env),
			shell(path.join(detached, "guard-log.sh"), env),
		],
	};
};

const base = { PATH: process.env.PATH ?? "/usr/bin:/bin" };

describe("configDir and gr_config_dir", () => {
	it.each([
		[
			"names CLAUDE_CONFIG_DIR verbatim when set",
			{ ...base, HOME: "/h", CLAUDE_CONFIG_DIR: "/c" },
			"/c",
		],
		[
			"falls back to $HOME/.claude when unset",
			{ ...base, HOME: "/h" },
			"/h/.claude",
		],
		[
			"falls back to the password database's home when HOME is unset too",
			base,
			path.join(PASSWD_HOME, ".claude"),
		],
		[
			"takes an empty HOME as os.homedir() does, a relative .claude",
			{ ...base, HOME: "" },
			".claude",
		],
		[
			"reads an empty CLAUDE_CONFIG_DIR as set (#2095)",
			{ ...base, HOME: "/h", CLAUDE_CONFIG_DIR: "" },
			"",
		],
	])("%s", (_case, env, want) => {
		const { js, shells } = run(env);
		expect(js).toBe(want);
		for (const sh of shells)
			expect(path.normalize(`${sh}/settings.json`)).toBe(
				path.join(js, "settings.json"),
			);
	});
});

describe("configDirFrom", () => {
	it("reads an environ's unset null as unset, an empty value as set (#2095)", () => {
		expect(configDirFrom(null)).toBe(path.join(os.homedir(), ".claude"));
		expect(configDirFrom("")).toBe("");
	});
});
