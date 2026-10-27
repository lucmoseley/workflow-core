// @vitest-environment node
/*
 * Pins lib/upgrade-walk.js's walk of an adopter from its pinned tag to the installed
 * one: each migration note's residue applied once, its refusals, the hook,
 * session-rule and .gitignore re-rendering, and that no path calls `claude`.
 *
 * Each test builds a fake adopter and plugin root in a temp dir and calls
 * upgrade() directly, with a logging `claude` stub where a call would show.
 *
 * upgrade runs in every adopter on every bump, so breaking it miswrites an
 * adopter's settings or hooks, or advances `walkedTo` past a note whose
 * Verify failed (#6; each later limb cites its own ticket on its describe).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	HOOKS,
	renderHookShim,
	withIgnoreBlock,
} from "./lib/adopter-skeleton.js";
import { clearStepOwed } from "./lib/steps-owed.js";
import { upgrade } from "./lib/upgrade-walk.js";

let root: string;
let pluginRoot: string;
let made: string[] = [];

const CORE_IGNORE_BLOCK = (withIgnoreBlock("") as string).trimEnd();

const quiet = () => {
	/* progress lines are not what these cases read */
};

const write = (base: string, rel: string, body: string) => {
	const at = path.join(base, rel);
	fs.mkdirSync(path.dirname(at), { recursive: true });
	fs.writeFileSync(at, body);
};
const writeJson = (base: string, rel: string, body: unknown) =>
	write(base, rel, JSON.stringify(body));
const readJson = (base: string, rel: string) =>
	JSON.parse(fs.readFileSync(path.join(base, rel), "utf8"));
/* The marketplace entry alone: every run merges the core's other settings
 * keys in (#1501), so the file's bytes move where the pin must not. */
const pinOf = () =>
	readJson(root, ".claude/settings.json").extraKnownMarketplaces.wc;

const note = (tag: string, residue: object, verify: string) => `# ${tag}

## What changed

Test fixture.

## Ruling

#1.

## Residue

\`\`\`json
${JSON.stringify(residue)}
\`\`\`

## Manual steps

- [notice] nothing

## Verify

\`\`\`sh
${verify}
\`\`\`
`;

/* Pins the adopter at `fromTag` under a plugin released at the tag of
 * `notePath`, one of this repo's own notes, so a walk reads it as shipped. */
const walkRealNote = (notePath: string, fromTag: string) => {
	const tag = path.basename(notePath, ".md");
	writeJson(pluginRoot, ".claude-plugin/plugin.json", {
		name: "workflow-core",
		version: tag.slice(1),
	});
	write(pluginRoot, `migrations/${tag}.md`, fs.readFileSync(notePath, "utf8"));
	const settings = readJson(root, ".claude/settings.json");
	settings.extraKnownMarketplaces.wc.source.ref = fromTag;
	writeJson(root, ".claude/settings.json", settings);
	writeJson(root, ".claude/workflow-core.json", { contract: 1 });
	return upgrade({ root, pluginRoot, out: quiet });
};

beforeEach(() => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "upgrade-test-"));
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
		enabledPlugins: { "workflow-core@wc": true },
		extraKnownMarketplaces: {
			wc: {
				source: {
					source: "url",
					url: "https://example.invalid/wc.git",
					ref: "v1.0.0",
				},
			},
		},
	});
});
afterEach(() => {
	for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
	made = [];
});

