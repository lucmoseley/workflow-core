// @vitest-environment node

/*
 * Pins `.husky/pre-applypatch` (mantahostels#1707): gitleaks alone, on `git am` and
 * `git rebase --apply`, refusing the apply on a finding or on a scanner that
 * cannot run — exercised through git's own hook seam.
 *
 * The gap it closes: `git am` and `git rebase --apply` (the apply backend) run
 * NEITHER `.husky/pre-commit` NOR `.husky/prepare-commit-msg`, so a patch
 * applied from a file landed on `main` having run no gate at all — gitleaks
 * among them, and `AGENTS.md` §Secrets boundary makes a committed key
 * permanent. `pre-applypatch` is the only hook either route offers that can
 * refuse: git aborts the apply on a non-zero exit, before the commit is
 * written.
 *
 * Every case drives a REAL `git am`/`git rebase --apply` in a throwaway repo
 * with its own `core.hooksPath`, because the class of bug this file guards
 * against is one layer out from the hook's logic — a hook that is correct and
 * never invoked (`docs/agents/guard-authoring.md` §The proving discipline).
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defineTemplate, mkScratchDir } from "./lib/git-fixture";
import { registerTempCleanup } from "./lib/precommit-gate-harness";
import { ROOT } from "./lib/precommit-gate-testkit";
import { runInProcess } from "./lib/run-in-process.js";

const HOOK_REL = path.join(".husky", "pre-applypatch");
const HOOK = fs.readFileSync(path.join(ROOT, HOOK_REL), "utf8");

const temps = registerTempCleanup();

/** Where a stubbed hook appends the line proving it ran. */
const LOG = "fired.log";

/**
 * A credential gitleaks' stock rules match, split across a concatenation so this
 * file is not itself a finding on the repo's own scan. Not AWS's documentation
 * key, which gitleaks 8.30.1 allowlists.
 */
const SECRET = `AKIA${"2QQ7WZ4KKPFXJ3RN"}`;

/**
 * gitleaks has no npm route, so the cases needing it skip rather than fail. The
 * probe reads WFC_GITLEAKS like the hooks do (#224): probing PATH alone would
 * skip every case below on the var-only machine the variable exists for. `||`,
 * not `??`: the hooks' `${WFC_GITLEAKS:-gitleaks}` falls back on an empty
 * value too, and `??` would not (#239).
 */
const HAS_GITLEAKS = (() => {
	try {
		execFileSync(process.env.WFC_GITLEAKS || "gitleaks", ["version"], {
			stdio: "ignore",
		});
		return true;
	} catch {
		return false;
	}
})();

interface Probe {
	root: string;
	git: (...args: string[]) => Buffer;
	/** Every hook name that fired since the last `reset()`, in order. */
	fired: () => string[];
	reset: () => void;
	gitDir: () => string;
	/** The base branch by name: `git init` follows init.defaultBranch. */
	base: string;
}

/*
 * THE FIXTURE IS BUILT ONCE AND COPIED (mantahostels#2068), via scripts/lib/git-fixture.ts:
 * `core.hooksPath` at `.husky/_`, the real shim files copied in (rather than
 * written, so a husky upgrade that changed how `_/h` resolves the user hook
 * fails here instead of silently disarming the gate), and the repo's own
 * `pre-applypatch` beside STUBBED `pre-commit` and `prepare-commit-msg` that
 * only log.
 *
 * The two stubs exist to prove a NEGATIVE — that neither fires on these routes —
 * so they must be present and armed, not merely absent.
 *
 * Both stubs bake the fixture's own ABSOLUTE `fired.log` path into their text,
 * so a naive copy would have every instance log to the TEMPLATE's log file.
 * Both `.husky/pre-commit` and `.husky/prepare-commit-msg` are passed as
 * `extraPaths` entries so `instantiate()` relinks those occurrences the same
 * way it relinks `.git`'s own absolute paths.
 */
