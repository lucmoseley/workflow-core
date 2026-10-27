// @vitest-environment node
/*
 * A linked worktree's commit and push run that worktree's own .husky hook,
 * not the shared checkout's working copy that core.hooksPath names (#3125,
 * #3138).
 *
 * The fixture installs the hooks as package.json's `prepare` does — husky,
 * then scripts/install-hooks.js — and breaks the shared checkout's copy after
 * the worktree is cut, as a shared tree left behind `landing` or holding a
 * neighbour's half-written edit does.
 *
 * Loosen it and a neighbour's stale hook judges every worktree's commit again.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const HUSKY = path.join(ROOT, "node_modules", "husky", "bin.js");
const INSTALL = path.join(ROOT, "scripts", "install-hooks.js");
const STUBS = [
	"check-test-marker.js",
	"landing-push-gate.js",
	"public-push-gate.js",
	"run-mod-tests.js",
];

let tmp: string;
let shared: string;
let wt: string;

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const install = (cwd: string) =>
	spawnSync(process.execPath, [INSTALL], { cwd, encoding: "utf8" });

const writeChecker = (dir: string, body: string) =>
	fs.writeFileSync(path.join(dir, "scripts", "check-guard-registry.js"), body);

const env = () => {
	const e: NodeJS.ProcessEnv = { ...process.env, WFC_MODULES: "landing" };
	delete e.WFC_PLUGIN_ROOT;
	delete e.HUSKY;
	return e;
};

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "install-hooks-"));
	const remote = path.join(tmp, "remote.git");
	shared = path.join(tmp, "shared");
	wt = path.join(tmp, "wt");
	git(tmp, "init", "-q", "--bare", remote);
	git(tmp, "init", "-q", "-b", "main", shared);
	git(shared, "config", "user.email", "t@t");
	git(shared, "config", "user.name", "t");
	git(shared, "remote", "add", "origin", remote);

	fs.mkdirSync(path.join(shared, ".husky"));
	fs.copyFileSync(
		path.join(ROOT, ".husky", "pre-push"),
		path.join(shared, ".husky", "pre-push"),
	);
	fs.writeFileSync(
		path.join(shared, ".husky", "pre-commit"),
		'echo "own pre-commit" >&2\n',
	);
	const scripts = path.join(shared, "scripts");
	fs.mkdirSync(scripts);
	fs.copyFileSync(
		path.join(ROOT, "scripts", "landing-registry-gate.js"),
		path.join(scripts, "landing-registry-gate.js"),
	);
	fs.symlinkSync(path.join(ROOT, "scripts", "lib"), path.join(scripts, "lib"));
	for (const stub of STUBS)
		fs.writeFileSync(path.join(scripts, stub), "process.exitCode = 0;\n");
	writeChecker(
		shared,
		'process.stderr.write("FAIL: worktree checker\\n");\nprocess.exitCode = 1;\n',
	);
	git(shared, "add", ".");
	git(shared, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "seed");
	git(shared, "push", "-q", "--no-verify", "origin", "main:landing");

	execFileSync(process.execPath, [HUSKY], { cwd: shared, env: env() });
	expect(install(shared).status).toBe(0);
	git(shared, "worktree", "add", "-q", "--detach", wt);
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("a linked worktree's hooks (#3138)", () => {
	it("runs the worktree's own pre-commit while the shared copy refuses every commit", () => {
		fs.writeFileSync(
			path.join(shared, ".husky", "pre-commit"),
			'echo "shared pre-commit" >&2\nexit 1\n',
		);
		const r = spawnSync("git", ["commit", "--allow-empty", "-m", "carry"], {
			cwd: wt,
			encoding: "utf8",
			env: env(),
		});
		expect(r.stderr).not.toContain("shared pre-commit");
		expect(r.stderr).toContain("own pre-commit");
		expect(r.status).toBe(0);
	});

	it("runs the canonical pre-commit where the worktree's tree carries none", () => {
		fs.rmSync(path.join(wt, ".husky", "pre-commit"));
		fs.writeFileSync(
			path.join(shared, ".husky", "pre-commit"),
			'echo "shared pre-commit" >&2\nexit 1\n',
		);
		const r = spawnSync("git", ["commit", "--allow-empty", "-m", "carry"], {
			cwd: wt,
			encoding: "utf8",
			env: env(),
		});
		expect(r.stderr).toContain("shared pre-commit");
		expect(r.status).not.toBe(0);
	});

	it("refuses a worktree's push to landing on its own checker's FAIL while the shared hook calls no registry gate and its checker is BROKEN (#3125)", () => {
		writeChecker(
			shared,
			'process.stderr.write("BROKEN: ENOENT dispatch-cores.json\\n");\nprocess.exitCode = 2;\n',
		);
		const sharedHook = path.join(shared, ".husky", "pre-push");
		fs.writeFileSync(
			sharedHook,
			fs
				.readFileSync(sharedHook, "utf8")
				.replaceAll("landing-registry-gate.js", "no-such-gate.js"),
		);
		git(
			wt,
			"-c",
			"core.hooksPath=/dev/null",
			"commit",
			"-q",
			"--allow-empty",
			"-m",
			"carry",
		);

		const r = spawnSync("git", ["push", "origin", "HEAD:landing"], {
			cwd: wt,
			encoding: "utf8",
			env: env(),
		});
		expect(r.stderr).not.toContain("BROKEN");
		expect(r.stderr).toContain("FAIL: worktree checker");
		expect(r.stderr).toContain("pre-push: refused");
		expect(r.status).toBe(1);
	});
});

describe("install-hooks.js", () => {
	const shim = () => path.join(shared, ".husky", "_", "h");

	it("pins core.hooksPath absolute into the canonical checkout from a worktree too", () => {
		expect(install(wt).status).toBe(0);
		expect(git(wt, "config", "core.hooksPath")).toBe(
			path.join(fs.realpathSync(shared), ".husky", "_"),
		);
	});

	it("leaves an already-patched shim byte-identical on a rerun", () => {
		const before = fs.readFileSync(shim(), "utf8");
		expect(install(shared).status).toBe(0);
		expect(fs.readFileSync(shim(), "utf8")).toBe(before);
	});

	it("exits 2 naming the shim, leaving it untouched, where husky's lookup line is gone", () => {
		fs.writeFileSync(shim(), '#!/usr/bin/env sh\nsh -e "$0.hook"\n');
		const r = install(shared);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("BROKEN");
		expect(r.stderr).toContain(path.join(".husky", "_", "h"));
		expect(fs.readFileSync(shim(), "utf8")).toBe(
			'#!/usr/bin/env sh\nsh -e "$0.hook"\n',
		);
	});
});