describe("upgrade", () => {
	it("is a no-op where pinned already matches installed", () => {
		writeJson(pluginRoot, ".claude-plugin/plugin.json", {
			name: "workflow-core",
			version: "1.0.0",
		});
		const lines: string[] = [];
		const r = upgrade({ root, pluginRoot, out: (l) => lines.push(l) });
		expect(r.status).toBe(0);
		expect(lines).toContain("up to date at v1.0.0");
	});

	it("seeds the core's missing context-cost row on a bump, through the measurer it is handed (#679)", () => {
		const measureCore = vi.fn(() => ({ tokens: 2273 }));
		expect(upgrade({ root, pluginRoot, measureCore }).status).toBe(0);
		expect(measureCore).toHaveBeenCalledWith("workflow-core@wc");
		expect(
			readJson(root, ".claude/plugin-context-cost.json").plugins[
				"workflow-core@wc"
			].tokens,
		).toBe(2273);
	});

	it("seeds nothing and calls no measurer where it is handed none", () => {
		expect(upgrade({ root, pluginRoot }).status).toBe(0);
		expect(
			fs.existsSync(path.join(root, ".claude/plugin-context-cost.json")),
		).toBe(false);
	});

	it("walks a note, applies its residue, verifies, and advances walkedTo — never the pin", () => {
		writeJson(pluginRoot, ".claude-plugin/plugin.json", {
			name: "workflow-core",
			version: "2.0.0",
		});
		write(
			pluginRoot,
			"migrations/v2.0.0.md",
			note("v2.0.0", { contract: 2, ignoreBlock: ["*.wfc-local"] }, "true"),
		);

		const lines: string[] = [];
		const r = upgrade({ root, pluginRoot, out: (l) => lines.push(l) });
		expect(r.status).toBe(0);
		expect(lines).toContain("upgraded to v2.0.0");

		const settings = readJson(root, ".claude/settings.json");
		expect(settings.extraKnownMarketplaces.wc.source.ref).toBe("v1.0.0");

		const config = readJson(root, ".claude/workflow-core.json");
		expect(config.contract).toBe(2);
		expect(config.walkedTo).toBe("v2.0.0");

		/* The block's lines are the core's own, whatever the note names: every
		 * run brings it current, and the residue key only says so (#1501). */
		const ignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
		expect(ignore).not.toContain("*.wfc-local");
		expect(ignore).toContain(CORE_IGNORE_BLOCK);
		expect(lines).toContain(
			"residue  ignoreBlock: already brought current this run",
		);
	});

	it("run twice changes nothing the second time", () => {
		writeJson(pluginRoot, ".claude-plugin/plugin.json", {
			name: "workflow-core",
			version: "2.0.0",
		});
		write(
			pluginRoot,
			"migrations/v2.0.0.md",
			note("v2.0.0", { contract: 2 }, "true"),
		);

		expect(upgrade({ root, pluginRoot }).status).toBe(0);
		const after1 = fs.readFileSync(
			path.join(root, ".claude/settings.json"),
			"utf8",
		);

		const lines: string[] = [];
		const r = upgrade({ root, pluginRoot, out: (l) => lines.push(l) });
		expect(r.status).toBe(0);
		expect(lines).toContain("up to date at v2.0.0");
		expect(
			fs.readFileSync(path.join(root, ".claude/settings.json"), "utf8"),
		).toBe(after1);
	});

	it("exits non-zero while a note's Verify fails, giving that note as its reason, and advances neither walkedTo nor the pinned ref", () => {
		writeJson(pluginRoot, ".claude-plugin/plugin.json", {
			name: "workflow-core",
			version: "2.0.0",
		});
		write(
			pluginRoot,
			"migrations/v2.0.0.md",
			note("v2.0.0", { contract: 2 }, "exit 1"),
		);

		const r = upgrade({ root, pluginRoot });
		expect(r.status).toBe(1);
		expect(r.reason).toMatch(/v2\.0\.0 Verify failed/);

		const settings = readJson(root, ".claude/settings.json");
		expect(settings.extraKnownMarketplaces.wc.source.ref).toBe("v1.0.0");
		expect("walkedTo" in readJson(root, ".claude/workflow-core.json")).toBe(
			false,
		);
	});

	it("passes `env` through to a note's Verify (#300)", () => {
		writeJson(pluginRoot, ".claude-plugin/plugin.json", {
			name: "workflow-core",
			version: "2.0.0",
		});
		write(
			pluginRoot,
			"migrations/v2.0.0.md",
			note("v2.0.0", { contract: 2 }, `test "$WFC_TEST_MARKER" = present`),
		);

		const r = upgrade({
			root,
			pluginRoot,
			env: { ...process.env, WFC_TEST_MARKER: "present" },
		});
		expect(r.status).toBe(0);
	});

	it("bounds a note's Verify by `verifyTimeoutMs` and reports the kill (#300)", () => {
		writeJson(pluginRoot, ".claude-plugin/plugin.json", {
			name: "workflow-core",
			version: "2.0.0",
		});
		write(
			pluginRoot,
			"migrations/v2.0.0.md",
			note("v2.0.0", { contract: 2 }, "sleep 5"),
		);

		const r = upgrade({ root, pluginRoot, verifyTimeoutMs: 200 });
		expect(r.status).toBe(1);
		expect(r.reason).toMatch(/killed after exceeding 200ms/);
	});

	it("prints every manual-step type and continues, whatever the type (#246)", () => {
		writeJson(pluginRoot, ".claude-plugin/plugin.json", {
			name: "workflow-core",
			version: "2.0.0",
		});
		write(
			pluginRoot,
			"migrations/v2.0.0.md",
			note("v2.0.0", { contract: 2 }, "true").replace(
				"- [notice] nothing",
				"- [act] do a thing\n- [choice] pick a thing\n- [notice] fyi a thing",
			),
		);

		const lines: string[] = [];
		const r = upgrade({ root, pluginRoot, out: (l) => lines.push(l) });
		expect(r.status).toBe(0);
		expect(lines).toContain("upgraded to v2.0.0");
		const manual = lines.find((l) => l.startsWith("manual steps for v2.0.0"));
		expect(manual).toContain("[act] do a thing");
		expect(manual).toContain("[choice] pick a thing");
		expect(manual).toContain("[notice] fyi a thing");
	});

	it("records every manual step to stepsOwed, and prints the commit-body block (#248)", () => {
		writeJson(pluginRoot, ".claude-plugin/plugin.json", {
			name: "workflow-core",
			version: "2.0.0",
		});
		write(
			pluginRoot,
			"migrations/v2.0.0.md",
			note("v2.0.0", { contract: 2 }, "true").replace(
				"- [notice] nothing",
				"- [act] do a thing\n- [choice] pick a thing",
			),
		);

		const lines: string[] = [];
		const r = upgrade({ root, pluginRoot, out: (l) => lines.push(l) });
		expect(r.status).toBe(0);

		const config = readJson(root, ".claude/workflow-core.json");
		expect(config.stepsOwed).toEqual([
			{ tag: "v2.0.0", type: "act", text: "do a thing" },
			{ tag: "v2.0.0", type: "choice", text: "pick a thing" },
		]);

		expect(lines).toContain(
			"commit message body for v2.0.0 — paste verbatim (the permanent record that survives stepsOwed being cleared):",
		);
		expect(lines).toContain("- [act] (v2.0.0) do a thing");
		expect(lines).toContain("- [choice] (v2.0.0) pick a thing");
	});

	it("records v1.1.18's corpus step whole, as one owed act (#517)", () => {
		expect(
			walkRealNote(path.join(__dirname, "../migrations/v1.1.18.md"), "v1.1.17")
				.status,
		).toBe(0);

		const owed = readJson(root, ".claude/workflow-core.json").stepsOwed;
		expect(owed).toHaveLength(1);
		expect(owed[0]).toMatchObject({ tag: "v1.1.18", type: "act" });
		expect(owed[0].text).toMatch(
			/^Declare `corpus` in .*fantasy-books: add `lucmoseley\/mantahostels`\.$/,
		);
	});

	it("owes v1.3.14's sensitive-paths step as a choice to a repo on v1.3.13, and owes it no more once cleared (#1626)", () => {
		expect(
			walkRealNote(path.join(__dirname, "../migrations/v1.3.14.md"), "v1.3.13")
				.status,
		).toBe(0);

		const isStep = (e: { text: string }) =>
			e.text.startsWith("Declare your sensitive paths");
		const step = readJson(root, ".claude/workflow-core.json").stepsOwed.find(
			isStep,
		);
		expect(step).toMatchObject({ tag: "v1.3.14", type: "choice" });
		expect(step.text).toMatch(/Then clear this step\. Never decline it\.$/);

		clearStepOwed(root, step);
		expect(
			readJson(root, ".claude/workflow-core.json").stepsOwed.some(isStep),
		).toBe(false);
	});

	it("prints and records an earlier note's steps even where a later note's Verify then fails (#248)", () => {
		writeJson(pluginRoot, ".claude-plugin/plugin.json", {
			name: "workflow-core",
			version: "3.0.0",
		});
		write(
			pluginRoot,
			"migrations/v2.0.0.md",
			note("v2.0.0", { contract: 2 }, "true").replace(
				"- [notice] nothing",
				"- [act] first note's step",
			),
		);
		write(
			pluginRoot,
			"migrations/v3.0.0.md",
			note("v3.0.0", { contract: 3 }, "exit 1"),
		);

		const lines: string[] = [];
		const r = upgrade({ root, pluginRoot, out: (l) => lines.push(l) });
		expect(r.status).toBe(1);

		expect(lines).toContain(
			"commit message body for v2.0.0 — paste verbatim (the permanent record that survives stepsOwed being cleared):",
		);
		expect(lines).toContain("- [act] (v2.0.0) first note's step");

		const config = readJson(root, ".claude/workflow-core.json");
		expect(config.stepsOwed).toEqual([
			{ tag: "v2.0.0", type: "act", text: "first note's step" },
		]);
		expect(config.walkedTo).toBe("v2.0.0");
	});

	it("a cleared entry does not come back on the next run (#248)", () => {
		writeJson(pluginRoot, ".claude-plugin/plugin.json", {
			name: "workflow-core",
			version: "2.0.0",
		});
		write(
			pluginRoot,
			"migrations/v2.0.0.md",
			note("v2.0.0", { contract: 2 }, "true"),
		);

		expect(upgrade({ root, pluginRoot }).status).toBe(0);
		expect(
			clearStepOwed(root, { tag: "v2.0.0", type: "notice", text: "nothing" }),
		).toBe(true);
		expect(readJson(root, ".claude/workflow-core.json").stepsOwed).toEqual([]);

		expect(upgrade({ root, pluginRoot }).status).toBe(0);
		expect(readJson(root, ".claude/workflow-core.json").stepsOwed).toEqual([]);
	});

	it("records a note's [notice] step even where it is the only one", () => {
		writeJson(pluginRoot, ".claude-plugin/plugin.json", {
			name: "workflow-core",
			version: "2.0.0",
		});
		write(
			pluginRoot,
			"migrations/v2.0.0.md",
			note("v2.0.0", { contract: 2 }, "true"),
		);

		upgrade({ root, pluginRoot });
		const config = readJson(root, ".claude/workflow-core.json");
		expect(config.stepsOwed).toEqual([
			{ tag: "v2.0.0", type: "notice", text: "nothing" },
		]);
	});

	it("records nothing on a dry run", () => {
		writeJson(pluginRoot, ".claude-plugin/plugin.json", {
			name: "workflow-core",
			version: "2.0.0",
		});
		write(
			pluginRoot,
			"migrations/v2.0.0.md",
			note("v2.0.0", { contract: 2 }, "true").replace(
				"- [notice] nothing",
				"- [act] do a thing",
			),
		);

		upgrade({ root, pluginRoot, dryRun: true });
		expect(fs.existsSync(path.join(root, ".claude/workflow-core.json"))).toBe(
			false,
		);
	});

	it("never records a note whose Verify fails", () => {
		writeJson(pluginRoot, ".claude-plugin/plugin.json", {
			name: "workflow-core",
			version: "2.0.0",
		});
		write(
			pluginRoot,
			"migrations/v2.0.0.md",
			note("v2.0.0", { contract: 2 }, "exit 1").replace(
				"- [notice] nothing",
				"- [act] do a thing",
			),
		);

		const r = upgrade({ root, pluginRoot });
		expect(r.status).toBe(1);
		expect("stepsOwed" in readJson(root, ".claude/workflow-core.json")).toBe(
			false,
		);
	});

	it("refuses a malformed note before touching the pin or walkedTo", () => {
		writeJson(pluginRoot, ".claude-plugin/plugin.json", {
			name: "workflow-core",
			version: "2.0.0",
		});
		write(
			pluginRoot,
			"migrations/v2.0.0.md",
			"# v2.0.0\n\n## What changed\n\nno other sections\n",
		);

		const r = upgrade({ root, pluginRoot });
		expect(r.status).toBe(1);
		expect(r.reason).toMatch(/is malformed/);
		const settings = readJson(root, ".claude/settings.json");
		expect(settings.extraKnownMarketplaces.wc.source.ref).toBe("v1.0.0");
	});

	it("walks notes strictly between pinned and installed, in tag order", () => {
		writeJson(pluginRoot, ".claude-plugin/plugin.json", {
			name: "workflow-core",
			version: "3.0.0",
		});
		write(
			pluginRoot,
			"migrations/v2.0.0.md",
			note("v2.0.0", { contract: 2 }, "true"),
		);
		write(
			pluginRoot,
			"migrations/v3.0.0.md",
			note("v3.0.0", { contract: 3 }, "true"),
		);

		const lines: string[] = [];
		const r = upgrade({ root, pluginRoot, out: (l) => lines.push(l) });
		expect(r.status).toBe(0);
		expect(lines.filter((l) => l.startsWith("applying "))).toEqual([
			"applying v2.0.0",
			"applying v3.0.0",
		]);
		expect(readJson(root, ".claude/workflow-core.json").contract).toBe(3);
	});

	it("floors a directory-sourced install with no walkedTo at installed, walking nothing yet, with no pin fabricated (#244)", () => {
		writeJson(root, ".claude/settings.json", {
			enabledPlugins: { "workflow-core@wc": true },
			extraKnownMarketplaces: {
				wc: { source: { source: "directory", path: pluginRoot } },
			},
		});
		writeJson(pluginRoot, ".claude-plugin/plugin.json", {
			name: "workflow-core",
			version: "2.0.0",
		});
		write(
			pluginRoot,
			"migrations/v1.0.0.md",
			note("v1.0.0", { contract: 9 }, "true"),
		);
		write(
			pluginRoot,
			"migrations/v2.0.0.md",
			note("v2.0.0", { contract: 2 }, "true"),
		);

		const before = pinOf();
		const lines: string[] = [];
		const r = upgrade({ root, pluginRoot, out: (l) => lines.push(l) });
		expect(r.status).toBe(0);
		expect(lines).toContain("up to date at v2.0.0");
		expect(lines.some((l) => l.startsWith("applying "))).toBe(false);
		expect(lines.some((l) => l.includes("v1.0.0, v2.0.0"))).toBe(true);
		expect(pinOf()).toEqual(before);
		expect("contract" in readJson(root, ".claude/workflow-core.json")).toBe(
			false,
		);
		expect(readJson(root, ".claude/workflow-core.json").walkedTo).toBe(
			"v2.0.0",
		);
	});

	it("applies a note above a directory-sourced adopter's floor once walkedTo is established, and re-runs walk nothing (#244)", () => {
		writeJson(root, ".claude/settings.json", {
			enabledPlugins: { "workflow-core@wc": true },
			extraKnownMarketplaces: {
				wc: { source: { source: "directory", path: pluginRoot } },
			},
		});
		writeJson(pluginRoot, ".claude-plugin/plugin.json", {
			name: "workflow-core",
			version: "2.0.0",
		});
		expect(upgrade({ root, pluginRoot }).status).toBe(0);
		expect(readJson(root, ".claude/workflow-core.json").walkedTo).toBe(
			"v2.0.0",
		);

		writeJson(pluginRoot, ".claude-plugin/plugin.json", {
			name: "workflow-core",
			version: "3.0.0",
		});
		write(
			pluginRoot,
			"migrations/v3.0.0.md",
			note("v3.0.0", { contract: 3 }, "true"),
		);
		const before = pinOf();
		const lines: string[] = [];
		const r = upgrade({ root, pluginRoot, out: (l) => lines.push(l) });
		expect(r.status).toBe(0);
		expect(lines).toContain("applying v3.0.0");
		expect(readJson(root, ".claude/workflow-core.json").contract).toBe(3);
		expect(readJson(root, ".claude/workflow-core.json").walkedTo).toBe(
			"v3.0.0",
		);
		expect(pinOf()).toEqual(before);
		const after = fs.readFileSync(
			path.join(root, ".claude/settings.json"),
			"utf8",
		);
		expect(
			readJson(root, ".claude/settings.json").extraKnownMarketplaces.wc.source,
		).toEqual({ source: "directory", path: pluginRoot });

		const r2 = upgrade({ root, pluginRoot });
		expect(r2.status).toBe(0);
		expect(
			fs.readFileSync(path.join(root, ".claude/settings.json"), "utf8"),
		).toBe(after);
	});

	it("reports install-behind-pin as status 3, naming what the install owes, where the pin is newer than the installed plugin", () => {
		writeJson(pluginRoot, ".claude-plugin/plugin.json", {
			name: "workflow-core",
			version: "0.9.0",
		});
		const r = upgrade({ root, pluginRoot });
		expect(r.status).toBe(3);
		expect(r.reason).toMatch(
			/pin v1\.0\.0 is ahead of the installed plugin v0\.9\.0/,
		);
		expect(r.reason).toMatch(/install owes/);
	});

	it("bare pin 1.0.0 against installed v1.0.0 reports up to date, walks nothing, and leaves the pin byte-identical (#241)", () => {
		writeJson(root, ".claude/settings.json", {
			enabledPlugins: { "workflow-core@wc": true },
			extraKnownMarketplaces: {
				wc: {
					source: {
						source: "url",
						url: "https://example.invalid/wc.git",
						ref: "1.0.0",
					},
				},
			},
		});
		const before = pinOf();
		const lines: string[] = [];
		const r = upgrade({ root, pluginRoot, out: (l) => lines.push(l) });
		expect(r.status).toBe(0);
		expect(lines).toContain("up to date at v1.0.0");
		expect(pinOf()).toEqual(before);
	});

	it("v-prefixed pin v1.0.0 against installed v1.0.0 behaves identically", () => {
		const before = pinOf();
		const lines: string[] = [];
		const r = upgrade({ root, pluginRoot, out: (l) => lines.push(l) });
		expect(r.status).toBe(0);
		expect(lines).toContain("up to date at v1.0.0");
		expect(pinOf()).toEqual(before);
	});

	it("resumes from a failed note without re-verifying one already passed", () => {
		writeJson(pluginRoot, ".claude-plugin/plugin.json", {
			name: "workflow-core",
			version: "3.0.0",
		});
		write(
			pluginRoot,
			"migrations/v2.0.0.md",
			note("v2.0.0", { contract: 2 }, "true"),
		);
		write(
			pluginRoot,
			"migrations/v3.0.0.md",
			note("v3.0.0", { contract: 3 }, "exit 1"),
		);

		const first = upgrade({ root, pluginRoot });
		expect(first.status).toBe(1);
		expect(readJson(root, ".claude/workflow-core.json").walkedTo).toBe(
			"v2.0.0",
		);

		write(
			pluginRoot,
			"migrations/v3.0.0.md",
			note("v3.0.0", { contract: 3 }, "true"),
		);
		const lines: string[] = [];
		const second = upgrade({ root, pluginRoot, out: (l) => lines.push(l) });
		expect(second.status).toBe(0);
		expect(lines.filter((l) => l.startsWith("applying "))).toEqual([
			"applying v3.0.0",
		]);
	});

	it("resumes a stalled walk even where the pin has since advanced past installed, rather than reading pinned===installed as done (#241)", () => {
		writeJson(pluginRoot, ".claude-plugin/plugin.json", {
			name: "workflow-core",
			version: "3.0.0",
		});
		write(
			pluginRoot,
			"migrations/v2.0.0.md",
			note("v2.0.0", { contract: 2 }, "true"),
		);
		write(
			pluginRoot,
			"migrations/v3.0.0.md",
			note("v3.0.0", { contract: 3 }, "exit 1"),
		);
		const first = upgrade({ root, pluginRoot });
		expect(first.status).toBe(1);
		expect(readJson(root, ".claude/workflow-core.json").walkedTo).toBe(
			"v2.0.0",
		);

		// The founder's ordinary consent act: advance the pin to match what is
		// now installed, without the walk having caught up.
		writeJson(root, ".claude/settings.json", {
			enabledPlugins: { "workflow-core@wc": true },
			extraKnownMarketplaces: {
				wc: {
					source: {
						source: "url",
						url: "https://example.invalid/wc.git",
						ref: "v3.0.0",
					},
				},
			},
		});
		write(
			pluginRoot,
			"migrations/v3.0.0.md",
			note("v3.0.0", { contract: 3 }, "true"),
		);

		const lines: string[] = [];
		const second = upgrade({ root, pluginRoot, out: (l) => lines.push(l) });
		expect(second.status).toBe(0);
		expect(lines.filter((l) => l.startsWith("applying "))).toEqual([
			"applying v3.0.0",
		]);
		const config = readJson(root, ".claude/workflow-core.json");
		expect(config.contract).toBe(3);
		expect(config.walkedTo).toBe("v3.0.0");
	});

	describe("roadmapMajorPin residue (#70)", () => {
		beforeEach(() => {
			writeJson(root, ".claude/workflow-core.json", {
				founder: "Test",
				modules: ["roadmap"],
			});
			write(
				root,
				"docs/reference-roadmap.html",
				'<p class="docmeta">v3.4 · updated 18 September 2026, 12:09</p>',
			);
		});

		it("backfills the major from the adopter's own roadmap HTML", () => {
			writeJson(pluginRoot, ".claude-plugin/plugin.json", {
				name: "workflow-core",
				version: "2.0.0",
			});
			write(
				pluginRoot,
				"migrations/v2.0.0.md",
				note("v2.0.0", { roadmapMajorPin: true }, "true"),
			);
			const lines: string[] = [];
			const r = upgrade({ root, pluginRoot, out: (l) => lines.push(l) });
			expect(r.status).toBe(0);
			expect(readJson(root, ".claude/workflow-core.json").roadmapMajorPin).toBe(
				3,
			);
			expect(
				lines.some(
					(l) => l.includes("roadmapMajorPin backfilled") && l.includes("-> 3"),
				),
			).toBe(true);
		});

		it("run twice re-derives nothing: roadmapMajorPin stays put across a second bump, only walkedTo moves", () => {
			writeJson(pluginRoot, ".claude-plugin/plugin.json", {
				name: "workflow-core",
				version: "2.0.0",
			});
			write(
				pluginRoot,
				"migrations/v2.0.0.md",
				note("v2.0.0", { roadmapMajorPin: true }, "true"),
			);
			expect(upgrade({ root, pluginRoot }).status).toBe(0);
			const after1 = readJson(root, ".claude/workflow-core.json");
			expect(after1.roadmapMajorPin).toBe(3);
			expect(after1.walkedTo).toBe("v2.0.0");

			writeJson(pluginRoot, ".claude-plugin/plugin.json", {
				name: "workflow-core",
				version: "3.0.0",
			});
			write(
				pluginRoot,
				"migrations/v3.0.0.md",
				note("v3.0.0", { roadmapMajorPin: true }, "true"),
			);
			expect(upgrade({ root, pluginRoot }).status).toBe(0);
			const after2 = readJson(root, ".claude/workflow-core.json");
			expect(after2.roadmapMajorPin).toBe(3);
			expect(after2.walkedTo).toBe("v3.0.0");
		});

		it("leaves an already-seeded pin alone rather than re-deriving it", () => {
			writeJson(root, ".claude/workflow-core.json", {
				founder: "Test",
				modules: ["roadmap"],
				roadmapMajorPin: 1,
			});
			writeJson(pluginRoot, ".claude-plugin/plugin.json", {
				name: "workflow-core",
				version: "2.0.0",
			});
			write(
				pluginRoot,
				"migrations/v2.0.0.md",
				note("v2.0.0", { roadmapMajorPin: true }, "true"),
			);
			upgrade({ root, pluginRoot });
			expect(readJson(root, ".claude/workflow-core.json").roadmapMajorPin).toBe(
				1,
			);
		});

		it("skips a non-roadmap adopter", () => {
			writeJson(root, ".claude/workflow-core.json", {
				founder: "Test",
				modules: [],
			});
			writeJson(pluginRoot, ".claude-plugin/plugin.json", {
				name: "workflow-core",
				version: "2.0.0",
			});
			write(
				pluginRoot,
				"migrations/v2.0.0.md",
				note("v2.0.0", { roadmapMajorPin: true }, "true"),
			);
			upgrade({ root, pluginRoot });
			expect(
				"roadmapMajorPin" in readJson(root, ".claude/workflow-core.json"),
			).toBe(false);
		});

		it("names the doc and moves on where the roadmap HTML carries no version line", () => {
			write(root, "docs/reference-roadmap.html", "<p>no version here</p>");
			writeJson(pluginRoot, ".claude-plugin/plugin.json", {
				name: "workflow-core",
				version: "2.0.0",
			});
			write(
				pluginRoot,
				"migrations/v2.0.0.md",
				note("v2.0.0", { roadmapMajorPin: true }, "true"),
			);
			const lines: string[] = [];
			const r = upgrade({ root, pluginRoot, out: (l) => lines.push(l) });
			expect(r.status).toBe(0);
			expect(
				"roadmapMajorPin" in readJson(root, ".claude/workflow-core.json"),
			).toBe(false);
			expect(
				lines.some(
					(l) =>
						l.includes("roadmapMajorPin") &&
						l.includes("carries no docmeta version line"),
				),
			).toBe(true);
		});

		it("treats a missing roadmap HTML the same as one with no version line", () => {
			fs.rmSync(path.join(root, "docs/reference-roadmap.html"));
			writeJson(pluginRoot, ".claude-plugin/plugin.json", {
				name: "workflow-core",
				version: "2.0.0",
			});
			write(
				pluginRoot,
				"migrations/v2.0.0.md",
				note("v2.0.0", { roadmapMajorPin: true }, "true"),
			);
			const r = upgrade({ root, pluginRoot });
			expect(r.status).toBe(0);
			expect(
				"roadmapMajorPin" in readJson(root, ".claude/workflow-core.json"),
			).toBe(false);
		});

		it("ignores a version-shaped string outside the docmeta line, e.g. a card body quoting an old one", () => {
			write(
				root,
				"docs/reference-roadmap.html",
				"<p>Superseded: was v2.1 · updated 1 January 2026, 09:00</p>" +
					'<p class="docmeta">v3.4 · updated 18 September 2026, 12:09</p>',
			);
			writeJson(pluginRoot, ".claude-plugin/plugin.json", {
				name: "workflow-core",
				version: "2.0.0",
			});
			write(
				pluginRoot,
				"migrations/v2.0.0.md",
				note("v2.0.0", { roadmapMajorPin: true }, "true"),
			);
			upgrade({ root, pluginRoot });
			expect(readJson(root, ".claude/workflow-core.json").roadmapMajorPin).toBe(
				3,
			);
		});
	});

	describe("settingsKeys residue (#195)", () => {
		it("merges the plugin's settings keys and leaves the adopter's other keys intact", () => {
			writeJson(pluginRoot, ".claude-plugin/plugin.json", {
				name: "workflow-core",
				version: "2.0.0",
			});
			writeJson(root, ".claude/settings.json", {
				enabledPlugins: { "workflow-core@wc": true },
				extraKnownMarketplaces: {
					wc: {
						source: {
							source: "url",
							url: "https://example.invalid/wc.git",
							ref: "v1.0.0",
						},
					},
				},
				statusLine: { type: "command", command: "echo hi" },
				permissions: { deny: ["Read(./secret.env)"] },
			});
			write(
				pluginRoot,
				"migrations/v2.0.0.md",
				note("v2.0.0", { settingsKeys: true }, "true"),
			);

			const r = upgrade({ root, pluginRoot });
			expect(r.status).toBe(0);

			const settings = readJson(root, ".claude/settings.json");
			expect(settings.autoMemoryEnabled).toBe(false);
			expect(settings.autoCompactWindow).toBe(320_000);
			expect(settings.outputStyle).toBe("workflow-core:Core voice");
			expect(settings.env.CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP).toBe("1");
			expect(settings.permissions.deny).toContain("Read(./secret.env)");
			expect(settings.permissions.deny).toContain("Read(./.env)");
			expect(settings.statusLine).toEqual({
				type: "command",
				command: "echo hi",
			});
		});

		it("leaves an adopter's explicit autoMemoryEnabled value alone", () => {
			writeJson(pluginRoot, ".claude-plugin/plugin.json", {
				name: "workflow-core",
				version: "2.0.0",
			});
			writeJson(root, ".claude/settings.json", {
				enabledPlugins: { "workflow-core@wc": true },
				extraKnownMarketplaces: {
					wc: {
						source: {
							source: "url",
							url: "https://example.invalid/wc.git",
							ref: "v1.0.0",
						},
					},
				},
				autoMemoryEnabled: true,
			});
			write(
				pluginRoot,
				"migrations/v2.0.0.md",
				note("v2.0.0", { settingsKeys: true }, "true"),
			);

			expect(upgrade({ root, pluginRoot }).status).toBe(0);
			expect(readJson(root, ".claude/settings.json").autoMemoryEnabled).toBe(
				true,
			);
		});

		it.each([
			{ held: 320_000, expected: 320_000, does: "keeps the core's default" },
			{ held: 360_000, expected: 360_000, does: "keeps #1056's 360000" },
			{
				held: 500_000,
				expected: 500_000,
				does: "keeps an adopter's own value",
			},
		])("autoCompactWindow $held: $does (#1237)", ({ held, expected }) => {
			writeJson(pluginRoot, ".claude-plugin/plugin.json", {
				name: "workflow-core",
				version: "2.0.0",
			});
			writeJson(root, ".claude/settings.json", {
				enabledPlugins: { "workflow-core@wc": true },
				extraKnownMarketplaces: {
					wc: {
						source: {
							source: "url",
							url: "https://example.invalid/wc.git",
							ref: "v1.0.0",
						},
					},
				},
				autoCompactWindow: held,
			});
			write(
				pluginRoot,
				"migrations/v2.0.0.md",
				note("v2.0.0", { settingsKeys: true }, "true"),
			);

			expect(upgrade({ root, pluginRoot }).status).toBe(0);
			expect(readJson(root, ".claude/settings.json").autoCompactWindow).toBe(
				expected,
			);
		});
	});

	describe("a hand-moved pin's skipped notes are probed, not assumed (#284)", () => {
		const contractIs7 = `node -e "process.exit(require('./.claude/workflow-core.json').contract === 7 ? 0 : 1)"`;
		const readContract = () => {
			try {
				return readJson(root, ".claude/workflow-core.json").contract;
			} catch {
				// No config yet reads as no contract.
			}
		};
		const pinnedAbove = () => {
			writeJson(pluginRoot, ".claude-plugin/plugin.json", {
				name: "workflow-core",
				version: "2.0.0",
			});
			writeJson(root, ".claude/settings.json", {
				enabledPlugins: { "workflow-core@wc": true },
				extraKnownMarketplaces: {
					wc: {
						source: {
							source: "url",
							url: "https://example.invalid/wc.git",
							ref: "v2.0.0",
						},
					},
				},
			});
			write(
				pluginRoot,
				"migrations/v1.5.0.md",
				note("v1.5.0", { contract: 7 }, contractIs7),
			);
		};

		it("applies a below-pin note whose own Verify fails against the tree", () => {
			pinnedAbove();

			const lines: string[] = [];
			const r = upgrade({ root, pluginRoot, out: (l) => lines.push(l) });

			expect(r.status).toBe(0);
			expect(readContract()).toBe(7);
			expect(lines.join("\n")).toContain(
				"claims v1.5.0 applied, but their Verify fails here",
			);
			expect(lines.join("\n")).toContain("applying v1.5.0");
		});

		it("records no walkedTo below the pin", () => {
			pinnedAbove();

			upgrade({ root, pluginRoot, out: quiet });

			expect(readJson(root, ".claude/workflow-core.json").walkedTo).toBe(
				"v2.0.0",
			);
		});

		it("skips a note whose Verify will not run, rather than applying it", () => {
			pinnedAbove();
			write(
				pluginRoot,
				"migrations/v1.5.0.md",
				/* Killed by a signal, so node reports no numeric exit status. */
				note("v1.5.0", { contract: 7 }, "kill -TERM $$"),
			);

			const lines: string[] = [];
			expect(
				upgrade({ root, pluginRoot, out: (l) => lines.push(l) }).status,
			).toBe(0);
			expect(readContract()).toBeUndefined();
			expect(lines.join("\n")).toContain("its Verify would not run");
		});

		it("leaves a below-pin note alone where its Verify already passes", () => {
			pinnedAbove();
			writeJson(root, ".claude/workflow-core.json", { contract: 7 });

			const lines: string[] = [];
			expect(
				upgrade({ root, pluginRoot, out: (l) => lines.push(l) }).status,
			).toBe(0);
			expect(lines.join("\n")).not.toContain("applying v1.5.0");
		});

		it("probes nothing once walkedTo is recorded", () => {
			pinnedAbove();
			writeJson(root, ".claude/workflow-core.json", { walkedTo: "2.0.0" });

			const lines: string[] = [];
			expect(
				upgrade({ root, pluginRoot, out: (l) => lines.push(l) }).status,
			).toBe(0);
			expect(readContract()).toBeUndefined();
			expect(lines.join("\n")).not.toContain("applying v1.5.0");
		});
	});
});