const buildTemplate = (root: string) => {
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
	git("init", "-q", ".");
	// A repo-local identity: a machine with no global `user.email` cannot
	// commit at all (mantahostels#953).
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");

	const husky = path.join(root, ".husky");
	const underscore = path.join(husky, "_");
	fs.mkdirSync(underscore, { recursive: true });

	for (const f of ["h", "pre-applypatch", "pre-commit", "prepare-commit-msg"]) {
		const src = path.join(ROOT, ".husky", "_", f);
		fs.copyFileSync(src, path.join(underscore, f));
		fs.chmodSync(path.join(underscore, f), 0o755);
	}
	fs.copyFileSync(
		path.join(ROOT, HOOK_REL),
		path.join(husky, "pre-applypatch"),
	);
	// The route module the hook sources from beside it, and refuses without.
	const lib = path.join(root, "scripts", "lib");
	fs.mkdirSync(lib, { recursive: true });
	fs.copyFileSync(
		path.join(ROOT, "scripts", "lib", "commit-route.sh"),
		path.join(lib, "commit-route.sh"),
	);
	git("config", "core.hooksPath", underscore);

	const log = path.join(root, LOG);
	for (const f of ["pre-commit", "prepare-commit-msg"])
		fs.writeFileSync(path.join(husky, f), `echo "${f}" >> "${log}"\nexit 0\n`);

	fs.writeFileSync(path.join(root, "base.txt"), "base\n");
	git("add", "--", "base.txt");
	git("commit", "-qm", "base");
};

const template = defineTemplate(buildTemplate);

/** Hands out a copy of `buildTemplate`'s repo, plus the accessors `probe()`'s
 * callers depend on. */
function probe(): Probe {
	const root = mkScratchDir("pre-applypatch-gate-");
	temps.push(root);
	template.instantiate(root, {
		extraPaths: [
			path.join(".husky", "pre-commit"),
			path.join(".husky", "prepare-commit-msg"),
		],
	});
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
	const log = path.join(root, LOG);

	return {
		root,
		git,
		fired: () =>
			fs.existsSync(log)
				? fs.readFileSync(log, "utf8").split("\n").filter(Boolean)
				: [],
		reset: () => fs.rmSync(log, { force: true }),
		gitDir: () =>
			execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
				cwd: root,
				encoding: "utf8",
			}).trim(),
		base: execFileSync("git", ["symbolic-ref", "--short", "HEAD"], {
			cwd: root,
			encoding: "utf8",
		}).trim(),
	};
}

/**
 * Runs `git args` in `cwd`, returning the exit code and the merged output. An
 * `extraEnv` entry set to `undefined` is REMOVED from the child's environment
 * rather than passed empty, which is how a case asks for a machine that has
 * never heard of the variable.
 */
function run(
	cwd: string,
	args: string[],
	extraEnv: Record<string, string | undefined> = {},
): { code: number; output: string } {
	const env: Record<string, string | undefined> = {
		...process.env,
		GIT_EDITOR: "true",
		...extraEnv,
	};
	for (const [k, v] of Object.entries(extraEnv))
		if (v === undefined) delete env[k];
	// spawnSync, not execFileSync: the latter surfaces stderr on a throw only, so
	// a case asserting what a SUCCEEDING hook printed would never see it.
	const r = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	return {
		code: r.status ?? 1,
		output: `${r.stdout ?? ""}${r.stderr ?? ""}`,
	};
}

/** `run` with the environment left alone, which is what most cases want. */
function attempt(
	cwd: string,
	...args: string[]
): { code: number; output: string } {
	return run(cwd, args);
}

/**
 * A stub standing in for gitleaks at the hook's own `WFC_GITLEAKS` injection
 * point, exiting `code` and announcing itself so a case can tell it apart from
 * the real binary. It is what lets the #224 cases below run on a machine with
 * no gitleaks at all.
 */
function scannerStub(dir: string, code: number): string {
	const bin = path.join(dir, `scanner-exit-${code}`);
	fs.writeFileSync(
		bin,
		`#!/bin/sh\necho "STUB SCANNER RAN" >&2\nexit ${code}\n`,
	);
	fs.chmodSync(bin, 0o755);
	return bin;
}

