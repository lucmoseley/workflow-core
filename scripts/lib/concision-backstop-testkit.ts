/*
 * The shared fixture and drivers for the concision-backstop.sh test files,
 * split by subject so no one file runs past the per-file limit (#4308).
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach } from "vitest";
import { ledgerHead } from "./arbiter-testkit";
import { defineTemplate, mkScratchDir } from "./git-fixture";
import { runInProcess } from "./run-in-process.js";

export const BACKSTOP = path.resolve(__dirname, "..", "concision-backstop.sh");
const ARBITER = path.resolve(__dirname, "..", "session-arbiter.js");
export const INJECTOR = path.resolve(__dirname, "..", "inject-tracker-docs.sh");

export const ME = "session-under-test";
export const OTHER = "parallel-session";

/* A function, not a hoisted const: `repo` is reassigned per test. */
export const markersDir = () => path.join(repo, ".claude", "tmp", "markers");

export let dir: string;
export let repo: string;
export let cfg: string;

export const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: repo, encoding: "utf8" });

export const env = () => ({
	...process.env,
	CLAUDE_PROJECT_DIR: repo,
	CLAUDE_CONFIG_DIR: cfg,
	// The /implement marker the backstop reads lives under TMPDIR, so it is
	// pointed at this test's scratch directory — otherwise a real session's
	// marker in the host's /tmp could decide the outcome.
	TMPDIR: dir,
});

/**
 * Reserve the marker inject-tracker-docs.sh writes when `/implement` fires, at
 * the path and with the sanitising the backstop reads back.
 */
export const implementRan = (sid = ME) => {
	const d = path.join(dir, `wfc-tracker-inject-${process.getuid?.() ?? 0}`);
	fs.mkdirSync(d, { recursive: true });
	fs.writeFileSync(
		path.join(d, `${sid.replace(/[^A-Za-z0-9_-]/g, "_")}.implement`),
		"",
	);
};

/**
 * A path in this repo's arbiter store — asked of the arbiter rather than
 * rebuilt, so a change to its slugging cannot leave the test chmodding or
 * reading a path nothing writes.
 */
// biome-ignore lint/suspicious/noExplicitAny: the store is untyped CommonJS.
export const storePath = (pick: (store: any) => string) => {
	const saved = { ...process.env };
	Object.assign(process.env, {
		CLAUDE_PROJECT_DIR: repo,
		CLAUDE_CONFIG_DIR: cfg,
	});
	try {
		// The store, not the CLI: session-arbiter.js exports nothing (mantahostels#158),
		// and requiring it would run a subcommand and exit this process.
		return pick(createRequire(__filename)("./arbiter-store.js"));
	} finally {
		process.env = saved;
	}
};

export const ledgerFor = (sid: string) => storePath((s) => s.paths.ledger(sid));

const arbiter = (args: string[], e: NodeJS.ProcessEnv) => {
	const r = runInProcess(ARBITER, args, { env: e });
	if (r.status !== 0)
		throw new Error(`session-arbiter.js ${args[0]}: ${r.stderr}`);
};

/** Note in the ledger that `sid` wrote `rel` — what PostToolUse does for real. */
export const record = (rel: string, sid: string) =>
	arbiter(["record", rel, sid], env());

/** Note HEAD in `sid`'s commit ledger — what post-commit does for real. */
export const ledgerHeadOf = (sid: string) =>
	ledgerHead(repo, { ...env(), CLAUDE_CODE_SESSION_ID: sid });

export const write = (rel: string, body: string) => {
	fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
	fs.writeFileSync(path.join(repo, rel), body);
};

export const gitAt = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" });

/*
 * THE FIXTURE IS BUILT ONCE AND COPIED, via scripts/lib/git-fixture.ts (mantahostels#2068),
 * rather than rebuilt per test. One template, not mantahostels#2048's pre-built
 * variants: the git calls left per test are ones the test bodies make, not
 * repo construction (mantahostels#2076).
 */
const buildTemplate = (root: string) => {
	const repoDir = path.join(root, "repo");
	fs.mkdirSync(repoDir, { recursive: true });
	gitAt(repoDir, "init", "-q", "-b", "main", ".");
	gitAt(repoDir, "config", "user.email", "test@example.com");
	gitAt(repoDir, "config", "user.name", "test");
	// core.hooksPath is absolute in this checkout, so a scratch repo would
	// otherwise run the real Husky gates (mantahostels#100's finding). relink() rewrites
	// this template-relative path in .git/config on every instantiate() call.
	gitAt(repoDir, "config", "core.hooksPath", path.join(root, "no-hooks"));
	fs.writeFileSync(path.join(repoDir, "seed.md"), "seed\n");
	gitAt(repoDir, "add", "seed.md");
	gitAt(repoDir, "commit", "-qm", "init");
	// The SessionStart run every case starts from, made once here (#4308): it
	// writes only ME's base marker, which the copy carries.
	const r = spawnSync(BACKSTOP, ["start"], {
		cwd: repoDir,
		encoding: "utf8",
		input: JSON.stringify({ session_id: ME }),
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: repoDir,
			CLAUDE_CONFIG_DIR: path.join(root, "config"),
			TMPDIR: root,
		},
	});
	if (r.status !== 0) throw new Error(`backstop start failed: ${r.stderr}`);
};

export const template = defineTemplate(buildTemplate);

/** Runs the hook in `mode`, as Claude Code would, returning the whole result. */
export const spawnBackstop = (
	mode: "start" | "stop",
	sid = ME,
	extra: Record<string, string> = {},
	script = BACKSTOP,
) => {
	const r = spawnSync(script, [mode], {
		cwd: repo,
		encoding: "utf8",
		input: JSON.stringify({ session_id: sid }),
		env: { ...env(), ...extra },
	});
	if (r.status === null) throw new Error(`backstop did not run: ${r.error}`);
	return r;
};

/** Runs the hook in `mode`, as Claude Code would, returning its block reason. */
export const run = (
	mode: "start" | "stop",
	sid = ME,
	extra: Record<string, string> = {},
) => {
	const r = spawnBackstop(mode, sid, extra);
	if (!r.stdout?.trim()) return null;
	return JSON.parse(r.stdout).reason as string;
};

/** 60 words — comfortably over the script's THRESHOLD of 50. */
export const PARAGRAPH = `${Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ")}\n`;

/** A code change big enough to clear CODE_THRESHOLD, the churn gate at mantahostels#1071. */
export const BIG_CODE = Array.from(
	{ length: 30 },
	(_, i) => `export const x${i} = ${i};`,
).join("\n");

/** Each case's fresh copy of the template, removed after it. */
export const backstopFixture = () => {
	beforeEach(() => {
		// realpath: the repo root the arbiter derives comes from `git rev-parse`,
		// which resolves symlinks, so an unresolved tmpdir would slug to a different
		// project directory and the ledger would be written where nothing reads it.
		dir = mkScratchDir("backstop-");
		repo = path.join(dir, "repo");
		cfg = path.join(dir, "config");
		template.instantiate(dir);
	});

	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
};
