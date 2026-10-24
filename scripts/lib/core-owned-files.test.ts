// @vitest-environment node
/*
 * Pins core-owned-files.js through upgrade(), the run every adopter makes on
 * every bump (#1501). A new entry's paths are pinned through bringCoreFiles
 * and skeletonPaths directly (#1540); initPaths' half is in
 * ../init-adopter.test.ts.
 *
 * Breaking it leaves adopters on stale helpers and hooks after a bump, or
 * rewrites their settings and labels on every run.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upgrade } from "../upgrade.js";
import { labelPlan } from "./adopter-skeleton.js";
import { bringCoreFiles, skeletonPaths } from "./core-owned-files.js";

let root: string;
let pluginRoot: string;
let made: string[] = [];

const write = (base: string, rel: string, body: string) => {
	const at = path.join(base, rel);
	fs.mkdirSync(path.dirname(at), { recursive: true });
	fs.writeFileSync(at, body);
};
const HELPER = "scripts/browse.py";
const PLUGIN_HELPER = "#!/usr/bin/env python3\nprint('plugin')\n";

beforeEach(() => {
	/* The suite injects WFC_MODULES, which replaces the declared list the
	 * labels are planned from. */
	vi.stubEnv("WFC_MODULES", undefined);
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "core-owned-test-"));
	made.push(tmp);
	root = path.join(tmp, "adopter");
	pluginRoot = path.join(tmp, "plugin");
	write(
		pluginRoot,
		".claude-plugin/plugin.json",
		JSON.stringify({ name: "workflow-core", version: "1.0.0" }),
	);
	write(pluginRoot, HELPER, PLUGIN_HELPER);
	write(
		root,
		".claude/settings.json",
		JSON.stringify({
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
		}),
	);
	write(
		root,
		".claude/workflow-core.json",
		JSON.stringify({ contract: 1, founder: "A Founder", modules: [] }),
	);
});
afterEach(() => {
	vi.unstubAllEnvs();
	for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
	made = [];
});

/** One upgrade; `labels` absent, it reads and writes no label. */
function run(labels?: Parameters<typeof upgrade>[0]["labels"]) {
	const lines: string[] = [];
	const r = upgrade({ root, pluginRoot, out: (l) => lines.push(l), labels });
	expect(r.status).toBe(0);
	return lines;
}

describe("the helpers (#1453)", () => {
	const helper = () => fs.readFileSync(path.join(root, HELPER), "utf8");
	const mode = () => fs.statSync(path.join(root, HELPER)).mode & 0o777;

	it("writes a missing helper executable, byte-identical to the plugin's", () => {
		expect(run()).toContain(`wrote   ${HELPER}`);
		expect(helper()).toBe(PLUGIN_HELPER);
		expect(mode()).toBe(0o755);
	});

	it("rewrites a stale or locally edited helper, saying the edit is gone", () => {
		write(root, HELPER, "print('old')\n");
		expect(run()).toContain(
			`rewrote ${HELPER} — it differed from the plugin's copy, so any local edit to it is gone`,
		);
		expect(helper()).toBe(PLUGIN_HELPER);
	});

	it("repairs a lost exec bit and nothing else, and a current helper says nothing", () => {
		write(root, HELPER, PLUGIN_HELPER);
		fs.chmodSync(path.join(root, HELPER), 0o644);
		expect(run()).toContain(`repaired ${HELPER}'s exec bit`);
		expect(mode()).toBe(0o755);
		expect(run().filter((l) => l.includes(HELPER))).toEqual([]);
	});

	it("writes nothing under a dry run, naming what it would", () => {
		const lines: string[] = [];
		upgrade({ root, pluginRoot, dryRun: true, out: (l) => lines.push(l) });
		expect(lines).toContain(`would   write ${HELPER}`);
		expect(fs.existsSync(path.join(root, HELPER))).toBe(false);
	});
});