/** A `side` branch adding `files`, leaving the probe back on the base branch. */
function sideBranch(p: Probe, files: Record<string, string>): void {
	p.git("checkout", "-q", "-b", "side");
	for (const [rel, body] of Object.entries(files)) {
		fs.writeFileSync(path.join(p.root, rel), body);
		p.git("add", "--", rel);
		p.git("commit", "-qm", rel);
	}
	p.git("checkout", "-q", p.base);
}

/** Puts the base branch one commit ahead of `side`, so a rebase has work to do. */
function diverge(p: Probe): void {
	fs.writeFileSync(path.join(p.root, "base.txt"), "moved\n");
	p.git("commit", "-qm", "moved", "--", "base.txt");
}

/** `side`'s single commit as a patch file, ready for `git am`. */
function patchOfSide(p: Probe): string {
	const dir = path.join(p.root, "patches");
	p.git("format-patch", "-1", "side", "-o", dir, "-q");
	const file = fs
		.readdirSync(dir)
		.map((f) => path.join(dir, f))
		.find((f) => f.endsWith(".patch"));
	if (!file) throw new Error("git format-patch wrote no patch");
	return file;
}

const gitLog = (p: Probe, ...args: string[]) =>
	execFileSync("git", ["log", ...args], { cwd: p.root, encoding: "utf8" });

describe(".husky/pre-applypatch", () => {
	it("is the hook husky actually dispatches", () => {
		// `_/h` exits 0 when the user hook is absent, so the two halves are
		// separately load-bearing.
		expect(fs.existsSync(path.join(ROOT, HOOK_REL))).toBe(true);
		expect(
			fs.existsSync(path.join(ROOT, ".husky", "_", "pre-applypatch")),
		).toBe(true);
	});

	it("runs gitleaks ALONE, never the gate stack", () => {
		// The design, not an accident: a rebase replaying N commits would run N
		// full stacks, and an intermediate state can fail a cross-file check that
		// only the final state satisfies (mantahostels#1706, restated at mantahostels#1707).
		const code = HOOK.split("\n").filter((l) => !l.trimStart().startsWith("#"));
		expect(code.join("\n")).not.toMatch(
			/sh -e|node scripts\/|npm run|gitleaks/,
		);
		// The scan is the route module's, called once (#1503).
		expect(
			code.filter((l) => l.includes("wfc_replay_scan pre-applypatch")).length,
		).toBe(1);
	});
});

describe("the premise: which hooks these two routes reach", () => {
	/*
	 * Facts about git 2.43.0, measured at mantahostels#1706 and re-measured at mantahostels#1707 with a
	 * marker hook on every hook name. If a future git routes either operation
	 * through `prepare-commit-msg` instead, these fail and the change is reported
	 * rather than silently doubling or dropping the gate.
	 */
	it("`git am` reaches pre-applypatch and neither pre-commit nor prepare-commit-msg", () => {
		const p = probe();
		sideBranch(p, { "side.txt": "side\n" });
		const patch = patchOfSide(p);
		p.git("reset", "-q", "--hard", "HEAD");
		p.reset();

		const r = attempt(p.root, "am", patch);
		// The two stubs are armed and log on sight; neither ran, which holds with
		// or without gitleaks on the machine. Without it the real hook refuses
		// rather than passing, so only the exit-code assertion is conditional
		// (mantahostels#1707).
		expect(p.fired()).toEqual([]);
		if (HAS_GITLEAKS) expect(r.code).toBe(0);
	});

	it("`git rebase --apply` reaches it too, so the backend choice is no escape", () => {
		const p = probe();
		sideBranch(p, { "side.txt": "side\n" });
		diverge(p);
		p.git("checkout", "-q", "side");
		p.reset();

		const r = attempt(p.root, "rebase", "--apply", p.base);
		expect(p.fired()).toEqual([]);
		if (HAS_GITLEAKS) expect(r.code).toBe(0);
	});
});

