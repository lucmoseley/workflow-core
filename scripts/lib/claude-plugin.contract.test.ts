// @vitest-environment node
/*
 * Holds lib/claude-plugin-fake.ts, the `claude` init-adopter.test.ts's
 * materialising cases run, to the installed harness's recorded answers
 * (scripts/fixtures/claude-plugin.json, re-recorded by
 * `node scripts/record-claude-plugin.js`) (#5146). One case list, each run
 * against the recording and the fake, read through the production readers:
 * each verb's exit as lib/materialise-plugin.js's `run` takes it, the
 * `details` figure through lib/core-context-cost.js's parser, the refusal
 * through materialise-plugin.js's installFailure, and the two side effects'
 * keys and types. No case runs the real `claude`: each call writes a plugin
 * registry, so the recording is the real side (§G7.2). A url source's
 * `marketplace add` is unheld, being unrecorded.
 *
 * Breaking it lets init-adopter.test.ts pass on a `claude` the core misreads:
 * a cost row seeded from a line the harness never prints, a failure message
 * built from a stderr it never writes, or an install row the core's
 * findInstallRecord reads where the harness's would not be.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	alwaysOnLine,
	type PluginFake,
	recorded,
	writeClaudePluginFake,
} from "./claude-plugin-fake";
import { parseAlwaysOn } from "./core-context-cost.js";
import { installFailure, materialisePlugin } from "./materialise-plugin.js";
import { findInstallRecord } from "./plugin-state.js";

const PLUGIN_ID = "workflow-core@workflow-core";

let dir: string;
let project: string;
let config: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-plugin-"));
	project = path.join(dir, "project");
	config = path.join(dir, "config");
	fs.mkdirSync(project);
	fs.mkdirSync(config);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const fake = (opts: PluginFake = {}) => writeClaudePluginFake(dir, opts);

/** The fake run as materialise-plugin.js's `run` runs a call. */
const call = (bin: string, args: string[]) =>
	spawnSync(bin, args, {
		cwd: project,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: project,
			CLAUDE_CONFIG_DIR: config,
		},
	});

/** A JSON value's shape: its keys and each value's type, not its values. */
const shape = (value: Record<string, unknown>) =>
	Object.fromEntries(Object.entries(value).map(([k, v]) => [k, typeof v]));

const verbs: {
	verb: "marketplaceAdd" | "install" | "update" | "details";
	args: string[];
}[] = [
	{
		verb: "marketplaceAdd",
		args: ["plugin", "marketplace", "add", "/a/checkout", "--scope", "project"],
	},
	{
		verb: "install",
		args: ["plugin", "install", PLUGIN_ID, "-y", "--scope", "project"],
	},
	{
		verb: "update",
		args: ["plugin", "update", PLUGIN_ID, "--scope", "project", "-y"],
	},
	{ verb: "details", args: ["plugin", "details", PLUGIN_ID] },
];

describe.each(verbs)("`claude $args`", ({ verb, args }) => {
	it(`exits as ${recorded.harness}'s recording does, from the fake`, () => {
		expect(call(fake(), args).status).toBe(recorded.responses[verb].status);
	});
});

it("materialises, update included, in the recording and from the fake", () => {
	const { marketplaceAdd, install, update } = recorded.responses;
	expect([marketplaceAdd, install, update].map((r) => r.status)).toEqual([
		0, 0, 0,
	]);
	const result = materialisePlugin({
		root: project,
		claudeBin: fake(),
		addSource: "/a/checkout",
		pluginId: PLUGIN_ID,
		configDir: config,
	});
	expect(result).toMatchObject({ ok: true });
	expect(result).not.toHaveProperty("updateFailed");
});

describe("`details`' Always-on figure, through the cost parser", () => {
	it("reads as a figure in the recording", () => {
		expect(parseAlwaysOn(recorded.responses.details.alwaysOn)).toEqual(
			expect.any(Number),
		);
	});

	it("reads as the recording's figure from the fake", () => {
		const out = call(fake(), ["plugin", "details", PLUGIN_ID]).stdout;
		expect(parseAlwaysOn(out)).toBe(
			parseAlwaysOn(recorded.responses.details.alwaysOn),
		);
	});

	it("reads as a case's own figure, in the recorded line, from the fake", () => {
		const out = call(fake({ alwaysOn: "2,273" }), [
			"plugin",
			"details",
			PLUGIN_ID,
		]).stdout;
		expect(parseAlwaysOn(out)).toBe(2273);
		expect(out.trimEnd()).toBe(alwaysOnLine("2,273"));
	});
});

describe("a refusal, through installFailure", () => {
	const recordedReason = installFailure({
		stderr: recorded.responses.refusal.stderr,
	});

	it("exits nonzero with a reason in the recording", () => {
		expect(recorded.responses.refusal.status).not.toBe(0);
		expect(recordedReason).not.toBe("");
	});

	it("exits as recorded from the fake, giving the recorded reason", () => {
		const r = call(fake({ refuse: true }), verbs[0].args);
		expect(r.status).toBe(recorded.responses.refusal.status);
		const result = materialisePlugin({
			root: project,
			claudeBin: fake({ refuse: true }),
			addSource: "/a/checkout",
			pluginId: PLUGIN_ID,
			configDir: config,
		});
		expect(result).toMatchObject({ ok: false, reason: recordedReason });
	});
});

describe("the side effects' shapes", () => {
	it("`marketplace add` writes the recorded source shape at the added path", () => {
		call(fake({ marketplaceSource: true }), verbs[0].args);
		const source = JSON.parse(
			fs.readFileSync(path.join(project, ".claude/settings.json"), "utf8"),
		).extraKnownMarketplaces["workflow-core"].source;
		expect(shape(source)).toEqual(
			shape(recorded.sideEffects.marketplaceSource),
		);
		expect(source).toEqual({
			...recorded.sideEffects.marketplaceSource,
			path: "/a/checkout",
		});
	});

	it("`install` writes the recorded row shape, which findInstallRecord reads", () => {
		call(
			fake({ install: { version: "1.1.0", gitCommitSha: "a".repeat(40) } }),
			verbs[1].args,
		);
		const doc = JSON.parse(
			fs.readFileSync(
				path.join(config, "plugins/installed_plugins.json"),
				"utf8",
			),
		);
		expect(doc.version).toBe(recorded.sideEffects.installedPlugins.version);
		const [row] = doc.plugins[PLUGIN_ID];
		expect(shape(row)).toEqual(
			shape(recorded.sideEffects.installedPlugins.row),
		);
		expect(
			findInstallRecord(
				path.join(config, "plugins"),
				"workflow-core",
				"workflow-core",
				project,
			),
		).toEqual({
			installPath: path.join(
				config,
				"plugins/cache/workflow-core/workflow-core/1.1.0",
			),
			version: "1.1.0",
			gitCommitSha: "a".repeat(40),
		});
	});

	it("the recorded row sits at the cache path the recorded config dir names", () => {
		const { row } = recorded.sideEffects.installedPlugins;
		expect(row.installPath).toBe(
			`/synthetic/config/plugins/cache/workflow-core/workflow-core/${row.version}`,
		);
	});
});

it("logs each call's argv, one line per call, its config dir first where asked", () => {
	const log = path.join(dir, "log");
	const bin = fake({ log, logConfigDir: true });
	call(bin, verbs[2].args);
	call(bin, verbs[3].args);
	expect(fs.readFileSync(log, "utf8")).toBe(
		`${config} ${verbs[2].args.join(" ")}\n${config} ${verbs[3].args.join(" ")}\n`,
	);
});
