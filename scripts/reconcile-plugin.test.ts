// @vitest-environment node
// full-sweep-only: #5528
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	decline,
	readPendingConsent,
	setPendingConsent,
} from "./lib/adopter-consent.js";
import { defineTemplate, identityRepoTemplate } from "./lib/git-fixture";
import { keptSpawn } from "./lib/kept-spawn.js";
import { noop } from "./lib/noop.js";
import { writePsStub } from "./lib/ps-stub";
import { runInProcess } from "./lib/run-in-process.js";
import { shellQuote } from "./lib/sh-quote.js";

const SCRIPT = path.join(__dirname, "reconcile-plugin.js");

let made: string[] = [];

afterEach(() => {
	for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
	made = [];
});

function mkTmp(prefix: string) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	made.push(dir);
	return dir;
}

function writeJson(at: string, doc: unknown) {
	fs.mkdirSync(path.dirname(at), { recursive: true });
	fs.writeFileSync(at, JSON.stringify(doc));
}

const PLUGIN = "workflow-core";
const MARKET = "wc";

const repos = defineTemplate({
	clone: (dir) => {
		execSync("git init -q -b main", { cwd: dir });
		execSync(
			"git -c user.email=t@t -c user.name=t commit -q --allow-empty -m x",
			{ cwd: dir },
		);
	},
	adopter: identityRepoTemplate,
});

function fixture({
	pinRef,
	installedVersion,
	supplyRef = installedVersion ? `v${installedVersion}` : "main",
	url = "https://example.invalid/wc.git",
	configName = "config",
}: {
	pinRef: string;
	installedVersion: string;
	supplyRef?: string;
	url?: string;
	configName?: string;
}) {
	const tmp = mkTmp("wfc-reconcile-plugin-");
	const root = path.join(tmp, "adopter");
	const pluginRoot = path.join(tmp, "plugin");
	const configDir = path.join(tmp, configName);

	writeJson(path.join(pluginRoot, ".claude-plugin", "plugin.json"), {
		name: PLUGIN,
		version: installedVersion,
	});
	repos.instantiate(root, "adopter");
	writeJson(path.join(root, ".claude", "settings.json"), {
		enabledPlugins: { [`${PLUGIN}@${MARKET}`]: true },
		extraKnownMarketplaces: {
			[MARKET]: { source: { source: "url", url, ref: pinRef } },
		},
	});
	const installPath = path.join(
		configDir,
		"plugins/cache",
		MARKET,
		installedVersion,
	);
	writeJson(path.join(configDir, "plugins", "installed_plugins.json"), {
		plugins: {
			[`${PLUGIN}@${MARKET}`]: [
				{ projectPath: root, installPath, version: installedVersion },
			],
		},
	});
	writeJson(path.join(installPath, ".claude-plugin", "plugin.json"), {
		name: PLUGIN,
		version: installedVersion,
	});

	const clone = path.join(configDir, "plugins/marketplaces", MARKET);
	writeJson(path.join(configDir, "plugins", "known_marketplaces.json"), {
		[MARKET]: { source: { source: "url", url }, installLocation: clone },
	});
	repos.instantiate(clone, "clone");
	if (supplyRef !== "main")
		execSync(`git tag ${shellQuote(supplyRef)}`, { cwd: clone });

	execSync("git add -A", { cwd: root });
	execSync("git commit -q -m x", { cwd: root });

	return { tmp, root, pluginRoot, configDir };
}

type Fixture = ReturnType<typeof fixture>;

let stubs = 0;

function claudeStub(
	at: Fixture,
	{
		fail,
		log = path.join(at.tmp, "claude.log"),
	}: { fail?: { on: string; said: string }; log?: string } = {},
) {
	const stub = path.join(at.tmp, `claude-stub-${++stubs}.sh`);
	fs.writeFileSync(
		stub,
		[
			"#!/bin/sh",
			`echo "$PWD :: $CLAUDE_CONFIG_DIR :: $*" >> ${shellQuote(log)}`,
			...(fail
				? [
						`case "$*" in *${shellQuote(fail.on)}*) echo ${shellQuote(fail.said)} >&2; exit 1;; esac`,
					]
				: []),
			"exit 0",
			"",
		].join("\n"),
		{ mode: 0o755 },
	);
	return stub;
}

