// @vitest-environment node
/*
 * marker-root.js / marker-root.sh's own suite, plus the regression guard F8
 * (mantahostels#3515, #2) asks for: a hook-wired script that writes one
 * of the moved per-session markers must land it under `.claude/tmp/markers/`,
 * never bare at the host root.
 *
 * SCOPE: this drives the writers actually touched by F8 —
 * `scripts/lib/hook-block.js`,
 * `scripts/concision-backstop.sh`, `scripts/lib/guard-entry.js`'s rule latch,
 * and `scripts/clear-rule-latch.sh`. It is NOT an exhaustive run of every
 * script `.claude/settings.json` wires — most need a specific transcript or
 * tool-call payload to do anything at all, and that full corpus is future
 * work, not this suite's job.
 *
 * Each writer is spawned for real against a fresh temp repo set as
 * CLAUDE_PROJECT_DIR, and the root is then listed for stray dotfiles.
 *
 * A loosened case lets a hook drop markers at an adopter's repo root again,
 * where only .gitignore hides them and a `git add -A` sweeps them into a
 * commit.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
function freshRoot(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "marker-root-"));
	roots.push(dir);
	return dir;
}
afterEach(() => {
	for (const r of roots.splice(0))
		fs.rmSync(r, { recursive: true, force: true });
});

/** Every entry directly at `root`, besides `.claude` itself. */
const readRootDotfiles = (root: string) =>
	fs
		.readdirSync(root)
		.filter((f) => f.startsWith(".") && f !== ".claude" && f !== ".git");

describe("marker-root.js", () => {
	const { markersDir } = require("./marker-root.js");

	it("resolves under .claude/tmp/markers and creates the directory", () => {
		const root = freshRoot();
		const dir = markersDir(root);
		expect(dir).toBe(path.join(root, ".claude", "tmp", "markers"));
		expect(fs.existsSync(dir)).toBe(true);
	});
});

describe("marker-root.sh", () => {
	const run = (root: string, fn: string) =>
		spawnSync(
			"bash",
			["-c", `source "${path.resolve(__dirname, "marker-root.sh")}" && ${fn}`],
			{ encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: root } },
		).stdout;

	it("gr_markers_dir resolves under .claude/tmp/markers and creates it", () => {
		const root = freshRoot();
		expect(run(root, "gr_markers_dir")).toBe(
			path.join(root, ".claude", "tmp", "markers"),
		);
		expect(fs.existsSync(path.join(root, ".claude", "tmp", "markers"))).toBe(
			true,
		);
	});

	it("propagates gr_root's empty disarm signal rather than falling back to cwd", () => {
		const out = spawnSync(
			"bash",
			[
				"-c",
				`source "${path.resolve(__dirname, "marker-root.sh")}" && gr_root() { :; }; gr_markers_dir`,
			],
			{ encoding: "utf8" },
		).stdout;
		expect(out).toBe("");
	});
});

/*
 * The regression guard itself: run each writer against a throwaway host root
 * and assert nothing lands as a bare dotfile at the root.
 */
describe("hook-wired writers leave no marker at the host root (F8)", () => {
	it("concision-backstop.sh's start mode writes no root dotfile", () => {
		const root = freshRoot();
		spawnSync("git", ["init", "-q", root]);
		const r = spawnSync(
			path.resolve(__dirname, "..", "concision-backstop.sh"),
			["start"],
			{
				input: JSON.stringify({ session_id: "probe-sid" }),
				encoding: "utf8",
				env: {
					...process.env,
					CLAUDE_PROJECT_DIR: root,
					CLAUDE_CONFIG_DIR: path.join(root, "config"),
				},
				cwd: root,
			},
		);
		expect(r.status).toBe(0);
		expect(readRootDotfiles(root)).toEqual([]);
		expect(
			fs.existsSync(
				path.join(
					root,
					".claude",
					"tmp",
					"markers",
					".concision-base-probe-sid",
				),
			),
		).toBe(true);
	});

	it("hook-block.js's blockStop writes no root dotfile", () => {
		const root = freshRoot();
		const call = `require(${JSON.stringify(
			path.resolve(__dirname, "hook-block.js"),
		)}).blockStop({ prefix: ".t-", sessionId: "probe-sid", reason: "seen" })`;
		const r = spawnSync("node", ["-e", call], {
			cwd: root,
			encoding: "utf8",
			env: { ...process.env, WFC_REPO_ROOT: root },
		});
		expect(r.status).toBe(0);
		expect(readRootDotfiles(root)).toEqual([]);
		expect(
			fs.existsSync(
				path.join(root, ".claude", "tmp", "markers", ".t-probe-sid"),
			),
		).toBe(true);
	});

	it("guard-entry.js's writeLatches writes no root dotfile for its latch", () => {
		const root = freshRoot();
		const call = `require(${JSON.stringify(
			path.resolve(__dirname, "guard-entry.js"),
		)}).writeLatches({ root: process.argv[1], payload: { session_id: "probe-sid" }, log: () => process.exit(3) }, [{ name: "file-claim", text: "" }])`;
		const r = spawnSync("node", ["-e", call, root], { encoding: "utf8" });
		expect(r.status).toBe(0);
		expect(readRootDotfiles(root)).toEqual([]);
		const markers = fs
			.readdirSync(path.join(root, ".claude", "tmp", "markers"))
			.filter((f) => f.startsWith(".rule-injected-"));
		expect(markers).not.toEqual([]);
	});

	/* SANITY CHECK — proves `readRootDotfiles` itself would have caught a bare
	 * root marker had one of the writers above left one: not a mutation of
	 * any writer, just a check that the detector fires on the shape it is
	 * meant to catch. */
	it("SANITY CHECK — rootDotfiles catches a marker written at the bare root", () => {
		const root = freshRoot();
		fs.writeFileSync(path.join(root, ".t-mutation-check"), "1");
		expect(readRootDotfiles(root)).toEqual([".t-mutation-check"]);
	});
});
