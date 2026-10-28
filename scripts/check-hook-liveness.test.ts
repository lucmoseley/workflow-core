// @vitest-environment node
/*
 * Pins that check-hook-liveness.js reports a hook that is wired and does not
 * run (mantahostels#1898, decided at mantahostels#1895): a census of failing
 * hooks over the transcripts, a plugin cache manifest that wires nothing, a
 * registered hook command that resolves to no runnable file, and a reap that died
 * mid-run.
 *
 * Every test drives the real script, most through lib/run-in-process.js's
 * in-process seam rather than a subprocess (mantahostels#1945) — with every config dir
 * and the project root pointed inside the case's own temp dir either way, so
 * no run can read the founder's live transcripts, plugin cache or
 * settings.json, nor the census the live core's hooks, and no run can write a
 * notify stamp into the real state directory.
 *
 * An ordinary silent pass leaves NO transcript record at all, so a hook that is
 * fine is represented here by no records rather than by success records.
 *
 * Its self-plugin assertion is a hard gate in .husky/pre-commit, and the rest
 * report through `npm run status`: loosen a case and a dangling hook command
 * lands, or a hook failing at every session start goes on failing unnamed.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";
import { useScratchCore } from "./lib/scratch-core-testkit";

const SCRIPT = path.join(__dirname, "check-hook-liveness.js");

/** The first config dir, standing in for this machine's first Claude plan. */
let dir: string;
/** The second, so a case can prove the union across plans is read. */
let second: string;
/** The repo the hooks belong to. */
let repo: string;

beforeEach(() => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "check-hook-liveness-"));
	dir = path.join(root, "one");
	second = path.join(root, "two");
	repo = path.join(root, "repo");
	for (const d of [dir, second, repo]) fs.mkdirSync(d, { recursive: true });
});

