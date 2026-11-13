// @vitest-environment node
/*
 * Holds lib/claude-plugin-fake.ts, the `claude` init-adopter.test.ts's
 * materialising cases run, to the installed harness's recorded answers
 * (scripts/fixtures/claude-plugin.json, re-recorded by
 * `node scripts/record-claude-plugin.js`) (#5146). Where `claude` is on PATH,
 * the live cases run the free, offline calls against it in a scratch config
 * dir and project (§G7.2); `details` goes through `--plugin-dir`, since
 * `details` of an installed plugin needs `install`, which clones the plugin's
 * url source from GitHub. Unheld, being unrecorded: a url source's
 * `marketplace add`, and the clone `install` lands at the row's installPath
 * (the fake's `place`).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	alwaysOnLine,
	type PluginFake,
	REFUSED_PATH,
	recorded,
	refusalOf,
	writeClaudePluginFake,
} from "./claude-plugin-fake";
import { measurerFor } from "./core-context-cost.js";
import {
	installFailure,
	materialisePlugin,
	run,
} from "./materialise-plugin.js";
import { findInstallRecord } from "./plugin-state.js";
import { shellQuote } from "./sh-quote.js";

const PLUGIN_ID = "workflow-core@workflow-core";
/* This checkout: a directory marketplace and a plugin, as init adds it. */
const CHECKOUT = path.resolve(__dirname, "../..");

const realClaude = (process.env.PATH ?? "")
	.split(path.delimiter)
	.map((d) => path.join(d, "claude"))
	.find((f) => {
		try {
			fs.accessSync(f, fs.constants.X_OK);
			return true;
		} catch {
			return false;
		}
	});

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

const measure = (bin: string, pluginId = PLUGIN_ID) =>
	measurerFor({ root: project, claudeBin: bin, configDir: config })(pluginId);

const addedSource = () =>
	JSON.parse(
		fs.readFileSync(path.join(project, ".claude/settings.json"), "utf8"),
	).extraKnownMarketplaces["workflow-core"].source;

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

describe("`details`' Always-on figure, through the cost measurer", () => {
	it("reads as a figure in the recording, which the fake prints unchanged", () => {
		const out = call(fake(), ["plugin", "details", PLUGIN_ID]).stdout;
		expect(out.trimEnd()).toBe(recorded.responses.details.alwaysOn);
		expect(measure(fake())).toEqual({ tokens: expect.any(Number) });
	});

	it("reads as a case's own figure, in the recorded line, from the fake", () => {
		const out = call(fake({ alwaysOn: "2,273" }), [
			"plugin",
			"details",
			PLUGIN_ID,
		]).stdout;
		expect(measure(fake({ alwaysOn: "2,273" }))).toEqual({ tokens: 2273 });
		expect(out.trimEnd()).toBe(alwaysOnLine("2,273"));
	});
});

describe("a refusal, through installFailure", () => {
	const recordedReason = installFailure({
		stderr: recorded.responses.refusal.stderr,
	});

	it("exits nonzero with a reason naming the absent path in the recording", () => {
		expect(recorded.responses.refusal.status).not.toBe(0);
		expect(recordedReason).toContain(REFUSED_PATH);
	});

	it("exits as recorded from the fake, giving the recorded reason for the path it was given", () => {
		const r = call(fake({ refuse: true }), verbs[0].args);
		expect(r.status).toBe(recorded.responses.refusal.status);
		const result = materialisePlugin({
			root: project,
			claudeBin: fake({ refuse: true }),
			addSource: "/a/checkout",
			pluginId: PLUGIN_ID,
			configDir: config,
		});
		const reason = installFailure({ stderr: refusalOf("/a/checkout") });
		expect(reason).toBe(recordedReason.replace(REFUSED_PATH, "/a/checkout"));
		expect(result).toMatchObject({ ok: false, reason });
	});
});

describe("the side effects' shapes", () => {
	it("`marketplace add` writes the recorded source shape at the added path", () => {
		call(fake(), verbs[0].args);
		const source = addedSource();
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

	it("`install` writes the recorded row with no value given, as the real binary always does", () => {
		call(fake(), verbs[1].args);
		expect(
			findInstallRecord(
				path.join(config, "plugins"),
				"workflow-core",
				"workflow-core",
				project,
			),
		).toMatchObject({
			version: recorded.sideEffects.installedPlugins.row.version,
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

describe.skipIf(!realClaude)("against the installed claude", () => {
	const real = realClaude as string;
	/* On a red here, re-record (the header's command) and re-read the fake. */
	const stale = () =>
		`recorded on ${recorded.harness}, run on ${run(project, [real, "--version"]).trim()}`;

	it("refuses an absent path as the fake does, through installFailure", () => {
		const at = {
			root: project,
			addSource: path.join(dir, "absent"),
			pluginId: PLUGIN_ID,
			configDir: config,
		};
		/* The verdict and reason, not the argv, which names each binary. */
		const verdict = (claudeBin: string) => {
			const r = materialisePlugin({ ...at, claudeBin });
			return { ok: r.ok, reason: "reason" in r ? r.reason : undefined };
		};
		const live = verdict(real);
		expect(live).toMatchObject({ ok: false, reason: expect.any(String) });
		expect(verdict(fake({ refuse: true })), stale()).toEqual(live);
	}, 60_000);

	it("adds a directory source in the recorded shape, as the fake writes it", () => {
		const args = [
			"plugin",
			"marketplace",
			"add",
			CHECKOUT,
			"--scope",
			"project",
		];
		run(project, [real, ...args], { configDir: config });
		const live = addedSource();
		expect(shape(live), stale()).toEqual(
			shape(recorded.sideEffects.marketplaceSource),
		);
		fs.rmSync(path.join(project, ".claude"), { recursive: true });
		call(fake(), args);
		expect(addedSource()).toEqual(live);
	}, 60_000);

	it("prints a `details` line the cost measurer reads as a figure, as the fake's", () => {
		const wrapper = path.join(dir, "claude-plugin-dir");
		fs.writeFileSync(
			wrapper,
			`#!/bin/sh\nexec ${shellQuote(real)} --plugin-dir ${shellQuote(CHECKOUT)} "$@"\n`,
			{ mode: 0o755 },
		);
		expect(measure(wrapper, "workflow-core"), stale()).toEqual({
			tokens: expect.any(Number),
		});
		expect(measure(fake())).toEqual({ tokens: expect.any(Number) });
	}, 60_000);
});