describe("settings.json's layout (#1484)", () => {
	it("is written 2-space, and a second upgrade leaves it byte for byte", () => {
		run();
		const once = fs.readFileSync(
			path.join(root, ".claude/settings.json"),
			"utf8",
		);
		expect(once).toMatch(/^\{\n {2}"/);
		expect(once).not.toContain("\t");
		run();
		expect(
			fs.readFileSync(path.join(root, ".claude/settings.json"), "utf8"),
		).toBe(once);
	});

	it("keeps an adopter's own layout where every key is current", () => {
		run();
		const at = path.join(root, ".claude/settings.json");
		const tabbed = JSON.stringify(
			JSON.parse(fs.readFileSync(at, "utf8")),
			null,
			"\t",
		);
		fs.writeFileSync(at, tabbed);
		run();
		expect(fs.readFileSync(at, "utf8")).toBe(tabbed);
	});
});

describe("the core's own wfc-self self-plugin (#2440)", () => {
	it("is left out of an adopter's enabledPlugins, and the adopter's own entries stay", () => {
		const at = path.join(root, ".claude/settings.json");
		const settings = JSON.parse(fs.readFileSync(at, "utf8"));
		settings.enabledPlugins = {
			...settings.enabledPlugins,
			"wfc-self@wfc-self": true,
			"other@market": true,
		};
		fs.writeFileSync(at, JSON.stringify(settings));
		run();
		expect(JSON.parse(fs.readFileSync(at, "utf8")).enabledPlugins).toEqual({
			"workflow-core@wc": true,
			"other@market": true,
		});
	});
});

describe("the labels (#1484)", () => {
	interface Label {
		name: string;
		color: string;
		description: string;
	}
	function stubGh(have: Label[] = []) {
		const calls: string[] = [];
		return {
			calls,
			gh: {
				list: (repo: string) => {
					calls.push(`list ${repo}`);
					return have;
				},
				create: (repo: string, label: Label) => {
					calls.push(`create ${repo} ${label.name}`);
				},
			},
		};
	}

	it("derives an undeclared tracker from the origin remote and syncs through it", () => {
		execFileSync("git", ["init", "-q", root]);
		execFileSync("git", [
			"-C",
			root,
			"remote",
			"add",
			"origin",
			"https://github.com/acme/widgets.git",
		]);
		const { calls, gh } = stubGh();
		const lines = run(gh);
		const plan = labelPlan({ modules: [], categories: {} });
		expect(calls[0]).toBe("list acme/widgets");
		expect(calls.filter((c) => c.startsWith("create"))).toHaveLength(
			plan.length,
		);
		expect(lines).toContain(
			`labels   acme/widgets: ${plan.length} of ${plan.length} created or updated`,
		);
	});

	it("says why it skipped where no tracker resolves", () => {
		const { calls, gh } = stubGh();
		expect(run(gh)).toContain(
			"skipped the labels — no `tracker` in .claude/workflow-core.json and no GitHub origin remote to derive one from",
		);
		expect(calls).toEqual([]);
	});

	it("makes one read and no create where every label is current", () => {
		write(
			root,
			".claude/workflow-core.json",
			JSON.stringify({
				contract: 1,
				founder: "A Founder",
				modules: [],
				tracker: "acme/widgets",
			}),
		);
		const plan = labelPlan({ modules: [], categories: {} });
		const { calls, gh } = stubGh(
			plan.map((l: Label) => ({ ...l, color: l.color.toUpperCase() })),
		);
		const lines = run(gh);
		expect(calls).toEqual(["list acme/widgets"]);
		expect(lines.filter((l) => l.startsWith("labels"))).toEqual([]);
	});
});

describe("the session cost table (#1734)", () => {
	const tableRel = "docs/data/session-cost-table.json";
	const scriptRel = "scripts/measure-session-cost.js";
	const ledgerRel = ".claude/tmp/markers/.pick-next/dispatched.jsonl";
	/* A stand-in for the plugin's script: the real one's pricing is
	 * measure-session-cost.test.ts's to pin. */
	const stub = (body: string) =>
		write(pluginRoot, scriptRel, `const fs = require("node:fs");\n${body}\n`);
	const stubTableWriter = () =>
		stub(
			`fs.mkdirSync(process.env.CLAUDE_PROJECT_DIR + "/docs/data", { recursive: true });
fs.writeFileSync(process.env.CLAUDE_PROJECT_DIR + "/${tableRel}", "{}\\n");
console.log("n=2 mean=$3");`,
		);
	const table = () => path.join(root, tableRel);
	const command = () => `node ${path.join(pluginRoot, scriptRel)} --write`;

	it("builds a missing table from the host's ledger, naming the refresh command", () => {
		stubTableWriter();
		write(root, ledgerRel, '{"jobId":"abcdef12"}\n');
		expect(run()).toContain(
			`built   ${tableRel} (n=2 mean=$3) — refresh it with ${command()}`,
		);
		expect(fs.existsSync(table())).toBe(true);
	});

	it("leaves an existing table alone, saying nothing", () => {
		stubTableWriter();
		write(root, ledgerRel, '{"jobId":"abcdef12"}\n');
		write(root, tableRel, "kept\n");
		expect(run().filter((l) => l.includes(tableRel))).toEqual([]);
		expect(fs.readFileSync(table(), "utf8")).toBe("kept\n");
	});

	it("builds nothing, and says nothing, where the host has no ledger history", () => {
		stubTableWriter();
		expect(run().filter((l) => l.includes(tableRel))).toEqual([]);
		expect(fs.existsSync(table())).toBe(false);
		expect(fs.existsSync(path.join(root, ".claude/tmp"))).toBe(false);
	});

	it("reports a failed build with the hand-run command, and carries on", () => {
		stub(
			'process.stderr.write("no ledger entry matched a transcript\\n"); process.exit(1);',
		);
		write(root, ledgerRel, '{"jobId":"abcdef12"}\n');
		expect(run()).toContain(
			`FAILED building ${tableRel}: no ledger entry matched a transcript — build it by hand: ${command()}`,
		);
	});

	it("writes nothing under a dry run, naming the command it would run", () => {
		stubTableWriter();
		write(root, ledgerRel, '{"jobId":"abcdef12"}\n');
		const lines: string[] = [];
		upgrade({ root, pluginRoot, dryRun: true, out: (l) => lines.push(l) });
		expect(lines).toContain(`would   build ${tableRel} (${command()})`);
		expect(fs.existsSync(table())).toBe(false);
	});
});

describe("a new entry's paths (#1540)", () => {
	const written = "scripts/new-helper.sh";
	const idle = ".github/new-core.yml";
	const ctx = () => ({
		root,
		pluginRoot,
		dryRun: false,
		out: () => undefined,
		record: null,
		pin: null,
	});
	const added = [
		{
			bring: () => {
				write(root, written, "#!/bin/sh\n");
				return [written];
			},
			paths: [written],
		},
		{ bring: () => [], paths: [idle] },
	];
	const isPresent = (rel: string) => fs.existsSync(path.join(root, rel));

	it("reach the skeleton pathspec with no other edit", () => {
		expect(bringCoreFiles(ctx(), added)).toContain(written);
		expect(skeletonPaths(isPresent, added)).toContain(written);
	});

	it("leave out a declared path the run did not write, since a pathspec naming it fails", () => {
		bringCoreFiles(ctx(), added);
		expect(skeletonPaths(isPresent, added)).not.toContain(idle);
	});

	it("name no path a skeleton root already covers", () => {
		const spec = skeletonPaths(() => true);
		expect(spec.filter((p: string) => p.startsWith(".husky/"))).toEqual([]);
		expect(spec).not.toContain(".claude/settings.json");
	});

	it("refuses an entry writing a path its paths do not declare, naming both", () => {
		const entries = [{ ...added[0], paths: [] }];
		expect(() => bringCoreFiles(ctx(), entries)).toThrow(
			`bring wrote ${written}, which its entry's paths do not declare`,
		);
	});
});
