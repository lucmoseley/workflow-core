// @vitest-environment node

/*
 * scripts/lib/commit-route.sh (#1503): which git operation made the commit a
 * hook is asked about, the route's abort, and the replay secrets scan.
 *
 * The route cases drive REAL git operations in a throwaway repo whose every
 * hook sources the live module and logs the route it reads, because what the
 * module encodes is git's own behaviour per hook — which a constructed $GIT_DIR
 * can only restate. pre-commit runs under bash with `set -u`, as the two inner
 * gates do; every other hook under `sh`, as husky runs them.
 *
 * A loosened row lets a hook gate a replay as an ordinary commit or stand an
 * ordinary commit down as a replay, on a route git does not show it as.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderHookShim } from "./adopter-skeleton";
import { newRepo, registerTempCleanup } from "./precommit-gate-harness";
import { ROOT } from "./precommit-gate-testkit";

const LIB = path.join(ROOT, "scripts", "lib", "commit-route.sh");
const temps = registerTempCleanup(afterEach);

/** The hooks a commit route can reach; pre-push and post-merge never ask. */
const HOOKS = [
	"applypatch-msg",
	"pre-applypatch",
	"post-applypatch",
	"pre-commit",
	"pre-merge-commit",
	"prepare-commit-msg",
	"commit-msg",
	"post-commit",
];

/** A marker hook logging `<hook> <route>` for each step a case labels `act`. */
function markerHook(hook: string): string {
	const ask = `route="$(wfc_commit_route ${hook} "$(git rev-parse --absolute-git-dir)")"`;
	const log = `[ "$LABEL" != act ] || echo "\${WFC_ASKER:+$WFC_ASKER>}${hook} $route" >> "$ROUTE_LOG"`;
	if (hook === "pre-commit")
		return `#!/usr/bin/env bash\nset -uo pipefail\nsource "${LIB}"\n${ask}\n${log}\n`;
	// pre-merge-commit runs pre-commit as the real one does, so the merge
	// that has not written MERGE_HEAD yet is asked about from inside it too.
	const nested =
		hook === "pre-merge-commit"
			? `WFC_ASKER=pre-merge-commit "$(dirname "$0")/pre-commit"\n`
			: "";
	return `#!/bin/sh\n. "${LIB}"\n${ask}\n${log}\n${nested}`;
}

type Git = (...args: string[]) => string;

/** A repo with the marker hooks installed, one base commit, and a `git` whose
 * steps log only once `act()` is called. */
function routeRepo() {
	const { root } = newRepo("commit-route-", temps);
	const log = path.join(root, ".git", "route.log");
	const hooks = path.join(root, ".git", "marker-hooks");
	fs.mkdirSync(hooks);
	for (const h of HOOKS)
		fs.writeFileSync(path.join(hooks, h), markerHook(h), { mode: 0o755 });
	let label = "setup";
	const env = () => ({
		...process.env,
		GIT_EDITOR: "true",
		LABEL: label,
		ROUTE_LOG: log,
	});
	const git: Git = (...args) =>
		execFileSync("git", args, { cwd: root, env: env(), encoding: "utf8" });
	/** A step expected to stop, as a conflict does. */
	const stops = (...args: string[]) =>
		expect(
			spawnSync("git", args, { cwd: root, env: env(), stdio: "ignore" }).status,
		).not.toBe(0);
	git("config", "core.hooksPath", hooks);
	const commit = (file: string, body: string) => {
		fs.writeFileSync(path.join(root, file), `${body}\n`);
		git("add", "--", file);
		git("commit", "-qm", `${file} ${body}`);
	};
	commit("f", "base");
	const base = git("symbolic-ref", "--short", "HEAD").trim();
	return {
		root,
		git,
		stops,
		commit,
		base,
		act: () => {
			label = "act";
		},
		routes: () =>
			fs.existsSync(log)
				? fs.readFileSync(log, "utf8").split("\n").filter(Boolean)
				: [],
	};
}

type Repo = ReturnType<typeof routeRepo>;