describe("upgrade() calls claude on no path (#217, #230)", () => {
	let origBin: string | undefined;

	beforeEach(() => {
		origBin = process.env.WFC_CLAUDE_BIN;
	});
	afterEach(() => {
		process.env.WFC_CLAUDE_BIN = origBin;
	});

	/** A logging `claude` stub on WFC_CLAUDE_BIN — returns its argv log's path. */
	const stubClaude = () => {
		const stub = fs.mkdtempSync(path.join(os.tmpdir(), "upgrade-claude-"));
		made.push(stub);
		const log = path.join(stub, "claude-calls.log");
		fs.writeFileSync(
			path.join(stub, "claude"),
			`#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\nexit 0\n`,
			{ mode: 0o755 },
		);
		process.env.WFC_CLAUDE_BIN = path.join(stub, "claude");
		return log;
	};

	it("materialising is wholly the reconciler's job: a walk that applies notes never spawns claude", () => {
		const log = stubClaude();
		writeJson(pluginRoot, ".claude-plugin/plugin.json", {
			name: "workflow-core",
			version: "2.0.0",
		});
		write(
			pluginRoot,
			"migrations/v2.0.0.md",
			note("v2.0.0", { contract: 2 }, "true"),
		);

		const r = upgrade({ root, pluginRoot });
		expect(r.status).toBe(0);
		expect(fs.existsSync(log)).toBe(false);
	});

	it("never spawns claude under --dry-run either", () => {
		const log = stubClaude();
		writeJson(pluginRoot, ".claude-plugin/plugin.json", {
			name: "workflow-core",
			version: "2.0.0",
		});
		write(
			pluginRoot,
			"migrations/v2.0.0.md",
			note("v2.0.0", { contract: 2 }, "true"),
		);

		const r = upgrade({ root, pluginRoot, dryRun: true });
		expect(r.status).toBe(0);
		expect(fs.existsSync(log)).toBe(false);
	});
});

