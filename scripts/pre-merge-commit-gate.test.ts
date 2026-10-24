// @vitest-environment node

/*
 * Pins `.husky/pre-merge-commit` (mantahostels#1679): an auto-resolving merge
 * runs the whole of `.husky/pre-commit` over its own delta, and a red gate
 * refuses the merge commit — exercised through git's own hook seam.
 *
 * The gap it closes: `git merge` runs `pre-merge-commit`, never `pre-commit`, so
 * while `.husky/pre-merge-commit` did not exist an auto-resolving merge landed
 * on `main` having run none of `.husky/pre-commit`'s gates — gitleaks among
 * them, which is the limb that matters, `AGENTS.md` §Secrets boundary making a
 * committed key permanent.
 *
 * Every merge case drives a REAL `git merge` in a throwaway repo with its own
 * `core.hooksPath`, because the class of bug this file guards against is one
 * layer out from the hook's logic — a hook that is correct and never invoked
 * (`docs/agents/guard-authoring.md` §The proving discipline).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defineTemplate, mkScratchDir } from "./lib/git-fixture";
import { registerTempCleanup } from "./lib/precommit-gate-harness";
import { ROOT } from "./lib/precommit-gate-testkit";
import { runInProcess } from "./lib/run-in-process.js";

const HOOK_REL = path.join(".husky", "pre-merge-commit");
const HOOK = fs.readFileSync(path.join(ROOT, HOOK_REL), "utf8");

const temps = registerTempCleanup();

/** Where a stubbed hook appends the line proving it ran. */
const LOG = "fired.log";

/**
 * A credential gitleaks' stock rules match, split across a concatenation so this
 * file is not itself a finding on the repo's own scan. Not AWS's documentation
 * key `AKIA`+`IOSFODNN7EXAMPLE`, which gitleaks 8.30.1 allowlists and which
 * would make the case below pass vacuously.
 */
const SECRET = `AKIA${"2QQ7WZ4KKPFXJ3RN"}`;

/**
 * The one secrets-scan spelling the hooks share (#224), so the stub hook below
 * resolves the binary exactly as the live ones do.
 */
const SCAN = `"\${WFC_GITLEAKS:-gitleaks}" git --staged --redact`;

/**
 * gitleaks has no npm route, so the case that needs it skips rather than fails.
 * The probe resolves the binary as `SCAN`'s `:-` does (#224) — `||`, not `??`,
 * so an empty WFC_GITLEAKS falls back rather than skipping a case the hooks
 * would run.
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
	/** Replaces the stub `pre-commit` with one exiting `code`. */
	precommitExits: (code: number) => void;
}

const stubText = (name: string, logFile: string, code: number) =>
	`echo "${name}" >> "${logFile}"\nexit ${code}\n`;

/*
 * THE FIXTURE IS BUILT ONCE AND COPIED (mantahostels#2068), via scripts/lib/git-fixture.ts:
 * `core.hooksPath` at `.husky/_`, the real shim files copied in (rather than
 * written, so a husky upgrade that changed how `_/h` resolves the user hook
 * fails here instead of silently disarming the gate), and the repo's own
 * `pre-merge-commit` beside a STUBBED `pre-commit` — stubbed because this
 * suite is about the merge seam, what the real one checks being
 * `scripts/precommit-*.test.ts`'s ground.
 *
 * The `pre-commit` stub bakes the fixture's own ABSOLUTE `fired.log` path into
 * its text (`stubText` above), so a naive copy would have every instance log
 * to the TEMPLATE's log file. `.husky/pre-commit` is passed as an `extraPaths`
 * entry so `instantiate()`
 * relinks that occurrence the same way it relinks `.git`'s own absolute paths.
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

	for (const f of ["h", "pre-merge-commit", "pre-commit"]) {
		const src = path.join(ROOT, ".husky", "_", f);
		fs.copyFileSync(src, path.join(underscore, f));
		fs.chmodSync(path.join(underscore, f), 0o755);
	}
	fs.copyFileSync(
		path.join(ROOT, HOOK_REL),
		path.join(husky, "pre-merge-commit"),
	);
	git("config", "core.hooksPath", underscore);

	const log = path.join(root, LOG);
	fs.writeFileSync(
		path.join(husky, "pre-commit"),
		stubText("pre-commit", log, 0),
	);

	fs.writeFileSync(path.join(root, "base.txt"), "base\n");
	fs.writeFileSync(path.join(root, "shared.txt"), "shared\n");
	git("add", "--", "base.txt", "shared.txt");
	git("commit", "-qm", "base");
};

const template = defineTemplate(buildTemplate);

/** Hands out a copy of `buildTemplate`'s repo, plus accessors onto its
 * `fired.log` and a way to change the `pre-commit` stub's exit code. */