afterEach(() => {
	fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

const run = (...args: string[]) => runUnder(dir, ...args);

/** Extra environment for the run in flight, set only by `runWithEnv`. */
let envExtra: Record<string, string> = {};

/**
 * The same run, with extra environment on top — for a seam the script reads
 * only from the environment, such as the census budget's (mantahostels#2035). Restored
 * after the call, so no case leaks its seam into the next.
 */
function runWithEnv(extra: Record<string, string>, ...args: string[]) {
	envExtra = extra;
	try {
		return run(...args);
	} finally {
		envExtra = {};
	}
}

/** The same run, as the plan whose config dir is `cfg`. */
const runUnder = (cfg: string, ...args: string[]) => runFor(repo, cfg, ...args);

/** The same run again, against a project root of the case's own choosing. */
function runFor(root: string, cfg: string, ...args: string[]) {
	const res = runInProcess(SCRIPT, args, {
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: root,
			CLAUDE_CONFIG_DIR: cfg,
			// Every plan named explicitly, or _C's default IS a sibling of the real
			// temp root and a case would sweep it in.
			WFC_CLAUDE_CONFIG_A: dir,
			WFC_CLAUDE_CONFIG_B: second,
			WFC_CLAUDE_CONFIG_C: second,
			CLAUDE_CODE_SESSION_ID: "",
			// Unset, or a run under CI writes every WARN's message to stdout as a
			// ::warning:: annotation and a test of the say passes without it.
			GITHUB_ACTIONS: "",
			...envExtra,
		},
	});
	return { ...res, out: `${res.stdout}${res.stderr}` };
}

/**
 * Where a config dir keeps this project's transcripts, spelled as the HARNESS
 * spells it — every non-alphanumeric a hyphen — rather than by calling the
 * script's own slug, which is the thing under test (mantahostels#1963).
 */
const projectDir = (cfg: string, root = repo) =>
	path.join(cfg, "projects", root.replace(/[^a-zA-Z0-9]/g, "-"));

/** One transcript attachment record, as the harness writes it. */
function record(type: string, command: string, agoDays = 0) {
	return JSON.stringify({
		parentUuid: null,
		type: "attachment",
		attachment: { type, hookEvent: "SessionStart", command },
		timestamp: new Date(Date.now() - agoDays * 86_400_000).toISOString(),
	});
}

/** A transcript file. `session` names it, so a case can append to it later. */
function transcript(
	cfg: string,
	session: string,
	lines: string[],
	{ append = false } = {},
) {
	const at = path.join(projectDir(cfg), `${session}.jsonl`);
	fs.mkdirSync(path.dirname(at), { recursive: true });
	const body = `${lines.join("\n")}\n`;
	if (append) fs.appendFileSync(at, body);
	else fs.writeFileSync(at, body);
	return at;
}

const failures = (command: string, n: number, agoDays = 0) =>
	Array.from({ length: n }, () => record("hook_cancelled", command, agoDays));
const successes = (command: string, n: number) =>
	Array.from({ length: n }, () => record("hook_success", command));

/**
 * Failure records carrying no `command` at all — the shape every PostToolUse
 * cancellation has, and the one the census cannot attribute to any hook (mantahostels#2296).
 */
const bare = (n: number, agoDays = 0, type = "hook_cancelled") =>
	Array.from({ length: n }, () =>
		JSON.stringify({
			parentUuid: null,
			type: "attachment",
			attachment: { type, hookEvent: "PostToolUse" },
			timestamp: new Date(Date.now() - agoDays * 86_400_000).toISOString(),
		}),
	);

/**
 * A settings.json with one hook per entry given. A bare string is the command;
 * an object carries whatever else the entry has, `args` above all — the key the
 * exec form adds (mantahostels#2107).
 */
function settings(commands: Array<string | Record<string, unknown>>) {
	const at = path.join(repo, ".claude", "settings.json");
	fs.mkdirSync(path.dirname(at), { recursive: true });
	fs.writeFileSync(
		at,
		JSON.stringify({
			hooks: {
				PreToolUse: [
					{
						matcher: "Bash",
						hooks: commands.map((c) =>
							typeof c === "string" ? { command: c } : c,
						),
					},
				],
			},
		}),
	);
	return at;
}

/** A settings.json wiring `commands` as persisting, async SessionStart producers. */
function asyncSettings(commands: string[]) {
	const at = path.join(repo, ".claude", "settings.json");
	fs.mkdirSync(path.dirname(at), { recursive: true });
	fs.writeFileSync(
		at,
		JSON.stringify({
			hooks: {
				SessionStart: [
					{ hooks: commands.map((command) => ({ command, async: true })) },
				],
			},
		}),
	);
	return at;
}

/** A script under the repo's scripts/, executable or not. */
function script(name: string, { executable = true } = {}) {
	const at = path.join(repo, "scripts", name);
	fs.mkdirSync(path.dirname(at), { recursive: true });
	fs.writeFileSync(at, "#!/bin/sh\nexit 0\n");
	fs.chmodSync(at, executable ? 0o755 : 0o644);
	return at;
}

/**
 * A plugin installed under `cfg`, with a cached hooks.json and a marketplace
 * that declares one. Either may be null, meaning the file is absent.
 *
 * The marketplace is a plain directory rather than a git checkout, so the
 * comparison falls back to the checkout as it stands. `git` passes the pinned
 * commit instead.
 */
function plugin(
	cfg: string,
	{
		name = "demo",
		marketplace = "market",
		cached,
		upstream,
		git = false,
	}: {
		name?: string;
		marketplace?: string;
		cached: string | null;
		upstream: string | null;
		/** Commit the marketplace and pin the entry to that sha. */
		git?: boolean;
	},
) {
	const plugins = path.join(cfg, "plugins");
	const installPath = path.join(plugins, "cache", marketplace, name, "1.0.0");
	const marketDir = path.join(plugins, "marketplaces", marketplace);

	// Merged with whatever this marketplace already declares, so a second call
	// naming the same marketplace ADDS a plugin rather than replacing the first.
	const marketAt = path.join(marketDir, ".claude-plugin", "marketplace.json");
	let marketDoc: {
		name: string;
		plugins: Array<{ name: string; source: string }>;
	};
	try {
		marketDoc = JSON.parse(fs.readFileSync(marketAt, "utf8"));
	} catch {
		marketDoc = { name: marketplace, plugins: [] };
	}
	marketDoc.plugins = marketDoc.plugins
		.filter((p) => p.name !== name)
		.concat({ name, source: "./" });
	fs.mkdirSync(path.join(marketDir, ".claude-plugin"), { recursive: true });
	fs.writeFileSync(marketAt, JSON.stringify(marketDoc));
	if (upstream !== null) {
		fs.mkdirSync(path.join(marketDir, "hooks"), { recursive: true });
		fs.writeFileSync(path.join(marketDir, "hooks", "hooks.json"), upstream);
	}
	if (cached !== null) {
		fs.mkdirSync(path.join(installPath, "hooks"), { recursive: true });
		fs.writeFileSync(path.join(installPath, "hooks", "hooks.json"), cached);
	}
	let gitCommitSha: string | undefined;
	if (git) {
		const marketGit = (...args: string[]) =>
			spawnSync("git", ["-C", marketDir, ...args], { encoding: "utf8" });
		marketGit("init", "-q");
		marketGit("config", "user.email", "t@example.invalid");
		marketGit("config", "user.name", "t");
		marketGit("add", "-A");
		marketGit("commit", "-q", "-m", "fixture");
		gitCommitSha = marketGit("rev-parse", "HEAD").stdout.trim();
	}
	const installedAt = path.join(plugins, "installed_plugins.json");
	let installedDoc: { version: number; plugins: Record<string, unknown> };
	try {
		installedDoc = JSON.parse(fs.readFileSync(installedAt, "utf8"));
	} catch {
		installedDoc = { version: 2, plugins: {} };
	}
	installedDoc.plugins[`${name}@${marketplace}`] = [
		{ scope: "project", projectPath: repo, installPath, gitCommitSha },
	];
	fs.writeFileSync(installedAt, JSON.stringify(installedDoc));
}

/**
 * Enables `key` (`"<plugin>@<marketplace>"`) in the repo's own committed
 * `.claude/settings.json`, merged onto whatever that file already holds —
 * one of the files `readEnabledPluginsFor()` merges for the plugin-hosted checks
 * (mantahostels#3515 F9).
 */
function enablePlugin(key: string) {
	const at = path.join(repo, ".claude", "settings.json");
	let doc: Record<string, unknown> = {};
	try {
		doc = JSON.parse(fs.readFileSync(at, "utf8"));
	} catch {
		// No settings.json yet — start from an empty one.
	}
	doc.enabledPlugins = {
		...(doc.enabledPlugins as Record<string, unknown> | undefined),
		[key]: true,
	};
	fs.mkdirSync(path.dirname(at), { recursive: true });
	fs.writeFileSync(at, JSON.stringify(doc));
}

/**
 * A `directory`-sourced marketplace: `known_marketplaces.json` names it with
 * `source.source === "directory"` and an `installLocation` that is a plain
 * directory holding its own `.claude-plugin/marketplace.json` — never a
 * clone under `plugins/marketplaces/<name>/`, which this fixture does not
 * create (mantahostels#3515 F9's premise: a directory marketplace never has one).
 */
function directoryMarketplace(cfg: string, marketplace: string, at: string) {
	const known = path.join(cfg, "plugins", "known_marketplaces.json");
	let doc: Record<string, unknown> = {};
	try {
		doc = JSON.parse(fs.readFileSync(known, "utf8"));
	} catch {
		// No known_marketplaces.json yet.
	}
	doc[marketplace] = {
		source: { source: "directory", path: at },
		installLocation: at,
	};
	fs.mkdirSync(path.dirname(known), { recursive: true });
	fs.writeFileSync(known, JSON.stringify(doc));
}

/**
 * A plugin installed under `cfg`, with a real `${CLAUDE_PLUGIN_ROOT}`-rooted
 * hooks.json on both sides (upstream and cache), for the drop/liveness checks
 * to walk.
 *
 * `hookEntries` is `[event, command]` pairs; `cachedHookEntries` defaults to
 * the same set, so a case names only what it wants to differ.
 */
function pluginWithHooks(
	cfg: string,
	{
		name = "demo",
		marketplace = "market",
		marketplaceDir,
		hookEntries,
		cachedHookEntries = hookEntries,
	}: {
		name?: string;
		marketplace?: string;
		/** Where the marketplace's own tree lives, for a directory source. */
		marketplaceDir?: string;
		hookEntries: [string, string][];
		cachedHookEntries?: [string, string][];
	},
) {
	const manifestOf = (entries: [string, string][]) => {
		const hooks: Record<
			string,
			Array<{ hooks: Array<{ command: string }> }>
		> = {};
		for (const [event, command] of entries) {
			if (!hooks[event]) hooks[event] = [];
			hooks[event].push({ hooks: [{ command }] });
		}
		return JSON.stringify({ hooks });
	};
	plugin(cfg, {
		name,
		marketplace,
		cached: manifestOf(cachedHookEntries),
		upstream: manifestOf(hookEntries),
	});
	if (marketplaceDir) {
		// `plugin()` always writes the marketplace tree under
		// `plugins/marketplaces/<marketplace>/` — move it to the directory
		// source's own path, which is where `resolveMarketplaceDir` looks once
		// `directoryMarketplace()` is also called.
		const from = path.join(cfg, "plugins", "marketplaces", marketplace);
		fs.mkdirSync(path.dirname(marketplaceDir), { recursive: true });
		fs.rmSync(marketplaceDir, { recursive: true, force: true });
		fs.renameSync(from, marketplaceDir);
	}
	return path.join(cfg, "plugins", "cache", marketplace, name, "1.0.0");
}

/** A script under a plugin's installed cache root, executable or not. */
function pluginScript(
	installPath: string,
	rel: string,
	{ executable = true } = {},
) {
	const at = path.join(installPath, rel);
	fs.mkdirSync(path.dirname(at), { recursive: true });
	fs.writeFileSync(at, "#!/bin/sh\nexit 0\n");
	fs.chmodSync(at, executable ? 0o755 : 0o644);
	return at;
}

/**
 * The plugin-root env token a real hooks.json spells `${CLAUDE_PLUGIN_ROOT}` —
 * built by interpolation, never as a literal `"${CLAUDE_PLUGIN_ROOT}"` string,
 * so Biome's `noTemplateCurlyInString` (a real placeholder someone forgot to
 * put in a template) does not mistake this deliberate one for that typo.
 */
const PLUGIN_ROOT = `$${"{CLAUDE_PLUGIN_ROOT}"}`;

/** A hook command rooted on the plugin token, e.g. `pluginCmd("scripts/r.sh")`. */
const pluginCmd = (rel: string) => `${PLUGIN_ROOT}/${rel}`;

const WIRED = 'command -v node && node "$CLAUDE_PROJECT_DIR"/scripts/slow.js';

describe("check-hook-liveness — the census", () => {
	/* The census's async-blind roster merges the core plugin's producers in;
	 * a stand-in core keeps the live core's out of every case. The host has
	 * no settings file until a case wires a hook, and --notify stays silent
	 * on it (#2462). */
	let restoreCore: () => void;
	beforeEach(() => {
		restoreCore = useScratchCore(path.dirname(dir));
	});
	afterEach(() => restoreCore());

	it("reports a hook whose failures dominate, at the zero-success floor", () => {
		transcript(dir, "s1", failures(WIRED, 60));

		const { out, status } = run("--only", "census");

		expect(out).toContain(
			"wired hook(s) whose failure records outnumber their successes",
		);
		expect(out).toContain("60 failed / 0 succeeded");
		expect(status).toBe(1);
	});

	it("counts a hardlinked transcript's unattributable records once (mantahostels#2299)", () => {
		// Every ratio divides the duplication out; a bare count cannot.
		const at = transcript(dir, "s1", bare(4));
		const also = path.join(projectDir(second), "s1.jsonl");
		fs.mkdirSync(path.dirname(also), { recursive: true });
		fs.linkSync(at, also);

		expect(run("--only", "census").out).toContain("4 failure record(s)");
	});

	it("counts a session held on two seats once, from the larger copy (#382)", () => {
		transcript(dir, "s1", bare(2));
		// Resumed on the second seat: its own real copy holds the whole session.
		transcript(second, "s1", bare(4));

		expect(run("--only", "census").out).toContain("4 failure record(s)");
	});

	it("counts a bare hook_non_blocking_error too, not cancellations alone (mantahostels#2296)", () => {
		transcript(dir, "s1", bare(2, 0, "hook_non_blocking_error"));

		expect(run("--only", "census").out).toContain("2 failure record(s)");
	});

	it("says the unattributable count beside a failing hook, not instead of one", () => {
		// The block sits above both `bad` early-returns for exactly this reason.
		transcript(dir, "s1", [...failures(WIRED, 60), ...bare(3)]);

		const { out } = run("--only", "census");

		expect(out).toContain("3 failure record(s)");
		expect(out).toContain("60 failed / 0 succeeded");
	});

	it("says the unattributable count again after it has gone away and returned", () => {
		// Without the clear, the stamp stands and the line is silenced for good.
		const at = transcript(dir, "s1", bare(4));
		expect(run("--notify", "--only", "census").out).toContain(
			"4 failure record(s)",
		);

		fs.rmSync(at);
		run("--notify", "--only", "census");
		transcript(dir, "s1", bare(4));

		expect(run("--notify", "--only", "census").out).toContain(
			"4 failure record(s)",
		);
	});

	it("counts the failure records that name no hook, and says how many", () => {
		transcript(dir, "s1", bare(4));

		const { out, status } = run("--only", "census");

		expect(out).toContain("4 failure record(s)");
		expect(out).toContain("named no hook command");
		// Not a fault: it measures a blind spot, it does not accuse a hook.
		expect(status).toBe(0);
	});

	it("says nothing about unattributable records where there are none (mantahostels#2296)", () => {
		transcript(dir, "s1", successes(WIRED, 3));

		expect(run("--only", "census").out).not.toContain("named no hook command");
	});

	it("counts no unattributable SUCCESS, which says nothing about a dead hook (mantahostels#2296)", () => {
		transcript(dir, "s1", bare(4, 0, "hook_success"));

		expect(run("--only", "census").out).not.toContain("named no hook command");
	});

	it("counts no unattributable record from outside the window (mantahostels#2296)", () => {
		transcript(dir, "s1", bare(4, 30));

		expect(run("--only", "census").out).not.toContain("named no hook command");
	});

	it("says the unattributable count once under --notify, then stays quiet", () => {
		transcript(dir, "s1", bare(4));

		expect(run("--notify", "--only", "census").out).toContain(
			"4 failure record(s)",
		);
		expect(run("--notify", "--only", "census").out).toBe("");
	});

	it("stays quiet under --notify when only the unattributable count moves", () => {
		// Keyed on presence, not the number.
		transcript(dir, "s1", bare(4));
		run("--notify", "--only", "census");

		transcript(dir, "s1", bare(1), { append: true });

		expect(run("--notify", "--only", "census").out).toBe("");
	});

	it("stays silent on a zero-success hook failing in too few sessions", () => {
		// A guard that allows quietly records no success, so the ratio cannot judge
		// it; 9 failures spread over 300 sessions is 0.33%, under the rate.
		for (let i = 0; i < 300; i++) transcript(dir, `s${i}`, []);
		transcript(dir, "s0", failures(WIRED, 9));

		const { out, status } = run("--only", "census");

		expect(out).toContain("OK:");
		expect(status).toBe(0);
	});

	it("reports a zero-success hook once its session rate clears the floor", () => {
		for (let i = 0; i < 300; i++) transcript(dir, `s${i}`, []);
		for (let i = 0; i < 5; i++)
			transcript(dir, `s${i}`, failures(WIRED, 2), { append: true });

		const { out, status } = run("--only", "census");

		expect(out).toContain("in 5 of 300 session(s)");
		expect(status).toBe(1);
	});

	it("reports on the ratio once the hook records successes at all", () => {
		transcript(dir, "s1", [...failures(WIRED, 12), ...successes(WIRED, 3)]);

		const { out, status } = run("--only", "census");

		expect(out).toContain("12 failed / 3 succeeded");
		expect(status).toBe(1);
	});

	it("leaves a hook alone whose successes outnumber its failures", () => {
		transcript(dir, "s1", [...failures(WIRED, 12), ...successes(WIRED, 40)]);

		const { out, status } = run("--only", "census");

		expect(out).toContain("OK:");
		expect(status).toBe(0);
	});

	it("counts nothing from a script named in a record's prose", () => {
		const prose = Array.from({ length: 80 }, () =>
			JSON.stringify({
				type: "attachment",
				attachment: {
					type: "hook_cancelled",
					hookEvent: "SessionStart",
					command: "other.sh",
					content: `see ${WIRED} and scripts/slow.js for the rules`,
				},
				timestamp: new Date().toISOString(),
			}),
		);
		transcript(dir, "s1", prose);

		const { out } = run("--only", "census");

		expect(out).toContain("other.sh");
		expect(out).not.toContain("slow.js");
	});

	it("reads every config dir, not only the one it is running under", () => {
		transcript(second, "s2", failures(WIRED, 60));

		const { out, status } = run("--only", "census");

		expect(out).toContain("60 failed / 0 succeeded");
		expect(status).toBe(1);
	});

	it("counts a record appended after the last run exactly once", () => {
		// Three rounds, not two: an offset that rewinds to the LENGTH of the last
		// append rather than the end of the file reads correctly once and then
		// starts re-counting.
		transcript(dir, "s1", failures(WIRED, 60));
		expect(run("--only", "census").out).toContain("60 failed");

		transcript(dir, "s1", failures(WIRED, 5), { append: true });
		expect(run("--only", "census").out).toContain("65 failed");

		transcript(dir, "s1", failures(WIRED, 5), { append: true });
		expect(run("--only", "census").out).toContain("70 failed");
	});

	it("counts one transcript as one session however many days it spans", () => {
		for (let i = 0; i < 200; i++) transcript(dir, `s${i}`, []);
		transcript(dir, "s0", [...failures(WIRED, 5), ...failures(WIRED, 5, 1)]);

		const { out } = run("--only", "census");

		expect(out).toContain("in 1 of 200 session(s)");
	});

	it("does not count a record the harness is still appending", () => {
		const at = transcript(dir, "s1", failures(WIRED, 60));
		fs.appendFileSync(at, record("hook_cancelled", WIRED).slice(0, 40));

		const { out } = run("--only", "census");

		expect(out).toContain("60 failed");
	});

	it("counts a half-written record once its line completes", () => {
		// The offset must stop at the last newline, not at the end of the file: a
		// run that stamps past bytes it never parsed loses that record for good,
		// because every later run starts after it.
		const at = transcript(dir, "s1", failures(WIRED, 60));
		const whole = record("hook_cancelled", WIRED);
		// Cut PAST the attachment's opening bytes, so the scanner finds the record
		// and cannot parse it. Cut before them and the guard is untested: nothing
		// has been seen to skip past.
		expect(whole.slice(0, 100)).toContain('{"type":"hook_');
		fs.appendFileSync(at, whole.slice(0, 100));
		run("--only", "census");

		fs.appendFileSync(at, `${whole.slice(100)}\n${whole}\n`);

		expect(run("--only", "census").out).toContain("62 failed");
	});

	it("passes when the corpus holds no hook records at all", () => {
		transcript(dir, "s1", [JSON.stringify({ type: "user", timestamp: "x" })]);

		const { out, status } = run("--only", "census");

		expect(out).toContain("OK:");
		expect(status).toBe(0);
	});

	it("skips rather than passing where no transcript directory exists", () => {
		const { out, status } = run("--only", "census");

		expect(out).toContain("SKIP:");
		expect(status).toBe(0);
	});

	it("says a set once under --notify and stays silent on the next start", () => {
		transcript(dir, "s1", failures(WIRED, 60));

		expect(run("--notify", "--only", "census").out).toContain("60 failed");
		expect(run("--notify", "--only", "census").out).toBe("");
	});

	it("speaks again under --notify when a second hook joins the set", () => {
		transcript(dir, "s1", failures(WIRED, 60));
		run("--notify", "--only", "census");

		transcript(dir, "s2", failures("other.sh", 60));

		expect(run("--notify", "--only", "census").out).toContain("other.sh");
	});

	it("finds transcripts under a project root carrying a dot", () => {
		// mantahostels#1963
		const root = path.join(path.dirname(dir), "repo.git");
		fs.mkdirSync(root, { recursive: true });
		const at = projectDir(dir, root);
		fs.mkdirSync(at, { recursive: true });
		fs.writeFileSync(
			path.join(at, "s1.jsonl"),
			`${failures(WIRED, 60).join("\n")}\n`,
		);

		const { out, status } = runFor(root, dir, "--only", "census");

		expect(out).toContain("60 failed");
		expect(out).not.toContain("SKIP:");
		expect(status).toBe(1);
	});

	/*
	 * The next two turn on the corpus and the notify stamp living in DIFFERENT
	 * config dirs: transcripts are seeded into `second`, and the stamp goes to the
	 * sorted-first dir that can hold state, which is `dir`. The stamp sits inside a
	 * directory the corpus itself enumerates, so seeding both in one dir would
	 * delete the stamp along with the transcripts and neither guarantee would be
	 * under test.
	 */
	it("says a fault again when its transcripts go away and come back identical", () => {
		const at = projectDir(second);
		const seed = () => transcript(second, "s1", failures(WIRED, 60));
		seed();
		expect(run("--notify", "--only", "census").out).toContain("60 failed");

		// The set empties by the transcripts going away, not by the fault clearing
		// — the stamp must still clear, or the same fault returning is silenced.
		fs.rmSync(at, { recursive: true, force: true });
		expect(run("--notify", "--only", "census").out).toBe("");
		seed();

		expect(run("--notify", "--only", "census").out).toContain("60 failed");
	});

	it("stays silent when a config dir goes unreadable and comes back with the same fault", () => {
		const at = projectDir(second);
		transcript(second, "s1", failures(WIRED, 60));
		expect(run("--notify", "--only", "census").out).toContain("60 failed");

		/* An empty set read off a directory that REFUSED to be listed is not the
		 * fault clearing, so it must not clear the stamp (mantahostels#1964). */
		fs.chmodSync(at, 0o000);
		let locked: { out: string };
		try {
			locked = run("--notify", "--only", "census");
		} finally {
			fs.chmodSync(at, 0o755);
		}

		/* Asserted, not discarded: where the chmod does not actually deny — as
		 * root, or on a mount ignoring mode bits — the middle run reads an ordinary
		 * empty corpus and the case passes on the plain dedupe path, proving
		 * nothing. */
		expect(locked.out).toContain("could not be listed");

		expect(run("--notify", "--only", "census").out).toBe("");
	});

	it("keeps the stamp when EVERY config dir refuses to be listed", () => {
		/* The unavailable return mantahostels#1964 named, which the empty-`bad` clear does not
		 * cover. Mode 0o333 is what reaches it: readdir gives EACCES, so `dirs` is
		 * empty and every dir is unreadable — while the stamp inside stays
		 * readable, opened by name through a directory that permits traversal and
		 * refuses listing. */
		const dirs = [projectDir(dir), projectDir(second)];
		transcript(second, "s1", failures(WIRED, 60));
		expect(run("--notify", "--only", "census").out).toContain("60 failed");
		// Written by the first run's cache; the stamp sits here too.
		expect(fs.existsSync(dirs[0])).toBe(true);

		for (const at of dirs) fs.chmodSync(at, 0o333);
		let locked: { out: string };
		try {
			locked = run("--notify", "--only", "census");
		} finally {
			for (const at of dirs) fs.chmodSync(at, 0o755);
		}

		/* Proves the run under test found NO listable dir, rather than some other
		 * path that happens to leave the stamp alone. These two are every config
		 * dir the run has. */
		for (const at of dirs) expect(locked.out).toContain(`${at} could not be`);

		expect(run("--notify", "--only", "census").out).toBe("");
	});

	it("stays silent where a plan's own project dir is a plain file, not a directory", () => {
		// ENOTDIR rather than ENOENT, read the same way as detached's mantahostels#2000 case
		// (mantahostels#2142): the live record from `second` is what stops this passing on
		// an empty corpus, which would be green whether or not `dir` was ever
		// visited.
		transcript(second, "s1", failures(WIRED, 60));
		const notADir = projectDir(dir);
		fs.mkdirSync(path.dirname(notADir), { recursive: true });
		fs.writeFileSync(notADir, "");

		const { out, status } = run("--only", "census");

		expect(out).toContain("60 failed");
		expect(out).not.toContain("could not be listed");
		expect(status).toBe(1);
	});

	it("puts the notify stamp inside the directory it censuses", () => {
		/* The corpus and the state path must resolve to ONE directory (mantahostels#1963).
		 * Asserted under a dotted root, the only place the two candidate spellings
		 * differ. */
		const root = path.join(path.dirname(dir), "repo.git");
		fs.mkdirSync(root, { recursive: true });
		const at = projectDir(dir, root);
		fs.mkdirSync(at, { recursive: true });
		fs.writeFileSync(
			path.join(at, "s1.jsonl"),
			`${failures(WIRED, 60).join("\n")}\n`,
		);

		runFor(root, dir, "--notify", "--only", "census");

		expect(
			fs.existsSync(
				path.join(at, "notify-reports", "hook-liveness-census.notified"),
			),
		).toBe(true);
		// The census CACHE is what statePath still resolves.
		expect(fs.existsSync(path.join(at, "hook-liveness-census.json"))).toBe(
			true,
		);
	});

	it("keeps the census cache in the pinned store, not the sorted-first config dir (#385)", () => {
		/* _A names `two`, which sorts after `one`, and the run is on `one`: a
		 * non-first seat. The old sorted-first-usable rule picked `one`. */
		transcript(second, "s1", failures(WIRED, 60));
		runWithEnv(
			{
				CLAUDE_CONFIG_DIR: dir,
				WFC_CLAUDE_CONFIG_A: second,
				WFC_CLAUDE_CONFIG_B: dir,
			},
			"--only",
			"census",
		);

		const cache = "hook-liveness-census.json";
		expect(fs.existsSync(path.join(projectDir(second), cache))).toBe(true);
		expect(fs.existsSync(path.join(projectDir(dir), cache))).toBe(false);
	});

	it("clears the stamp on a hand run, though a hand run writes none", () => {
		/* The clear is ungated where the write is not (mantahostels#2244): a run that was not
		 * the delivery still notices the set empty. */
		transcript(second, "s1", failures(WIRED, 60));
		expect(run("--notify", "--only", "census").out).toContain("60 failed");

		fs.rmSync(projectDir(second), { recursive: true, force: true });
		run("--only", "census");
		transcript(second, "s1", failures(WIRED, 60));

		expect(run("--notify", "--only", "census").out).toContain("60 failed");
	});

	it("decides the stamp without writing it, by source", () => {
		/* On the source, because no runtime test reaches the failure: it is a
		 * process killed between deciding and reporting, and every path that
		 * returns normally writes the stamp either way. */
		const src = fs.readFileSync(SCRIPT, "utf8");
		const from = src.indexOf("function saidBeforeElseQueue");
		const to = src.indexOf("function flushStamps");
		// Both anchors found before their span means anything: a renamed function
		// would otherwise leave this passing over nothing.
		expect(from).toBeGreaterThanOrEqual(0);
		expect(to).toBeGreaterThan(from);

		const decides = src.slice(from, to);

		expect(decides).toContain("alreadyDelivered");
		expect(decides).not.toMatch(/markDelivered|recordDelivery|writeFileSync/);
	});

	/*
	 * The producer's stdout is not the delivery under persist mode, so its
	 * own stamp must not suppress anything (mantahostels#1975, mantahostels#2244).
	 */
	describe("under persist mode", () => {
		/** delivery-stamp.js's store. */
		const stampDir = () => path.join(projectDir(dir), "notify-reports");
		const persist = (...args: string[]) =>
			runWithEnv({ WFC_NOTIFY_PERSIST: "1" }, ...args);
		const readReport = () =>
			JSON.parse(
				fs.readFileSync(
					path.join(stampDir(), "hook-liveness.report.json"),
					"utf8",
				),
			);

		it("reports the same fault on every run, however stamped", () => {
			transcript(second, "s1", failures(WIRED, 60));
			expect(run("--notify", "--only", "census").out).toContain("60 failed");
			expect(
				fs.existsSync(path.join(stampDir(), "hook-liveness-census.notified")),
			).toBe(true);

			for (const _ of [1, 2]) {
				expect(persist("--notify", "--only", "census").status).toBe(0);
				expect(readReport().text).toContain("60 failed");
			}
		});

		it("writes no stamp of its own", () => {
			transcript(second, "s1", failures(WIRED, 60));

			persist("--notify", "--only", "census");

			expect(
				fs.existsSync(path.join(stampDir(), "hook-liveness-census.notified")),
			).toBe(false);
			expect(readReport().text).toContain("60 failed");
		});

		/* mantahostels#2277: the eight assertion stamps this checker can never write for
		 * itself under persist mode travel in the persisted report's own
		 * `stamps` field instead, for the reader to apply once it has shown the
		 * report. */
		it("carries the census assertion's stamp in the persisted report", () => {
			transcript(second, "s1", failures(WIRED, 60));

			persist("--notify", "--only", "census");

			expect(readReport().stamps).toHaveProperty("hook-liveness-census");
			expect(typeof readReport().stamps["hook-liveness-census"]).toBe("string");
			expect(readReport().stamps["hook-liveness-census"]).not.toBe("");
		});
	});

	it("exits 0 under --notify even on a finding", () => {
		transcript(dir, "s1", failures(WIRED, 60));

		expect(run("--notify", "--only", "census").status).toBe(0);
	});

	it("reports its coverage when the budget stops the scan short", () => {
		for (let i = 0; i < 40; i++) transcript(dir, `s${i}`, failures(WIRED, 60));

		/* Through the budget seam, on a count of files read, rather than a 1 ms
		 * wall-clock budget (mantahostels#1945, mantahostels#2035). The seam CAPS the clock rather than
		 * replacing it, so the budget below is set wide enough that the count is
		 * what spends it. */
		const { out } = runWithEnv(
			{ WFC_CENSUS_BUDGET_AFTER: "5" },
			"--only",
			"census",
			"--budget-ms",
			"60000",
		);

		expect(out).toContain("Budget spent at 5 of 40 transcript file(s)");
		// Only the five it read, so the count is the short scan's and not the
		// whole corpus's.
		expect(out).toContain("300 failed / 0 succeeded");

		expect(run("--only", "census").out).toContain("2400 failed / 0 succeeded");
	});

	it("refuses a budget seam that is not a whole number of files, naming the variable and its value", () => {
		// A usage error at the entry point, not a throw out of the census (mantahostels#2035).
		const { out, status } = runWithEnv(
			{ WFC_CENSUS_BUDGET_AFTER: "half" },
			"--only",
			"census",
		);

		expect(out).toContain(
			"WFC_CENSUS_BUDGET_AFTER must be a whole number of files, not half",
		);
		expect(out).not.toContain("unhandled error");
		expect(status).toBe(2);
	});

	it("refuses the seam before any assertion runs, not only the census", () => {
		// The reason it is validated at the entry point: --only detached never
		// reaches the census at all, and must still refuse rather than run.
		const { status } = runWithEnv(
			{ WFC_CENSUS_BUDGET_AFTER: "-1" },
			"--only",
			"detached",
		);

		expect(status).toBe(2);
	});

	it("refuses a budget that is not a positive number, naming --budget-ms", () => {
		const { out, status } = run("--only", "census", "--budget-ms", "0");

		expect(out).toContain("--budget-ms must be a positive number");
		expect(status).toBe(2);
	});

	it("rescans from zero a transcript shorter than the bytes already counted", () => {
		transcript(dir, "s1", failures(WIRED, 60));
		expect(run("--only", "census").out).toContain("60 failed / 0 succeeded");

		// Replaced rather than appended to, so the cached offset now points past
		// the end.
		transcript(dir, "s1", failures(WIRED, 8));

		expect(run("--only", "census").out).toContain("8 failed / 0 succeeded");
	});

	it("leaves a failure older than the window alone until --days reaches it", () => {
		transcript(dir, "s1", failures(WIRED, 30, 3));

		expect(run("--only", "census").out).toContain("OK:");
		expect(run("--only", "census", "--days", "5").out).toContain(
			"30 failed / 0 succeeded",
		);
	});

	it.each(["-1", "0", "later"])(
		"refuses a --days of %s, saying it must be a positive number",
		(days) => {
			const { out, status } = run("--only", "census", "--days", days);

			expect(out).toContain("--days must be a positive number");
			expect(status).toBe(2);
		},
	);

	it("never reads a transcript past the cache retention, however wide --days is", () => {
		const at = transcript(dir, "s1", failures(WIRED, 60));
		const stale = (Date.now() - 10 * 86_400_000) / 1000;
		fs.utimesSync(at, stale, stale);

		expect(run("--only", "census", "--days", "30").out).toContain("OK:");

		const fresh = (Date.now() - 6 * 86_400_000) / 1000;
		fs.utimesSync(at, fresh, fresh);
		expect(run("--only", "census", "--days", "30").out).toContain(
			"60 failed / 0 succeeded",
		);
	});

	it("warns on stderr about a config dir it cannot list rather than passing over it, exiting 0", () => {
		transcript(second, "s1", []);
		const blocked = projectDir(dir);
		fs.mkdirSync(blocked, { recursive: true });
		fs.chmodSync(blocked, 0o000);
		try {
			const res = run("--only", "census");

			// stderr, not `out`: the annotation route writes the same sentence to
			// stdout, so only this stream proves the reader was told.
			expect(res.stderr).toContain("could not be listed");
			// A corpus this run could not read is not a hook failing.
			expect(res.status).toBe(0);
		} finally {
			fs.chmodSync(blocked, 0o755);
		}
	});

	it("says an unreadable config dir once under --notify, not at every start", () => {
		transcript(dir, "s1", []);
		const blocked = projectDir(second);
		fs.mkdirSync(blocked, { recursive: true });
		fs.chmodSync(blocked, 0o000);
		try {
			// stdout under --notify: that is the stream a SessionStart hook injects.
			expect(run("--notify", "--only", "census").stdout).toContain(
				"could not be listed",
			);
			expect(run("--notify", "--only", "census").stdout).not.toContain(
				"could not be listed",
			);
		} finally {
			fs.chmodSync(blocked, 0o755);
		}
	});

	it("dedupes the census notice when the first config dir cannot be written", () => {
		transcript(second, "s1", failures(WIRED, 60));
		const blocked = projectDir(dir);
		fs.mkdirSync(blocked, { recursive: true });
		fs.chmodSync(blocked, 0o000);
		try {
			const first = run("--notify", "--only", "census");
			expect(first.stdout).toContain("60 failed / 0 succeeded");
			expect(first.status).toBe(0);
			expect(run("--notify", "--only", "census").stdout).not.toContain(
				"60 failed / 0 succeeded",
			);
		} finally {
			fs.chmodSync(blocked, 0o755);
		}
	});

	it("says one set once for the machine, not once per plan running it", () => {
		transcript(dir, "s1", failures(WIRED, 60));

		// The stamp is pinned by name rather than hung off the running session's own
		// config dir, so the second plan reads the first's stamp and stays silent.
		expect(runUnder(dir, "--notify", "--only", "census").stdout).toContain(
			"60 failed / 0 succeeded",
		);
		expect(
			runUnder(second, "--notify", "--only", "census").stdout,
		).not.toContain("60 failed / 0 succeeded");
	});

	it("passes over a config dir whose projects entry is a dangling symlink", () => {
		transcript(second, "s1", failures(WIRED, 60));
		const broken = projectDir(dir);
		fs.mkdirSync(path.dirname(broken), { recursive: true });
		// access() resolves the link and reports ENOENT, so a walk trusting its
		// parent's bits would pin the base here and mkdir would then throw EEXIST.
		fs.symlinkSync(path.join(dir, "nowhere"), broken);

		expect(run("--notify", "--only", "census").stdout).toContain(
			"60 failed / 0 succeeded",
		);
		expect(run("--notify", "--only", "census").stdout).not.toContain(
			"60 failed / 0 succeeded",
		);
	});

	it("counts an unreadable dir as a dir, never as a hook, in the summary", () => {
		transcript(dir, "s1", []);
		const blocked = projectDir(second);
		fs.mkdirSync(blocked, { recursive: true });
		fs.chmodSync(blocked, 0o000);
		try {
			const { out } = run("--only", "census");

			expect(out).toContain("WARN: 1 config dir the census could not read");
			expect(out).not.toContain("hook that is wired and not running");
		} finally {
			fs.chmodSync(blocked, 0o755);
		}
	});

	it("does not report an absence of transcripts it could not look for", () => {
		const blocked = projectDir(dir);
		fs.mkdirSync(blocked, { recursive: true });
		fs.chmodSync(blocked, 0o000);
		try {
			const { out } = run("--only", "census");

			expect(out).toContain("refused to be listed");
			expect(out).not.toContain("no retained transcripts");
		} finally {
			fs.chmodSync(blocked, 0o755);
		}
	});

	it("leaves the unreadable-dir sentence to the annotation under Actions", () => {
		transcript(dir, "s1", []);
		const blocked = projectDir(second);
		fs.mkdirSync(blocked, { recursive: true });
		fs.chmodSync(blocked, 0o000);
		try {
			const res = runInProcess(SCRIPT, ["--only", "census"], {
				env: {
					...process.env,
					CLAUDE_PROJECT_DIR: repo,
					CLAUDE_CONFIG_DIR: dir,
					WFC_CLAUDE_CONFIG_A: dir,
					WFC_CLAUDE_CONFIG_B: second,
					WFC_CLAUDE_CONFIG_C: second,
					CLAUDE_CODE_SESSION_ID: "",
					GITHUB_ACTIONS: "true",
				},
			});

			// ::warning:: on stdout carries it; a say on stderr would be the same
			// sentence twice in one run.
			expect(res.stdout).toContain("::warning::");
			expect(res.stderr).not.toContain("could not be listed");
		} finally {
			fs.chmodSync(blocked, 0o755);
		}
	});

	it("counts a record carrying no timestamp instead of dropping it", () => {
		// A record with no day cannot be shown to fall outside the window.
		const undated = JSON.stringify({
			type: "attachment",
			attachment: {
				type: "hook_cancelled",
				hookEvent: "SessionStart",
				command: WIRED,
			},
		});
		transcript(
			dir,
			"s1",
			Array.from({ length: 30 }, () => undated),
		);

		const { out, status } = run("--only", "census");

		expect(out).toContain("30 failed / 0 succeeded");
		expect(status).toBe(1);
	});

	const persisting = (name: string) =>
		`command -v node >/dev/null 2>&1 && WFC_NOTIFY_PERSIST=1 node "$CLAUDE_PROJECT_DIR"/scripts/${name} --notify || true`;

	it("names a SessionStart producer wired async (mantahostels#2366)", () => {
		transcript(dir, "s1", []);
		asyncSettings([persisting("check-ci-status.js")]);

		const { out, status } = run("--only", "census");

		expect(out).toContain("cannot see them: ci-status");
		expect(out).toContain("replay-notify-reports.js reads their persisted");
		expect(status).toBe(0);
	});

	it("names every async producer wired, not only the first", () => {
		transcript(dir, "s1", []);
		asyncSettings([
			persisting("check-ci-status.js"),
			persisting("check-issue-labels.js"),
		]);

		const { out } = run("--only", "census");

		expect(out).toContain("2 SessionStart producer(s)");
		expect(out).toContain("ci-status (check-ci-status.js)");
		expect(out).toContain("issue-labels (check-issue-labels.js)");
	});

	it("keys the blind spot on persisting, not on `async: true` itself", () => {
		// No `async` field at all: the roster it names is driven by
		// WFC_NOTIFY_PERSIST=1 + --notify, not by the async flag (mantahostels#2366).
		transcript(dir, "s1", []);
		const at = path.join(repo, ".claude", "settings.json");
		fs.mkdirSync(path.dirname(at), { recursive: true });
		fs.writeFileSync(
			at,
			JSON.stringify({
				hooks: {
					SessionStart: [
						{ hooks: [{ command: persisting("check-ci-status.js") }] },
					],
				},
			}),
		);

		expect(run("--only", "census").out).toContain("cannot see them: ci-status");
	});

	it("says nothing about the async blind spot where nothing is wired to persist", () => {
		transcript(dir, "s1", []);

		expect(run("--only", "census").out).not.toContain("cannot see them");
	});

	it("says nothing about the async blind spot for a hook not wired to persist", () => {
		transcript(dir, "s1", []);
		// No WFC_NOTIFY_PERSIST=1 on the line: readSessionStartRoster() excludes it.
		const at = path.join(repo, ".claude", "settings.json");
		fs.mkdirSync(path.dirname(at), { recursive: true });
		fs.writeFileSync(
			at,
			JSON.stringify({
				hooks: {
					SessionStart: [
						{
							hooks: [
								{
									command:
										'command -v node && node "$CLAUDE_PROJECT_DIR"/scripts/check-orphan-wait-loops.js --notify',
								},
							],
						},
					],
				},
			}),
		);

		expect(run("--only", "census").out).not.toContain("cannot see them");
	});

	it("reports the async-blind count on the --json envelope", () => {
		transcript(dir, "s1", []);
		asyncSettings([
			persisting("check-ci-status.js"),
			persisting("check-issue-labels.js"),
		]);

		const { out } = run("--only", "census", "--json");
		const doc = JSON.parse(out);

		expect(doc.census.asyncBlind).toBe(2);
	});

	it("says the async blind spot once under --notify, then stays quiet", () => {
		transcript(dir, "s1", []);
		asyncSettings([persisting("check-ci-status.js")]);

		expect(run("--notify", "--only", "census").out).toContain(
			"cannot see them",
		);
		expect(run("--notify", "--only", "census").out).toBe("");
	});

	it("says the async blind spot again once the roster changes", () => {
		transcript(dir, "s1", []);
		asyncSettings([persisting("check-ci-status.js")]);
		run("--notify", "--only", "census");

		asyncSettings([
			persisting("check-ci-status.js"),
			persisting("check-issue-labels.js"),
		]);

		expect(run("--notify", "--only", "census").out).toContain(
			"cannot see them",
		);
	});
});

describe("check-hook-liveness — the plugin cache manifest", () => {
	it("reports a cache that wires nothing where the marketplace wires a hook", () => {
		plugin(dir, {
			cached: '{"hooks": {}}',
			upstream: JSON.stringify({
				hooks: { SessionStart: [{ hooks: [{ command: "run.sh" }] }] },
			}),
		});

		const { out, status } = run("--only", "manifest");

		expect(out).toContain("cached 13 B against");
		expect(out).toContain("The runtime wires the cache copy");
		expect(status).toBe(1);
	});

	it("reports a cache missing the file the marketplace ships", () => {
		plugin(dir, { cached: null, upstream: '{"hooks": {"Stop": []}}' });

		const { out, status } = run("--only", "manifest");

		expect(out).toContain("the cache holds no hooks/hooks.json at all");
		expect(status).toBe(1);
	});

	it("passes where the two agree apart from formatting", () => {
		plugin(dir, {
			cached: '{"hooks":{"Stop":[]}}',
			upstream: '{\n  "hooks": {\n    "Stop": []\n  }\n}\n',
		});

		const { out, status } = run("--only", "manifest");

		expect(out).toContain("OK:");
		expect(status).toBe(0);
	});

	it("passes where neither side ships hooks", () => {
		plugin(dir, { cached: null, upstream: null });

		const { status } = run("--only", "manifest");

		expect(status).toBe(0);
	});

	it("ignores a plugin installed for another project", () => {
		plugin(dir, { cached: '{"hooks": {}}', upstream: '{"hooks":{"Stop":[]}}' });
		const at = path.join(dir, "plugins", "installed_plugins.json");
		const doc = JSON.parse(fs.readFileSync(at, "utf8"));
		doc.plugins["demo@market"][0].projectPath = "/somewhere/else";
		fs.writeFileSync(at, JSON.stringify(doc));

		const { status } = run("--only", "manifest");

		expect(status).toBe(0);
	});

	it("compares against the pinned commit where the marketplace is a git repo", () => {
		plugin(dir, {
			cached: '{"hooks": {}}',
			upstream: '{"hooks":{"Stop":[{"hooks":[{"command":"r.sh"}]}]}}',
			git: true,
		});

		const { out, status } = run("--only", "manifest");

		expect(out).toMatch(/marketplace: [0-9a-f]{8}:hooks\/hooks\.json/);
		expect(status).toBe(1);
	});

	it("passes where the cache matches the blob at the pinned commit", () => {
		plugin(dir, {
			cached: '{"hooks":{"Stop":[]}}',
			upstream: '{"hooks":{"Stop":[]}}',
			git: true,
		});

		const { out, status } = run("--only", "manifest");

		expect(out).toContain("OK:");
		expect(status).toBe(0);
	});

	it("reads a pinned commit that ships no hooks as shipping none", () => {
		plugin(dir, { cached: null, upstream: null, git: true });

		const { out, status } = run("--only", "manifest");

		expect(out).toContain("OK:");
		expect(status).toBe(0);
	});

	it("reports a pinned commit the clone does not hold as unreadable, never as shipping no hooks (#747)", () => {
		plugin(dir, {
			cached: '{"hooks":{"Stop":[]}}',
			upstream: '{"hooks":{"Stop":[]}}',
			git: true,
		});
		const at = path.join(dir, "plugins", "installed_plugins.json");
		const doc = JSON.parse(fs.readFileSync(at, "utf8"));
		doc.plugins["demo@market"][0].gitCommitSha = "0".repeat(40);
		fs.writeFileSync(at, JSON.stringify(doc));

		const { out, status } = run("--only", "manifest");

		expect(out).toContain("1 plugin(s) could not be compared");
		expect(out).toContain("commit 00000000 is not in");
		expect(out).not.toContain("no hooks/hooks.json");
		expect(status).toBe(0);
	});

	it("counts a plugin sourced from another repository as unverifiable", () => {
		plugin(dir, { cached: '{"hooks":{}}', upstream: null });
		// The object form of `source` points at a repository this machine does not
		// hold, so there is nothing local to compare against.
		fs.writeFileSync(
			path.join(
				dir,
				"plugins/marketplaces/market/.claude-plugin/marketplace.json",
			),
			JSON.stringify({
				name: "market",
				plugins: [
					{ name: "demo", source: { source: "github", repo: "someone/else" } },
				],
			}),
		);

		const { out, status } = run("--only", "manifest");

		expect(out).toContain("1 plugin(s) could not be compared");
		expect(out).toContain("sourced from another repository");
		expect(status).toBe(0);
	});

	it("says a divergence again when the cache goes away and comes back", () => {
		const cached = '{"hooks": {}}';
		const upstream = JSON.stringify({
			hooks: { SessionStart: [{ hooks: [{ command: "run.sh" }] }] },
		});
		plugin(dir, { cached, upstream });
		expect(run("--notify", "--only", "manifest").out).toContain("cached 13 B");

		// The set empties by every plugin being uninstalled, not by the divergence
		// being repaired — the stamp must still clear, or the same divergence
		// returning is silenced.
		fs.rmSync(path.join(dir, "plugins"), { recursive: true, force: true });
		run("--notify", "--only", "manifest");
		plugin(dir, { cached, upstream });

		expect(run("--notify", "--only", "manifest").out).toContain("cached 13 B");
	});

	it("stays silent when the marketplace goes unreadable and comes back diverged", () => {
		const cached = '{"hooks": {}}';
		const upstream = '{"hooks":{"Stop":[]}}';
		plugin(dir, { cached, upstream });
		expect(run("--notify", "--only", "manifest").out).toContain("demo@market");

		/* A marketplace refused by a permission bit sends its plugin to
		 * `unverifiable`, which skips it past the divergence check — `diverged`
		 * empties without the divergence being repaired, so the stamp must stand
		 * (mantahostels#1981). Run without --notify because the unverifiable count is said only
		 * there; the clear itself does not depend on the flag. */
		const marketAt = path.join(
			dir,
			"plugins/marketplaces/market/.claude-plugin/marketplace.json",
		);
		fs.chmodSync(marketAt, 0o000);
		let locked: { out: string };
		try {
			locked = run("--only", "manifest");
		} finally {
			fs.chmodSync(marketAt, 0o644);
		}

		/* Asserted, not discarded: where the chmod does not actually deny — as
		 * root, or on a mount ignoring mode bits — the middle run reads the
		 * divergence as usual and the case passes on the plain dedupe path. */
		expect(locked.out).toContain("1 plugin(s) could not be compared");

		expect(run("--notify", "--only", "manifest").out).toBe("");
	});

	it("clears the stamp though a plugin is permanently unverifiable", () => {
		/* "Sourced from another repository" is a settled answer and an ordinary
		 * pass, not a failure to look — gating the clear on the whole `unverifiable`
		 * set would leave the stamp standing for good on any machine holding one
		 * such plugin, silencing a repaired-and-recurring divergence (mantahostels#1981). */
		const cached = '{"hooks": {}}';
		const upstream = '{"hooks":{"Stop":[]}}';
		plugin(dir, { cached, upstream });
		plugin(dir, { name: "other", marketplace: "m2", cached, upstream });
		fs.writeFileSync(
			path.join(dir, "plugins/marketplaces/m2/.claude-plugin/marketplace.json"),
			JSON.stringify({
				name: "m2",
				plugins: [
					{ name: "other", source: { source: "github", repo: "someone/else" } },
				],
			}),
		);
		expect(run("--notify", "--only", "manifest").out).toContain("demo@market");

		// The divergence is repaired, then recurs identically.
		fs.writeFileSync(
			path.join(dir, "plugins/cache/market/demo/1.0.0/hooks/hooks.json"),
			upstream,
		);
		expect(run("--notify", "--only", "manifest").out).toBe("");
		fs.writeFileSync(
			path.join(dir, "plugins/cache/market/demo/1.0.0/hooks/hooks.json"),
			cached,
		);

		expect(run("--notify", "--only", "manifest").out).toContain("demo@market");
	});

	it("still dedupes a divergence while another plugin's marketplace is unreadable", () => {
		/* The other limb of the same gate (mantahostels#1981): where the set is NOT empty, the
		 * stamp must still be written, or a standing divergence is announced at
		 * every session start for as long as the unrelated fault lasts. */
		plugin(dir, { cached: '{"hooks": {}}', upstream: '{"hooks":{"Stop":[]}}' });
		plugin(dir, {
			name: "other",
			marketplace: "m2",
			cached: '{"hooks": {}}',
			upstream: '{"hooks":{"Stop":[]}}',
		});
		const otherMarket = path.join(
			dir,
			"plugins/marketplaces/m2/.claude-plugin/marketplace.json",
		);
		fs.chmodSync(otherMarket, 0o000);
		try {
			expect(run("--notify", "--only", "manifest").out).toContain(
				"demo@market",
			);
			expect(run("--notify", "--only", "manifest").out).toBe("");
		} finally {
			fs.chmodSync(otherMarket, 0o644);
		}
	});

	it("skips rather than passing where no plugin manifest exists", () => {
		const { out, status } = run("--only", "manifest");

		expect(out).toContain("SKIP:");
		expect(status).toBe(0);
	});

	it("says a diverged manifest once under --notify and stays silent on the next start", () => {
		plugin(dir, { cached: '{"hooks": {}}', upstream: '{"hooks":{"Stop":[]}}' });

		expect(run("--notify", "--only", "manifest").out).toContain("demo@market");
		expect(run("--notify", "--only", "manifest").out).toBe("");
	});

	it("speaks again under --notify when a second plugin's cache diverges", () => {
		plugin(dir, { cached: '{"hooks": {}}', upstream: '{"hooks":{"Stop":[]}}' });
		run("--notify", "--only", "manifest");

		plugin(dir, {
			name: "second",
			cached: '{"hooks": {}}',
			upstream: '{"hooks":{"Stop":[]}}',
		});

		expect(run("--notify", "--only", "manifest").out).toContain(
			"second@market",
		);
	});
});

describe("check-hook-liveness — a plugin-hosted hook stack (mantahostels#3515 F9)", () => {
	it("passes an enabled plugin whose manifests agree and whose script is live", () => {
		enablePlugin("demo@market");
		const installPath = pluginWithHooks(dir, {
			hookEntries: [["Stop", pluginCmd("scripts/r.sh")]],
		});
		pluginScript(installPath, "scripts/r.sh");

		const { out, status } = run("--only", "manifest");

		expect(out).toContain("OK:");
		expect(status).toBe(0);
	});

	it("does not run the plugin-hosted checks for a plugin this repo has not enabled", () => {
		// Same hook entries as the passing case, but the missing script is never
		// created.
		pluginWithHooks(dir, {
			hookEntries: [["Stop", pluginCmd("scripts/missing.sh")]],
		});

		const { out, status } = run("--only", "manifest");

		expect(out).toContain("OK:");
		expect(status).toBe(0);
	});

	it("reports a hook dropped from the plugin-hosted manifest", () => {
		enablePlugin("demo@market");
		pluginWithHooks(dir, {
			hookEntries: [
				["Stop", pluginCmd("scripts/kept.sh")],
				["SessionStart", pluginCmd("scripts/dropped.sh")],
			],
			cachedHookEntries: [["Stop", pluginCmd("scripts/kept.sh")]],
		});

		const { out, status } = run("--only", "manifest");

		expect(out).toContain("dropped.sh");
		expect(out).toContain("dropped in packaging");
		expect(status).toBe(1);
	});

	it("audits a plugin enabled only in the config dir's user settings (#43)", () => {
		fs.writeFileSync(
			path.join(dir, "settings.json"),
			JSON.stringify({ enabledPlugins: { "demo@market": true } }),
		);
		pluginWithHooks(dir, {
			hookEntries: [
				["Stop", pluginCmd("scripts/kept.sh")],
				["SessionStart", pluginCmd("scripts/dropped.sh")],
			],
			cachedHookEntries: [["Stop", pluginCmd("scripts/kept.sh")]],
		});

		const { out, status } = run("--only", "manifest");

		expect(out).toContain("dropped in packaging");
		expect(status).toBe(1);
	});

	it("lets the repo's settings switch off a user-level enablement (#43)", () => {
		fs.writeFileSync(
			path.join(dir, "settings.json"),
			JSON.stringify({ enabledPlugins: { "demo@market": true } }),
		);
		fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
		fs.writeFileSync(
			path.join(repo, ".claude", "settings.json"),
			JSON.stringify({ enabledPlugins: { "demo@market": false } }),
		);
		// The script is never created: audited, this would fail.
		pluginWithHooks(dir, {
			hookEntries: [["Stop", pluginCmd("scripts/missing.sh")]],
		});

		const { out, status } = run("--only", "manifest");

		expect(out).toContain("OK:");
		expect(status).toBe(0);
	});

	it("warns where a settings file enabling plugins does not parse, saying no plugin it enables is audited (#43)", () => {
		fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
		fs.writeFileSync(path.join(repo, ".claude", "settings.json"), "{ nope");
		pluginWithHooks(dir, {
			hookEntries: [["Stop", pluginCmd("scripts/r.sh")]],
		});

		const { out, status } = run("--only", "manifest");

		expect(out).toContain("does not parse, so no plugin it enables is audited");
		expect(status).toBe(0);
	});

	it("passes where the plugin-hosted manifests agree, mutation-checked", () => {
		// Baseline: same hook set both sides — the case that must NOT report a
		// drop.
		enablePlugin("demo@market");
		pluginWithHooks(dir, {
			hookEntries: [["Stop", pluginCmd("scripts/kept.sh")]],
		});

		expect(run("--only", "manifest").out).not.toContain("dropped in packaging");

		// Mutation: drop the SessionStart hook from the cache alone, as the
		// reporting test does — the finding must now appear.
		pluginWithHooks(dir, {
			hookEntries: [
				["Stop", pluginCmd("scripts/kept.sh")],
				["SessionStart", pluginCmd("scripts/dropped.sh")],
			],
			cachedHookEntries: [["Stop", pluginCmd("scripts/kept.sh")]],
		});

		expect(run("--only", "manifest").out).toContain("dropped in packaging");
	});

	it("reports a plugin-hosted hook whose script is missing under CLAUDE_PLUGIN_ROOT", () => {
		enablePlugin("demo@market");
		pluginWithHooks(dir, {
			hookEntries: [["Stop", pluginCmd("scripts/missing.sh")]],
		});
		// No pluginScript() call: the file at that path is never created.

		const { out, status } = run("--only", "manifest");

		expect(out).toContain("missing.sh does not exist under the plugin root");
		expect(status).toBe(1);
	});

	it("reports a plugin-hosted hook whose script is not executable", () => {
		enablePlugin("demo@market");
		const installPath = pluginWithHooks(dir, {
			hookEntries: [["Stop", pluginCmd("scripts/r.sh")]],
		});
		pluginScript(installPath, "scripts/r.sh", { executable: false });

		const { out, status } = run("--only", "manifest");

		expect(out).toContain("r.sh is not executable under the plugin root");
		expect(status).toBe(1);
	});

	it("reads a directory-source marketplace, which is never cloned under plugins/marketplaces/", () => {
		enablePlugin("demo@market");
		const marketplaceDir = path.join(path.dirname(dir), "dir-market");
		const installPath = pluginWithHooks(dir, {
			marketplaceDir,
			hookEntries: [["Stop", pluginCmd("scripts/r.sh")]],
			cachedHookEntries: [],
		});
		directoryMarketplace(dir, "market", marketplaceDir);
		pluginScript(installPath, "scripts/r.sh");
		expect(
			fs.existsSync(path.join(dir, "plugins", "marketplaces", "market")),
		).toBe(false);

		const { out, status } = run("--only", "manifest");

		expect(out).toContain("dropped in packaging");
		expect(status).toBe(1);
	});
});

describe("check-hook-liveness — the core's self-plugin file paths (#2442)", () => {
	function selfPlugin(commands: string[]) {
		const at = path.join(repo, "self-plugin", "hooks", "hooks.json");
		fs.mkdirSync(path.dirname(at), { recursive: true });
		fs.writeFileSync(
			at,
			JSON.stringify({
				hooks: {
					Stop: [{ hooks: commands.map((command) => ({ command })) }],
				},
			}),
		);
	}
	/* WFC_SCRIPT_ROOT makes `repo` the core. */
	const asCore = (...args: string[]) =>
		runWithEnv({ WFC_SCRIPT_ROOT: repo }, ...args);

	it("refuses a typo'd command path in the self-plugin file, naming the file to fix", () => {
		script("guard-demo.sh");
		selfPlugin(['"$CLAUDE_PROJECT_DIR"/scrpits/guard-demo.sh']);

		const { out, status } = asCore("--only", "self-plugin");

		expect(out).toContain("scrpits/guard-demo.sh does not exist");
		expect(out).toContain("drop its entry from self-plugin/hooks/hooks.json");
		expect(status).toBe(1);
	});

	it("reads the self-plugin file then the settings at the core, naming the file each path is in (#2572)", () => {
		script("guard-demo.sh");
		selfPlugin(['"$CLAUDE_PROJECT_DIR"/scripts/guard-demo.sh']);
		settings(['"$CLAUDE_PROJECT_DIR"/scripts/guard-gone.sh']);

		const { out, status } = asCore("--only", "self-plugin");

		expect(out).toContain("scripts/guard-gone.sh does not exist");
		expect(out).toContain("drop its entry from .claude/settings.json");
		expect(out).not.toContain("drop its entry from self-plugin");
		expect(status).toBe(1);

		script("guard-gone.sh");
		expect(asCore("--only", "self-plugin").out).toContain(
			"2 self-plugin/hooks/hooks.json and .claude/settings.json hook path(s) resolved",
		);
	});

	it("compares wfc-self as a plugin this repo enables, loaded in place from self-plugin/", () => {
		script("guard-demo.sh");
		selfPlugin(['"$CLAUDE_PROJECT_DIR"/scripts/guard-demo.sh']);
		const selfDir = path.join(repo, "self-plugin");
		fs.mkdirSync(path.join(selfDir, ".claude-plugin"), { recursive: true });
		fs.writeFileSync(
			path.join(selfDir, ".claude-plugin", "marketplace.json"),
			JSON.stringify({
				name: "wfc-self",
				plugins: [{ name: "wfc-self", source: "./" }],
			}),
		);
		directoryMarketplace(dir, "wfc-self", selfDir);
		fs.mkdirSync(path.join(dir, "plugins"), { recursive: true });
		fs.writeFileSync(
			path.join(dir, "plugins", "installed_plugins.json"),
			JSON.stringify({
				version: 2,
				plugins: { "wfc-self@wfc-self": [{ installPath: selfDir }] },
			}),
		);
		enablePlugin("wfc-self@wfc-self");

		const { out, status } = run("--only", "manifest");

		expect(out).toContain("1 plugin manifest(s) compared");
		expect(out).not.toContain("could not be compared");
		expect(status).toBe(0);
	});

	it("is BROKEN, never OK, where the core carries no self-plugin file", () => {
		const { out, status } = asCore("--only", "self-plugin");

		expect(out).toContain("BROKEN:");
		expect(out).toContain("self-plugin/hooks/hooks.json cannot be read");
		expect(status).toBe(2);
	});
});

describe("check-hook-liveness — an adopter's settings.json paths", () => {
	it("passes a wired hook whose script exists and is executable", () => {
		script("guard-demo.sh");
		settings(['"$CLAUDE_PROJECT_DIR"/scripts/guard-demo.sh']);

		const { out, status } = run("--only", "self-plugin");

		expect(out).toContain("OK:");
		expect(status).toBe(0);
	});

	it("refuses a command whose script does not exist, naming the script", () => {
		settings(['"$CLAUDE_PROJECT_DIR"/scripts/guard-gone.sh']);

		const { out, status } = run("--only", "self-plugin");

		expect(out).toContain("scripts/guard-gone.sh does not exist");
		expect(status).toBe(1);
	});

	it("catches a mistyped directory, not only a mistyped file", () => {
		script("guard-demo.sh");
		settings(['"$CLAUDE_PROJECT_DIR"/scrpits/guard-demo.sh']);

		const { out, status } = run("--only", "self-plugin");

		expect(out).toContain("scrpits/guard-demo.sh");
		expect(status).toBe(1);
	});

	it("refuses a directly-invoked script that is not executable, naming the script", () => {
		script("guard-demo.sh", { executable: false });
		settings(['"$CLAUDE_PROJECT_DIR"/scripts/guard-demo.sh']);

		const { out, status } = run("--only", "self-plugin");

		expect(out).toContain("scripts/guard-demo.sh is not executable");
		expect(status).toBe(1);
	});

	it("asks no executable bit of a script handed to node", () => {
		script("check-demo.js", { executable: false });
		settings([
			'command -v node >/dev/null 2>&1 && node "$CLAUDE_PROJECT_DIR"/scripts/check-demo.js --notify || true',
		]);

		const { out, status } = run("--only", "self-plugin");

		expect(out).toContain("OK:");
		expect(status).toBe(0);
	});

	it("asks no executable bit of a script handed to python3", () => {
		script("check-demo.py", { executable: false });
		script("check-pathed.py", { executable: false });
		settings([
			'command -v python3 >/dev/null 2>&1 && python3 "$CLAUDE_PROJECT_DIR"/scripts/check-demo.py --quiet 2>&1 || true',
			'/usr/bin/python3 "$CLAUDE_PROJECT_DIR"/scripts/check-pathed.py',
		]);

		const { out, status } = run("--only", "self-plugin");

		expect(out).not.toContain("not executable");
		expect(status).toBe(0);
	});

	it("reads a path relative to a cd into the project root", () => {
		script("check-demo.js", { executable: false });
		settings([
			'command -v node && cd "$CLAUDE_PROJECT_DIR" && node scripts/check-demo.js --notify',
		]);

		const { status } = run("--only", "self-plugin");

		expect(status).toBe(0);
	});

	it('does not read `cd "$CLAUDE_PROJECT_DIR"` as a hook path', () => {
		script("check-demo.js");
		settings(['cd "$CLAUDE_PROJECT_DIR" && node scripts/check-demo.js']);

		const { out } = run("--only", "self-plugin");

		expect(out).toContain("1 .claude/settings.json hook path(s) resolved");
	});

	/* The exec form (mantahostels#2059) spells its command with braces and carries an
	 * `args` key. A strip regex that stopped resolving that spelling would fail
	 * silently: a guard whose path does not resolve produces a non-blocking
	 * ENOENT visible only in the transcript (mantahostels#2107). */
	/* The exec form's own spelling, assembled rather than written whole: biome's
	 * noTemplateCurlyInString cannot tell a shell variable from a botched
	 * template literal, and every one of these is the shell's. */
	const braced = (name: string) => `\${CLAUDE_PROJECT_DIR}/scripts/${name}`;

	it("resolves the brace spelling of the project-dir variable", () => {
		script("guard-brace.sh");
		settings([braced("guard-brace.sh")]);

		const { out, status } = run("--only", "self-plugin");

		expect(out).toContain("1 .claude/settings.json hook path(s) resolved");
		expect(out).not.toContain("does not exist");
		expect(status).toBe(0);
	});

	it("resolves the quoted spelling too, so neither is dropped for the other", () => {
		script("guard-quoted.sh");
		settings(['"$CLAUDE_PROJECT_DIR"/scripts/guard-quoted.sh']);

		const { out, status } = run("--only", "self-plugin");

		expect(out).toContain("1 .claude/settings.json hook path(s) resolved");
		expect(out).not.toContain("does not exist");
		expect(status).toBe(0);
	});

	it("reads a hook entry carrying an args key, as the exec form writes it", () => {
		script("guard-exec.sh");
		settings([
			{
				type: "command",
				command: braced("guard-exec.sh"),
				args: [],
				timeout: 10,
			},
		]);

		const { out, status } = run("--only", "self-plugin");

		expect(out).toContain("1 .claude/settings.json hook path(s) resolved");
		expect(status).toBe(0);
	});

	/* The vendor-documented interpreter spelling puts no path in `command` at
	 * all. Walking `command` alone finds nothing to check, so the entry escapes
	 * HOOK-PATH-MISSING however wrong its path is (mantahostels#2106). */
	it("refuses an interpreter-plus-script entry whose script in args is gone, naming the missing script", () => {
		settings([
			{
				type: "command",
				command: "node",
				args: [braced("check-args-gone.js"), "--notify"],
			},
		]);

		const { out, status } = run("--only", "self-plugin");

		expect(out).toContain(": scripts/check-args-gone.js does not exist");
		expect(status).toBe(1);
	});

	/* An interpreter runs the script, so the file need not be executable — the
	 * `direct` limb has to read the interpreter out of `command` to know that. */
	it("resolves a script held in args without demanding it be executable", () => {
		script("check-args.js", { executable: false });
		settings([
			{
				type: "command",
				command: "node",
				args: [braced("check-args.js"), "--notify"],
			},
		]);

		const { out, status } = run("--only", "self-plugin");

		expect(out).toContain("1 .claude/settings.json hook path(s) resolved");
		expect(out).not.toContain("not executable");
		expect(status).toBe(0);
	});

	/* `node --enable-source-maps scripts/x.js` is the ordinary interpreter shape,
	 * and args is where those flags now live. Reading only the token immediately
	 * before the script judges it directly invoked and raises a false
	 * HOOK-NOT-EXECUTABLE in a pre-commit gate (mantahostels#2106). */
	it("steps back over the interpreter's own flags before judging direct", () => {
		script("check-flagged.js", { executable: false });
		settings([
			{
				type: "command",
				command: "node",
				args: ["--enable-source-maps", braced("check-flagged.js")],
			},
		]);

		const { out, status } = run("--only", "self-plugin");

		expect(out).not.toContain("not executable");
		expect(status).toBe(0);
	});

	/* A wrapper handed a script path runs it however it likes (#83). */
	it("does not demand a wrapper's script argument be executable", () => {
		script("at-wrap.sh");
		script("check-wrapped.js", { executable: false });
		settings([
			`command -v node >/dev/null 2>&1 && ${braced("at-wrap.sh")} scripts/check-wrapped.js --quiet || true`,
		]);

		const { out, status } = run("--only", "self-plugin");

		expect(out).toContain("2 .claude/settings.json hook path(s) resolved");
		expect(out).not.toContain("not executable");
		expect(status).toBe(0);
	});

	it("still demands the wrapper itself be executable", () => {
		script("at-wrap-bare.sh", { executable: false });
		script("check-wrapped-ok.js", { executable: false });
		settings([`${braced("at-wrap-bare.sh")} scripts/check-wrapped-ok.js`]);

		const { out, status } = run("--only", "self-plugin");

		expect(out).toContain("scripts/at-wrap-bare.sh is not executable");
		expect(out).not.toContain("check-wrapped-ok.js is not executable");
		expect(status).toBe(1);
	});

	it("still demands both scripts be executable when an operator chains them", () => {
		script("guard-chain-a.sh", { executable: false });
		script("guard-chain-b.sh", { executable: false });
		settings([
			`${braced("guard-chain-a.sh")} && ${braced("guard-chain-b.sh")}`,
		]);

		const { out, status } = run("--only", "self-plugin");

		expect(out).toContain("scripts/guard-chain-a.sh is not executable");
		expect(out).toContain("scripts/guard-chain-b.sh is not executable");
		expect(status).toBe(1);
	});

	it("reads a scalar args rather than dropping the path it holds", () => {
		settings([
			{
				type: "command",
				command: "node",
				args: braced("check-scalar-gone.js"),
			},
		]);

		const { out, status } = run("--only", "self-plugin");

		expect(out).toContain(": scripts/check-scalar-gone.js does not exist");
		expect(status).toBe(1);
	});

	it("still refuses a brace-spelled command whose script is gone", () => {
		settings([braced("guard-brace-gone.sh")]);

		const { out, status } = run("--only", "self-plugin");

		/* The event separator is part of the match on purpose: without it, a strip
		 * regex that left a `}/` prefix on the path would still satisfy a bare
		 * substring and this would read as a pin it is not (mantahostels#2107). */
		expect(out).toContain(": scripts/guard-brace-gone.sh does not exist");
		expect(status).toBe(1);
	});

	it("passes a repo that has no settings.json at all", () => {
		// A temp fixture and a fresh checkout both look like this. BROKEN here
		// refuses every commit either one makes.
		const { out, status } = run("--only", "self-plugin");

		expect(out).toContain("OK:");
		expect(status).toBe(0);
	});

	it("is BROKEN, never OK, on a settings.json it cannot parse", () => {
		const at = path.join(repo, ".claude", "settings.json");
		fs.mkdirSync(path.dirname(at), { recursive: true });
		fs.writeFileSync(at, "{ not json");

		const { out, status } = run("--only", "self-plugin");

		expect(out).toContain("BROKEN:");
		expect(status).toBe(2);
	});
});

describe("check-hook-liveness — the five together", () => {
	it("runs the other assertions when one of them cannot answer", () => {
		// No transcripts at all, so the census cannot answer.
		settings(['"$CLAUDE_PROJECT_DIR"/scripts/guard-gone.sh']);
		plugin(dir, { cached: null, upstream: null });

		const { out, status } = run();

		expect(out).toContain("scripts/guard-gone.sh does not exist");
		expect(out).toContain("assertion not run: census");
		expect(status).toBe(1);
	});

	it("leaves the settings assertion out of the --notify surface", () => {
		settings(['"$CLAUDE_PROJECT_DIR"/scripts/guard-gone.sh']);
		plugin(dir, { cached: null, upstream: null });
		transcript(dir, "s1", []);

		const { out } = run("--notify");

		expect(out).not.toContain("guard-gone.sh");
	});

	it("refuses an --only nobody declared, listing the five it takes", () => {
		const { out, status } = run("--only", "everything");

		expect(out).toContain(
			"--only takes census, manifest, self-plugin, reap or detached",
		);
		expect(status).toBe(2);
	});
});

describe("check-hook-liveness — the reap run record", () => {
	/** The reaper's record under `cfg`, one row per mode given. */
	function reapRun(
		cfg: string,
		rows: Record<string, Record<string, unknown>>,
		{ raw }: { raw?: string } = {},
	) {
		const at = path.join(cfg, "wfc-reap-run.json");
		fs.mkdirSync(cfg, { recursive: true });
		fs.writeFileSync(at, raw ?? JSON.stringify(rows, null, "\t"));
		return at;
	}

	/** A stamp `mins` minutes before now, in the shape the reaper writes. */
	const ago = (mins: number) =>
		new Date(Date.now() - mins * 60_000).toISOString();

	it("reports a dry reap that opened its record and never closed it", () => {
		reapRun(dir, { dry: { mode: "dry", startedAt: ago(30) } });

		const { out, status } = run("--only", "reap");

		expect(out).toContain("the dry reap recorded in");
		expect(out).toContain("never finished");
		// A diagnostic, never a gate — this must not refuse a commit or a start.
		expect(status).toBe(0);
	});

	it("says nothing about a run that closed its own record", () => {
		reapRun(dir, {
			live: { mode: "live", startedAt: ago(30), finishedAt: ago(29) },
			dry: { mode: "dry", startedAt: ago(10), finishedAt: ago(10) },
		});

		const { out, status } = run("--only", "reap");

		expect(out).toContain("1 reap run record(s) read");
		expect(out).not.toContain("never finished");
		expect(status).toBe(0);
	});

	it("names the live reaper's own command, not the dry one, on a live row", () => {
		reapRun(dir, { live: { mode: "live", startedAt: ago(30) } });

		const { out } = run("--only", "reap");

		expect(out).toContain("node scripts/reap-finished-sessions.js\n");
		expect(out).not.toContain("reap-finished-sessions.js --dry-run");
	});

	it("names the dry reaper's own command on a dry row", () => {
		reapRun(dir, { dry: { mode: "dry", startedAt: ago(30) } });

		expect(run("--only", "reap").out).toContain(
			"node scripts/reap-finished-sessions.js --dry-run",
		);
	});

	it("does not read a run still in flight as a run that died", () => {
		// The reaper writes its start half before its slow read, and this checker
		// is a SessionStart hook beside it — so an open record seconds old is the
		// run happening right now.
		reapRun(dir, { live: { mode: "live", startedAt: ago(0) } });

		const { out, status } = run("--only", "reap");

		expect(out).not.toContain("never finished");
		expect(status).toBe(0);
	});

	it("treats an absent record as nothing to check, never as a finding", () => {
		const { out, status } = run("--only", "reap");

		expect(out).toContain("no wfc-reap-run.json under any config dir");
		expect(out).not.toContain("never finished");
		expect(status).toBe(0);
	});

	it("reads the record of a plan other than the one running", () => {
		reapRun(second, { dry: { mode: "dry", startedAt: ago(30) } });

		const res = runUnder(dir, "--only", "reap");

		expect(res.out).toContain("never finished");
		expect(res.status).toBe(0);
	});

	it("says a standing cancellation once, not at every session start", () => {
		reapRun(dir, { dry: { mode: "dry", startedAt: ago(30) } });

		expect(run("--notify", "--only", "reap").stdout).toContain(
			"never finished",
		);
		// Keyed on file and mode, not the stamp: a reap cancelled at every start
		// writes a fresh one each time and is still one standing fault.
		reapRun(dir, { dry: { mode: "dry", startedAt: ago(20) } });
		expect(run("--notify", "--only", "reap").stdout).not.toContain(
			"never finished",
		);
	});

	it("says a cancellation again once a second mode joins the set", () => {
		// The other half of the stamp: a key that never changed would silence a
		// new fault for good.
		reapRun(dir, { dry: { mode: "dry", startedAt: ago(30) } });
		expect(run("--notify", "--only", "reap").stdout).toContain("the dry reap");

		reapRun(dir, {
			dry: { mode: "dry", startedAt: ago(30) },
			live: { mode: "live", startedAt: ago(30) },
		});
		expect(run("--notify", "--only", "reap").stdout).toContain("the live reap");
	});

	it("names the record it could not read, and calls it a record not a hook", () => {
		reapRun(dir, {}, { raw: "{ not json" });

		const { out, status } = run("--only", "reap");

		expect(out).toContain("wfc-reap-run.json");
		expect(out).toContain("could not be read");
		expect(out).toContain("a reap that died mid-run cannot be seen here");
		expect(out).toContain("WARN: 1 reap run record that could not be read");
		expect(out).not.toContain("hook that is wired and not running");
		expect(status).toBe(0);
	});

	it("says a fault again when its record goes away and comes back identical", () => {
		reapRun(dir, { dry: { mode: "dry", startedAt: ago(30) } });
		expect(run("--notify", "--only", "reap").stdout).toContain("the dry reap");

		// The set empties by the file being removed, not by the fault clearing —
		// the stamp must still clear, or the same fault returning is silenced.
		fs.rmSync(path.join(dir, "wfc-reap-run.json"));
		run("--notify", "--only", "reap");
		reapRun(dir, { dry: { mode: "dry", startedAt: ago(30) } });

		expect(run("--notify", "--only", "reap").stdout).toContain("the dry reap");
	});

	it("stays silent when its record goes unreadable and comes back with the same fault", () => {
		const at = reapRun(dir, { dry: { mode: "dry", startedAt: ago(30) } });
		expect(run("--notify", "--only", "reap").stdout).toContain("the dry reap");

		/* An empty `open` read off a record that REFUSED to be read is not the reap
		 * being repaired, so it must not clear the stamp (mantahostels#1981). The unavailable
		 * return does not cover this: `unreadable` is non-empty, so the run carries
		 * on past it with nothing in `open`. */
		fs.chmodSync(at, 0o000);
		let locked: { stdout: string };
		try {
			locked = run("--notify", "--only", "reap");
		} finally {
			fs.chmodSync(at, 0o644);
		}

		// As the manifest case above asserts (mantahostels#1981).
		expect(locked.stdout).toContain("could not be read");

		expect(run("--notify", "--only", "reap").stdout).not.toContain(
			"the dry reap",
		);
	});

	it("still dedupes an open reap while another plan's record is unreadable", () => {
		// The other limb of the same gate, as in the manifest case above (mantahostels#1981).
		reapRun(dir, { dry: { mode: "dry", startedAt: ago(30) } });
		const other = reapRun(second, { dry: { mode: "dry", startedAt: ago(30) } });
		fs.chmodSync(other, 0o000);
		try {
			expect(run("--notify", "--only", "reap").stdout).toContain(
				"the dry reap",
			);
			expect(run("--notify", "--only", "reap").stdout).not.toContain(
				"the dry reap",
			);
		} finally {
			fs.chmodSync(other, 0o644);
		}
	});

	it("clears the stamp on a record read whole and found to be the wrong shape", () => {
		/* A record that parsed to an array is a STANDING corruption, not a failure
		 * to look — gating the clear on it would hold the stamp open for good, so
		 * a repaired-and-recurring reap would never be said again (mantahostels#1981). */
		reapRun(dir, { dry: { mode: "dry", startedAt: ago(30) } });
		expect(run("--notify", "--only", "reap").stdout).toContain("the dry reap");

		reapRun(dir, {}, { raw: "[]" });
		expect(run("--notify", "--only", "reap").stdout).toContain(
			"not an object keyed by mode",
		);

		reapRun(dir, { dry: { mode: "dry", startedAt: ago(30) } });
		expect(run("--notify", "--only", "reap").stdout).toContain("the dry reap");
	});

	it("is on the --notify surface", () => {
		// With `reap` out of the default --notify set, nothing reads the record at
		// a session start.
		reapRun(dir, { dry: { mode: "dry", startedAt: ago(30) } });
		transcript(dir, "s1", []);
		plugin(dir, { cached: null, upstream: null });

		expect(run("--notify").stdout).toContain("the dry reap recorded in");
	});

	it("survives a row that is not an object of its own", () => {
		// A null row is the one that would throw rather than mis-report.
		reapRun(dir, {}, { raw: JSON.stringify({ dry: "cancelled", live: null }) });

		const { out, status } = run("--only", "reap");

		expect(out).not.toContain("never finished");
		expect(out).toContain("1 reap run record(s) read");
		expect(status).toBe(0);
	});

	it("passes over a row whose start stamp is missing or not a string", () => {
		// 2026 is the trap: a bare number Date.parse happily reads as a year, so
		// the string test is what stops a stamp nobody wrote being aged.
		reapRun(dir, {
			dry: { mode: "dry" },
			live: { mode: "live", startedAt: 2026 },
		});

		expect(run("--only", "reap").out).not.toContain("never finished");
	});

	it("passes over a row whose start stamp will not parse as a date", () => {
		// It cannot be aged, so it cannot be told from a run in flight.
		reapRun(dir, { dry: { mode: "dry", startedAt: "the other day" } });

		expect(run("--only", "reap").out).not.toContain("never finished");
	});

	it("keeps the general noun where an unreadable record joins a real fault", () => {
		// Two tags, so neither narrow noun is honest.
		reapRun(dir, { dry: { mode: "dry", startedAt: ago(30) } });
		reapRun(second, {}, { raw: "{ not json" });

		const { out } = run("--only", "reap");

		expect(out).toContain("hook that is wired and not running");
		expect(out).not.toContain("reap run record that could not be read");
	});

	it("names a record that parsed to something other than rows by mode", () => {
		reapRun(dir, {}, { raw: "[]" });

		const { out, status } = run("--only", "reap");

		expect(out).toContain("not an object keyed by mode");
		expect(status).toBe(0);
	});
});

describe("check-hook-liveness — a live reap cancelled at consecutive session starts (mantahostels#1952)", () => {
	/** The reaper's record under `cfg`, one row per mode given. */
	function reapRun(cfg: string, rows: Record<string, Record<string, unknown>>) {
		const at = path.join(cfg, "wfc-reap-run.json");
		fs.mkdirSync(cfg, { recursive: true });
		fs.writeFileSync(at, JSON.stringify(rows, null, "\t"));
		return at;
	}

	it("reports a live row seen unfinished across enough starts, however young its own stamp", () => {
		// Fresh — seconds old — so the single-row `open` check above would never
		// catch it, which is the whole gap mantahostels#1952 closes.
		reapRun(dir, {
			live: {
				mode: "live",
				startedAt: new Date().toISOString(),
				openedSince: new Date(Date.now() - 20 * 60_000).toISOString(),
				deaths: 3,
			},
		});

		const { out, status } = run("--only", "reap");

		expect(out).toContain("the live reap recorded in");
		expect(out).toContain("3 consecutive session starts");
		expect(out).not.toContain("never finished");
		// A diagnostic, never a gate.
		expect(status).toBe(0);
	});

	it("says nothing below the threshold", () => {
		reapRun(dir, {
			live: {
				mode: "live",
				startedAt: new Date().toISOString(),
				openedSince: new Date(Date.now() - 5 * 60_000).toISOString(),
				deaths: 2,
			},
		});

		expect(run("--only", "reap").out).not.toContain(
			"consecutive session starts",
		);
	});

	it("says nothing once the row closes, whatever it last counted", () => {
		reapRun(dir, {
			live: {
				mode: "live",
				startedAt: new Date().toISOString(),
				finishedAt: new Date().toISOString(),
				openedSince: new Date().toISOString(),
				deaths: 5,
			},
		});

		expect(run("--only", "reap").out).not.toContain(
			"consecutive session starts",
		);
	});

	it("names the live reaper's own command to run by hand", () => {
		reapRun(dir, {
			live: {
				mode: "live",
				startedAt: new Date().toISOString(),
				deaths: 4,
			},
		});

		const out = run("--only", "reap").out;
		expect(out).toContain("node scripts/reap-finished-sessions.js\n");
		expect(out).not.toContain("reap-finished-sessions.js --dry-run");
	});

	it("says a standing cancellation once, not at every session start", () => {
		reapRun(dir, {
			live: { mode: "live", startedAt: new Date().toISOString(), deaths: 3 },
		});
		expect(run("--notify", "--only", "reap").stdout).toContain(
			"consecutive session starts",
		);

		// The deaths figure keeps climbing while the fault stands — the stamp must
		// still dedupe, keyed on file and mode rather than the count.
		reapRun(dir, {
			live: { mode: "live", startedAt: new Date().toISOString(), deaths: 4 },
		});
		expect(run("--notify", "--only", "reap").stdout).not.toContain(
			"consecutive session starts",
		);
	});

	it("says a cancellation again once the row closes and reopens chronically later", () => {
		reapRun(dir, {
			live: { mode: "live", startedAt: new Date().toISOString(), deaths: 3 },
		});
		expect(run("--notify", "--only", "reap").stdout).toContain(
			"consecutive session starts",
		);

		reapRun(dir, {
			live: {
				mode: "live",
				startedAt: new Date().toISOString(),
				finishedAt: new Date().toISOString(),
				deaths: 0,
			},
		});
		run("--notify", "--only", "reap");

		reapRun(dir, {
			live: { mode: "live", startedAt: new Date().toISOString(), deaths: 3 },
		});
		expect(run("--notify", "--only", "reap").stdout).toContain(
			"consecutive session starts",
		);
	});

	it("ignores a dry row's own deaths — dry ages into the single-row check above instead", () => {
		// Fresh and carrying a `deaths` past the threshold: the chronic report is
		// `live`-only (its message describes a mode reopened every session start,
		// which `dry` is not), so this must say nothing at all.
		reapRun(dir, {
			dry: { mode: "dry", startedAt: new Date().toISOString(), deaths: 3 },
		});

		const { out, status } = run("--only", "reap");
		expect(out).not.toContain("consecutive session starts");
		expect(out).not.toContain("never finished");
		expect(status).toBe(0);
	});
});

describe("check-hook-liveness — the detached run record", () => {
	/** The detached-run record under `cfg`, one row per job given. */
	function detachedRun(
		cfg: string,
		rows: Record<string, Record<string, unknown>>,
		{ raw }: { raw?: string } = {},
	) {
		const at = path.join(cfg, "wfc-detached-run.json");
		fs.mkdirSync(cfg, { recursive: true });
		fs.writeFileSync(at, raw ?? JSON.stringify(rows, null, "\t"));
		return at;
	}

	/** A row for a job that has failed to return `deaths` starts running. */
	const dead = (deaths: number) => ({
		deaths,
		lastFinishedAt: new Date(Date.now() - 3_600_000).toISOString(),
	});

	it("treats an absent record as nothing to check, never as a finding", () => {
		const { out, status } = run("--only", "detached");

		expect(out).toContain("no wfc-detached-run.json under any config dir");
		expect(out).not.toContain("consecutive session starts");
		expect(status).toBe(0);
	});

	it("says nothing about a job still short of the reporting floor", () => {
		// DEATHS_TO_REPORT is 3 (scripts/lib/detached-run.js): two in a row is the
		// ordinary shape of a machine running a dozen sessions at once.
		detachedRun(dir, { "prune-markers": dead(2) });

		const { out, status } = run("--only", "detached");

		expect(out).toContain("1 detached run record(s) read");
		expect(out).not.toContain("consecutive session starts");
		expect(status).toBe(0);
	});

	it("reports a job that has reached the floor, and how to run it in front of you", () => {
		detachedRun(dir, { "prune-markers": dead(3) });

		const { out, status } = run("--only", "detached");

		expect(out).toContain("the detached prune-markers recorded in");
		expect(out).toContain("failed to return on 3 consecutive session starts");
		// Anchored on the newline so the two-space indent is pinned (mantahostels#2000).
		expect(out).toContain("\n  node scripts/session-arbiter.js prune-markers");
		// A diagnostic, never a gate — this must not refuse a commit or a start.
		expect(status).toBe(0);
	});

	it("says a row has never completed rather than printing an absent stamp", () => {
		detachedRun(dir, { "debt-sweep": { deaths: 4 } });

		const { out } = run("--only", "detached");

		expect(out).toContain("last completed: never recorded");
	});

	it("passes over a row that is not an object, and one whose deaths will not parse", () => {
		detachedRun(dir, {
			"prune-markers": null as unknown as Record<string, unknown>,
			"debt-sweep": { deaths: "many" },
		});

		const { out, status } = run("--only", "detached");

		expect(out).toContain("1 detached run record(s) read");
		expect(out).not.toContain("consecutive session starts");
		expect(status).toBe(0);
	});

	it("reads the record of a plan other than the one running", () => {
		detachedRun(second, { "debt-sweep": dead(5) });

		const { out } = runUnder(dir, "--only", "detached");

		expect(out).toContain("the detached debt-sweep recorded in");
	});

	it("names the record it could not read, and calls it a record not a hook", () => {
		detachedRun(dir, {}, { raw: "{ not json" });

		const { out, status } = run("--only", "detached");

		expect(out).toContain("wfc-detached-run.json");
		expect(out).toContain("could not be read");
		expect(out).toContain(
			"a detached session-start child that died cannot be seen here",
		);
		expect(out).toContain("WARN: 1 detached run record that could not be read");
		expect(out).not.toContain("hook that is wired and not running");
		expect(status).toBe(0);
	});

	it("names a record that parsed to something other than rows by job", () => {
		detachedRun(dir, {}, { raw: "[]" });

		const { out, status } = run("--only", "detached");

		expect(out).toContain("not an object keyed by job");
		expect(status).toBe(0);
	});

	it("says so rather than guessing where the job is not one it knows", () => {
		// detached-run.js's JOBS and this file's DETACHED_HOW are typed against each
		// other, so a key outside both can only come off a record written by an
		// older or a foreign writer — the reader is told, never handed a command.
		detachedRun(dir, { "some-old-job": dead(3) });

		const { out, status } = run("--only", "detached");

		expect(out).toContain("the detached some-old-job recorded in");
		// Two-deep, exactly as a known job's command is (mantahostels#2000).
		expect(out).toContain(
			"\n  (unknown job — check scripts/lib/detached-run.js",
		);
		expect(status).toBe(0);
	});

	it("stays silent where a plan's config dir is a plain file, not a directory", () => {
		// ENOTDIR rather than ENOENT, and it must read the same way (mantahostels#2000). The
		// live record is what stops this passing on the unavailable return, which
		// would be green whether or not the file was ever visited.
		detachedRun(dir, { "prune-markers": dead(1) });
		const notADir = path.join(path.dirname(dir), "plan-is-a-file");
		fs.writeFileSync(notADir, "");

		const { out, status } = runWithEnv(
			{ WFC_CLAUDE_CONFIG_B: notADir },
			"--only",
			"detached",
		);

		expect(out).toContain("1 detached run record(s) read");
		expect(out).not.toContain("could not be read");
		expect(status).toBe(0);
	});

	it("is on both default surfaces, not only under --only", () => {
		// Two arrays, and a case using --only reads neither (mantahostels#2000): --notify is
		// the session start, the bare run is the command line and pre-commit.
		detachedRun(dir, { "prune-markers": dead(3) });

		const notify = run("--notify");
		expect(notify.stdout).toContain("the detached prune-markers recorded in");
		expect(notify.status).toBe(0);

		const unflagged = run();
		expect(unflagged.out).toContain("the detached prune-markers recorded in");
		expect(unflagged.status).toBe(0);
	});

	it("reports a dead job under every config dir it can read, not just the first", () => {
		// Both plans readable at once — the union, as distinct from reading a
		// second plan instead of the running one (mantahostels#2000).
		detachedRun(dir, { "prune-markers": dead(3) });
		detachedRun(second, { "debt-sweep": dead(4) });

		const { out, status } = run("--only", "detached");

		expect(out).toContain("the detached prune-markers recorded in");
		expect(out).toContain("the detached debt-sweep recorded in");
		expect(status).toBe(0);
	});

	it("says a dead job once under --notify, not at every session start", () => {
		detachedRun(dir, { "prune-markers": dead(3) });

		expect(run("--notify", "--only", "detached").stdout).toContain(
			"the detached prune-markers",
		);
		expect(run("--notify", "--only", "detached").stdout).not.toContain(
			"the detached prune-markers",
		);
	});

	it("speaks again under --notify when a second job joins the set", () => {
		detachedRun(dir, { "prune-markers": dead(3) });
		run("--notify", "--only", "detached");

		detachedRun(dir, { "prune-markers": dead(4), "debt-sweep": dead(3) });

		expect(run("--notify", "--only", "detached").stdout).toContain(
			"the detached debt-sweep",
		);
	});

	it("says a fault again when its record goes away and comes back identical", () => {
		detachedRun(dir, { "prune-markers": dead(3) });
		expect(run("--notify", "--only", "detached").stdout).toContain(
			"the detached prune-markers",
		);

		// As the reap case above: the set empties by the file being removed, not by
		// the fault clearing, and the stamp must still clear.
		fs.rmSync(path.join(dir, "wfc-detached-run.json"));
		run("--notify", "--only", "detached");
		detachedRun(dir, { "prune-markers": dead(3) });

		expect(run("--notify", "--only", "detached").stdout).toContain(
			"the detached prune-markers",
		);
	});

	it("stays silent when its record goes unreadable and comes back with the same fault", () => {
		const at = detachedRun(dir, { "prune-markers": dead(3) });
		expect(run("--notify", "--only", "detached").stdout).toContain(
			"the detached prune-markers",
		);

		// The reap case's gate, in the fourth place (mantahostels#2108).
		fs.chmodSync(at, 0o000);
		let locked: { stdout: string };
		try {
			locked = run("--notify", "--only", "detached");
		} finally {
			fs.chmodSync(at, 0o644);
		}

		// Asserted so a case where the file was readable after all cannot pass as
		// the gate working.
		expect(locked.stdout).toContain("could not be read");

		expect(run("--notify", "--only", "detached").stdout).not.toContain(
			"the detached prune-markers",
		);
	});

	it("still dedupes a dead job while another plan's record is unreadable", () => {
		// The other limb of the same gate: an unreadable record elsewhere must not
		// make a finding that IS present speak at every start (mantahostels#2108).
		detachedRun(dir, { "prune-markers": dead(3) });
		const other = detachedRun(second, { "debt-sweep": dead(3) });
		fs.chmodSync(other, 0o000);
		try {
			expect(run("--notify", "--only", "detached").stdout).toContain(
				"the detached prune-markers",
			);
			expect(run("--notify", "--only", "detached").stdout).not.toContain(
				"the detached prune-markers",
			);
		} finally {
			fs.chmodSync(other, 0o644);
		}
	});

	it("clears the stamp on a record read whole and found to be the wrong shape", () => {
		// The other limb of the reap case's gate (mantahostels#2108).
		detachedRun(dir, { "prune-markers": dead(3) });
		expect(run("--notify", "--only", "detached").stdout).toContain(
			"the detached prune-markers",
		);

		detachedRun(dir, {}, { raw: "[]" });
		expect(run("--notify", "--only", "detached").stdout).toContain(
			"not an object keyed by job",
		);

		detachedRun(dir, { "prune-markers": dead(3) });
		expect(run("--notify", "--only", "detached").stdout).toContain(
			"the detached prune-markers",
		);
	});
});
