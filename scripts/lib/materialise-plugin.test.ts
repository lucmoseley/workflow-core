// @vitest-environment node
/*
 * materialise-plugin.test.ts — CLAUDE_CONFIG_DIR isolation (#117): a caller
 * passing `configDir` gets it on every `claude` call `materialisePlugin`
 * makes; a caller passing nothing gets exactly what the process env already
 * carries.
 * Also covers `run()`'s timeout on a hung `claude` call (#135), #258's
 * cross-scope ref-conflict short-circuit, and #342's source-kind one.
 *
 * Every `claude` call goes to a stub script in a temp dir that logs its argv
 * and CLAUDE_CONFIG_DIR, so no case touches a real plugin registry.
 *
 * init-adopter.js and reconcile-plugin.js install plugins through this, so a
 * loosened case lets a caller that isolated its config dir rewrite the
 * founder's own plugin registry, or a hung `claude` call hang the session
 * running it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	materialisePlugin,
	predictedRefConflict,
	run,
} from "./materialise-plugin.js";

let made: string[] = [];
let origConfigDir: string | undefined;

/**
 * A stub `claude` that logs its own argv and CLAUDE_CONFIG_DIR, one line per
 * call, to `log`.
 */
function stubClaude(log: string) {
	const stub = fs.mkdtempSync(path.join(os.tmpdir(), "materialise-claude-"));
	made.push(stub);
	const bin = path.join(stub, "claude");
	fs.writeFileSync(
		bin,
		`#!/bin/sh\necho "$CLAUDE_CONFIG_DIR|$@" >> ${JSON.stringify(log)}\nexit 0\n`,
		{ mode: 0o755 },
	);
	return bin;
}

beforeEach(() => {
	origConfigDir = process.env.CLAUDE_CONFIG_DIR;
});

afterEach(() => {
	if (origConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
	else process.env.CLAUDE_CONFIG_DIR = origConfigDir;
	for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
	made = [];
});

describe("materialisePlugin's CLAUDE_CONFIG_DIR isolation (#117)", () => {
	it("leaves CLAUDE_CONFIG_DIR exactly as the calling session set it, with no configDir passed", () => {
		process.env.CLAUDE_CONFIG_DIR = "/tmp/some-dev-session/.claude3";
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "materialise-root-"));
		made.push(root);
		const log = path.join(root, "calls.log");
		const claudeBin = stubClaude(log);

		const result = materialisePlugin({
			root,
			claudeBin,
			addSource: "https://example.invalid/wc.git#v1.0.0",
			pluginId: "workflow-core@wc",
		});

		expect(result.ok).toBe(true);
		const lines = fs.readFileSync(log, "utf8").trim().split("\n");
		expect(lines).toHaveLength(3);
		for (const line of lines)
			expect(line.split("|")[0]).toBe("/tmp/some-dev-session/.claude3");
	});

	it("falls through to the real ~/.claude where the session sets no override", () => {
		delete process.env.CLAUDE_CONFIG_DIR;
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "materialise-root-"));
		made.push(root);
		const log = path.join(root, "calls.log");
		const claudeBin = stubClaude(log);

		materialisePlugin({
			root,
			claudeBin,
			addSource: "https://example.invalid/wc.git#v1.0.0",
			pluginId: "workflow-core@wc",
		});

		const lines = fs.readFileSync(log, "utf8").trim().split("\n");
		for (const line of lines)
			expect(line.split("|")[0]).toBe(path.join(os.homedir(), ".claude"));
	});

	it("honours an explicit configDir over the session's own, on all three calls", () => {
		process.env.CLAUDE_CONFIG_DIR = "/tmp/some-dev-session/.claude3";
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "materialise-root-"));
		made.push(root);
		const throwaway = fs.mkdtempSync(
			path.join(os.tmpdir(), "materialise-config-"),
		);
		made.push(throwaway);
		const log = path.join(root, "calls.log");
		const claudeBin = stubClaude(log);

		const result = materialisePlugin({
			root,
			claudeBin,
			addSource: "https://example.invalid/wc.git#v1.0.0",
			pluginId: "workflow-core@wc",
			configDir: throwaway,
		});

		expect(result.ok).toBe(true);
		const lines = fs.readFileSync(log, "utf8").trim().split("\n");
		expect(lines).toHaveLength(3);
		for (const line of lines) expect(line.split("|")[0]).toBe(throwaway);
	});

	it("leaves the session's own registry JSON byte-identical (#117)", () => {
		const sessionConfig = fs.mkdtempSync(
			path.join(os.tmpdir(), "materialise-session-"),
		);
		made.push(sessionConfig);
		fs.mkdirSync(path.join(sessionConfig, "plugins"));
		const registries = ["known_marketplaces.json", "installed_plugins.json"];
		for (const f of registries) {
			fs.writeFileSync(
				path.join(sessionConfig, "plugins", f),
				JSON.stringify({ untouched: true }),
			);
		}
		const before = registries.map((f) =>
			fs.readFileSync(path.join(sessionConfig, "plugins", f)),
		);
		process.env.CLAUDE_CONFIG_DIR = sessionConfig;

		const root = fs.mkdtempSync(path.join(os.tmpdir(), "materialise-root-"));
		made.push(root);
		const throwaway = fs.mkdtempSync(
			path.join(os.tmpdir(), "materialise-config-"),
		);
		made.push(throwaway);
		const log = path.join(root, "calls.log");
		const stub = fs.mkdtempSync(path.join(os.tmpdir(), "materialise-claude-"));
		made.push(stub);
		const claudeBin = path.join(stub, "claude");
		fs.writeFileSync(
			claudeBin,
			"#!/bin/sh\n" +
				`echo "$CLAUDE_CONFIG_DIR|$@" >> ${JSON.stringify(log)}\n` +
				`mkdir -p "$CLAUDE_CONFIG_DIR/plugins"\n` +
				`echo clobbered > "$CLAUDE_CONFIG_DIR/plugins/known_marketplaces.json"\n` +
				"exit 0\n",
			{ mode: 0o755 },
		);

		const result = materialisePlugin({
			root,
			claudeBin,
			addSource: "https://example.invalid/wc.git#v1.0.0",
			pluginId: "workflow-core@wc",
			configDir: throwaway,
		});

		expect(result.ok).toBe(true);
		expect(fs.readFileSync(log, "utf8").trim().split("\n")).toHaveLength(3);
		expect(
			fs.readFileSync(
				path.join(throwaway, "plugins/known_marketplaces.json"),
				"utf8",
			),
		).toBe("clobbered\n");
		for (const [i, f] of registries.entries()) {
			expect(fs.readFileSync(path.join(sessionConfig, "plugins", f))).toEqual(
				before[i],
			);
		}
	});
});