/** `side` with one commit per file, the base branch one commit ahead of it. */
function forked(r: Repo, files: string[], baseFile = "m"): void {
	r.git("checkout", "-q", "-b", "side");
	for (const f of files) r.commit(f, "side");
	r.git("checkout", "-q", r.base);
	r.commit(baseFile, "moved");
}

const COMMIT_HOOKS = (route: string, from = "pre-commit") =>
	["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit"]
		.slice(["pre-commit", "prepare-commit-msg"].indexOf(from))
		.map((h) => `${h} ${route}`);

/** One replayed commit's hooks, for an operation replaying two. */
const twice = (lines: string[]) => [...lines, ...lines];

/*
 * Each row is the marker table in commit-route.sh's header, driven: the hooks
 * that fire on the route, in firing order, and the route each one reads.
 */
const CASES: [string, (r: Repo) => void, string[]][] = [
	[
		"an ordinary commit",
		(r) => {
			r.act();
			r.commit("a", "x");
		},
		COMMIT_HOOKS("commit"),
	],
	[
		"`git commit --no-verify`",
		(r) => {
			fs.writeFileSync(path.join(r.root, "a"), "x\n");
			r.git("add", "a");
			r.act();
			r.git("commit", "-q", "--no-verify", "-m", "a");
		},
		["prepare-commit-msg commit", "post-commit commit"],
	],
	[
		"a clean `git merge`, before and after MERGE_HEAD exists",
		(r) => {
			forked(r, ["s"]);
			r.act();
			r.git("merge", "-q", "--no-edit", "side");
		},
		[
			"pre-merge-commit merge",
			"pre-merge-commit>pre-commit merge",
			"prepare-commit-msg merge",
			"commit-msg merge",
		],
	],
	[
		"`git pull`'s merge, whose reflog action is not `merge`",
		(r) => {
			forked(r, ["s"]);
			r.act();
			r.git("pull", "-q", "--no-rebase", "--no-edit", ".", "side");
		},
		[
			"pre-merge-commit merge",
			"pre-merge-commit>pre-commit merge",
			"prepare-commit-msg merge",
			"commit-msg merge",
		],
	],
	[
		"`git merge --no-verify`",
		(r) => {
			forked(r, ["s"]);
			r.act();
			r.git("merge", "-q", "--no-verify", "--no-edit", "side");
		},
		["prepare-commit-msg merge"],
	],
	[
		"the `git commit` resolving a conflicted merge",
		(r) => {
			forked(r, ["f"], "f");
			r.stops("merge", "-q", "--no-edit", "side");
			fs.writeFileSync(path.join(r.root, "f"), "resolved\n");
			r.git("add", "f");
			r.act();
			r.git("commit", "-q", "--no-edit");
		},
		[...COMMIT_HOOKS("merge").slice(0, 3), "post-commit commit"],
	],
	[
		"a clean `git cherry-pick`",
		(r) => {
			forked(r, ["s"]);
			r.act();
			r.git("cherry-pick", "side");
		},
		["prepare-commit-msg cherry-pick", "post-commit cherry-pick"],
	],
	[
		"a cherry-picked range, which sets `sequencer` too",
		(r) => {
			forked(r, ["s", "t"]);
			r.act();
			r.git("cherry-pick", `${r.base}..side`);
		},
		twice(["prepare-commit-msg cherry-pick", "post-commit cherry-pick"]),
	],
	[
		"`git cherry-pick --continue`",
		(r) => {
			forked(r, ["f"], "f");
			r.stops("cherry-pick", "side");
			fs.writeFileSync(path.join(r.root, "f"), "resolved\n");
			r.git("add", "f");
			r.act();
			r.git("cherry-pick", "--continue");
		},
		[...COMMIT_HOOKS("cherry-pick").slice(0, 3), "post-commit commit"],
	],
	[
		"a clean single `git revert`, which nothing tells from a commit",
		(r) => {
			r.commit("a", "x");
			r.act();
			r.git("revert", "--no-edit", "HEAD");
		},
		COMMIT_HOOKS("commit", "prepare-commit-msg").filter(
			(l) => !l.startsWith("commit-msg"),
		),
	],
	[
		"`git revert A B`",
		(r) => {
			r.commit("a", "x");
			r.commit("b", "x");
			r.act();
			r.git("revert", "--no-edit", "HEAD", "HEAD~1");
		},
		twice([
			"prepare-commit-msg revert-sequence",
			"post-commit revert-sequence",
		]),
	],
	[
		"`git revert --continue`",
		(r) => {
			r.commit("g", "1");
			r.commit("g", "2");
			r.stops("revert", "--no-edit", "HEAD~1");
			fs.writeFileSync(path.join(r.root, "g"), "resolved\n");
			r.git("add", "g");
			r.act();
			r.git("revert", "--continue");
		},
		[...COMMIT_HOOKS("revert-continue").slice(0, 3), "post-commit commit"],
	],
	[
		"a rebase replaying two commits",
		(r) => {
			forked(r, ["s", "t"]);
			r.git("checkout", "-q", "side");
			r.act();
			r.git("rebase", "-q", r.base);
		},
		twice(["prepare-commit-msg rebase", "post-commit rebase"]),
	],
	[
		"`git rebase --continue`",
		(r) => {
			forked(r, ["f"], "f");
			r.git("checkout", "-q", "side");
			r.stops("rebase", "-q", r.base);
			fs.writeFileSync(path.join(r.root, "f"), "resolved\n");
			r.git("add", "f");
			r.act();
			r.git("rebase", "--continue");
		},
		["prepare-commit-msg rebase", "post-commit rebase"],
	],
	[
		"a `git commit` by hand in the middle of a rebase",
		(r) => {
			forked(r, ["f"], "f");
			r.git("checkout", "-q", "side");
			r.stops("rebase", "-q", r.base);
			fs.writeFileSync(path.join(r.root, "f"), "resolved\n");
			r.git("add", "f");
			r.act();
			r.git("commit", "-qm", "by hand");
		},
		COMMIT_HOOKS("rebase"),
	],
	[
		"`git rebase --apply`",
		(r) => {
			forked(r, ["s"]);
			r.git("checkout", "-q", "side");
			r.act();
			r.git("rebase", "-q", "--apply", r.base);
		},
		[
			"applypatch-msg rebase-apply",
			"pre-applypatch rebase-apply",
			"post-applypatch rebase-apply",
		],
	],
	[
		"`git am`",
		(r) => {
			forked(r, ["s"]);
			const dir = path.join(r.root, ".git", "patches");
			r.git("format-patch", "-q", "-1", "side", "-o", dir);
			r.act();
			r.git("am", "-q", ...fs.readdirSync(dir).map((f) => path.join(dir, f)));
		},
		["applypatch-msg am", "pre-applypatch am", "post-applypatch am"],
	],
	[
		"a commit by hand mid-bisect",
		(r) => {
			r.commit("a", "x");
			r.commit("b", "x");
			r.git("bisect", "start", "HEAD", "HEAD~2");
			r.act();
			r.commit("z", "x");
		},
		COMMIT_HOOKS("bisect"),
	],
];

