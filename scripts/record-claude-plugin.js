#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { caught } = require("./lib/caught.js");
const { claudeBin } = require("./lib/claude-bin.js");
const { cutAt } = require("./lib/cut-at.js");
const { execGit } = require("./lib/git.js");
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
	const core = sessionTree({ cwd: process.cwd() });
	if (!core) throw new Error("run it from a checkout of workflow-core");
	const at = {
		config: path.join(base, "config"),
		project: path.join(base, "project"),
	};
	try {
		fs.mkdirSync(at.config);
		fs.mkdirSync(at.project);
		execGit(["init", "-q", at.project]);
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
