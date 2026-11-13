#!/usr/bin/env node
/*
 * record-claude-plugin.js — re-records the installed harness's answers to the
 * `claude plugin` calls init-adopter.js and upgrade.js make, as
 * scripts/fixtures/claude-plugin.json, which lib/claude-plugin-fake.ts serves
 * and lib/claude-plugin.contract.test.ts holds it to (#5146):
 *   - the exits of `marketplace add` of a directory source (this checkout),
 *     `install`, `update` and `details`, as lib/materialise-plugin.js and
 *     lib/core-context-cost.js run them;
 *   - `details`' Always-on line, which lib/core-context-cost.js parses;
 *   - a refusal, `marketplace add` of a path that does not exist: its exit and
 *     its stderr's first line, which materialise-plugin.js's installFailure
 *     reads;
 *   - the shape of the two side effects the adopter's state is read from: the
 *     `extraKnownMarketplaces.<name>.source` object `marketplace add` writes
 *     into the project's .claude/settings.json, and the row `install` writes
 *     into `<configDir>/plugins/installed_plugins.json`, with that file's
 *     top-level `version`.
 * Paths, shas, timestamps and the plugin's version are replaced with
 * synthetic values (§G7.3).
 *
 * Unrecorded: a url source's `marketplace add` (`<url>#<ref>`). The CLI
 * takes only owner/repo, https:// or a path, refusing file://, so recording
 * one clones a published marketplace.
 *
 * The calls write a plugin registry, and `install` clones the plugin's url
 * source (.claude-plugin/marketplace.json) from GitHub. Each runs in a
 * throwaway CLAUDE_CONFIG_DIR and a throwaway git project, through
 * materialise-plugin.js's own `run`, so
 * stdin is closed (`update` with stdin open waits on it). Run it by hand
 * after a harness upgrade, then
 * `npm run test -- scripts/lib/claude-plugin.contract.test.ts`.
 *
 * In no family (§N3): it writes a fixture, but runs the real `claude` to do
 * it, so it is no `generate-*` a gate may run.
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { caught } = require("./lib/caught.js");
const { claudeBin } = require("./lib/claude-bin.js");
const { cutAt } = require("./lib/cut-at.js");
const { sessionTree } = require("./lib/host-root.js");
const { run } = require("./lib/materialise-plugin.js");
const { writeFd } = require("./lib/write-fd.js");

const FIXTURE = path.join(__dirname, "fixtures", "claude-plugin.json");
const RECORDED_BY = "node scripts/record-claude-plugin.js";
const PLUGIN_ID = "workflow-core@workflow-core";
const MARKETPLACE = "workflow-core";

const SYNTHETIC = {
	config: "/synthetic/config",
	project: "/synthetic/project",
	pluginRoot: "/synthetic/plugin-root",
	absent: "/synthetic/absent",
	version: "1.0.0",
	sha: "0".repeat(40),
	time: "2026-01-01T00:00:00.000Z",
};

/**
 * A refusal's status and stderr read off `run`'s throw, any other throw (a timeout, no binary) rethrown.
 * @param {{config: string, project: string}} at
 * @param {string[]} args
 */
function claude(at, args) {
	try {
		const stdout = run(at.project, [claudeBin(), ...args], {
			configDir: at.config,
		});
		return { status: 0, stdout, stderr: "" };
	} catch (err) {
		const { status, stderr } = caught(err);
		if (typeof status !== "number") throw err;
		return { status, stdout: "", stderr: String(stderr) };
	}
}

/**
 * `value` with every machine value of this run swapped for its synthetic
 * one, its keys and types kept.
 * @param {unknown} value
 * @param {[string, string][]} swaps
 * @returns {unknown}
 */
function synthetic(value, swaps) {
	if (Array.isArray(value)) return value.map((v) => synthetic(v, swaps));
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([k, v]) => [k, synthetic(v, swaps)]),
		);
	if (typeof value !== "string") return value;
	if (/^[0-9a-f]{40}$/.test(value)) return SYNTHETIC.sha;
	if (/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value)) return SYNTHETIC.time;
	return swaps.reduce((s, [from, to]) => s.replaceAll(from, to), value);
}

/** @param {string} file */
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

/** @param {string} what @param {{status: number, stderr: string}} r */
function mustSucceed(what, r) {
	if (r.status !== 0)
		throw new Error(`${what} exited ${r.status}: ${r.stderr.trim()}`);
	return { status: r.status };
}

function main() {
	const base = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "record-claude-plugin-")),
	);
	/* The checkout this is run from, its plugin the directory source. */
	const core = sessionTree({ cwd: process.cwd() });
	if (!core) throw new Error("run it from a checkout of workflow-core");
	const at = {
		config: path.join(base, "config"),
		project: path.join(base, "project"),
	};
	try {
		fs.mkdirSync(at.config);
		fs.mkdirSync(at.project);
		execFileSync("git", ["init", "-q", at.project]);
		const harness = claude(at, ["--version"]).stdout.split(" ")[0];
		const marketplaceAdd = mustSucceed(
			"marketplace add",
			claude(at, ["plugin", "marketplace", "add", core, "--scope", "project"]),
		);
		const source = readJson(path.join(at.project, ".claude", "settings.json"))
			.extraKnownMarketplaces[MARKETPLACE].source;
		const install = mustSucceed(
			"install",
			claude(at, ["plugin", "install", PLUGIN_ID, "-y", "--scope", "project"]),
		);
		const registry = readJson(
			path.join(at.config, "plugins", "installed_plugins.json"),
		);
		const row = registry.plugins[PLUGIN_ID].at(-1);
		const update = mustSucceed(
			"update",
			claude(at, ["plugin", "update", PLUGIN_ID, "--scope", "project", "-y"]),
		);
		const details = claude(at, ["plugin", "details", PLUGIN_ID]);
		mustSucceed("details", details);
		const alwaysOn = details.stdout
			.split("\n")
			.find((l) => /Always-on:/.test(l));
		if (!alwaysOn) throw new Error("details printed no Always-on line");
		const absent = path.join(base, "absent");
		const refused = claude(at, [
			"plugin",
			"marketplace",
			"add",
			absent,
			"--scope",
			"project",
		]);
		if (refused.status === 0)
			throw new Error("marketplace add of an absent path succeeded");
		/** @type {[string, string][]} */
		const swaps = [
			[at.config, SYNTHETIC.config],
			[at.project, SYNTHETIC.project],
			[absent, SYNTHETIC.absent],
			[core, SYNTHETIC.pluginRoot],
			[row.version, SYNTHETIC.version],
		];
		const recorded = {
			recordedBy: RECORDED_BY,
			harness,
			responses: {
				marketplaceAdd,
				install,
				update,
				details: { status: details.status, alwaysOn },
				refusal: {
					status: refused.status,
					stderr: synthetic(cutAt(refused.stderr.trim(), "\n")[0], swaps),
				},
			},
			sideEffects: {
				marketplaceSource: synthetic(source, swaps),
				installedPlugins: {
					version: registry.version,
					row: synthetic(row, swaps),
				},
			},
		};
		fs.writeFileSync(FIXTURE, `${JSON.stringify(recorded, null, "\t")}\n`);
		writeFd(1, `recorded ${FIXTURE}\n`);
		return 0;
	} finally {
		fs.rmSync(base, { recursive: true, force: true });
	}
}

try {
	process.exitCode = main();
} catch (e) {
	writeFd(2, `${caught(e).message}\n`);
	process.exitCode = 1;
}