describe("the route each hook reads, through real git (#1503)", () => {
	it.each(CASES)(
		"%s: each hook reads the route the marker table gives it",
		(_name, drive, expected) => {
			const r = routeRepo();
			drive(r);
			expect(r.routes()).toEqual(expected);
		},
	);
});

/** Runs `script` with the module sourced, under `shell`, in `cwd`. */
function inShell(
	shell: "sh" | "bash",
	script: string,
	env: Record<string, string> = {},
	cwd = ROOT,
) {
	const prelude = shell === "bash" ? "set -u\n" : "";
	const r = spawnSync(shell, ["-c", `${prelude}. "${LIB}"\n${script}`], {
		cwd,
		encoding: "utf8",
		env: { ...process.env, GIT_REFLOG_ACTION: "", ...env },
	});
	return { code: r.status, out: r.stdout.trim(), err: r.stderr };
}

/** A $GIT_DIR holding exactly `markers`; a path ending in `/` is a directory. */
function gitDir(markers: string[]): string {
	const { root } = newRepo("commit-route-dir-", temps);
	const dir = path.join(root, ".git");
	for (const m of markers) {
		const abs = path.join(dir, m);
		if (m.endsWith("/")) fs.mkdirSync(abs, { recursive: true });
		else {
			fs.mkdirSync(path.dirname(abs), { recursive: true });
			fs.writeFileSync(abs, "x\n");
		}
	}
	return dir;
}

