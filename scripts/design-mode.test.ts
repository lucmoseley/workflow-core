// @vitest-environment node
/*
 * Pins that design mode's on, off and status work on a checkout with no
 * `enabledPlugins` entry yet, write only the plugin's own key, and refuse an
 * unknown verb (#125).
 *
 * design-mode.sh reads CLAUDE_PROJECT_DIR (guard-root.sh's gr_root()) to find
 * .claude/settings.json, so a scratch project dir with no git repo of its own
 * stands in for the host checkout.
 *
 * The design-mode skill runs it: loosen a case and switching design mode fails
 * on a fresh checkout, or rewrites other keys in the repo's
 * `.claude/settings.json`.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(__dirname, "design-mode.sh");

let projectDir: string;
let settingsPath: string;

const readEnabledPlugins = () =>
	JSON.parse(fs.readFileSync(settingsPath, "utf8")).enabledPlugins;

const run = (arg: string) => {
	const r = spawnSync(SCRIPT, [arg], {
		encoding: "utf8",
		env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
	});
	if (r.status === null) throw new Error(`script did not run: ${r.error}`);
	return r;
};

beforeEach(() => {
	projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "design-mode-"));
	fs.mkdirSync(path.join(projectDir, ".claude"));
	settingsPath = path.join(projectDir, ".claude", "settings.json");
});

afterEach(() => {
	fs.rmSync(projectDir, { recursive: true, force: true });
});

describe("a fresh checkout with no enabledPlugins entry at all (#125)", () => {
	beforeEach(() => {
		fs.writeFileSync(settingsPath, JSON.stringify({ outputStyle: "x" }));
	});

	it("reports absent on status without writing", () => {
		const before = fs.readFileSync(settingsPath, "utf8");
		const r = run("status");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("impeccable@impeccable    absent");
		expect(fs.readFileSync(settingsPath, "utf8")).toBe(before);
	});

	it("off succeeds and writes the key false", () => {
		const r = run("off");
		expect(r.status).toBe(0);
		expect(r.stderr).toBe("");
		expect(readEnabledPlugins()["impeccable@impeccable"]).toBe(false);
	});

	it("on succeeds and writes the key true", () => {
		const r = run("on");
		expect(r.status).toBe(0);
		expect(r.stderr).toBe("");
		expect(readEnabledPlugins()["impeccable@impeccable"]).toBe(true);
	});

	it("touches no other key in enabledPlugins or the settings file", () => {
		fs.writeFileSync(
			settingsPath,
			JSON.stringify({ outputStyle: "x", enabledPlugins: { other: true } }),
		);
		run("on");
		expect(JSON.parse(fs.readFileSync(settingsPath, "utf8"))).toEqual({
			outputStyle: "x",
			enabledPlugins: { other: true, "impeccable@impeccable": true },
		});
	});
});

describe("an existing key", () => {
	beforeEach(() => {
		fs.writeFileSync(
			settingsPath,
			JSON.stringify({ enabledPlugins: { "impeccable@impeccable": false } }),
		);
	});

	it("round-trips on then off", () => {
		run("on");
		expect(readEnabledPlugins()["impeccable@impeccable"]).toBe(true);
		run("off");
		expect(readEnabledPlugins()["impeccable@impeccable"]).toBe(false);
	});

	it("status reports the live value", () => {
		expect(run("status").stdout).toContain("impeccable@impeccable    false");
	});
});

describe("usage", () => {
	it("refuses an unknown verb, naming the three it takes", () => {
		fs.writeFileSync(settingsPath, JSON.stringify({}));
		const r = run("maybe");
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("on|off|status");
	});
});
