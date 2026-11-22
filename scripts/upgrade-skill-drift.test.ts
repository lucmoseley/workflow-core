// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { upgrade } from "./lib/upgrade-walk.js";

let root: string;
let pluginRoot: string;
let made: string[] = [];

const write = (base: string, rel: string, body: string) => {
	const at = path.join(base, rel);
	fs.mkdirSync(path.dirname(at), { recursive: true });
	fs.writeFileSync(at, body);
};
const writeJson = (base: string, rel: string, body: unknown) =>
	write(base, rel, JSON.stringify(body));

beforeEach(() => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "upgrade-drift-test-"));
	made.push(tmp);
	root = path.join(tmp, "adopter");
	pluginRoot = path.join(tmp, "plugin");
	fs.mkdirSync(root, { recursive: true });
	fs.mkdirSync(pluginRoot, { recursive: true });
	writeJson(pluginRoot, ".claude-plugin/plugin.json", {
		name: "workflow-core",
		version: "1.0.0",
	});
	writeJson(root, ".claude/settings.json", {
		enabledPlugins: { "workflow-core@wfc": true },
		extraKnownMarketplaces: {
			wfc: { source: { source: "git", ref: "v1.0.0" } },
		},
	});
	writeJson(root, ".claude/workflow-core.json", {
		founder: "Fixture Founder",
		overrides: { skills: { "pick-next": "1.0.0" } },
	});
});

afterEach(() => {
	for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
	made = [];
});

describe("upgrade()'s skill-drift report", () => {
	it("names a fork that has drifted from the plugin's current copy", () => {
		write(root, ".claude/skills/pick-next/SKILL.md", "forked body\n");
		write(pluginRoot, ".claude/skills/pick-next/SKILL.md", "moved on\n");
		const lines: string[] = [];
		const result = upgrade({ root, pluginRoot, out: (l) => lines.push(l) });
		expect(result.status).toBe(0);
		expect(
			lines.some((l) => l.includes('"pick-next"') && l.includes("drifted")),
		).toBe(true);
	});

	it("says nothing where the fork still matches the plugin's current copy", () => {
		write(root, ".claude/skills/pick-next/SKILL.md", "same body\n");
		write(pluginRoot, ".claude/skills/pick-next/SKILL.md", "same body\n");
		const lines: string[] = [];
		upgrade({ root, pluginRoot, out: (l) => lines.push(l) });
		expect(lines.some((l) => l.includes("pick-next"))).toBe(false);
	});

	it("says a fork that will not read goes unchecked", () => {
		fs.mkdirSync(path.join(root, ".claude/skills/pick-next/SKILL.md"), {
			recursive: true,
		});
		write(pluginRoot, ".claude/skills/pick-next/SKILL.md", "core body\n");
		const lines: string[] = [];
		upgrade({ root, pluginRoot, out: (l) => lines.push(l) });
		expect(
			lines.some(
				(l) => l.includes('"pick-next"') && l.includes("goes unchecked"),
			),
		).toBe(true);
	});

	it("says nothing where overrides.skills declares no fork", () => {
		writeJson(root, ".claude/workflow-core.json", {
			founder: "Fixture Founder",
		});
		const lines: string[] = [];
		upgrade({ root, pluginRoot, out: (l) => lines.push(l) });
		expect(lines.some((l) => l.includes("drifted"))).toBe(false);
	});
});