function readClaudeCalls(at: Fixture) {
	const log = path.join(at.tmp, "claude.log");
	return fs.existsSync(log)
		? fs.readFileSync(log, "utf8").trim().split("\n")
		: [];
}

const readRotations = (at: Fixture) =>
	readClaudeCalls(at).filter((c) =>
		/plugin (?:marketplace add|install|update) /.test(c),
	);

function sessionEnv(at: Fixture, extra: Record<string, string> = {}) {
	const env: Record<string, string | undefined> = {
		...process.env,
		CLAUDE_PROJECT_DIR: at.root,
		CLAUDE_PLUGIN_ROOT: at.pluginRoot,
		CLAUDE_CONFIG_DIR: at.configDir,
		WFC_CLAUDE_CONFIG_A: at.configDir,
		WFC_CLAUDE_CONFIG_B: at.configDir,
		WFC_CLAUDE_CONFIG_C: at.configDir,
		HOME: at.tmp,
		WFC_PS: writePsStub(at.tmp, [], { name: "ps-none.sh" }),
		WFC_PROC: path.join(at.tmp, "no-proc"),
		WFC_CLAUDE_BIN: undefined,
		...extra,
	};
	env.WFC_CLAUDE_BIN ??= claudeStub(at);
	delete env.CLAUDE_PID;
	return env as NodeJS.ProcessEnv;
}

function sessionEnd(at: Fixture, extra: Record<string, string> = {}) {
	const r = runInProcess(SCRIPT, ["--session-end"], {
		env: sessionEnv(at, extra),
	});
	expect(r.status, `reconcile-plugin.js exits 0:\n${r.stderr}`).toBe(0);
	return { ...r, text: r.stdout };
}

function readReportOutcome(at: Fixture) {
	const hit = (
		fs.readdirSync(at.configDir, { recursive: true }) as string[]
	).find((f) => f.endsWith("reconcile-plugin.report.json"));
	return hit
		? JSON.parse(fs.readFileSync(path.join(at.configDir, hit), "utf8")).outcome
		: null;
}

const readConsentOf = (at: Fixture, tag: string) =>
	readPendingConsent(at.root, tag, { configDir: at.configDir });

const pinBytes = (root: string) =>
	JSON.stringify(
		JSON.parse(
			fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8"),
		).extraKnownMarketplaces ?? null,
	);

