// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configDirFrom } from "./config-dir.js";
import { shellQuote } from "./sh-quote.js";

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
			`set -u; source ${shellQuote(lib)}; gr_config_dir dir; printf '%s' "$dir"`,
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

	it("resolves an unset value under the home it is given", () => {
		expect(configDirFrom(undefined, "/h")).toBe(path.join("/h", ".claude"));
		expect(configDirFrom("/c", "/h")).toBe("/c");
	});
});