describe.each(["sh", "bash"] as const)("wfc_commit_route under %s", (shell) => {
	const route = (hook: string, markers: string[], env = {}) =>
		inShell(shell, `wfc_commit_route ${hook} "${gitDir(markers)}"`, env).out;

	it.each([
		[
			"rebase-merge before CHERRY_PICK_HEAD",
			["rebase-merge/", "CHERRY_PICK_HEAD"],
			"rebase",
		],
		[
			"`rebasing` as the apply backend",
			["rebase-apply/rebasing"],
			"rebase-apply",
		],
		["`applying` as `git am`", ["rebase-apply/applying"], "am"],
		[
			"CHERRY_PICK_HEAD before sequencer",
			["CHERRY_PICK_HEAD", "sequencer/"],
			"cherry-pick",
		],
		[
			"REVERT_HEAD before sequencer",
			["REVERT_HEAD", "sequencer/"],
			"revert-continue",
		],
		// A cherry-pick range finished by a plain `git commit` leaves
		// `sequencer` behind, and a later merge must still read as one (#1503).
		[
			"MERGE_HEAD before a leftover sequencer",
			["sequencer/", "MERGE_HEAD"],
			"merge",
		],
		[
			"sequencer alone as a multi-commit revert",
			["sequencer/"],
			"revert-sequence",
		],
		["MERGE_HEAD before BISECT_LOG", ["MERGE_HEAD", "BISECT_LOG"], "merge"],
		[
			"AUTO_MERGE and MERGE_MSG as a commit",
			["AUTO_MERGE", "MERGE_MSG"],
			"commit",
		],
	])("reads %s", (_name, markers, expected) => {
		expect(route("prepare-commit-msg", markers)).toBe(expected);
	});

	it("names `git am --abort` for prepare-commit-msg's `rebase-apply/applying`", () => {
		const out = inShell(
			shell,
			`wfc_commit_route_abort "$(wfc_commit_route prepare-commit-msg "${gitDir(["rebase-apply/applying"])}")"`,
		).out;
		expect(out).toBe("git am --abort");
	});

	it("reads GIT_REFLOG_ACTION as a merge at pre-commit alone", () => {
		// `pull …` is `git pull`'s merge.
		for (const action of ["merge side", "pull . side"])
			expect(route("pre-commit", [], { GIT_REFLOG_ACTION: action })).toBe(
				"merge",
			);
		expect(
			route("prepare-commit-msg", [], { GIT_REFLOG_ACTION: "merge side" }),
		).toBe("commit");
		expect(
			route("pre-commit", [], { GIT_REFLOG_ACTION: "rebase (reword)" }),
		).toBe("commit");
	});

	it("reads pre-merge-commit as a merge whatever $GIT_DIR holds", () => {
		expect(route("pre-merge-commit", ["CHERRY_PICK_HEAD"])).toBe("merge");
	});

	it("reads an empty git dir, a git that would not answer, as no marker", () => {
		expect(inShell(shell, 'wfc_commit_route commit-msg ""').out).toBe("commit");
		expect(inShell(shell, 'wfc_commit_route pre-applypatch ""').out).toBe("am");
	});

	it("exits 2 naming a hook it has no row for, so a caller under set -e refuses", () => {
		const r = inShell(shell, 'wfc_commit_route pre-push ""');
		expect(r.code).toBe(2);
		expect(r.out).toBe("");
		expect(r.err).toContain("no marker table for the hook 'pre-push'");
	});
});

