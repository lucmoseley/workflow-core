// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mainWorktreeOf } from "./git-fixture";

const {
	projectSlug,
	slugForRepo,
	transcriptPath,
} = require("./project-slug.js");

describe("projectSlug — the spelling the harness writes", () => {
	it("maps a dot to a hyphen, not only the slashes", () => {
		expect(projectSlug("/home/lucmo/.claude3/jobs/12fb6c3a/tmp")).toBe(
			"-home-lucmo--claude3-jobs-12fb6c3a-tmp",
		);
	});

	it("preserves case", () => {
		expect(projectSlug("/tmp/armA")).toBe("-tmp-armA");
	});

	it("gives one hyphen per character, never one per run", () => {
		expect(projectSlug("/a..b")).toBe("-a--b");
	});

	it("defaults to the cwd", () => {
		expect(projectSlug()).toBe(projectSlug(process.cwd()));
	});
});

describe("transcriptPath — a session's transcript on a seat", () => {
	it("sits under the seat's project directory for its cwd", () => {
		expect(transcriptPath("/h/.claude2", "/r/repo.x", "s1")).toBe(
			path.join("/h/.claude2", "projects", "-r-repo-x", "s1.jsonl"),
		);
	});
});

describe("slugForRepo — for a script with no repoRoot() of its own", () => {
	const cwd = process.cwd();
	const repo = path.join(__dirname, "..", "..");
	beforeEach(() => vi.stubEnv("CLAUDE_PROJECT_DIR", undefined));
	afterEach(() => {
		process.chdir(cwd);
	});

	it("names the repo root, not the directory the caller was invoked from", () => {
		const from = slugForRepo();
		process.chdir(__dirname);
		expect(slugForRepo()).toBe(from);
		expect(slugForRepo()).not.toBe(projectSlug());
	});

	it("agrees with projectSlug on the main checkout owning the repo root", () => {
		expect(slugForRepo()).toBe(projectSlug(mainWorktreeOf(repo)));
	});
});

describe("every caller derives the slug from that one function", () => {
	const cwd = process.cwd();
	const dirs: string[] = [];

	afterEach(() => {
		vi.unstubAllEnvs();
		process.chdir(cwd);
		for (const d of dirs.splice(0))
			fs.rmSync(d, { recursive: true, force: true });
	});

	it("guard-fires transcriptDirs spells the main checkout's directory with it", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "manta.slug."));
		dirs.push(root);
		vi.stubEnv("CLAUDE_PROJECT_DIR", root);
		const { transcriptDirs } = require("./guard-fires.js");
		expect(transcriptDirs()[0]).toBe(
			path.join(
				process.env.CLAUDE_CONFIG_DIR ||
					path.join(process.env.HOME || "", ".claude"),
				"projects",
				projectSlug(fs.realpathSync(root)),
			),
		);
	});

	it("arbiter-core stateDir spells it with it", () => {
		const config = path.join(os.tmpdir(), "slug-cfg");
		vi.stubEnv("CLAUDE_CONFIG_DIR", config);
		const core = require("./arbiter-core.js");
		expect(core.stateDir()).toBe(
			path.join(config, "projects", projectSlug(core.repoRoot())),
		);
	});

	it("hook-message's fallback transcript resolves a dotted project root", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "manta.slug."));
		dirs.push(root);
		process.chdir(root);
		vi.stubEnv("CLAUDE_CONFIG_DIR", "/cfg");
		const hookMessage = require("./hook-message.js");
		const got = hookMessage.transcriptPath(null, "sid1");
		expect(got).toBe(
			path.join("/cfg", "projects", projectSlug(process.cwd()), "sid1.jsonl"),
		);
		expect(got.split(path.sep).at(-2)).not.toContain(".");
	});
});