/** A stub `claude` that never returns. */
function hungClaude() {
	const stub = fs.mkdtempSync(path.join(os.tmpdir(), "materialise-claude-"));
	made.push(stub);
	const bin = path.join(stub, "claude");
	fs.writeFileSync(bin, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
	return bin;
}

describe("materialisePlugin's timeout (#135)", () => {
	it("run() kills a hung claude call rather than waiting on it forever", () => {
		const bin = hungClaude();
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "materialise-root-"));
		made.push(root);

		expect(() =>
			run(root, [bin, "plugin", "marketplace", "add", "x"], {
				timeoutMs: 200,
			}),
		).toThrow(/ETIMEDOUT/);
	});

	it("surfaces a hung marketplace add as a failed materialisePlugin naming the timeout", () => {
		const bin = hungClaude();
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "materialise-root-"));
		made.push(root);

		const result = materialisePlugin({
			root,
			claudeBin: bin,
			addSource: "https://example.invalid/wc.git#v1.0.0",
			pluginId: "workflow-core@wc",
			timeoutMs: 200,
		});

		expect(result.ok).toBe(false);
		expect((result as { reason: string }).reason).toMatch(/ETIMEDOUT/);
	});

	it("a call finishing inside an explicit timeoutMs is unaffected by it", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "materialise-root-"));
		made.push(root);
		const log = path.join(root, "calls.log");
		const claudeBin = stubClaude(log);

		const result = materialisePlugin({
			root,
			claudeBin,
			addSource: "https://example.invalid/wc.git#v1.0.0",
			pluginId: "workflow-core@wc",
			timeoutMs: 5000,
		});

		expect(result.ok).toBe(true);
		expect(fs.readFileSync(log, "utf8").trim().split("\n")).toHaveLength(3);
	});
});