describe("reconcile-plugin.js --session-end (#247)", () => {
	it("stops before anything else on a declined tag", () => {
		const at = fixture({ pinRef: "v2.0.0", installedVersion: "1.0.0" });
		decline(at.root, "v2.0.0", { configDir: at.configDir });
		setPendingConsent(at.root, "v2.0.0", { configDir: at.configDir });
		const got = sessionEnd(at);
		expect(got.text).toBe("");
		expect(readClaudeCalls(at)).toEqual([]);
		expect(readConsentOf(at, "v2.0.0")).not.toBeNull();
	});

	it("makes no claude call at all where no consent is pending", () => {
		const at = fixture({ pinRef: "v2.0.0", installedVersion: "1.0.0" });
		const got = sessionEnd(at);
		expect(got.text).toBe("");
		expect(got.stderr).toBe("");
		expect(readClaudeCalls(at)).toEqual([]);
		expect(readReportOutcome(at)).toBeNull();
	});

	it("says nothing at all for an adopter carrying no pin", () => {
		const at = fixture({ pinRef: "v2.0.0", installedVersion: "1.0.0" });
		writeJson(path.join(at.root, ".claude", "settings.json"), {});
		expect(sessionEnd(at).text).toBe("");
		expect(readReportOutcome(at)).toBeNull();
	});

	it("defers on a live neighbour, naming it, and leaves the consent standing", () => {
		const at = fixture({ pinRef: "v2.0.0", installedVersion: "1.0.0" });
		setPendingConsent(at.root, "v2.0.0", { configDir: at.configDir });
		const procs = procFixture(at, [
			{ pid: "4242", args: "claude", configDir: at.configDir },
		]);
		const got = sessionEnd(at, procs);
		expect(got.text).toContain("deferring the v2.0.0 materialise");
		expect(got.text).toContain("(pid 4242)");
		expect(got.text).toContain("next session's exit");
		expect(readRotations(at)).toEqual([]);
		expect(readConsentOf(at, "v2.0.0")).not.toBeNull();
		expect(readReportOutcome(at)).toBe("OK");
	});

	it("emits the contention report before the rotation it describes, and rotates anyway", () => {
		const at = fixture({
			pinRef: "v2.0.0",
			installedVersion: "1.0.0",
			supplyRef: "v1.5.0",
		});
		setPendingConsent(at.root, "v2.0.0", { configDir: at.configDir });
		const out = path.join(at.tmp, "stdout.log");
		const fd = fs.openSync(out, "a");
		try {
			keptSpawn("fd").execFileSync(
				process.execPath,
				[SCRIPT, "--session-end"],
				{
					stdio: ["ignore", fd, "pipe"],
					env: sessionEnv(at, { WFC_CLAUDE_BIN: claudeStub(at, { log: out }) }),
				},
			);
		} finally {
			fs.closeSync(fd);
		}
		const events = fs.readFileSync(out, "utf8").trim().split("\n");
		expect(events[0]).toContain("v1.5.0");
		expect(events[0]).toContain("Rotating anyway");
		expect(events[1]).toContain(
			"plugin marketplace add https://example.invalid/wc.git#v2.0.0",
		);
		expect(events.join("\n")).toContain("materialised v2.0.0");
	});

	it("threads the config dir, the root and the pinned url#ref through the materialise, and clears the consent", () => {
		const at = fixture({ pinRef: "v2.0.0", installedVersion: "1.0.0" });
		setPendingConsent(at.root, "v2.0.0", { configDir: at.configDir });
		const got = sessionEnd(at);
		const [add, install] = readRotations(at);
		expect(add).toBe(
			`${at.root} :: ${at.configDir} :: plugin marketplace add https://example.invalid/wc.git#v2.0.0 --scope project`,
		);
		expect(install).toContain(`plugin install ${PLUGIN}@${MARKET} -y`);
		expect(readConsentOf(at, "v2.0.0")).toBeNull();
		expect(got.text).toContain("materialised v2.0.0");
		expect(got.text).toContain(`the next session in ${at.root} runs v2.0.0`);
		expect(readReportOutcome(at)).toBe("OK");
	});

	it("runs the three calls in order, then measures the core's context cost (#679)", () => {
		const at = fixture({ pinRef: "v2.0.0", installedVersion: "1.0.0" });
		setPendingConsent(at.root, "v2.0.0", { configDir: at.configDir });
		sessionEnd(at);
		const ran = readClaudeCalls(at);
		expect(ran).toHaveLength(4);
		expect(ran[0]).toContain(
			"plugin marketplace add https://example.invalid/wc.git#v2.0.0 --scope project",
		);
		expect(ran[1]).toContain(`plugin install ${PLUGIN}@${MARKET} -y`);
		expect(ran[2]).toContain(`plugin update ${PLUGIN}@${MARKET}`);
		expect(ran[3]).toContain(`plugin details ${PLUGIN}@${MARKET}`);
		for (const line of ran) expect(line.split(" :: ")[1]).toBe(at.configDir);
	});

	it("leaves the consent standing while the walk defers on a dirty tree, and clears it once the tree is clean (#249)", () => {
		const at = fixture({ pinRef: "v1.0.0", installedVersion: "1.0.0" });
		setPendingConsent(at.root, "v1.0.0", { configDir: at.configDir });
		fs.writeFileSync(path.join(at.root, "scratch.txt"), "not committed");

		const dirty = sessionEnd(at);
		expect(dirty.text).toMatch(/not clean/);
		expect(dirty.text).toMatch(/consent stands/);
		expect(readConsentOf(at, "v1.0.0")).not.toBeNull();

		fs.rmSync(path.join(at.root, "scratch.txt"));
		const clean = sessionEnd(at);
		expect(clean.text).toContain("the next session in");
		expect(readRotations(at)).toEqual([]);
		expect(readConsentOf(at, "v1.0.0")).toBeNull();
	});

	it("leaves the consent in place when the materialise fails", () => {
		const at = fixture({ pinRef: "v2.0.0", installedVersion: "1.0.0" });
		setPendingConsent(at.root, "v2.0.0", { configDir: at.configDir });
		const got = sessionEnd(at, {
			WFC_CLAUDE_BIN: claudeStub(at, {
				fail: { on: "marketplace add", said: "no such ref" },
			}),
		});
		expect(got.text).toContain("materialising v2.0.0 FAILED — no such ref");
		expect(got.text).toContain("Finish by hand:");
		expect(readConsentOf(at, "v2.0.0")).not.toBeNull();
		expect(readReportOutcome(at)).toBe("WARN");
	});

	it("leaves the consent in place when only the update fails", () => {
		const at = fixture({ pinRef: "v2.0.0", installedVersion: "1.0.0" });
		setPendingConsent(at.root, "v2.0.0", { configDir: at.configDir });
		const got = sessionEnd(at, {
			WFC_CLAUDE_BIN: claudeStub(at, {
				fail: { on: "plugin update", said: "network down" },
			}),
		});
		expect(got.text).toContain("the update after it FAILED — network down");
		expect(readConsentOf(at, "v2.0.0")).not.toBeNull();
		expect(readReportOutcome(at)).toBe("WARN");
	});

	it("leaves the pin byte-identical on every path", () => {
		for (const fail of [
			undefined,
			{ on: "plugin update", said: "x" },
			{ on: "marketplace add", said: "y" },
		]) {
			const at = fixture({ pinRef: "v2.0.0", installedVersion: "1.0.0" });
			setPendingConsent(at.root, "v2.0.0", { configDir: at.configDir });
			const before = pinBytes(at.root);
			sessionEnd(at, { WFC_CLAUDE_BIN: claudeStub(at, { fail }) });
			expect(pinBytes(at.root)).toEqual(before);
		}
		const stoppers: [RegExp, (at: Fixture) => void][] = [
			[/^$/, (at) => decline(at.root, "v3.0.0", { configDir: at.configDir })],
			[/^$/, noop],
			[
				/^$/,
				(at) => writeJson(path.join(at.root, ".claude", "settings.json"), {}),
			],
			[
				/names no url/,
				(at) => {
					setPendingConsent(at.root, "v3.0.0", { configDir: at.configDir });
					writeJson(path.join(at.root, ".claude", "settings.json"), {
						enabledPlugins: { [`${PLUGIN}@${MARKET}`]: true },
						extraKnownMarketplaces: {
							[MARKET]: { source: { source: "url", ref: "v3.0.0" } },
						},
					});
				},
			],
		];
		for (const [said, arrange] of stoppers) {
			const at = fixture({ pinRef: "v3.0.0", installedVersion: "1.0.0" });
			arrange(at);
			const before = pinBytes(at.root);
			expect(sessionEnd(at).text.trim()).toMatch(said);
			expect(readRotations(at)).toEqual([]);
			expect(pinBytes(at.root)).toEqual(before);
		}

		const busy = fixture({ pinRef: "v3.0.0", installedVersion: "1.0.0" });
		setPendingConsent(busy.root, "v3.0.0", { configDir: busy.configDir });
		const beforeBusy = pinBytes(busy.root);
		const procs = procFixture(busy, [
			{ pid: "7", args: "claude", configDir: busy.configDir },
			{ pid: "8", args: "claude", configDir: busy.configDir },
		]);
		expect(sessionEnd(busy, procs).text).toContain("(pid 7, 8)");
		expect(pinBytes(busy.root)).toEqual(beforeBusy);
	});
});