describe("wfc_commit_route_replays", () => {
	it.each([
		["rebase", 0],
		["rebase-apply", 0],
		["am", 0],
		["cherry-pick", 0],
		["revert-sequence", 1],
		["revert-continue", 1],
		["merge", 1],
		["bisect", 1],
		["commit", 1],
	])("answers %s with exit %i", (route, exitCode) => {
		expect(inShell("sh", `wfc_commit_route_replays ${route}`).code).toBe(
			exitCode,
		);
	});
});

describe("wfc_commit_route_abort", () => {
	it.each([
		["rebase", "git rebase --abort"],
		["rebase-apply", "git rebase --abort"],
		["am", "git am --abort"],
		["cherry-pick", "git cherry-pick --abort"],
		["revert-sequence", "git revert --abort"],
		["revert-continue", "git revert --abort"],
		["merge", "git merge --abort"],
		["bisect", ""],
		["commit", ""],
	])("clears %s with `%s`", (route, abort) => {
		expect(inShell("sh", `wfc_commit_route_abort ${route}`).out).toBe(abort);
	});
});

/** A stand-in for gitleaks at the module's WFC_GITLEAKS seam, exiting `exitCode`. */
function scanner(exitCode: number): string {
	const { root } = newRepo("commit-route-scan-", temps);
	const bin = path.join(root, `scanner-${exitCode}`);
	fs.writeFileSync(
		bin,
		`#!/bin/sh\necho "STUB SCANNER $*" >&2\nexit ${exitCode}\n`,
	);
	fs.chmodSync(bin, 0o755);
	return bin;
}

describe("wfc_replay_scan", () => {
	it("runs the command .husky/pre-commit runs, spelled once, here", () => {
		// The literal is never derived from either file, which would make this
		// tautological.
		const scan = `"\${WFC_GITLEAKS:-gitleaks}" git --staged --redact`;
		const module = fs.readFileSync(LIB, "utf8");
		expect(module.split(scan).length - 1).toBe(1);
		expect(
			fs.readFileSync(path.join(ROOT, ".husky", "pre-commit"), "utf8"),
		).toContain(scan);
	});

	it("passes silently where the scan passes", () => {
		const r = inShell("sh", "wfc_replay_scan pre-applypatch am", {
			WFC_GITLEAKS: scanner(0),
		});
		expect(r.code).toBe(0);
		expect(r.err).toBe("STUB SCANNER git --staged --redact\n");
	});

	it.each([
		["pre-applypatch", "am", "git am", "git am --abort"],
		[
			"pre-applypatch",
			"rebase-apply",
			"git rebase --apply",
			"git rebase --abort",
		],
		[
			"prepare-commit-msg",
			"cherry-pick",
			"git cherry-pick",
			"git cherry-pick --abort",
		],
		["prepare-commit-msg", "rebase", "git rebase", "git rebase --abort"],
	])(
		"refuses for %s on a %s, naming %s and `%s`",
		(hook, route, name, abort) => {
			const r = inShell("sh", `wfc_replay_scan ${hook} ${route}`, {
				WFC_GITLEAKS: scanner(1),
			});
			expect(r.code).toBe(1);
			expect(r.err).toContain(
				`${hook}: the secrets scan did not pass on this ${name}`,
			);
			expect(r.err).toContain("gitleaks itself is missing");
			expect(r.err).toContain(
				`The ${name} is left IN PROGRESS. Clear it with:  ${abort}`,
			);
		},
	);
});

