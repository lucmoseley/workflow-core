// @vitest-environment node
/*
 * Pins that check-output-style.js warns on an `outputStyle` no style answers
 * to, and passes the plugin's namespaced style, a project style, a built-in
 * and another plugin's style (#1944).
 *
 * CLAUDE_CONFIG_DIR is an empty directory, so the machine's own user styles
 * never answer.
 *
 * The plugin's style comes from the core's own `.claude-plugin/plugin.json`
 * and `.claude/output-styles/core-voice.md`, read through the checker.
 *
 * It reports through `npm run status`: loosen a case and an adopter's style
 * goes unloaded in silence again.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.join(__dirname, "check-output-style.js");
const CORE = path.resolve(__dirname, "..");

let repo: string;
let config: string;
beforeEach(() => {
	repo = fs.mkdtempSync(path.join(os.tmpdir(), "output-style-"));
	config = fs.mkdtempSync(path.join(os.tmpdir(), "output-style-cfg-"));
	fs.mkdirSync(path.join(repo, ".claude"));
});
afterEach(() => {
	fs.rmSync(repo, { recursive: true, force: true });
	fs.rmSync(config, { recursive: true, force: true });
});

const settings = (rel: string, body: object) =>
	fs.writeFileSync(path.join(repo, rel), JSON.stringify(body));
const run = () =>
	runInProcess(SCRIPT, [], {
		cwd: repo,
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: repo,
			CLAUDE_CONFIG_DIR: config,
			WFC_SCRIPT_ROOT: CORE,
			GITHUB_ACTIONS: "",
		},
	});

describe("output style (#1944)", () => {
	it("warns on the old `core-voice` default, naming the style the plugin ships", () => {
		settings(".claude/settings.json", { outputStyle: "core-voice" });
		const r = run();
		expect(r.status).toBe(0); // WARN: a report, never a gate
		expect(r.stderr).toContain("UNKNOWN-OUTPUT-STYLE");
		expect(r.stderr).toContain('"core-voice"');
		expect(r.stderr).toContain(".claude/settings.json");
		expect(r.stderr).toContain("workflow-core:Core voice");
	});

	it.each([
		["the plugin's namespaced style", "workflow-core:Core voice"],
		["a built-in", "Explanatory"],
		["another plugin's style, unread", "other-plugin:Its voice"],
	])("passes %s", (_, style) => {
		settings(".claude/settings.json", { outputStyle: style });
		const r = run();
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("OK:");
		expect(r.stderr).not.toContain("UNKNOWN-OUTPUT-STYLE");
	});

	it("passes a project style by its frontmatter name, and reads settings.local.json first", () => {
		fs.mkdirSync(path.join(repo, ".claude/output-styles"));
		fs.writeFileSync(
			path.join(repo, ".claude/output-styles/manta-voice.md"),
			"---\nname: Manta voice\ndescription: x\n---\nBody\n",
		);
		settings(".claude/settings.json", { outputStyle: "nothing-by-this" });
		settings(".claude/settings.local.json", { outputStyle: "Manta voice" });
		const r = run();
		expect(r.status).toBe(0);
		expect(r.stderr).toContain('"Manta voice"');
		expect(r.stderr).not.toContain("UNKNOWN-OUTPUT-STYLE");
	});

	it("skips where no settings file declares a style", () => {
		settings(".claude/settings.json", { env: {} });
		const r = run();
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("SKIP");
	});
});