describe("reconcile-plugin.js leaves the supply alone once the install is at the pin (#747)", () => {
	it("still materialises an install off the pin, and leaves the consent standing while the walk defers on a dirty tree", () => {
		const at = fixture({ pinRef: "v2.0.0", installedVersion: "1.0.0" });
		setPendingConsent(at.root, "v2.0.0", { configDir: at.configDir });
		fs.writeFileSync(path.join(at.root, "scratch.txt"), "not committed");
		const got = sessionEnd(at);
		expect(
			readRotations(at).filter((c) => c.includes("marketplace add")),
		).toHaveLength(1);
		expect(got.text).toContain("materialised v2.0.0");
		expect(got.text).toMatch(/not clean/);
		expect(readConsentOf(at, "v2.0.0")).not.toBeNull();
	});

	it("never calls materialise, and still runs the walk and clears the consent", () => {
		const at = fixture({
			pinRef: "v1.0.0",
			installedVersion: "1.0.0",
			supplyRef: "v0.9.0",
		});
		setPendingConsent(at.root, "v1.0.0", { configDir: at.configDir });
		installWalker(
			at.configDir,
			`exports.walkAndCommit = (at) => { at.out("stub walker ran"); return { action: "committed", lines: [] }; };\n`,
		);
		const got = sessionEnd(at);
		expect(readRotations(at)).toEqual([]);
		expect(got.text).toContain("already installed at v1.0.0");
		expect(got.text).not.toContain("v0.9.0");
		expect(got.text).toContain("stub walker ran");
		expect(readConsentOf(at, "v1.0.0")).toBeNull();
	});

	function walkOnly() {
		const at = fixture({ pinRef: "v1.0.0", installedVersion: "1.0.0" });
		setPendingConsent(at.root, "v1.0.0", { configDir: at.configDir });
		installWalker(
			at.configDir,
			`exports.walkAndCommit = (at) => { at.out("stub walker ran"); return { action: "committed", lines: [] }; };\n`,
		);
		return at;
	}

	it("walks past sessions under its own config dir that work elsewhere, and a linked worktree's (#5286)", () => {
		const at = walkOnly();
		const worktree = path.join(at.root, ".claude", "worktrees", "w");
		fs.mkdirSync(worktree, { recursive: true });
		fs.writeFileSync(path.join(worktree, ".git"), "gitdir: x\n");
		const procs = procFixture(at, [
			{ pid: "500", args: "claude", configDir: at.configDir, cwd: at.tmp },
			{ pid: "501", args: "claude", configDir: at.configDir, cwd: worktree },
		]);
		const got = sessionEnd(at, procs);
		expect(got.text).not.toContain("deferring");
		expect(got.text).toContain("stub walker ran");
		expect(readConsentOf(at, "v1.0.0")).toBeNull();
	});

	it("clears the consent where an in-session walk already landed, and walks nothing again (#5286)", () => {
		const at = fixture({ pinRef: "v1.0.0", installedVersion: "1.0.0" });
		setPendingConsent(at.root, "v1.0.0", { configDir: at.configDir });
		installWalker(
			at.configDir,
			`exports.walkAndCommit = () => ({ action: "up-to-date", lines: [] });\n`,
		);
		const got = sessionEnd(at);
		expect(got.text).toContain("the next session in");
		expect(readConsentOf(at, "v1.0.0")).toBeNull();
	});

	it("defers on a session in this checkout under any config dir, or one whose cwd cannot be read (#5286)", () => {
		const at = walkOnly();
		const sub = path.join(at.root, ".claude");
		const procs = procFixture(at, [
			{
				pid: "600",
				args: "claude",
				configDir: path.join(at.tmp, "o"),
				cwd: sub,
			},
			{ pid: "601", args: "claude", configDir: path.join(at.tmp, "o") },
		]);
		const got = sessionEnd(at, procs);
		expect(got.text).toContain("deferring the v1.0.0 migration walk");
		expect(got.text).toContain("(pid 600, 601)");
		expect(got.text).not.toContain("stub walker ran");
		expect(readConsentOf(at, "v1.0.0")).not.toBeNull();
	});
});