describe("turning the adopter's hooks into shims on every run (#104, #1839)", () => {
	/* A hook bootstrap or an upgrade wrote before #1839: it names its plugin
	 * on a root line, so it is the core's to rewrite. */
	const legacy = (rootLine: string) =>
		`#!/usr/bin/env sh\n# header\n${rootLine}\nexport WFC_PLUGIN_ROOT\n\nold body\n`;
	const read = (name: string) =>
		fs.readFileSync(path.join(root, ".husky", name), "utf8");
	const bump = () =>
		writeJson(pluginRoot, ".claude-plugin/plugin.json", {
			name: "workflow-core",
			version: "1.1.6",
		});

	it("turns a pre-#1839 hook into its shim on a bump with no migration note between the two tags", () => {
		bump();
		write(
			root,
			".husky/pre-commit",
			legacy('WFC_PLUGIN_ROOT="/home/someone/old-plugin"'),
		);
		const lines: string[] = [];
		expect(upgrade({ root, pluginRoot, out: (l) => lines.push(l) })).toEqual({
			status: 0,
		});
		expect(read("pre-commit")).toBe(renderHookShim("pre-commit"));
		expect(lines.filter((l) => l.includes(".husky/pre-commit"))).toEqual([
			"rewrote .husky/pre-commit",
		]);
	});

	it("turns it even where the pin is already up to date — the exact fantasy-books shape", () => {
		write(
			root,
			".husky/pre-commit",
			legacy(`WFC_PLUGIN_ROOT="${path.resolve(pluginRoot)}"`),
		);
		const lines: string[] = [];
		upgrade({ root, pluginRoot, out: (l) => lines.push(l) });
		expect(lines).toContain("up to date at v1.0.0");
		expect(read("pre-commit")).toBe(renderHookShim("pre-commit"));
		expect(lines).toContain("rewrote .husky/pre-commit");
	});

	it("writes every hook's shim where the adopter has none, and the resolver they run", () => {
		write(
			pluginRoot,
			"scripts/lib/resolve-core.js",
			"// the plugin's resolver\n",
		);
		upgrade({ root, pluginRoot });
		for (const hook of HOOKS) expect(read(hook)).toBe(renderHookShim(hook));
		expect(
			fs.readFileSync(path.join(root, "scripts/lib/resolve-core.js"), "utf8"),
		).toBe("// the plugin's resolver\n");
	});

	it("leaves a shim byte-identical across a bump, logging nothing", () => {
		bump();
		write(root, ".husky/pre-commit", renderHookShim("pre-commit"));
		fs.chmodSync(path.join(root, ".husky/pre-commit"), 0o755);
		const lines: string[] = [];
		upgrade({ root, pluginRoot, out: (l) => lines.push(l) });
		expect(read("pre-commit")).toBe(renderHookShim("pre-commit"));
		expect(lines.filter((l) => l.includes(".husky/pre-commit"))).toEqual([]);
	});

	it("repairs a wrong exec bit alone where the body already matches", () => {
		write(root, ".husky/pre-commit", renderHookShim("pre-commit"));
		fs.chmodSync(path.join(root, ".husky/pre-commit"), 0o644);
		const lines: string[] = [];
		upgrade({ root, pluginRoot, out: (l) => lines.push(l) });
		expect(read("pre-commit")).toBe(renderHookShim("pre-commit"));
		expect(fs.statSync(path.join(root, ".husky/pre-commit")).mode & 0o777).toBe(
			0o755,
		);
		expect(lines).toContain("repaired .husky/pre-commit's exec bit");
	});

	it("never touches an adopter's own hook under a shipped name — neither shim nor root line, so bootstrap never wrote it — and says the core's gate does not run there (#1501)", () => {
		bump();
		write(root, ".husky/pre-commit", "#!/usr/bin/env sh\n# adopter's own\n");
		const lines: string[] = [];
		upgrade({ root, pluginRoot, out: (l) => lines.push(l) });
		expect(read("pre-commit")).toBe("#!/usr/bin/env sh\n# adopter's own\n");
		expect(lines.filter((l) => l.includes(".husky/pre-commit"))).toEqual([
			"skipped .husky/pre-commit — the adopter's own hook (no shim marker or WFC_PLUGIN_ROOT line), so the core's pre-commit gate does not run there",
		]);
	});

	it("names the conversion under --dry-run and writes nothing", () => {
		bump();
		write(
			root,
			".husky/pre-commit",
			legacy('WFC_PLUGIN_ROOT="/home/someone/old-plugin"'),
		);
		const before = read("pre-commit");
		const lines: string[] = [];
		upgrade({ root, pluginRoot, dryRun: true, out: (l) => lines.push(l) });
		expect(read("pre-commit")).toBe(before);
		expect(lines).toContain("would   rewrite .husky/pre-commit");
	});
});

