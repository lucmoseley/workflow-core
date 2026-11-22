import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach } from "vitest";
import { ledgerHead } from "./arbiter-testkit";
import { defineTemplate, mkScratchDir } from "./git-fixture";
import { runInProcess } from "./run-in-process.js";
import { withStubbedEnv } from "./scoped-env";

export const BACKSTOP = path.resolve(__dirname, "..", "concision-backstop.sh");
const ARBITER = path.resolve(__dirname, "..", "session-arbiter.js");
export const INJECTOR = path.resolve(__dirname, "..", "inject-tracker-docs.js");

export const ME = "session-under-test";
export const OTHER = "parallel-session";

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
	TMPDIR: dir,
});

export const implementRan = (sid = ME) => {
	const d = path.join(dir, `wfc-tracker-inject-${process.getuid?.() ?? 0}`);
	fs.mkdirSync(d, { recursive: true });
	fs.writeFileSync(
		path.join(d, `${sid.replace(/[^A-Za-z0-9_-]/g, "_")}.implement`),
		"",
	);
};

type ArbiterStore = typeof import("./arbiter-store.js");

export const storePath = (pick: (store: ArbiterStore) => string) =>
	withStubbedEnv({ CLAUDE_PROJECT_DIR: repo, CLAUDE_CONFIG_DIR: cfg }, () =>
		pick(createRequire(__filename)("./arbiter-store.js") as ArbiterStore),
	);

export const ledgerFor = (sid: string) => storePath((s) => s.paths.ledger(sid));

const arbiter = (args: string[], e: NodeJS.ProcessEnv, cwd?: string) => {
	const r = runInProcess(ARBITER, args, { env: e, ...(cwd ? { cwd } : {}) });
	if (r.status !== 0)
		throw new Error(`session-arbiter.js ${args[0]}: ${r.stderr}`);
};

export const record = (rel: string, sid: string, cwd?: string) =>
	arbiter(["record", rel, sid], env(), cwd);

export const ledgerHeadOf = (sid: string) =>
	ledgerHead(repo, { ...env(), CLAUDE_CODE_SESSION_ID: sid });

export const write = (rel: string, body: string) => {
	fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
	fs.writeFileSync(path.join(repo, rel), body);
};

export const gitAt = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" });

const buildTemplate = (root: string) => {
	const repoDir = path.join(root, "repo");
	fs.mkdirSync(repoDir, { recursive: true });
	gitAt(repoDir, "init", "-q", "-b", "main", ".");
	gitAt(repoDir, "config", "user.email", "test@example.com");
	gitAt(repoDir, "config", "user.name", "test");
	gitAt(repoDir, "config", "core.hooksPath", path.join(root, "no-hooks"));
	fs.writeFileSync(path.join(repoDir, "seed.md"), "seed\n");
	gitAt(repoDir, "add", "seed.md");
	gitAt(repoDir, "commit", "-qm", "init");
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

export const run = (
	mode: "start" | "stop",
	sid = ME,
	extra: Record<string, string> = {},
) => {
	const r = spawnBackstop(mode, sid, extra);
	if (!r.stdout?.trim()) return null;
	return JSON.parse(r.stdout).reason as string;
};

export const stopIn = (cwd: string, from = cwd) => {
	const r = spawnSync(BACKSTOP, ["stop"], {
		cwd: from,
		encoding: "utf8",
		input: JSON.stringify({ session_id: ME, cwd }),
		env: env(),
	});
	if (r.status === null) throw new Error(`backstop did not run: ${r.error}`);
	return r.stdout?.trim() ? (JSON.parse(r.stdout).reason as string) : null;
};

export const PARAGRAPH = `${Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ")}\n`;

export const BIG_CODE = Array.from(
	{ length: 30 },
	(_, i) => `export const x${i} = ${i};`,
).join("\n");

export const backstopFixture = () => {
	beforeEach(() => {
		dir = mkScratchDir("backstop-");
		repo = path.join(dir, "repo");
		cfg = path.join(dir, "config");
		template.instantiate(dir);
	});

	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
};