function installWalker(configDir: string, body: string) {
	const installPath = path.join(configDir, "plugins/cache", MARKET, "1.0.0");
	const at = path.join(installPath, "scripts", "lib", "walk-and-commit.js");
	fs.mkdirSync(path.dirname(at), { recursive: true });
	fs.writeFileSync(at, body);
	return installPath;
}

describe("reconcile-plugin.js's walker is the fresh install's own (#682)", () => {
	const endWithConsent = (at: Fixture, extra: Record<string, string> = {}) => {
		setPendingConsent(at.root, "v1.0.0", { configDir: at.configDir });
		return sessionEnd(at, extra);
	};

	it("loads the walker from installPath and hands it plain values and its out callback only", () => {
		const at = fixture({ pinRef: "v1.0.0", installedVersion: "1.0.0" });
		const log = path.join(at.tmp, "walker-args.json");
		const installPath = installWalker(
			at.configDir,
			`exports.walkAndCommit = (at) => {
	const seen = {};
	for (const [k, v] of Object.entries(at)) seen[k] = typeof v === "function" ? "function" : v;
	require("node:fs").writeFileSync(${JSON.stringify(log)}, JSON.stringify(seen));
	at.out("stub walker ran");
	return { action: "committed", lines: [] };
};\n`,
		);
		const stub = claudeStub(at);
		const got = endWithConsent(at, { WFC_CLAUDE_BIN: stub });
		expect(got.text).toContain("install's own walker");
		expect(got.text).toContain("stub walker ran");
		const seen = JSON.parse(fs.readFileSync(log, "utf8"));
		expect(Object.keys(seen).sort()).toEqual([
			"claudeBin",
			"configDir",
			"out",
			"pluginRoot",
			"root",
		]);
		expect(seen).toEqual({
			root: at.root,
			pluginRoot: installPath,
			configDir: at.configDir,
			out: "function",
			claudeBin: stub,
		});
		expect(readConsentOf(at, "v1.0.0")).toBeNull();
	});

	it("falls back to the bundled walker, saying so, where the install carries none", () => {
		const at = fixture({ pinRef: "v1.0.0", installedVersion: "1.0.0" });
		const { text } = endWithConsent(at);
		expect(text).toMatch(
			/bundled walker, \S+scripts\/lib\/walk-and-commit\.js/,
		);
		expect(text).toContain("could not be used (no ");
		expect(text).toContain("migration walk: committed");
	});

	it("falls back to the bundled walker, saying so, where loading the install's throws", () => {
		const at = fixture({ pinRef: "v1.0.0", installedVersion: "1.0.0" });
		installWalker(at.configDir, 'throw new Error("broken release");\n');
		const { text } = endWithConsent(at);
		expect(text).toContain("bundled walker");
		expect(text).toContain("threw: broken release");
		expect(text).toContain("migration walk: committed");
	});

	it("keeps the fallback to one line where the load error spans several", () => {
		const at = fixture({ pinRef: "v1.0.0", installedVersion: "1.0.0" });
		installWalker(at.configDir, 'require("./missing-lib.js");\n');
		const line = endWithConsent(at)
			.text.split("\n")
			.find((l) => l.includes("bundled walker"));
		expect(line).toContain("threw: Cannot find module './missing-lib.js'");
	});
});