/*
 * The #258 short-circuit. `claude plugin marketplace add --scope project` is
 * refused only where the SAME name is already declared at USER scope with a
 * differing ref — a same-scope rotation (project → project, any ref to any
 * other ref) always succeeds, however stale `plugins/known_marketplaces.json`
 * looks, because it is a last-write cache shared across every project on the
 * config dir, not the thing the CLI actually checks.
 */
function configDirWith(entry: unknown, name = "workflow-core") {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "materialise-config-"));
	made.push(dir);
	fs.writeFileSync(
		path.join(dir, "settings.json"),
		JSON.stringify({
			extraKnownMarketplaces: entry ? { [name]: { source: entry } } : {},
		}),
	);
	return dir;
}

describe("predictedRefConflict (#258)", () => {
	it("is null with no settings.json at all", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "materialise-empty-"));
		made.push(dir);
		expect(
			predictedRefConflict(
				dir,
				"workflow-core",
				"https://github.com/x/y.git#v1.0.0",
			),
		).toBeNull();
	});

	it("is null on an unparseable settings.json", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "materialise-bad-"));
		made.push(dir);
		fs.writeFileSync(path.join(dir, "settings.json"), "{not json");
		expect(
			predictedRefConflict(
				dir,
				"workflow-core",
				"https://github.com/x/y.git#v1.0.0",
			),
		).toBeNull();
	});

	it("is null when the name isn't registered at all", () => {
		const dir = configDirWith(null);
		expect(
			predictedRefConflict(
				dir,
				"workflow-core",
				"https://github.com/x/y.git#v1.0.0",
			),
		).toBeNull();
	});

	it("is null when the registered source carries no string ref", () => {
		const dir = configDirWith({
			source: "url",
			url: "https://x/y.git",
			ref: 42,
		});
		expect(
			predictedRefConflict(dir, "workflow-core", "https://x/y.git#v1.1.11"),
		).toBeNull();
	});

	it("is null for a directory source (no ref to conflict over)", () => {
		const dir = configDirWith({ source: "git", url: "https://x/y.git" });
		expect(
			predictedRefConflict(dir, "workflow-core", "/some/plugin/dir"),
		).toBeNull();
	});

	it("is null for a bare url with no ref, whatever's registered", () => {
		const dir = configDirWith({ source: "git", url: "https://x/y.git" });
		expect(
			predictedRefConflict(dir, "workflow-core", "https://x/y.git"),
		).toBeNull();
	});

	it("is null when the wanted ref matches the one already registered", () => {
		const dir = configDirWith({
			source: "url",
			url: "https://x/y.git",
			ref: "v1.1.11",
		});
		expect(
			predictedRefConflict(dir, "workflow-core", "https://x/y.git#v1.1.11"),
		).toBeNull();
	});

	it("flags a ref-less user-scope git registration against a wanted ref, recording the wanted ref", () => {
		const dir = configDirWith({ source: "git", url: "https://x/y.git" });
		expect(
			predictedRefConflict(dir, "workflow-core", "https://x/y.git#v1.1.11"),
		).toEqual({ existingRef: null, wantedRef: "v1.1.11" });
	});

	it("flags a different ref already registered at user scope, recording both refs", () => {
		const dir = configDirWith({
			source: "url",
			url: "https://x/y.git",
			ref: "v1.1.8",
		});
		expect(
			predictedRefConflict(dir, "workflow-core", "https://x/y.git#v1.1.11"),
		).toEqual({ existingRef: "v1.1.8", wantedRef: "v1.1.11" });
	});

	it("is null against a bare known_marketplaces.json cache with no user-scope settings.json", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "materialise-cache-"));
		made.push(dir);
		fs.mkdirSync(path.join(dir, "plugins"), { recursive: true });
		fs.writeFileSync(
			path.join(dir, "plugins", "known_marketplaces.json"),
			JSON.stringify({
				"workflow-core": { source: { source: "git", url: "https://x/y.git" } },
			}),
		);
		expect(
			predictedRefConflict(dir, "workflow-core", "https://x/y.git#v1.1.11"),
		).toBeNull();
	});
});