describe("re-rendering the adopter's session rules on a bump (#654)", () => {
	const rulesFile = ".claude/workflow-core.md";
	const referenceFile = ".claude/workflow-core.reference.md";
	const provenanceBlock =
		"\n## Plugin provenance\n\n- directory source, HEAD abc123\n";
	const read = (rel = rulesFile) =>
		fs.readFileSync(path.join(root, rel), "utf8");
	const configure = (extra: object = {}) =>
		writeJson(root, ".claude/workflow-core.json", {
			contract: 1,
			founder: "A Founder",
			modules: [],
			...extra,
		});

	/* The install registry the provenance sha is read from, pointed away from
	 * the real one so no test reads this machine's installs. */
	let configDir: string;
	beforeEach(() => {
		configDir = fs.mkdtempSync(path.join(os.tmpdir(), "upgrade-cfg-"));
		made.push(configDir);
		vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
	});
	afterEach(() => vi.unstubAllEnvs());
	const installRow = (version: string, gitCommitSha: string) =>
		writeJson(configDir, "plugins/installed_plugins.json", {
			plugins: {
				"workflow-core@wc": [
					{ projectPath: root, installPath: pluginRoot, version, gitCommitSha },
				],
			},
		});
	const pinAt = (source: object) =>
		writeJson(root, ".claude/settings.json", {
			enabledPlugins: { "workflow-core@wc": true },
			extraKnownMarketplaces: { wc: { source } },
		});
	const installedAt = (version: string) =>
		writeJson(pluginRoot, ".claude-plugin/plugin.json", {
			name: "workflow-core",
			version,
		});
	const readProvenanceLine = () =>
		read(referenceFile).split("## Plugin provenance\n\n")[1]?.split("\n")[0];

	it("spells the rules' core commands at the new plugin root", () => {
		configure();
		write(
			root,
			rulesFile,
			`<!-- CORE-OWNED. old -->\nrun \`node scripts/session-arbiter.js list\`\n${provenanceBlock}`,
		);
		const lines: string[] = [];
		expect(upgrade({ root, pluginRoot, out: (l) => lines.push(l) })).toEqual({
			status: 0,
		});
		const text = read();
		expect(text).toContain(
			`\`${path.resolve(pluginRoot)}/scripts/bg-run.sh check <name>\``,
		);
		expect(text).not.toMatch(/\b(?:node|bash) scripts\//);
		expect(text).toContain("nothing further waits on A Founder");
		expect(read(referenceFile)).toContain(
			`\`node ${path.resolve(pluginRoot)}/scripts/status-report.js\``,
		);
		expect(lines).toContain(`rewrote ${rulesFile}`);
		expect(lines).toContain(`wrote   ${referenceFile}`);
	});

	it("rewrites the provenance line an older ref wrote to the release now installed, from a git pin (#941)", () => {
		configure();
		installedAt("1.3.8");
		pinAt({
			source: "git",
			url: "https://example.invalid/wc.git",
			ref: "v1.3.8",
		});
		installRow("1.3.8", "04ad20bd");
		write(
			root,
			rulesFile,
			"<!-- CORE-OWNED. old -->\n\n## Plugin provenance\n\n- url source, ref v1.1.19, HEAD 0ld5ha\n",
		);
		upgrade({ root, pluginRoot });
		expect(readProvenanceLine()).toBe(
			"- url source, ref v1.3.8, HEAD 04ad20bd",
		);
		expect(read()).not.toContain("v1.1.19");
		expect(read(referenceFile)).not.toContain("v1.1.19");
	});

	it("calls the sha unknown where the install record is another release", () => {
		configure();
		installedAt("1.3.8");
		pinAt({
			source: "url",
			url: "https://example.invalid/wc.git",
			ref: "v1.3.8",
		});
		installRow("1.1.19", "0ld5ha");
		write(root, rulesFile, `<!-- CORE-OWNED. old -->\n${provenanceBlock}`);
		upgrade({ root, pluginRoot });
		expect(readProvenanceLine()).toBe("- url source, ref v1.3.8 (sha unknown)");
	});

	it("records a directory source's checkout HEAD", () => {
		configure();
		const checkout = path.join(configDir, "checkout");
		fs.mkdirSync(checkout);
		const git = (...args: string[]) =>
			execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim();
		git("init", "-q");
		git(
			"-c",
			"user.name=t",
			"-c",
			"user.email=t@t",
			"commit",
			"-q",
			"--allow-empty",
			"-m",
			"x",
		);
		pinAt({ source: "directory", path: checkout });
		write(root, rulesFile, `<!-- CORE-OWNED. old -->\n${provenanceBlock}`);
		upgrade({ root, pluginRoot });
		expect(readProvenanceLine()).toBe(
			`- directory source, HEAD ${git("rev-parse", "HEAD")}`,
		);
	});

	it("moves the provenance block, as written, out of the rules file where no pin names the plugin's source (#2035)", () => {
		configure();
		writeJson(root, ".claude/settings.json", {});
		write(root, rulesFile, `<!-- CORE-OWNED. old -->\n${provenanceBlock}`);
		upgrade({ root, pluginRoot });
		expect(read(referenceFile).endsWith(provenanceBlock)).toBe(true);
		expect(read()).not.toContain("## Plugin provenance");
		upgrade({ root, pluginRoot });
		expect(read(referenceFile).endsWith(provenanceBlock)).toBe(true);
	});

	it("leaves a reference file init did not write", () => {
		configure();
		write(root, rulesFile, `<!-- CORE-OWNED. old -->\n${provenanceBlock}`);
		write(root, referenceFile, "# hand-written\n");
		const lines: string[] = [];
		upgrade({ root, pluginRoot, out: (l) => lines.push(l) });
		expect(read(referenceFile)).toBe("# hand-written\n");
		expect(read()).toContain("\n## Plugin provenance\n");
		expect(lines).toContain(
			`skipped ${referenceFile} — it does not open on the CORE-OWNED marker, so the core did not write it`,
		);
	});

	it("run twice re-renders nothing the second time", () => {
		configure();
		write(root, rulesFile, `<!-- CORE-OWNED. old -->\n${provenanceBlock}`);
		upgrade({ root, pluginRoot });
		const lines: string[] = [];
		upgrade({ root, pluginRoot, out: (l) => lines.push(l) });
		expect(
			lines.filter((l) => l.includes(rulesFile) || l.includes(referenceFile)),
		).toEqual([]);
	});

	it("leaves a rules file init did not write, and writes none where there is none", () => {
		configure();
		write(root, rulesFile, "# hand-written\n");
		upgrade({ root, pluginRoot });
		expect(read()).toBe("# hand-written\n");
		fs.rmSync(path.join(root, rulesFile));
		upgrade({ root, pluginRoot });
		expect(fs.existsSync(path.join(root, rulesFile))).toBe(false);
	});

	it("names the re-render under --dry-run and writes nothing", () => {
		configure();
		const before = `<!-- CORE-OWNED. old -->\n${provenanceBlock}`;
		write(root, rulesFile, before);
		const lines: string[] = [];
		upgrade({ root, pluginRoot, dryRun: true, out: (l) => lines.push(l) });
		expect(read()).toBe(before);
		expect(lines).toContain(`would   rewrite ${rulesFile}`);
	});

	it("skips with a line where the config declares no founder", () => {
		configure({ founder: undefined });
		const before = `<!-- CORE-OWNED. old -->\n${provenanceBlock}`;
		write(root, rulesFile, before);
		const lines: string[] = [];
		upgrade({ root, pluginRoot, out: (l) => lines.push(l) });
		expect(read()).toBe(before);
		expect(lines).toContain(
			`skipped ${rulesFile}: .claude/workflow-core.json declares no founder`,
		);
	});
});

describe("the .gitignore block reaching an existing adopter (#773)", () => {
	const migrationsDir = path.join(__dirname, "../migrations");
	const legacyBlock =
		"# --- workflow-core: paths the core's rules assume are untracked (init-adopter.js) ---\n.claude/tmp/\n/private/\n# --- end workflow-core ignores ---\n";

	const atV135 = (gitignore: string) => {
		execFileSync("git", ["init", "-q"], { cwd: root });
		write(root, ".gitignore", gitignore);
		writeJson(root, ".claude/settings.json", {
			enabledPlugins: { "workflow-core@wc": true },
			extraKnownMarketplaces: {
				wc: {
					source: {
						source: "url",
						url: "https://example.invalid/wc.git",
						ref: "v1.3.5",
					},
				},
			},
		});
		writeJson(pluginRoot, ".claude-plugin/plugin.json", {
			name: "workflow-core",
			version: "1.3.6",
		});
		fs.cpSync(
			path.join(migrationsDir, "v1.3.6.md"),
			path.join(pluginRoot, "migrations/v1.3.6.md"),
		);
	};
	const isIgnored = (p: string) => {
		try {
			execFileSync("git", ["check-ignore", "-q", p], { cwd: root });
			return true;
		} catch {
			return false;
		}
	};

	it("ignores private/, .claude/tmp/ and .claude/worktrees/ in a repo bootstrapped before #737", () => {
		atV135("node_modules/\n");
		expect(upgrade({ root, pluginRoot, out: quiet }).status).toBe(0);
		expect(isIgnored("private/x")).toBe(true);
		expect(isIgnored(".claude/tmp/x")).toBe(true);
		expect(isIgnored(".claude/worktrees/x")).toBe(true);
	});

	it("adds no second copy to a repo init gave the block under #737's markers", () => {
		atV135(`node_modules/\n${legacyBlock}`);
		expect(upgrade({ root, pluginRoot, out: quiet }).status).toBe(0);
		const text = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
		expect(text).toBe(`node_modules/\n${CORE_IGNORE_BLOCK}\n`);
	});
});