function procFixture(
	at: Fixture,
	rows: {
		pid: string;
		args: string;
		configDir?: string;
		ppid?: string;
		cwd?: string;
	}[],
) {
	const proc = path.join(at.tmp, "proc");
	const ps = writePsStub(
		at.tmp,
		rows.map((r) => `${r.pid} ${r.args}`),
		{ name: "ps.sh" },
	);
	for (const r of rows) {
		const dir = path.join(proc, r.pid);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "environ"),
			r.configDir
				? `PATH=/bin\0CLAUDE_CONFIG_DIR=${r.configDir}\0`
				: "PATH=/bin\0",
		);
		fs.writeFileSync(
			path.join(dir, "stat"),
			`${r.pid} (claude) S ${r.ppid ?? "1"} ${"0 ".repeat(50).trim()}\n`,
		);
		if (r.cwd) fs.symlinkSync(r.cwd, path.join(dir, "cwd"));
	}
	return { WFC_PS: ps, WFC_PROC: proc };
}

describe("reconcile-plugin.js's live-session count (#247)", () => {
	function consenting(configName?: string) {
		const at = fixture({
			pinRef: "v2.0.0",
			installedVersion: "1.0.0",
			configName,
		});
		setPendingConsent(at.root, "v2.0.0", { configDir: at.configDir });
		return at;
	}

	it("reads argv[0], so a versioned binary counts and a mere mention does not", () => {
		const at = consenting();
		const procs = procFixture(
			at,
			[
				{ pid: "100", args: "claude --resume" },
				{
					pid: "101",
					args: "/home/x/.local/share/claude/versions/2.1.278 -p hi",
				},
				{
					pid: "102",
					args: "grep -r claude /home/x/.local/share/claude/versions/",
				},
				{ pid: "103", args: "node scripts/reconcile-plugin.js --session-end" },
			].map((r) => ({ ...r, configDir: at.configDir })),
		);
		const got = sessionEnd(at, procs);
		expect(got.text).toContain("2 other Claude session(s)");
		expect(got.text).toContain("(pid 100, 101)");
		expect(readRotations(at)).toEqual([]);
	});

	it("counts only the sessions under the same config dir, excluding this one's own ancestry", () => {
		const at = consenting();
		const other = path.join(at.tmp, "other-config");
		const self = String(process.pid);
		const procs = procFixture(at, [
			{ pid: "200", args: "claude", configDir: at.configDir },
			{ pid: "201", args: "claude", configDir: other },
			{ pid: "202", args: "claude", configDir: at.configDir, ppid: "1" },
			{ pid: self, args: "claude", configDir: at.configDir, ppid: "202" },
		]);
		const got = sessionEnd(at, procs);
		expect(got.text).toContain("1 other Claude session(s)");
		expect(got.text).toContain("(pid 200)");
	});

	it("rotates where the only sessions live are this one's own ancestry and another config dir's", () => {
		const at = consenting();
		const self = String(process.pid);
		const procs = procFixture(at, [
			{ pid: "201", args: "claude", configDir: path.join(at.tmp, "other") },
			{ pid: "202", args: "claude", configDir: at.configDir, ppid: "1" },
			{ pid: self, args: "claude", configDir: at.configDir, ppid: "202" },
		]);
		const got = sessionEnd(at, procs);
		expect(got.text).not.toContain("deferring");
		expect(
			readRotations(at).filter((c) => c.includes("marketplace add")),
		).toHaveLength(1);
	});

	it("counts a process whose environ cannot be read, rather than assuming it is somebody else's", () => {
		const at = consenting();
		const procs = procFixture(at, [
			{ pid: "300", args: "claude", configDir: path.join(at.tmp, "other") },
		]);
		fs.rmSync(path.join(procs.WFC_PROC, "300", "environ"));
		expect(sessionEnd(at, procs).text).toContain("(pid 300)");
	});

	function sparePair(at: Fixture, spareCwd: string) {
		const dir = "/tmp/cc-daemon-1000/abc/spare";
		const bin = "/home/x/.local/share/claude/versions/2.1.312";
		return [
			{ pid: "500", args: "claude daemon run" },
			{
				pid: "501",
				args: `${bin} bg-pty-host --bg-pty-host ${dir}/k7Q2.pty.sock 200 50`,
				ppid: "500",
			},
			{
				pid: "502",
				args: `claude bg-spare --bg-spare ${dir}/k7Q2.claim.sock`,
				ppid: "501",
				cwd: spareCwd,
			},
		].map((r) => ({ ...r, configDir: at.configDir }));
	}

	it("rotates where the only other Claude processes are the daemon and its idle spare pair (#4741)", () => {
		const at = consenting();
		const procs = procFixture(
			at,
			sparePair(at, "/tmp/cc-daemon-1000/abc/spare"),
		);
		const got = sessionEnd(at, procs);
		expect(got.text).not.toContain("deferring");
		expect(
			readRotations(at).filter((c) => c.includes("marketplace add")),
		).toHaveLength(1);
	});

	it("defers on a claimed spare pair, counting it one session and naming both halves (#4741)", () => {
		const at = consenting();
		const procs = procFixture(at, sparePair(at, at.root));
		const got = sessionEnd(at, procs);
		expect(got.text).toContain("1 other Claude session(s)");
		expect(got.text).toContain("(pid 501+502)");
		expect(readRotations(at)).toEqual([]);
	});

	it("falls back to ~/.claude for a session that exported no config dir", () => {
		const at = consenting(".claude");
		const procs = procFixture(at, [
			{ pid: "400", args: "claude" },
			{ pid: "401", args: "claude", configDir: path.join(at.tmp, "other") },
		]);
		const got = sessionEnd(at, procs);
		expect(got.text).toContain("1 other Claude session(s)");
		expect(got.text).toContain("(pid 400)");
	});
});