describe("what a refusal actually stops", () => {
	it.skipIf(!HAS_GITLEAKS)(
		"aborts a `git am` applying a secret, naming `git am --abort`",
		() => {
			const p = probe();
			// Built on a branch and cut to a patch file: the secret arrives as bytes
			// from outside, which is the shape this hook exists for.
			sideBranch(p, { "creds.txt": `${SECRET}\n` });
			const patch = patchOfSide(p);
			p.git("branch", "-qD", "side");
			p.git("reset", "-q", "--hard", "HEAD");
			const before = gitLog(p, "--format=%H", "-1").trim();

			const r = attempt(p.root, "am", patch);
			expect(r.code).not.toBe(0);
			expect(r.output).toContain("git am --abort");
			expect(gitLog(p, "--format=%H", "-1").trim()).toBe(before);
			// `side` is deleted, so nothing anywhere in the repo may carry it.
			expect(gitLog(p, "-p", "--all")).not.toContain(SECRET);
			// The message names an abort because there IS something to abort: git
			// leaves the apply in progress.
			expect(
				fs.existsSync(path.join(p.gitDir(), "rebase-apply", "applying")),
			).toBe(true);
		},
	);

	it.skipIf(!HAS_GITLEAKS)(
		"aborts a `git rebase --apply` replaying a secret, naming `git rebase --abort`",
		() => {
			const p = probe();
			sideBranch(p, { "creds.txt": `${SECRET}\n` });
			diverge(p);
			const onto = gitLog(p, "--format=%H", "-1").trim();
			p.git("checkout", "-q", "side");

			const r = attempt(p.root, "rebase", "--apply", p.base);
			expect(r.code).not.toBe(0);
			// The WRONG abort here would strand the tree: `git am --abort` does not
			// clear a rebase.
			expect(r.output).toContain("git rebase --abort");
			expect(r.output).not.toContain("git am --abort");
			// The rebase rewound HEAD onto the base branch and got no further.
			expect(gitLog(p, "--format=%H", "-1").trim()).toBe(onto);
			expect(gitLog(p, "-p", "HEAD")).not.toContain(SECRET);
			expect(
				fs.existsSync(path.join(p.gitDir(), "rebase-apply", "rebasing")),
			).toBe(true);
		},
	);

	it.skipIf(!HAS_GITLEAKS)("lets a clean `git am` through", () => {
		// The paired positive: the hook refuses on a finding, not on the route.
		const p = probe();
		sideBranch(p, { "side.txt": "side\n" });
		const patch = patchOfSide(p);
		p.git("reset", "-q", "--hard", "HEAD");

		expect(attempt(p.root, "am", patch).code).toBe(0);
		expect(gitLog(p, "--format=%s", "-1").trim()).toBe("side.txt");
	});

	it.skipIf(!HAS_GITLEAKS)("lets a clean `git rebase --apply` through", () => {
		const p = probe();
		sideBranch(p, { "side.txt": "side\n" });
		diverge(p);
		p.git("checkout", "-q", "side");

		expect(attempt(p.root, "rebase", "--apply", p.base).code).toBe(0);
		expect(gitLog(p, "--format=%s", "-1").trim()).toBe("side.txt");
	});

	it("refuses when gitleaks itself cannot run, rather than passing vacuously", () => {
		// A missing binary exits non-zero exactly as a finding does, and the
		// message says "did not pass" for that reason. Simulated by emptying PATH
		// of everything but git's own directory — and by unsetting WFC_GITLEAKS,
		// without which a machine that exports it would route around the point.
		const p = probe();
		sideBranch(p, { "side.txt": "side\n" });
		const patch = patchOfSide(p);
		p.git("reset", "-q", "--hard", "HEAD");
		const gitBin = path.dirname(
			execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(),
		);

		const r = run(p.root, ["am", patch], {
			PATH: gitBin,
			WFC_GITLEAKS: undefined,
		});
		expect(r.code).not.toBe(0);
		expect(r.output).toContain("did not pass");
		expect(r.output).toContain("gitleaks itself is missing");
	});

	it("runs the scanner WFC_GITLEAKS names, and refuses on its finding", () => {
		// #224: §N7 wants one named env var per external binary.
		const p = probe();
		sideBranch(p, { "side.txt": "side\n" });
		const patch = patchOfSide(p);
		p.git("reset", "-q", "--hard", "HEAD");
		const before = gitLog(p, "--format=%H", "-1").trim();

		const r = run(p.root, ["am", patch], {
			WFC_GITLEAKS: scannerStub(p.root, 1),
		});
		expect(r.code).not.toBe(0);
		expect(r.output).toContain("STUB SCANNER RAN");
		expect(r.output).toContain("did not pass");
		expect(r.output).toContain("Clear it with:  git am --abort");
		expect(gitLog(p, "--format=%H", "-1").trim()).toBe(before);
	});

	it("names `git rebase --abort`, never `git am --abort`, on a `git rebase --apply` the scanner refuses", () => {
		const p = probe();
		sideBranch(p, { "side.txt": "side\n" });
		diverge(p);
		p.git("checkout", "-q", "side");

		const r = run(p.root, ["rebase", "--apply", p.base], {
			WFC_GITLEAKS: scannerStub(p.root, 1),
		});
		expect(r.code).not.toBe(0);
		expect(r.output).toContain("Clear it with:  git rebase --abort");
		expect(r.output).not.toContain("git am --abort");
	});

	it("refuses the apply when scripts/lib/commit-route.sh is missing", () => {
		// The module holds the scan itself, so without it nothing scans (#1503).
		const p = probe();
		sideBranch(p, { "side.txt": "side\n" });
		const patch = patchOfSide(p);
		p.git("reset", "-q", "--hard", "HEAD");
		fs.rmSync(path.join(p.root, "scripts/lib/commit-route.sh"));
		const before = gitLog(p, "--format=%H", "-1").trim();

		const r = run(p.root, ["am", patch], {
			WFC_GITLEAKS: scannerStub(p.root, 0),
		});
		expect(r.code).not.toBe(0);
		expect(r.output).toContain("commit-route.sh is missing");
		expect(r.output).not.toContain("STUB SCANNER RAN");
		expect(gitLog(p, "--format=%H", "-1").trim()).toBe(before);
	});

	it("lets the apply through when the scanner WFC_GITLEAKS names passes it", () => {
		// The paired positive: the var routes the scan, it does not refuse the
		// route. Without it the case above would pass on a hook that refused
		// everything.
		const p = probe();
		sideBranch(p, { "side.txt": "side\n" });
		const patch = patchOfSide(p);
		p.git("reset", "-q", "--hard", "HEAD");

		const r = run(p.root, ["am", patch], {
			WFC_GITLEAKS: scannerStub(p.root, 0),
		});
		expect(r.code).toBe(0);
		expect(r.output).toContain("STUB SCANNER RAN");
		expect(gitLog(p, "--format=%s", "-1").trim()).toBe("side.txt");
	});
});

describe("the pre-applypatch hook's own linting", () => {
	it("is in check:sh's file set, which pre-commit's shell gate shares (#1828)", () => {
		// A husky hook nothing lints is a hook whose next edit breaks silently:
		// `npm run lint` never sees a shell file.
		const set = runInProcess(
			path.join(ROOT, "scripts/lib/formatters.js"),
			["shell-files", "--tracked"],
			{ cwd: ROOT },
		).stdout;
		expect(set.split("\n")).toContain(".husky/pre-applypatch");
	});
});

describe("the copied fixture is isolated from its template (mantahostels#2068)", () => {
	it("a commit made in the copy leaves the template untouched", () => {
		const p = probe();
		fs.writeFileSync(path.join(p.root, "only-in-copy.txt"), "x\n");
		p.git("add", "--", "only-in-copy.txt");
		p.git("commit", "-qm", "only in the copy");
		expect(gitLog(p, "--oneline").toString()).toContain("only in the copy");

		const fresh = probe();
		expect(gitLog(fresh, "--oneline").toString()).not.toContain(
			"only in the copy",
		);
	});
});