function probe(): Probe {
	const root = mkScratchDir("premerge-commit-gate-");
	temps.push(root);
	template.instantiate(root, {
		extraPaths: [path.join(".husky", "pre-commit")],
	});
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root });

	const husky = path.join(root, ".husky");
	const log = path.join(root, LOG);
	const stub = (name: string, code: number) =>
		fs.writeFileSync(path.join(husky, name), stubText(name, log, code));

	return {
		root,
		git,
		fired: () =>
			fs.existsSync(log)
				? fs.readFileSync(log, "utf8").split("\n").filter(Boolean)
				: [],
		reset: () => fs.rmSync(log, { force: true }),
		precommitExits: (code: number) => stub("pre-commit", code),
	};
}

/** A branch adding `files`, leaving the probe back on the branch it started on. */
function sideBranch(
	p: Probe,
	name: string,
	files: Record<string, string>,
): void {
	const start = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], {
		cwd: p.root,
		encoding: "utf8",
	}).trim();
	p.git("checkout", "-q", "-b", name);
	for (const [rel, body] of Object.entries(files)) {
		fs.writeFileSync(path.join(p.root, rel), body);
		p.git("add", "--", rel);
		p.git("commit", "-qm", rel);
	}
	p.git("checkout", "-q", start);
}

function merge(p: Probe, branch: string): { code: number; output: string } {
	try {
		const out = execFileSync(
			"git",
			["merge", branch, "-m", `merge ${branch}`],
			{
				cwd: p.root,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		return { code: 0, output: out };
	} catch (e) {
		const err = e as { status?: number; stdout?: string; stderr?: string };
		return {
			code: err.status ?? 1,
			output: `${err.stdout ?? ""}${err.stderr ?? ""}`,
		};
	}
}

const log = (p: Probe, ...args: string[]) =>
	execFileSync("git", ["log", ...args], { cwd: p.root, encoding: "utf8" });

describe(".husky/pre-merge-commit", () => {
	it("is the hook husky actually dispatches", () => {
		// `_/h` exits 0 when the user hook is absent, so the two halves are
		// separately load-bearing. The shim half is weak — husky writes every
		// shim at install, so it fails only on a husky that stopped emitting
		// this name.
		expect(fs.existsSync(path.join(ROOT, HOOK_REL))).toBe(true);
		expect(
			fs.existsSync(path.join(ROOT, ".husky", "_", "pre-merge-commit")),
		).toBe(true);
	});

	it("runs the whole of .husky/pre-commit rather than a copied gate list", () => {
		// A copied gate list goes stale (mantahostels#1261).
		expect(HOOK).toMatch(/sh -e "\$here\/pre-commit"/);
		// Comments strip out first: the header names gitleaks and mantahostels#1261, and
		// matching those would pass on a hook that ran them.
		const code = HOOK.split("\n").filter((l) => !l.trimStart().startsWith("#"));
		expect(code.join("\n")).not.toMatch(/gitleaks|node scripts\/|npm run/);
	});

	it("fires on an auto-resolving merge, which ran no gate at all before", () => {
		const p = probe();
		sideBranch(p, "side", { "side.txt": "side\n" });
		fs.writeFileSync(path.join(p.root, "base.txt"), "moved\n");
		p.git("commit", "-qm", "moved", "--", "base.txt");
		p.reset();

		const r = merge(p, "side");
		expect(r.output).toContain("Merge made by");
		expect(r.code).toBe(0);
		expect(p.fired()).toEqual(["pre-commit"]);
	});

	it("hands the gates the merge's own delta, not the whole tree", () => {
		/*
		 * mantahostels#1679 asked whether a merge's "staged paths" are the merge result or
		 * its delta, on the worry that reusing `check:staged` would gate the
		 * entire tree. Measured here: `git diff --cached` inside the hook is the
		 * delta against `ours`, so every `--staged`/`--cached` read in
		 * pre-commit is already scoped correctly and the worry does not arise.
		 */
		const p = probe();
		fs.writeFileSync(
			path.join(p.root, ".husky", "pre-commit"),
			`git diff --cached --name-only > "${path.join(p.root, "staged.txt")}"\n` +
				`git ls-files > "${path.join(p.root, "tracked.txt")}"\n`,
		);
		sideBranch(p, "side", {
			"a.txt": "a\n",
			"b.txt": "b\n",
			"c.txt": "c\n",
		});
		fs.writeFileSync(path.join(p.root, "base.txt"), "moved\n");
		p.git("commit", "-qm", "moved", "--", "base.txt");

		expect(merge(p, "side").code).toBe(0);
		const read = (f: string) =>
			fs.readFileSync(path.join(p.root, f), "utf8").split("\n").filter(Boolean);
		expect(read("staged.txt")).toEqual(["a.txt", "b.txt", "c.txt"]);
		// The paired negative: without it the case would pass on a hook that saw
		// nothing at all.
		expect(read("tracked.txt")).toContain("base.txt");
		expect(read("tracked.txt").length).toBeGreaterThan(3);
	});

	it("refuses the merge commit on a red gate, leaving the merge in progress and offering git merge --abort", () => {
		const p = probe();
		sideBranch(p, "side", { "side.txt": "side\n" });
		fs.writeFileSync(path.join(p.root, "base.txt"), "moved\n");
		p.git("commit", "-qm", "moved", "--", "base.txt");
		p.precommitExits(1);
		const before = log(p, "--format=%H", "-1").trim();

		const r = merge(p, "side");
		expect(r.output).toContain("the gates above refused this merge's content");
		// Spec F7 of mantahostels#1679's review: `git merge` itself exits non-zero.
		expect(r.code).not.toBe(0);
		expect(log(p, "--format=%H", "-1").trim()).toBe(before);
		expect(fs.existsSync(path.join(p.root, ".git", "MERGE_HEAD"))).toBe(true);
		expect(r.output).toContain("git merge --abort");
	});

	it("does not let `git commit` past the refusal without the same gates", () => {
		// The escape git prints — "use 'git commit' to complete the merge" — is
		// only honest because that commit runs pre-commit.
		const p = probe();
		sideBranch(p, "side", { "side.txt": "side\n" });
		fs.writeFileSync(path.join(p.root, "base.txt"), "moved\n");
		p.git("commit", "-qm", "moved", "--", "base.txt");
		p.precommitExits(1);
		merge(p, "side");
		p.reset();

		expect(() =>
			execFileSync("git", ["commit", "-qm", "complete the merge"], {
				cwd: p.root,
				stdio: ["ignore", "pipe", "pipe"],
			}),
		).toThrow();
		expect(p.fired()).toEqual(["pre-commit"]);
	});

	it("passes pre-commit's exit code through, which git then discards", () => {
		/*
		 * .husky/pre-commit exits 2 on BROKEN apparatus, distinct from a finding.
		 * The hook keeps that distinction for anything reading it directly —
		 * measured here by running the hook itself. `git merge` does NOT: it
		 * reports 1 on any non-zero hook, so no caller of `git merge` can tell
		 * the two apart, and nothing should be built on being able to.
		 */
		const p = probe();
		sideBranch(p, "side", { "side.txt": "side\n" });
		fs.writeFileSync(path.join(p.root, "base.txt"), "moved\n");
		p.git("commit", "-qm", "moved", "--", "base.txt");
		p.precommitExits(2);
		const hook = path.join(p.root, ".husky", "pre-merge-commit");
		let direct = 0;
		try {
			execFileSync("sh", ["-e", hook], {
				cwd: p.root,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (e) {
			direct = (e as { status?: number }).status ?? 0;
		}
		expect(direct).toBe(2);
		expect(merge(p, "side").code).toBe(1);
	});

	it.skipIf(!HAS_GITLEAKS)(
		"catches a secret arriving only by the merge, through real gitleaks",
		() => {
			/*
			 * The end-to-end case for mantahostels#1679's headline limb, run against the real
			 * gitleaks binary rather than a stub: the secret exists on neither the
			 * merge's own commit message nor `ours`, and reaches `main` only because
			 * the merge brings it. Skipped where gitleaks is absent — CLAUDE.md
			 * §Gotchas records that npm install does not supply it.
			 */
			const p = probe();
			// The branch is built under the stub, then the real scan is wired in:
			// the secret is already on the side branch by whatever route put it
			// there, and the merge is the moment it would reach main.
			sideBranch(p, "side", { "creds.txt": `${SECRET}\n` });
			fs.writeFileSync(path.join(p.root, "base.txt"), "moved\n");
			p.git("commit", "-qm", "moved", "--", "base.txt");
			fs.writeFileSync(
				path.join(p.root, ".husky", "pre-commit"),
				`${SCAN} || exit 1\n`,
			);

			const r = merge(p, "side");
			expect(r.output).toContain(
				"the gates above refused this merge's content",
			);
			expect(log(p, "--format=%s", "-1").trim()).toBe("moved");
		},
	);

	it("is skipped entirely by `git merge --no-verify`", () => {
		// The residual this hook alone cannot close. It is no longer a hole:
		// mantahostels#1705 put the gates behind `.husky/prepare-commit-msg`, which the flag
		// cannot skip, and widened guard-commit-form.sh's deny onto `git merge`.
		// This probe copies no prepare-commit-msg in, so what it measures is
		// still THIS hook's own reach — scripts/prepare-commit-msg-gate.test.ts
		// is where the merge is refused.
		const p = probe();
		sideBranch(p, "side", { "side.txt": "side\n" });
		fs.writeFileSync(path.join(p.root, "base.txt"), "moved\n");
		p.git("commit", "-qm", "moved", "--", "base.txt");
		p.precommitExits(1);
		p.reset();

		expect(
			execFileSync(
				"git",
				["merge", "--no-verify", "side", "-m", "unverified"],
				{
					cwd: p.root,
					encoding: "utf8",
				},
			),
		).toContain("Merge made by");
		expect(p.fired()).toEqual([]);
	});

	it("gates `git merge --continue`, the third way to finish a merge", () => {
		// Neither mantahostels#1679 nor its first measurement probed this spelling. It
		// completes a CONFLICTED merge, so what it runs is `pre-commit`.
		const p = probe();
		sideBranch(p, "side", { "shared.txt": "theirs\n" });
		fs.writeFileSync(path.join(p.root, "shared.txt"), "ours\n");
		p.git("commit", "-qm", "ours", "--", "shared.txt");
		merge(p, "side");
		fs.writeFileSync(path.join(p.root, "shared.txt"), "resolved\n");
		p.git("add", "--", "shared.txt");
		p.precommitExits(1);
		p.reset();

		expect(() =>
			execFileSync("git", ["merge", "--continue"], {
				cwd: p.root,
				env: { ...process.env, GIT_EDITOR: "true" },
				stdio: ["ignore", "pipe", "pipe"],
			}),
		).toThrow();
		expect(p.fired()).toEqual(["pre-commit"]);
	});

	it("leaves the conflicted shape alone — git already runs pre-commit there", () => {
		/*
		 * A CONFLICTED merge runs no hook on the failed merge itself, and its
		 * resolution `git commit` is an ordinary gated commit — so the
		 * auto-resolving shape was the only unguarded one. mantahostels#1679's issue body
		 * assumed otherwise and asked for a second measurer.
		 */
		const p = probe();
		sideBranch(p, "side", { "shared.txt": "theirs\n" });
		fs.writeFileSync(path.join(p.root, "shared.txt"), "ours\n");
		p.git("commit", "-qm", "ours", "--", "shared.txt");
		p.reset();

		const r = merge(p, "side");
		expect(r.output).toContain("CONFLICT");
		expect(p.fired()).toEqual([]);

		fs.writeFileSync(path.join(p.root, "shared.txt"), "resolved\n");
		p.git("add", "--", "shared.txt");
		p.git("commit", "-qm", "resolved");
		expect(p.fired()).toEqual(["pre-commit"]);
	});
});

describe("the pre-merge-commit hook's own linting", () => {
	it("is in check:sh's file set, which pre-commit's shell gate shares (#1828)", () => {
		// A husky hook nothing lints is a hook whose next edit breaks silently:
		// `npm run lint` never sees a shell file.
		const set = runInProcess(
			path.join(ROOT, "scripts/lib/formatters.js"),
			["shell-files", "--tracked"],
			{ cwd: ROOT },
		).stdout;
		expect(set.split("\n")).toContain(".husky/pre-merge-commit");
	});
});

describe("what a refused merge strands, and where", () => {
	it("parks MERGE_HEAD in the merging worktree alone, never repo-wide", () => {
		/*
		 * The residual the hook's header names, measured rather than assumed. A
		 * refusal leaves MERGE_HEAD set, and until it is cleared that tree
		 * cannot take the pathspec commit CLAUDE.md mandates. The question that
		 * decides its blast radius in a repo-global working tree is whether
		 * MERGE_HEAD is per-worktree: it is, so a merge-back refused in a
		 * throwaway worktree strands only that worktree.
		 */
		const p = probe();
		sideBranch(p, "side", { "side.txt": "side\n" });
		fs.writeFileSync(path.join(p.root, "base.txt"), "moved\n");
		p.git("commit", "-qm", "moved", "--", "base.txt");
		p.precommitExits(1);

		const main = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], {
			cwd: p.root,
			encoding: "utf8",
		}).trim();
		const wt = `${p.root}-wt`;
		temps.push(wt);
		p.git("worktree", "add", "-q", wt, "side");
		try {
			execFileSync("git", ["merge", main, "-m", "back"], {
				cwd: wt,
				stdio: ["ignore", "pipe", "pipe"],
			});
			throw new Error("the merge-back was expected to be refused");
		} catch (e) {
			expect((e as Error).message).not.toContain("expected to be refused");
		}

		const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
			cwd: wt,
			encoding: "utf8",
		}).trim();
		expect(fs.existsSync(path.join(gitDir, "MERGE_HEAD"))).toBe(true);
		expect(fs.existsSync(path.join(p.root, ".git", "MERGE_HEAD"))).toBe(false);

		// And the shared tree still takes a pathspec commit while that sits.
		fs.writeFileSync(path.join(p.root, "unrelated.txt"), "x\n");
		p.git("add", "--", "unrelated.txt");
		p.precommitExits(0);
		p.git("commit", "-qm", "unrelated", "--", "unrelated.txt");
		expect(log(p, "--format=%s", "-1").trim()).toBe("unrelated");
		p.git("worktree", "remove", "--force", wt);
	});
});

describe("the copied fixture is isolated from its template (mantahostels#2068)", () => {
	it("a commit made in the copy leaves the template untouched", () => {
		const p = probe();
		fs.writeFileSync(path.join(p.root, "only-in-copy.txt"), "x\n");
		p.git("add", "--", "only-in-copy.txt");
		p.git("commit", "-qm", "only in the copy");
		expect(log(p, "--oneline").toString()).toContain("only in the copy");

		const fresh = probe();
		expect(log(fresh, "--oneline").toString()).not.toContain(
			"only in the copy",
		);
	});
});
