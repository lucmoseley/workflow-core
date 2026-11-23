// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineTemplate } from "./lib/git-fixture";
import { OWN_LOOKUP } from "./lib/husky-shim.js";
import { keptSpawn } from "./lib/kept-spawn.js";
import { runInProcess } from "./lib/run-in-process.js";
import { shellQuote } from "./lib/sh-quote.js";

const ROOT = path.resolve(__dirname, "..");
const HUSKY = path.join(ROOT, "node_modules", "husky", "bin.js");
const INSTALL = path.join(ROOT, "scripts", "install-hooks.js");
const STUBS = [
	"landing-push-gate.js",
	"public-push-gate.js",
	"run-mod-tests.js",
];

let tmp: string;
let shared: string;
let wt: string;

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const install = (cwd: string) => runInProcess(INSTALL, [], { cwd });

const writeChecker = (dir: string, body: string) =>
	fs.writeFileSync(path.join(dir, "scripts", "check-guard-registry.js"), body);

const env = () => {
	const e: NodeJS.ProcessEnv = { ...process.env, WFC_MODULES: "" };
	delete e.WFC_PLUGIN_ROOT;
	delete e.HUSKY;
	return e;
};

const seeded = defineTemplate((root) => {
	const remote = path.join(root, "remote.git");
	const work = path.join(root, "shared");
	git(root, "init", "-q", "--bare", remote);
	git(root, "init", "-q", "-b", "main", work);
	git(work, "config", "user.email", "t@t");
	git(work, "config", "user.name", "t");
	git(work, "remote", "add", "origin", remote);

	fs.mkdirSync(path.join(work, ".husky"));
	fs.copyFileSync(
		path.join(ROOT, ".husky", "pre-push"),
		path.join(work, ".husky", "pre-push"),
	);
	fs.writeFileSync(
		path.join(work, ".husky", "pre-commit"),
		'echo "own pre-commit" >&2\n',
	);
	const scripts = path.join(work, "scripts");
	fs.mkdirSync(scripts);
	fs.copyFileSync(
		path.join(ROOT, "scripts", "landing-registry-gate.js"),
		path.join(scripts, "landing-registry-gate.js"),
	);
	fs.symlinkSync(path.join(ROOT, "scripts", "lib"), path.join(scripts, "lib"));
	fs.copyFileSync(
		path.join(ROOT, "scripts", "merge-registry-anchors.js"),
		path.join(scripts, "merge-registry-anchors.js"),
	);
	fs.copyFileSync(
		path.join(ROOT, ".gitattributes"),
		path.join(work, ".gitattributes"),
	);
	for (const stub of STUBS)
		fs.writeFileSync(path.join(scripts, stub), "process.exitCode = 0;\n");
	writeChecker(
		work,
		'process.stderr.write("FAIL: worktree checker\\n");\nprocess.exitCode = 1;\n',
	);
	git(work, "add", ".");
	git(work, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "seed");
	git(work, "push", "-q", "--no-verify", "origin", "main");
});

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "install-hooks-"));
	seeded.instantiate(tmp);
	shared = path.join(tmp, "shared");
	wt = path.join(tmp, "wt");

	keptSpawn("boundary").execFileSync(process.execPath, [HUSKY], {
		cwd: shared,
		env: env(),
	});
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

	it("refuses a worktree's queue push on its own checker's FAIL while the shared hook calls no registry gate and its checker is BROKEN (#3125)", () => {
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

		const r = spawnSync("git", ["push", "origin", "HEAD:refs/heads/queue/wt"], {
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

	it("defines the registry anchors' merge driver absolute into the canonical checkout from a worktree too (#4171)", () => {
		expect(install(wt).status).toBe(0);
		expect(git(wt, "config", "merge.registry-anchors.driver")).toBe(
			`node ${shellQuote(path.join(fs.realpathSync(shared), "scripts", "merge-registry-anchors.js"))} %O %A %B`,
		);
		expect(git(wt, "config", "merge.registry-anchors.name")).not.toBe("");
	});

	it("merges a registry row both sides moved with no conflict, keeping the current side's digest (#4171)", () => {
		const anchors = path.join(wt, ".claude", "guard-registry-anchors.json");
		const save = (rows: Record<string, string>, msg: string) => {
			fs.mkdirSync(path.dirname(anchors), { recursive: true });
			fs.writeFileSync(anchors, `${JSON.stringify(rows, null, "\t")}\n`);
			git(wt, "add", "-A");
			git(wt, "-c", "core.hooksPath=/dev/null", "commit", "-qm", msg);
			return git(wt, "rev-parse", "HEAD");
		};
		const base = save({ "a.js": "a0", "b.js": "b0" }, "base");
		const side = save({ "a.js": "a1", "b.js": "b0", "c.js": "c1" }, "side");
		git(wt, "checkout", "-q", "--detach", base);
		save({ "a.js": "a2", "b.js": "b2" }, "ours");

		const r = spawnSync(
			"git",
			["-c", "core.hooksPath=/dev/null", "merge", "--no-edit", side],
			{ cwd: wt, encoding: "utf8" },
		);
		expect(r.status, r.stdout + r.stderr).toBe(0);
		expect(fs.readFileSync(anchors, "utf8")).toBe(
			`${JSON.stringify({ "a.js": "a2", "b.js": "b2", "c.js": "c1" }, null, "\t")}\n`,
		);
	});

	it("leaves an already-patched shim byte-identical on a rerun", () => {
		const before = fs.readFileSync(shim(), "utf8");
		expect(install(shared).status).toBe(0);
		expect(fs.readFileSync(shim(), "utf8")).toBe(before);
	});

	it("patches a stock shim husky copied read-only, leaving it writable for husky's next copy (#4372)", () => {
		keptSpawn("boundary").execFileSync(process.execPath, [HUSKY], {
			cwd: shared,
			env: env(),
		});
		fs.chmodSync(shim(), 0o444);
		expect(install(shared).status).toBe(0);
		expect(fs.readFileSync(shim(), "utf8")).toContain(OWN_LOOKUP);
		expect(fs.statSync(shim()).mode & 0o200).toBe(0o200);
		keptSpawn("boundary").execFileSync(process.execPath, [HUSKY], {
			cwd: shared,
			env: env(),
		});
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
