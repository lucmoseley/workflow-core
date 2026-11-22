import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterAll, beforeEach, vi } from "vitest";
import { mkScratchDir } from "./git-fixture";

const require = createRequire(import.meta.url);

let repo: string | null = null;
let generated: string | null = null;
let configDir: string | null = null;

beforeEach(() => {
	vi.stubEnv("HUSKY", undefined);
	configDir ??= mkScratchDir("husky-config-");
	vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
});

afterAll(() => {
	for (const dir of [repo, configDir])
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	repo = null;
	generated = null;
	configDir = null;
});

function shimDir(): string {
	if (generated === null) {
		const at = mkScratchDir("husky-shim-");
		repo = at;
		const run = (args: string[]) =>
			execFileSync(process.execPath, args, {
				cwd: at,
				encoding: "utf8",
				stdio: "pipe",
			});
		execFileSync("git", ["init", "-q", "."], { cwd: at });
		const said = run([
			path.join(path.dirname(require.resolve("husky")), "bin.js"),
		]);
		const dir = path.join(at, ".husky", "_");
		if (!fs.existsSync(path.join(dir, "h")))
			throw new Error(`husky wrote no ${dir}/h: ${said.trim()}`);
		run([path.join(__dirname, "..", "install-hooks.js")]);
		generated = dir;
	}
	return generated;
}

export function huskyHooks(): string[] {
	return fs
		.readdirSync(shimDir())
		.filter((f) => !/^(h|husky\.sh|\.gitignore)$/.test(f));
}

export function installHuskyShim(root: string): void {
	const underscore = path.join(root, ".husky", "_");
	fs.cpSync(shimDir(), underscore, { recursive: true });
	execFileSync("git", ["config", "core.hooksPath", underscore], { cwd: root });
}