describe("reconcile-plugin.js's command line", () => {
	function handRun(at: Fixture) {
		const env = sessionEnv(at);
		delete env.CLAUDE_PLUGIN_ROOT;
		const r = runInProcess(SCRIPT, ["--session-end"], { env });
		expect(r.status).toBe(0);
		return r;
	}

	it.each([
		["no-plugin", "set CLAUDE_PLUGIN_ROOT", null],
		[
			"no-pin",
			"pins no git-sourced plugin",
			(at: Fixture) =>
				writeJson(path.join(at.root, ".claude", "settings.json"), {}),
		],
		[
			"declined",
			"declined the pinned tag",
			(at: Fixture) => decline(at.root, "v2.0.0", { configDir: at.configDir }),
		],
		["no-consent", "no consent is pending", null],
	])(
		"says on stderr why a hand run stopped at %s (#4741)",
		(stop, why, arrange) => {
			const at = fixture({ pinRef: "v2.0.0", installedVersion: "1.0.0" });
			if (stop !== "no-plugin")
				fs.cpSync(
					path.join(at.pluginRoot, ".claude-plugin"),
					path.join(at.root, ".claude-plugin"),
					{ recursive: true },
				);
			if (stop !== "no-consent")
				setPendingConsent(at.root, "v2.0.0", { configDir: at.configDir });
			arrange?.(at);
			const r = handRun(at);
			expect(r.stderr).toContain("reconcile-plugin: stopped — ");
			expect(r.stderr).toContain(why);
			expect(r.stdout).toBe("");
			expect(readClaudeCalls(at)).toEqual([]);
			expect(readReportOutcome(at)).toBeNull();
		},
	);

	it("does nothing at all without the flag", () => {
		const at = fixture({ pinRef: "v2.0.0", installedVersion: "1.0.0" });
		setPendingConsent(at.root, "v2.0.0", { configDir: at.configDir });
		const r = runInProcess(SCRIPT, [], { env: sessionEnv(at) });
		expect(r.stdout).toBe("");
		expect(r.status).toBe(0);
		expect(readClaudeCalls(at)).toEqual([]);
		expect(readConsentOf(at, "v2.0.0")).not.toBeNull();
	});
});
