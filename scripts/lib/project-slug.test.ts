// @vitest-environment node
/*
 * The guarantee under test is ONE thing: every site that names a project's
 * transcript directory spells the slug the same way, and that way is the one
 * the harness actually writes — every non-alphanumeric character to its own
 * hyphen, not the slashes alone.
 *
 * Every caller is asserted here rather than each in its own suite: the fault is
 * DIVERGENCE, which a per-caller suite cannot see.
 *
 * The source scan for callers with no export is `project-slug-scan.test.ts`,
 * apart so this file does not read the scripts tree (#1900).
 *
 * Settled at mantahostels#1963 and mantahostels#1982. The arbiter and the hooks
 * that find their own session's transcript build the path from this slug, so a
 * loosened case lets one site look in a directory the harness never wrote —
 * silently reading nothing.
 */

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
	// Unset, so the cases read the main checkout owning the cwd.
	beforeEach(() => vi.stubEnv("CLAUDE_PROJECT_DIR", undefined));
	afterEach(() => {
		process.chdir(cwd);
	});

	/*
	 * A SUBDIRECTORY OF THE REPO, not `os.tmpdir()` (#1). Since the seam,
	 * `slugForRepo()` names the HOST repo — `CLAUDE_PROJECT_DIR`, else the main
	 * checkout owning the cwd — rather than the checkout this file sits in, so from
	 * outside any repository it answers with the cwd and SHOULD. The defect this
	 * case exists to catch is unchanged: a script invoked from a subdirectory
	 * must still name the root, not the directory it was invoked from.
	 */
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
	const saved = { cwd: process.cwd(), config: process.env.CLAUDE_CONFIG_DIR };
	const dirs: string[] = [];

	afterEach(() => {
		vi.unstubAllEnvs();
		process.chdir(saved.cwd);
		for (const d of dirs.splice(0))
			fs.rmSync(d, { recursive: true, force: true });
		if (saved.config === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = saved.config;
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
		process.env.CLAUDE_CONFIG_DIR = path.join(os.tmpdir(), "slug-cfg");
		const core = require("./arbiter-core.js");
		expect(core.stateDir()).toBe(
			path.join(
				process.env.CLAUDE_CONFIG_DIR,
				"projects",
				projectSlug(core.repoRoot()),
			),
		);
	});

	it("hook-message's fallback transcript resolves a dotted project root", () => {
		// The dot in the name is the whole point: the slashes-only spelling this
		// replaced agrees with the right one on every path without one.
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "manta.slug."));
		dirs.push(root);
		process.chdir(root);
		process.env.CLAUDE_CONFIG_DIR = "/cfg";
		const hookMessage = require("./hook-message.js");
		const got = hookMessage.transcriptPath(null, "sid1");
		expect(got).toBe(
			path.join("/cfg", "projects", projectSlug(process.cwd()), "sid1.jsonl"),
		);
		/* The slashes-only spelling left the dot in place, so the segment is
		 * where the two disagree — the `.jsonl` suffix carries a dot either way. */
		expect(got.split(path.sep).at(-2)).not.toContain(".");
	});
});