describe("predictedRefConflict's source-kind conflict (#342)", () => {
	it("flags a user-scope directory declaration against a url#ref add, by kind, recording the wanted ref and the settings path", () => {
		const dir = configDirWith({ source: "directory", path: "/some/dir" });
		expect(
			predictedRefConflict(dir, "workflow-core", "https://x/y.git#v1.1.11"),
		).toEqual({
			existingKind: "directory",
			wantedRef: "v1.1.11",
			settingsPath: path.join(dir, "settings.json"),
		});
	});

	it("is null where user scope's kind matches and its ref agrees", () => {
		const dir = configDirWith({
			source: "git",
			url: "https://x/y.git",
			ref: "v1.1.11",
		});
		expect(
			predictedRefConflict(dir, "workflow-core", "https://x/y.git#v1.1.11"),
		).toBeNull();
	});

	it("flags a user-scope file declaration by kind too, recording the wanted ref", () => {
		const dir = configDirWith({
			source: "file",
			path: "/some/marketplace.json",
		});
		expect(
			predictedRefConflict(dir, "workflow-core", "https://x/y.git#v1.1.11"),
		).toMatchObject({ existingKind: "file", wantedRef: "v1.1.11" });
	});

	it("is null for a directory declaration under a different name", () => {
		const dir = configDirWith(
			{ source: "directory", path: "/some/dir" },
			"workflow-core-dryrun",
		);
		expect(
			predictedRefConflict(dir, "workflow-core", "https://x/y.git#v1.1.11"),
		).toBeNull();
	});
});

describe("materialisePlugin's #258 short-circuit", () => {
	it("returns ok: false without shelling out, naming the no-ref user-scope state and the wanted ref, with the argv still intact for fixByHand", () => {
		const configDir = configDirWith({
			source: "git",
			url: "https://x/y.git",
		});
		const result = materialisePlugin({
			root: os.tmpdir(),
			claudeBin: "/no/such/claude-binary-258",
			addSource: "https://x/y.git#v1.1.11",
			pluginId: "workflow-core@workflow-core",
			configDir,
		});
		expect(result.ok).toBe(false);
		expect((result as { reason: string }).reason).toContain("#258");
		expect((result as { reason: string }).reason).toContain(
			"none — tracks the default branch",
		);
		expect((result as { reason: string }).reason).toContain("v1.1.11");
		expect(result.marketplaceAdd).toEqual([
			"/no/such/claude-binary-258",
			"plugin",
			"marketplace",
			"add",
			"https://x/y.git#v1.1.11",
			"--scope",
			"project",
		]);
		expect(result.pluginInstall.length).toBeGreaterThan(0);
		expect(result.pluginUpdate.length).toBeGreaterThan(0);
	});

	it("names the actual existing ref, not just its absence, when one is registered", () => {
		const configDir = configDirWith({
			source: "url",
			url: "https://x/y.git",
			ref: "v1.1.8",
		});
		const result = materialisePlugin({
			root: os.tmpdir(),
			claudeBin: "/no/such/claude-binary-258",
			addSource: "https://x/y.git#v1.1.11",
			pluginId: "workflow-core@workflow-core",
			configDir,
		});
		expect(result.ok).toBe(false);
		expect((result as { reason: string }).reason).toContain("v1.1.8");
		expect((result as { reason: string }).reason).toContain("v1.1.11");
	});

	it("refuses a user-scope directory declaration without shelling out, naming the remove step (#342)", () => {
		const configDir = configDirWith({
			source: "directory",
			path: "/some/dir",
		});
		const result = materialisePlugin({
			root: os.tmpdir(),
			claudeBin: "/no/such/claude-binary-342",
			addSource: "https://x/y.git#v1.1.11",
			pluginId: "workflow-core@workflow-core",
			configDir,
		});
		expect(result.ok).toBe(false);
		const { reason } = result as { reason: string };
		expect(reason).toContain("as a directory source");
		expect(reason).toContain("claude plugin marketplace remove workflow-core");
		expect(reason).toContain(path.join(configDir, "settings.json"));
		expect(reason).not.toContain("edit user scope's ref");
		expect(reason).not.toMatch(/ENOENT|no such file/i);
	});

	it("actually attempts the add (an ENOENT on the missing binary, not the #258 short-circuit) when no conflict is predicted", () => {
		const configDir = configDirWith(null);
		const result = materialisePlugin({
			root: os.tmpdir(),
			claudeBin: "/no/such/claude-binary-258",
			addSource: "https://x/y.git#v1.1.11",
			pluginId: "workflow-core@workflow-core",
			configDir,
		});
		expect(result.ok).toBe(false);
		expect((result as { reason: string }).reason).not.toContain("#258");
		expect((result as { reason: string }).reason).toMatch(
			/ENOENT|no such file/i,
		);
	});
});
