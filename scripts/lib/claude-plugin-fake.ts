/*
 * The fake of the `claude plugin` calls lib/materialise-plugin.js and
 * lib/core-context-cost.js make (#5146): `marketplace add`, `install`,
 * `update` and `details`. Held to the installed harness's recorded answers
 * (scripts/fixtures/claude-plugin.json, re-recorded by
 * `node scripts/record-claude-plugin.js`) by lib/claude-plugin.contract.test.ts.
 *
 * A node stub, not lib/claude-stub.ts's bash one: its side effects are JSON
 * edits, and it is asked no `auth status`.
 */

import fs from "node:fs";
import path from "node:path";

type Row = Record<string, unknown>;

export const recorded: {
	harness: string;
	responses: {
		marketplaceAdd: { status: number };
		install: { status: number };
		update: { status: number };
		details: { status: number; alwaysOn: string };
		refusal: { status: number; stderr: string };
	};
	sideEffects: {
		marketplaceSource: Row;
		installedPlugins: { version: number; row: Row };
	};
} = JSON.parse(
	fs.readFileSync(
		path.join(__dirname, "..", "fixtures", "claude-plugin.json"),
		"utf8",
	),
);

export interface PluginFake {
	/** Where each call's argv is appended, one line per call. */
	log?: string;
	/** Opens each logged line with the call's CLAUDE_CONFIG_DIR and a space. */
	logConfigDir?: boolean;
	/** Every call answers as the recorded refusal, `marketplace add` naming
	 * its own source where the recording names its absent path. */
	refuse?: boolean;
	/** The figure `details` prints in place of the recorded one, as `2,273`. */
	alwaysOn?: string;
	/** Values for the row `install` writes. `place`, where given, is linked at
	 * the row's installPath, standing in for the clone the install lands
	 * there; that clone is unheld. */
	install?: { version?: string; gitCommitSha?: string; place?: string };
}

const STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const fake = JSON.parse(fs.readFileSync(path.join(__dirname, "claude-plugin-fake.json"), "utf8"));
const args = process.argv.slice(2);
const env = process.env;
if (fake.log)
	fs.appendFileSync(fake.log, (fake.logConfigDir ? (env.CLAUDE_CONFIG_DIR || "") + " " : "") + args.join(" ") + "\\n");
const answer = (r) => process.exit(r.status);
const project = env.CLAUDE_PROJECT_DIR || process.cwd();
const verb = args[0] !== "plugin" ? null : args[1] === "marketplace" ? "marketplace " + args[2] : args[1];
if (fake.refuse) {
	const { stderr } = fake.responses.refusal;
	process.stderr.write((verb === "marketplace add" ? stderr.replace(fake.absent, args[3]) : stderr) + "\\n");
	answer(fake.responses.refusal);
}
if (verb === "marketplace add") {
	const at = path.join(project, ".claude", "settings.json");
	const settings = fs.existsSync(at) ? JSON.parse(fs.readFileSync(at, "utf8")) : {};
	settings.extraKnownMarketplaces = settings.extraKnownMarketplaces || {};
	settings.extraKnownMarketplaces[fake.marketplace] = {
		source: { ...fake.sideEffects.marketplaceSource, path: args[3] },
	};
	fs.mkdirSync(path.dirname(at), { recursive: true });
	fs.writeFileSync(at, JSON.stringify(settings, null, 2) + "\\n");
	answer(fake.responses.marketplaceAdd);
}
if (verb === "install") {
	if (!env.CLAUDE_CONFIG_DIR) {
		process.stderr.write("claude-plugin-fake: install with no CLAUDE_CONFIG_DIR\\n");
		process.exit(1);
	}
	const given = fake.install || {};
	const [plugin, marketplace] = args[2].split("@");
	const recordedRow = fake.sideEffects.installedPlugins.row;
	const version = given.version || recordedRow.version;
	const installPath = path.join(env.CLAUDE_CONFIG_DIR, "plugins", "cache", marketplace, plugin, version);
	const now = new Date().toISOString();
	const row = {
		...recordedRow,
		installPath,
		version,
		installedAt: now,
		lastUpdated: now,
		gitCommitSha: given.gitCommitSha || recordedRow.gitCommitSha,
		projectPath: project,
	};
	const at = path.join(env.CLAUDE_CONFIG_DIR, "plugins", "installed_plugins.json");
	const doc = fs.existsSync(at)
		? JSON.parse(fs.readFileSync(at, "utf8"))
		: { version: fake.sideEffects.installedPlugins.version, plugins: {} };
	doc.plugins[args[2]] = (doc.plugins[args[2]] || []).filter((r) => r.projectPath !== project).concat([row]);
	fs.mkdirSync(path.dirname(at), { recursive: true });
	fs.writeFileSync(at, JSON.stringify(doc, null, 2));
	if (given.place) {
		fs.mkdirSync(path.dirname(installPath), { recursive: true });
		fs.symlinkSync(given.place, installPath);
	}
	answer(fake.responses.install);
}
if (verb === "update") answer(fake.responses.update);
if (verb === "details") {
	process.stdout.write(fake.alwaysOn + "\\n");
	answer(fake.responses.details);
}
process.stderr.write("claude-plugin-fake: unfaked call: " + args.join(" ") + "\\n");
process.exit(1);
`;

/** The absent path the recorded refusal names, record-claude-plugin.js's. */
export const REFUSED_PATH = "/synthetic/absent";

export const refusalOf = (source: string) =>
	recorded.responses.refusal.stderr.replace(REFUSED_PATH, source);

export const alwaysOnLine = (figure?: string) =>
	figure === undefined
		? recorded.responses.details.alwaysOn
		: recorded.responses.details.alwaysOn.replace(/~[\d,.]+k?/, `~${figure}`);

export function writeClaudePluginFake(dir: string, fake: PluginFake = {}) {
	const { alwaysOn, ...rest } = fake;
	fs.writeFileSync(
		path.join(dir, "claude-plugin-fake.json"),
		JSON.stringify({
			...rest,
			alwaysOn: alwaysOnLine(alwaysOn),
			marketplace: "workflow-core",
			absent: REFUSED_PATH,
			responses: recorded.responses,
			sideEffects: recorded.sideEffects,
		}),
	);
	const bin = path.join(dir, "claude");
	fs.writeFileSync(bin, STUB, { mode: 0o755 });
	return bin;
}
