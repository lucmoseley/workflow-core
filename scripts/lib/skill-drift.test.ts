// @vitest-environment node
/*
 * skill-drift.js's own suite: an adopter's forked skill is reported drifted
 * only where its bytes differ from the plugin's current copy, and a missing
 * file is named rather than read as drift. Built on a self-contained fixture
 * pair (adopter root, plugin root), carrying no host string — the doc-map
 * genericity test's shape (#7, AC3).
 *
 * `upgrade.js` prints what this returns on a plugin bump; loosen a case and an
 * adopter's fork is overwritten unreported, or flagged as drifted when it is not.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { skillDrift } = require("./skill-drift.js");

let root: string;
let pluginRoot: string;

const writeConfig = (overridesSkills: Record<string, string>) => {
	fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(root, ".claude", "workflow-core.json"),
		JSON.stringify({
			founder: "Fixture Founder",
			overrides: { skills: overridesSkills },
		}),
	);
};

const writeSkill = (at: string, name: string, body: string) => {
	const dir = path.join(at, ".claude", "skills", name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "SKILL.md"), body);
};

beforeEach(() => {
	root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "skill-drift-root-")),
	);
	pluginRoot = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "skill-drift-plugin-")),
	);
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
	fs.rmSync(pluginRoot, { recursive: true, force: true });
});

describe("skillDrift", () => {
	it("reports no drift where the fork is byte-identical to the plugin's copy", () => {
		writeConfig({ "pick-next": "1.1.0" });
		writeSkill(root, "pick-next", "same body\n");
		writeSkill(pluginRoot, "pick-next", "same body\n");
		expect(skillDrift({ root, pluginRoot })).toEqual([
			{ name: "pick-next", recordedFrom: "1.1.0", drifted: false },
		]);
	});

	it("reports drift where the fork's bytes differ from the plugin's current copy", () => {
		writeConfig({ "pick-next": "1.1.0" });
		writeSkill(root, "pick-next", "forked body\n");
		writeSkill(pluginRoot, "pick-next", "the plugin moved on\n");
		expect(skillDrift({ root, pluginRoot })).toEqual([
			{ name: "pick-next", recordedFrom: "1.1.0", drifted: true },
		]);
	});

	it("names a fork whose file is missing, rather than reporting drift", () => {
		writeConfig({ "pick-next": "1.1.0" });
		writeSkill(pluginRoot, "pick-next", "core body\n");
		expect(skillDrift({ root, pluginRoot })).toEqual([
			{
				name: "pick-next",
				recordedFrom: "1.1.0",
				drifted: false,
				reason: `no fork at ${path.join(root, ".claude", "skills", "pick-next", "SKILL.md")}`,
			},
		]);
	});

	it("names a skill the plugin no longer ships, rather than reporting drift", () => {
		writeConfig({ "retired-skill": "1.0.0" });
		writeSkill(root, "retired-skill", "fork body\n");
		expect(skillDrift({ root, pluginRoot })).toEqual([
			{
				name: "retired-skill",
				recordedFrom: "1.0.0",
				drifted: false,
				reason: `the plugin ships no "retired-skill" skill at ${path.join(pluginRoot, ".claude", "skills", "retired-skill", "SKILL.md")}`,
			},
		]);
	});

	it("returns nothing where the config declares no override", () => {
		writeConfig({});
		expect(skillDrift({ root, pluginRoot })).toEqual([]);
	});
});