/** Every line that is neither a comment nor blank. */
const code = (rel: string) =>
	fs
		.readFileSync(path.join(ROOT, rel), "utf8")
		.split("\n")
		.filter((l) => !/^\s*(#|$)/.test(l))
		.join("\n");

const CALLERS = [
	".husky/prepare-commit-msg",
	".husky/commit-msg",
	".husky/pre-applypatch",
	".husky/post-commit",
	"scripts/stale-write-back-gate.sh",
];

describe("the callers", () => {
	it.each(CALLERS)(
		"%s reads its route from the module and spells no marker of its own",
		(rel) => {
			const text = code(rel);
			expect(text).toMatch(/lib\/commit-route\.sh/);
			expect(text).not.toMatch(
				/rebase-merge|\/rebase-apply|rebase-apply\/|CHERRY_PICK_HEAD|REVERT_HEAD|sequencer|MERGE_HEAD|AUTO_MERGE|BISECT_LOG|GIT_REFLOG_ACTION/,
			);
		},
	);
});

describe("an adopter's hooks, run from the plugin through their shims (#1839)", () => {
	const HookCallers = CALLERS.filter((c) => c.startsWith(".husky/"));

	it.each(HookCallers)(
		"%s sources the module from $WFC_PLUGIN_ROOT where set",
		(rel) => {
			const out = fs.readFileSync(path.join(ROOT, rel), "utf8");
			expect(out).toContain(
				// biome-ignore lint/suspicious/noTemplateCurlyInString: a shell parameter expansion under test, not a JS placeholder
				'"${WFC_PLUGIN_ROOT:-$here/..}/scripts/lib/commit-route.sh"',
			);
		},
	);

	/** An adopter-shaped repo — core.hooksPath at `.husky`, no `.husky/_` —
	 * whose pre-applypatch shim runs the core's, from a plugin root holding the
	 * module that WORKFLOW_CORE_DIR names. */
	function adopter() {
		const { root, git } = newRepo("commit-route-adopter-", temps);
		const plugin = fs.mkdtempSync(`${root}-plugin-`);
		temps.push(plugin);
		fs.mkdirSync(path.join(plugin, "scripts", "lib"), { recursive: true });
		fs.copyFileSync(
			LIB,
			path.join(plugin, "scripts", "lib", "commit-route.sh"),
		);
		fs.mkdirSync(path.join(plugin, ".husky"));
		fs.copyFileSync(
			path.join(ROOT, ".husky", "pre-applypatch"),
			path.join(plugin, ".husky", "pre-applypatch"),
		);
		fs.mkdirSync(path.join(root, "scripts", "lib"), { recursive: true });
		fs.copyFileSync(
			path.join(ROOT, "scripts", "lib", "resolve-core.js"),
			path.join(root, "scripts", "lib", "resolve-core.js"),
		);
		fs.mkdirSync(path.join(root, ".husky"));
		fs.writeFileSync(
			path.join(root, ".husky", "pre-applypatch"),
			renderHookShim("pre-applypatch"),
			{ mode: 0o755 },
		);
		fs.writeFileSync(path.join(root, "base.txt"), "base\n");
		git("add", "--", "base.txt");
		git("commit", "-qm", "base");
		git("checkout", "-q", "-b", "side");
		fs.writeFileSync(path.join(root, "side.txt"), "side\n");
		git("add", "--", "side.txt");
		git("commit", "-qm", "side");
		git("format-patch", "-q", "-1", "-o", path.join(root, ".git", "p"));
		git("checkout", "-q", "-");
		git("config", "core.hooksPath", ".husky");
		const am = () => {
			const dir = path.join(root, ".git", "p");
			const r = spawnSync(
				"git",
				["am", ...fs.readdirSync(dir).map((f) => path.join(dir, f))],
				{
					cwd: root,
					encoding: "utf8",
					env: {
						...process.env,
						WFC_GITLEAKS: scanner(1),
						WORKFLOW_CORE_DIR: plugin,
					},
				},
			);
			return { code: r.status, out: `${r.stdout}${r.stderr}` };
		};
		return { plugin, am };
	}

	it("runs the plugin's module, naming `git am --abort` on a refused `git am`", () => {
		const r = adopter().am();
		expect(r.code).not.toBe(0);
		expect(r.out).toContain("STUB SCANNER");
		expect(r.out).toContain("Clear it with:  git am --abort");
	});

	it("refuses, naming the plugin's path, where the plugin has no module", () => {
		const a = adopter();
		fs.rmSync(path.join(a.plugin, "scripts", "lib", "commit-route.sh"));
		const r = a.am();
		expect(r.code).not.toBe(0);
		expect(r.out).toContain(
			`${a.plugin}/scripts/lib/commit-route.sh is missing`,
		);
		expect(r.out).not.toContain("STUB SCANNER");
	});
});
