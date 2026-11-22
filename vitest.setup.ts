import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, inject } from "vitest";
import "@testing-library/jest-dom/vitest";

const runTempRoot = inject("wfcTempRoot");
if (runTempRoot) process.env.TMPDIR = runTempRoot;

(
	globalThis as { __wfcReadAudit?: { claim: (file: string) => void } }
).__wfcReadAudit?.claim(String(expect.getState().testPath));

(
	createRequire(import.meta.url)("./scripts/lib/run-memory.js") as {
		claimFile: (file: string) => void;
	}
).claimFile(String(expect.getState().testPath));

const { GIT_DIR_VARS } = createRequire(import.meta.url)(
	"./scripts/lib/read-audit-git.js",
) as { GIT_DIR_VARS: string[] };
for (const name of GIT_DIR_VARS) delete process.env[name];

delete process.env.WFC_LANDER_RUN;
delete process.env.WFC_ROWLESS_RUN;

delete process.env.WFC_GATE_SEAT;

delete process.env.WFC_MERGE_PARENTS;

/* #5547 */
delete process.env.CLAUDE_JOB_DIR;

delete process.env.WFC_PASS_STORE_CACHED;

process.env.WFC_GATE_JUDGE = "off";

process.env.WFC_GATE_CITED = "off";

// code-edges loads: scripts/lib/host-git-guard/git
const guardDir = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"scripts/lib/host-git-guard",
);
const pathDirs = (process.env.PATH ?? "")
	.split(path.delimiter)
	.filter((dir) => dir && dir !== guardDir);
const realGit = pathDirs
	.filter((dir) => path.basename(dir) !== "host-git-guard")
	.map((dir) => path.join(dir, "git"))
	.find((git) => {
		try {
			fs.accessSync(git, fs.constants.X_OK);
			return true;
		} catch {
			return false;
		}
	});
if (realGit) process.env.WFC_HOST_GIT_REAL = realGit;
process.env.PATH = [guardDir, ...pathDirs].join(path.delimiter);
process.env.WFC_HOST_GIT_DIR = execFileSync(
	"git",
	["rev-parse", "--path-format=absolute", "--git-common-dir"],
	{ cwd: guardDir, encoding: "utf8" },
).trim();

const testConfigDir = fs.mkdtempSync(
	path.join(os.tmpdir(), "wfc-test-config-"),
);
process.env.CLAUDE_CONFIG_DIR = testConfigDir;
afterAll(() => fs.rmSync(testConfigDir, { recursive: true, force: true }));

process.env.WFC_CLAUDE_CONFIG_A = path.join(testConfigDir, "no-seat-a");
process.env.WFC_CLAUDE_CONFIG_B = path.join(testConfigDir, "no-seat-b");
process.env.WFC_CLAUDE_CONFIG_C = path.join(testConfigDir, "no-seat-c");

process.env.MEMWATCH_MINUTE_LOG = path.join(
	testConfigDir,
	"no-memwatch-minute.jsonl",
);

process.env.WFC_JOURNALCTL = path.join(testConfigDir, "no-journalctl");

const testHostDir = fs.mkdtempSync(path.join(os.tmpdir(), "wfc-test-host-"));
process.env.CLAUDE_PROJECT_DIR = testHostDir;
afterAll(() => fs.rmSync(testHostDir, { recursive: true, force: true }));

const testRefillDir = fs.mkdtempSync(
	path.join(os.tmpdir(), "wfc-test-refill-"),
);
process.env.WFC_REFILL_DIR = testRefillDir;
afterAll(() => fs.rmSync(testRefillDir, { recursive: true, force: true }));

const testGuardCodeDir = fs.mkdtempSync(
	path.join(os.tmpdir(), "wfc-test-guard-code-"),
);
process.env.WFC_GUARD_CODE_DIR = path.join(testGuardCodeDir, ".guard-code");
afterAll(() => fs.rmSync(testGuardCodeDir, { recursive: true, force: true }));

const testSecretsDir = fs.mkdtempSync(
	path.join(os.tmpdir(), "wfc-test-secrets-"),
);
process.env.WFC_SECRETS_FILE = path.join(testSecretsDir, "secrets.env");
afterAll(() => fs.rmSync(testSecretsDir, { recursive: true, force: true }));

process.env.WFC_SHARD_TIMINGS = path.join(testSecretsDir, "no-timings.csv");

process.env.WFC_RULES_DIR ??= path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"docs/agents/rules",
);

const config = createRequire(import.meta.url)(
	"./scripts/lib/workflow-core-config.js",
);
process.env.WFC_MODULES ??= config.MODULES.join(",");

process.env.WFC_LOAD_CEILING = "";

process.env.WFC_ALWAYS_LOADED ??= (
	config.readConfig({ root: path.dirname(fileURLToPath(import.meta.url)) })
		.alwaysLoaded ?? []
).join(",");

process.env.WFC_OUTPUT_STYLE ??=
	config.readConfig({ root: path.dirname(fileURLToPath(import.meta.url)) })
		.overrides.output_style ?? "";

const SUITE_GIT_CONFIG: Record<string, string> = {
	"maintenance.auto": "false",
	"gc.auto": "0",
};
let gitConfigCount = Number(process.env.GIT_CONFIG_COUNT ?? 0);
const presentGitPairs = new Set(
	Array.from(
		{ length: gitConfigCount },
		(_, i) =>
			`${process.env[`GIT_CONFIG_KEY_${i}`]}=${process.env[`GIT_CONFIG_VALUE_${i}`]}`,
	),
);
for (const [key, value] of Object.entries(SUITE_GIT_CONFIG)) {
	if (presentGitPairs.has(`${key}=${value}`)) continue;
	process.env[`GIT_CONFIG_KEY_${gitConfigCount}`] = key;
	process.env[`GIT_CONFIG_VALUE_${gitConfigCount}`] = value;
	gitConfigCount++;
}
process.env.GIT_CONFIG_COUNT = String(gitConfigCount);

(
	globalThis as { __wfcReadAudit?: { settle: () => void } }
).__wfcReadAudit?.settle();
