// @vitest-environment node

/*
 * Pins `.husky/prepare-commit-msg` (mantahostels#1705, mantahostels#1706,
 * #138): the whole gate stack on a commit or merge `pre-commit` did not gate,
 * standing down once on its stamp, gitleaks alone on a replay, and refusal of a
 * message that would close an issue — exercised through git's own hook seam.
 *
 * The gap it closes: `--no-verify` turns off `pre-commit`, `commit-msg` and
 * `pre-merge-commit` at once, so `git commit --no-verify` and `git merge
 * --no-verify` landed on `main` having run none of `.husky/pre-commit`'s ~14
 * gates — gitleaks among them, and `AGENTS.md` §Secrets boundary makes a
 * committed key permanent. `prepare-commit-msg` is the one hook that can refuse
 * a commit and that the flag leaves running, so it is the only place either
 * spelling can still be refused.
 *
 * Every case drives a REAL `git commit`/`git merge` in a throwaway repo with its
 * own `core.hooksPath`, because the class of bug this file guards against is one
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

const HOOK_REL = path.join(".husky", "prepare-commit-msg");
const HOOK = fs.readFileSync(path.join(ROOT, HOOK_REL), "utf8");
const PRECOMMIT = fs.readFileSync(
	path.join(ROOT, ".husky", "pre-commit"),
	"utf8",
);

/** The secrets scan .husky/pre-commit runs, as a stub `pre-commit`'s body (§N7, #224). */
const SCAN = `"\${WFC_GITLEAKS:-gitleaks}" git --staged --redact`;

/** The stamp's filename, asserted against the live hooks rather than assumed. */
const STAMP = "wfc-precommit-stamp";

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

/**
 * The stamp-writing block cut out of the LIVE `.husky/pre-commit`, verbatim.
 *
 * The stand-down cases below stub `pre-commit` — the point of them is the seam,
 * not the ~14 gates — but a stub writing its own stamp would test the stub. So
 * the real bytes are spliced into it: delete or rename the block in the hook and
 * every stand-down case here fails.
 */
function parseStampBlock(): string {
	const lines = PRECOMMIT.split("\n");
	const start = lines.findIndex((l) => l.startsWith("pc_stamp_dir="));
	if (start === -1)
		throw new Error(".husky/pre-commit no longer writes the stand-down stamp");
	const end = lines.findIndex((l, i) => i > start && l === "fi");
	if (end === -1)
		throw new Error("the stamp block in .husky/pre-commit is unclosed");
	return lines.slice(start, end + 1).join("\n");
}

interface Probe {
	root: string;
	git: (...args: string[]) => Buffer;
	/** Every hook name that fired since the last `reset()`, in order. */
	fired: () => string[];
	reset: () => void;
	/** Rewrites the stub `pre-commit`: log, exit `code`, stamp only on 0. */
	precommitExits: (code: number) => void;
	/** Replaces the stub `pre-commit` body wholesale. */
	precommitBody: (body: string) => void;
	gitDir: (cwd?: string) => string;
}

/*
 * THE FIXTURE IS BUILT ONCE AND COPIED (mantahostels#2068), via scripts/lib/git-fixture.ts:
 * `core.hooksPath` at `.husky/_`, the real shim files copied in — rather than
 * written, so a husky upgrade that changed how `_/h` resolves the user hook
 * fails here instead of disarming the gate — and the repo's own
 * `prepare-commit-msg` and `pre-merge-commit` beside a STUBBED `pre-commit`.
 *
 * The stub bakes the template's own absolute `fired.log` path into
 * `.husky/pre-commit`'s text, so a naive copy would have every instance log to
 * the TEMPLATE's log file. `.husky/pre-commit` is passed as an `extraPaths`
 * entry so `instantiate()` relinks that occurrence the same way it relinks
 * `.git`'s own absolute paths.
 */
/** `.husky/pre-commit`'s stub body: logs, then on 0 splices the real stamp
 * block and exits. The stamp goes LAST and only on success, exactly as the
 * real hook places it — a red gate must leave no stamp behind for the next
 * commit to reuse. Shared by the template's initial passing stub and every
 * case's `exits()` rewrite, so the two spellings cannot drift. */
function precommitStub(log: string, code: number): string {
	return (
		`echo "pre-commit" >> "${log}"\n` +
		(code === 0 ? `${parseStampBlock()}\nexit 0\n` : `exit ${code}\n`)
	);
}

/** Deliberately not `./lib/precommit-gate-harness`'s own `newRepo`: this
 * template needs the repo built inside a directory `defineTemplate` owns
 * (`root`), not one `newRepo` mints and registers for cleanup itself. */
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

	for (const f of [
		"h",
		"prepare-commit-msg",
		"pre-merge-commit",
		"pre-commit",
		"commit-msg",
	]) {
		const src = path.join(ROOT, ".husky", "_", f);
		fs.copyFileSync(src, path.join(underscore, f));
		fs.chmodSync(path.join(underscore, f), 0o755);
	}
	for (const f of ["prepare-commit-msg", "pre-merge-commit", "commit-msg"])
		fs.copyFileSync(path.join(ROOT, ".husky", f), path.join(husky, f));

	// The closing-keyword scanner's launcher (#138) and the route module
	// (#1503): both hooks FAIL CLOSED when either is absent, so without these copies every commit
	// in this fixture is refused. commit-msg alone also fails closed without
	// the subject check (#2332), and prints commit-message.txt on its refusal.
	for (const rel of [
		"scripts/lib/commit-route.sh",
		"scripts/check-commit-message-closes.sh",
		"scripts/check-commit-subject.sh",
		"scripts/review-tier-trailer.sh",
		"scripts/lib/rule-text.sh",
		"docs/agents/rules/commit-closes-keyword.txt",
		"docs/agents/rules/commit-message.txt",
	]) {
		const dest = path.join(root, rel);
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.copyFileSync(path.join(ROOT, rel), dest);
	}
	fs.chmodSync(
		path.join(root, "scripts/check-commit-message-closes.sh"),
		0o755,
	);
	// The scanner the launcher runs, commit-msg's Weakens: gate (#2235) and the
	// message reader the subject check spawns (#3075), linked rather than
	// copied: node resolves their requires from the link's target, so their lib
	// closure comes with them.
	for (const rel of [
		"scripts/check-commit-message-closes.js",
		"scripts/check-weakens-line.js",
		"scripts/lib/commit-message.js",
	])
		fs.symlinkSync(path.join(ROOT, rel), path.join(root, rel));
	git("config", "core.hooksPath", underscore);

	const log = path.join(root, LOG);
	fs.writeFileSync(path.join(husky, "pre-commit"), precommitStub(log, 0));

	fs.writeFileSync(path.join(root, "base.txt"), "base\n");
	git("add", "--", "base.txt");
	git("commit", "-qm", "base");
};

const template = defineTemplate(buildTemplate);

/** Hands out a copy of `buildTemplate`'s repo, plus the accessors every case
 * drives it through. */
function probe(): Probe {
	const root = mkScratchDir("prepare-commit-msg-gate-");
	temps.push(root);
	template.instantiate(root, {
		extraPaths: [path.join(".husky", "pre-commit")],
	});
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root });

	const husky = path.join(root, ".husky");
	const log = path.join(root, LOG);
	const write = (body: string) =>
		fs.writeFileSync(path.join(husky, "pre-commit"), body);
	const exits = (code: number) => write(precommitStub(log, code));

	return {
		root,
		git,
		fired: () =>
			fs.existsSync(log)
				? fs.readFileSync(log, "utf8").split("\n").filter(Boolean)
				: [],
		reset: () => fs.rmSync(log, { force: true }),
		precommitExits: exits,
		precommitBody: write,
		gitDir: (cwd = root) =>
			execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
				cwd,
				encoding: "utf8",
			}).trim(),
	};
}

/** Runs `args` in `cwd`, returning the exit code and the merged output. */
function attempt(
	cwd: string,
	...args: string[]
): { code: number; output: string } {
	try {
		const out = execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			env: { ...process.env, GIT_EDITOR: "true" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { code: 0, output: out };
	} catch (e) {
		const err = e as { status?: number; stdout?: string; stderr?: string };
		return {
			code: err.status ?? 1,
			output: `${err.stdout ?? ""}${err.stderr ?? ""}`,
		};
	}
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

/** Puts `p` one commit ahead of `branch`, so a merge of it cannot fast-forward. */
function diverge(p: Probe): void {
	fs.writeFileSync(path.join(p.root, "base.txt"), "moved\n");
	p.git("commit", "-qm", "moved", "--", "base.txt");
}

const gitLog = (p: Probe, ...args: string[]) =>
	execFileSync("git", ["log", ...args], { cwd: p.root, encoding: "utf8" });

describe(".husky/prepare-commit-msg", () => {
	it("is the hook husky actually dispatches", () => {
		// `_/h` exits 0 when the user hook is absent, so the two halves are
		// separately load-bearing.
		expect(fs.existsSync(path.join(ROOT, HOOK_REL))).toBe(true);
		expect(
			fs.existsSync(path.join(ROOT, ".husky", "_", "prepare-commit-msg")),
		).toBe(true);
	});

	it("runs the whole of .husky/pre-commit rather than a copied gate list", () => {
		// A copied gate list goes stale (mantahostels#1261).
		expect(HOOK).toMatch(/sh -e "\$here\/pre-commit"/);
		// Comments strip out first: the header names its gates, and matching a
		// comment would pass on a hook that ran nothing.
		const code = HOOK.split("\n").filter((l) => !l.trimStart().startsWith("#"));
		expect(code.join("\n")).not.toMatch(/node scripts\/|npm run|gitleaks/);
		// The replay path's scan is the route module's, called once
		// (mantahostels#1706, #1503).
		expect(
			code.filter((l) => l.includes("wfc_replay_scan prepare-commit-msg"))
				.length,
		).toBe(1);
	});

	it("refuses every commit when scripts/lib/commit-route.sh is missing", () => {
		// The route decides between the whole stack and gitleaks alone, so an
		// unreadable route refuses rather than guessing either (#1503).
		const p = probe();
		fs.rmSync(path.join(p.root, "scripts/lib/commit-route.sh"));
		fs.writeFileSync(path.join(p.root, "m.txt"), "m\n");
		p.git("add", "--", "m.txt");
		const before = gitLog(p, "--format=%H", "-1").trim();

		const r = attempt(p.root, "commit", "-m", "m");
		expect(r.code).not.toBe(0);
		expect(r.output).toContain("commit-route.sh is missing");
		expect(gitLog(p, "--format=%H", "-1").trim()).toBe(before);
	});
});

describe("the premise: what --no-verify does and does not skip", () => {
	/*
	 * A fact about git 2.43.0, measured at mantahostels#1705. If a future git skips
	 * prepare-commit-msg under --no-verify, these two fail and the hole is
	 * reported rather than reopened in silence.
	 *
	 * These cases flake in CI on the git-fixture copy — `scripts/lib/git-fixture.ts`
	 * (mantahostels#2437).
	 */
	it("skips pre-commit but NOT prepare-commit-msg on `git commit`", () => {
		const p = probe();
		fs.writeFileSync(path.join(p.root, "c.txt"), "c\n");
		p.git("add", "--", "c.txt");
		p.precommitExits(1);
		p.reset();

		// The refusal below can only come from prepare-commit-msg: pre-commit is
		// skipped, and its stub is the only other thing that logs.
		const r = attempt(p.root, "commit", "--no-verify", "-m", "c");
		expect(r.code).not.toBe(0);
		expect(r.output).toContain("--no-verify cannot turn it off");
		expect(p.fired()).toEqual(["pre-commit"]); // the RE-RUN, from the hook
	});

	it("skips pre-merge-commit but NOT prepare-commit-msg on `git merge`", () => {
		const p = probe();
		sideBranch(p, "side", { "side.txt": "side\n" });
		diverge(p);
		p.precommitExits(1);
		p.reset();

		const r = attempt(
			p.root,
			"merge",
			"--no-verify",
			"side",
			"-m",
			"unverified",
		);
		expect(r.code).not.toBe(0);
		expect(r.output).toContain("--no-verify cannot turn it off");
		expect(p.fired()).toEqual(["pre-commit"]);
	});
});

describe("what a refusal under --no-verify actually stops", () => {
	it.skipIf(!HAS_GITLEAKS)(
		"aborts `git commit --no-verify` with a secret staged, through real gitleaks",
		() => {
			const p = probe();
			p.precommitBody(`${SCAN} || exit 1\n`);
			fs.writeFileSync(path.join(p.root, "creds.txt"), `${SECRET}\n`);
			p.git("add", "--", "creds.txt");
			const before = gitLog(p, "--format=%H", "-1").trim();

			const r = attempt(p.root, "commit", "--no-verify", "-m", "creds");
			expect(r.code).not.toBe(0);
			expect(gitLog(p, "--format=%H", "-1").trim()).toBe(before);
			expect(gitLog(p, "-p", "--all")).not.toContain(SECRET);
		},
	);

	it.skipIf(!HAS_GITLEAKS)(
		"aborts `git merge --no-verify` bringing a secret, through real gitleaks",
		() => {
			const p = probe();
			// The branch is built under the passing stub: the secret is already on
			// `side` by whatever route put it there, and the merge is the moment it
			// would reach main.
			sideBranch(p, "side", { "creds.txt": `${SECRET}\n` });
			diverge(p);
			p.precommitBody(`${SCAN} || exit 1\n`);
			const before = gitLog(p, "--format=%H", "-1").trim();

			const r = attempt(p.root, "merge", "--no-verify", "side", "-m", "merged");
			expect(r.code).not.toBe(0);
			expect(gitLog(p, "--format=%H", "-1").trim()).toBe(before);
			// `--all` would reach `side`, where the secret legitimately lives; the
			// claim is that it never reached the branch being merged INTO.
			expect(gitLog(p, "-p", "HEAD")).not.toContain(SECRET);
			expect(fs.existsSync(path.join(p.gitDir(), "MERGE_HEAD"))).toBe(true);
		},
	);

	it("lets a clean `git commit --no-verify` through", () => {
		// The paired positive: the hook refuses on a finding, not on the flag.
		const p = probe();
		fs.writeFileSync(path.join(p.root, "ok.txt"), "ok\n");
		p.git("add", "--", "ok.txt");
		expect(attempt(p.root, "commit", "--no-verify", "-m", "ok").code).toBe(0);
		expect(gitLog(p, "--format=%s", "-1").trim()).toBe("ok");
	});

	it("lets a clean `git merge --no-verify` through", () => {
		const p = probe();
		sideBranch(p, "side", { "side.txt": "side\n" });
		diverge(p);
		expect(
			attempt(p.root, "merge", "--no-verify", "side", "-m", "merged").code,
		).toBe(0);
		expect(gitLog(p, "--format=%s", "-1").trim()).toBe("merged");
	});

	it("passes pre-commit's exit code through, which git then discards", () => {
		/*
		 * .husky/pre-commit exits 2 on BROKEN apparatus, distinct from a finding.
		 * The hook keeps that distinction for anything reading it directly; git
		 * reports 1 on any non-zero hook, so nothing should be built on it.
		 */
		const p = probe();
		fs.writeFileSync(path.join(p.root, "c.txt"), "c\n");
		p.git("add", "--", "c.txt");
		p.precommitExits(2);
		let direct = 0;
		try {
			execFileSync(
				"sh",
				["-e", path.join(p.root, ".husky", "prepare-commit-msg")],
				{
					cwd: p.root,
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
		} catch (e) {
			direct = (e as { status?: number }).status ?? 0;
		}
		expect(direct).toBe(2);
		expect(attempt(p.root, "commit", "--no-verify", "-m", "c").code).toBe(1);
	});
});

describe("the stand-down stamp", () => {
	it("makes an ordinary `git commit` run the gate stack exactly once", () => {
		// Without it this hook would double every commit's ~14 gates.
		const p = probe();
		fs.writeFileSync(path.join(p.root, "b.txt"), "b\n");
		p.git("add", "--", "b.txt");
		p.reset();

		expect(attempt(p.root, "commit", "-m", "b").code).toBe(0);
		expect(p.fired()).toEqual(["pre-commit"]);
	});

	it("makes an ordinary `git merge` run it exactly once too", () => {
		// pre-merge-commit runs pre-commit, which stamps; prepare-commit-msg then
		// stands down on that stamp.
		const p = probe();
		sideBranch(p, "side", { "side.txt": "side\n" });
		diverge(p);
		p.reset();

		expect(attempt(p.root, "merge", "side", "-m", "merged").code).toBe(0);
		expect(p.fired()).toEqual(["pre-commit"]);
	});

	it("is consumed on read, so it stands down one commit and no more", () => {
		const p = probe();
		fs.writeFileSync(path.join(p.root, "b.txt"), "b\n");
		p.git("add", "--", "b.txt");
		expect(attempt(p.root, "commit", "-m", "b").code).toBe(0);
		expect(fs.existsSync(path.join(p.gitDir(), STAMP))).toBe(false);

		// A second commit of the SAME tree — `--allow-empty` is the only way two
		// commits share one — must not find the first one's stamp waiting.
		p.precommitExits(1);
		p.reset();
		const r = attempt(
			p.root,
			"commit",
			"--no-verify",
			"--allow-empty",
			"-m",
			"e",
		);
		expect(r.code).not.toBe(0);
		expect(p.fired()).toEqual(["pre-commit"]);
	});

	it("does not stand down when its tree no longer matches the index", () => {
		// The key is the index tree object, so a stamp from a different index —
		// the case a pid or a timestamp would get wrong — is worthless.
		const p = probe();
		fs.writeFileSync(path.join(p.root, "b.txt"), "b\n");
		p.git("add", "--", "b.txt");
		p.precommitExits(1);
		fs.writeFileSync(path.join(p.gitDir(), STAMP), `${"0".repeat(40)}\n`);
		p.reset();

		const r = attempt(p.root, "commit", "--no-verify", "-m", "b");
		expect(r.code).not.toBe(0);
		expect(p.fired()).toEqual(["pre-commit"]);
	});

	it("stands down on a stamp that DOES match, which is the paired positive", () => {
		// Without this the case above would pass on a hook that ignored the stamp
		// entirely.
		const p = probe();
		fs.writeFileSync(path.join(p.root, "b.txt"), "b\n");
		p.git("add", "--", "b.txt");
		const tree = execFileSync("git", ["write-tree"], {
			cwd: p.root,
			encoding: "utf8",
		}).trim();
		p.precommitExits(1);
		fs.writeFileSync(path.join(p.gitDir(), STAMP), `${tree}\n`);
		p.reset();

		expect(attempt(p.root, "commit", "--no-verify", "-m", "b").code).toBe(0);
		expect(p.fired()).toEqual([]);
	});

	it("is not readable from a sibling worktree", () => {
		/*
		 * It lives under `$GIT_DIR`, per-worktree, beside MERGE_HEAD — not under
		 * `$GIT_COMMON_DIR`, which every worktree shares. Were it shared, one
		 * worktree's passing gate run would stand down a `--no-verify` commit of
		 * the same tree in another.
		 */
		const p = probe();
		const wt = `${p.root}-wt`;
		temps.push(wt);
		p.git("worktree", "add", "-q", "-b", "wt-branch", wt);

		fs.writeFileSync(path.join(wt, "b.txt"), "b\n");
		execFileSync("git", ["add", "--", "b.txt"], { cwd: wt });
		const tree = execFileSync("git", ["write-tree"], {
			cwd: wt,
			encoding: "utf8",
		}).trim();
		p.precommitExits(1);

		// Planted in the MAIN worktree's git dir, naming the sibling's tree.
		fs.writeFileSync(path.join(p.gitDir(), STAMP), `${tree}\n`);
		p.reset();
		expect(attempt(wt, "commit", "--no-verify", "-m", "b").code).not.toBe(0);
		expect(p.fired()).toEqual(["pre-commit"]);

		// The same bytes in the sibling's OWN git dir do stand it down, which is
		// what makes the negative above a statement about location.
		fs.writeFileSync(path.join(p.gitDir(wt), STAMP), `${tree}\n`);
		p.reset();
		expect(attempt(wt, "commit", "--no-verify", "-m", "b").code).toBe(0);
		expect(p.fired()).toEqual([]);
		p.git("worktree", "remove", "--force", wt);
	});

	it("is written by .husky/pre-commit only on its own exit 0", () => {
		// A stamp left behind by a RED gate would stand down the next commit of
		// that tree, which is the failure mode the whole key exists to avoid.
		const p = probe();
		fs.writeFileSync(path.join(p.root, "b.txt"), "b\n");
		p.git("add", "--", "b.txt");
		p.precommitExits(1);
		attempt(p.root, "commit", "-m", "b");
		expect(fs.existsSync(path.join(p.gitDir(), STAMP))).toBe(false);
	});
});

/*
 * The replay routes (mantahostels#1706): a cherry-pick, a rebase's own replay, and the
 * `rebase --continue` that finishes a conflict resolution. All three reach this
 * hook and NONE of them reaches `pre-commit`.
 *
 * They run `gitleaks` ALONE, never the whole stack (mantahostels#1687). Every case below
 * therefore stubs `pre-commit` to exit 1: a refusal that came from the stack
 * rather than from gitleaks shows up as a fired log line.
 */
describe("the replay path: cherry-pick, rebase and rebase --continue", () => {
	/** The base branch by name: `git init` follows the machine's init.defaultBranch. */
	const readBaseBranch = (p: Probe) =>
		execFileSync("git", ["symbolic-ref", "--short", "HEAD"], {
			cwd: p.root,
			encoding: "utf8",
		}).trim();

	/** A `side` branch whose `f.txt` conflicts with the base branch's. */
	function conflictingBranches(p: Probe): string {
		fs.writeFileSync(path.join(p.root, "f.txt"), "base\n");
		p.git("add", "--", "f.txt");
		p.git("commit", "-qm", "f");
		const base = readBaseBranch(p);
		p.git("checkout", "-q", "-b", "side");
		fs.writeFileSync(path.join(p.root, "f.txt"), "side\n");
		p.git("commit", "-qm", "side", "--", "f.txt");
		p.git("checkout", "-q", base);
		fs.writeFileSync(path.join(p.root, "f.txt"), "main\n");
		p.git("commit", "-qm", "main", "--", "f.txt");
		return base;
	}

	/** Stops `p` inside a conflicted rebase of `side` onto the base branch. */
	function conflictedRebase(p: Probe): void {
		const base = conflictingBranches(p);
		p.git("checkout", "-q", "side");
		expect(attempt(p.root, "rebase", base).code).not.toBe(0);
	}

	it("runs gitleaks and not the gate stack, which is the whole design", () => {
		// The hook's two paths are separate code, so this pins the cheap one:
		// a clean cherry-pick passes while `pre-commit` would have refused it.
		const p = probe();
		sideBranch(p, "side", { "side.txt": "side\n" });
		diverge(p);
		p.precommitExits(1);
		p.reset();

		const r = attempt(p.root, "cherry-pick", "side");
		// The stub is armed and logs on sight; it never ran. That is the claim, and
		// it holds with or without gitleaks on the machine — WITHOUT it the hook
		// refuses rather than passing, so only the exit code is conditional. CI
		// has no gitleaks and was red on this case until mantahostels#1707 noticed.
		expect(p.fired()).toEqual([]);
		if (HAS_GITLEAKS) expect(r.code).toBe(0);
	});

	it.skipIf(!HAS_GITLEAKS)(
		"aborts a cherry-pick replaying a secret, naming `git cherry-pick --abort`",
		() => {
			const p = probe();
			// Built under the passing stub: the secret is already on `side` by
			// whatever route put it there, and the cherry-pick is the moment it
			// would reach this branch.
			sideBranch(p, "side", { "creds.txt": `${SECRET}\n` });
			diverge(p);
			p.precommitExits(1);
			p.reset();
			const before = gitLog(p, "--format=%H", "-1").trim();

			const r = attempt(p.root, "cherry-pick", "side");
			expect(r.code).not.toBe(0);
			expect(r.output).toContain("git cherry-pick --abort");
			expect(p.fired()).toEqual([]);
			expect(gitLog(p, "--format=%H", "-1").trim()).toBe(before);
			// `--all` reaches `side`, where the secret legitimately lives.
			expect(gitLog(p, "-p", "HEAD")).not.toContain(SECRET);
			// The message names an abort command because there IS something to
			// abort.
			expect(fs.existsSync(path.join(p.gitDir(), "CHERRY_PICK_HEAD"))).toBe(
				true,
			);
		},
	);

	it.skipIf(!HAS_GITLEAKS)(
		"aborts a rebase replaying a secret, naming `git rebase --abort`",
		() => {
			// A rebase replay sets CHERRY_PICK_HEAD *and* rebase-merge, so this
			// pins the route naming too.
			const p = probe();
			sideBranch(p, "side", { "creds.txt": `${SECRET}\n` });
			diverge(p);
			const base = readBaseBranch(p);
			p.git("checkout", "-q", "side");
			p.precommitExits(1);
			p.reset();

			const r = attempt(p.root, "rebase", base);
			expect(r.code).not.toBe(0);
			expect(r.output).toContain("git rebase --abort");
			expect(r.output).not.toContain("git cherry-pick --abort");
			expect(p.fired()).toEqual([]);
			expect(gitLog(p, "-p", "HEAD")).not.toContain(SECRET);
		},
	);

	it.skipIf(!HAS_GITLEAKS)(
		"aborts a `git rebase --continue` resolution carrying a secret",
		() => {
			// The case this ticket exists for: `rebase --continue` fires no
			// pre-commit at all (measured mantahostels#1706).
			const p = probe();
			conflictedRebase(p);
			p.precommitExits(1);
			p.reset();
			fs.writeFileSync(path.join(p.root, "f.txt"), `${SECRET}\n`);
			p.git("add", "--", "f.txt");

			const r = attempt(p.root, "rebase", "--continue");
			expect(r.code).not.toBe(0);
			expect(r.output).toContain("git rebase --abort");
			expect(p.fired()).toEqual([]);
			expect(gitLog(p, "-p", "--all")).not.toContain(SECRET);
			// The refusal costs the founder nothing he typed.
			expect(fs.readFileSync(path.join(p.root, "f.txt"), "utf8")).toContain(
				SECRET,
			);
			expect(fs.existsSync(path.join(p.gitDir(), "rebase-merge"))).toBe(true);
		},
	);

	it.skipIf(!HAS_GITLEAKS)(
		"lets a clean `git rebase --continue` through",
		() => {
			// The paired positive: the replay path refuses on a finding, not on the
			// route.
			const p = probe();
			conflictedRebase(p);
			p.precommitExits(1);
			p.reset();
			fs.writeFileSync(path.join(p.root, "f.txt"), "resolved\n");
			p.git("add", "--", "f.txt");

			expect(attempt(p.root, "rebase", "--continue").code).toBe(0);
			expect(p.fired()).toEqual([]);
			expect(fs.existsSync(path.join(p.gitDir(), "rebase-merge"))).toBe(false);
		},
	);

	it.skipIf(!HAS_GITLEAKS)(
		"aborts a cherry-pick conflict resolution carrying a secret",
		() => {
			// Refused by the WHOLE stack rather than by the replay path, because
			// `cherry-pick --continue` fires pre-commit — the case below pins why.
			const p = probe();
			conflictingBranches(p);
			expect(attempt(p.root, "cherry-pick", "side").code).not.toBe(0);
			p.precommitBody(`${SCAN} || exit 1\n`);
			fs.writeFileSync(path.join(p.root, "f.txt"), `${SECRET}\n`);
			p.git("add", "--", "f.txt");
			const before = gitLog(p, "--format=%H", "-1").trim();

			expect(attempt(p.root, "cherry-pick", "--continue").code).not.toBe(0);
			expect(gitLog(p, "--format=%H", "-1").trim()).toBe(before);
			expect(gitLog(p, "-p", "HEAD")).not.toContain(SECRET);
		},
	);

	it("runs the WHOLE stack on a cherry-pick conflict resolution", () => {
		/*
		 * The asymmetry, measured at mantahostels#1706: `git cherry-pick --continue` fires
		 * `pre-commit` and so was gated all along, while `git rebase --continue`
		 * fires none and is what the case above closes.
		 */
		const p = probe();
		const base = conflictingBranches(p);
		expect(base).toBeTruthy();
		expect(attempt(p.root, "cherry-pick", "side").code).not.toBe(0);
		p.precommitExits(1);
		p.reset();
		fs.writeFileSync(path.join(p.root, "f.txt"), "resolved\n");
		p.git("add", "--", "f.txt");

		expect(attempt(p.root, "cherry-pick", "--continue").code).not.toBe(0);
		expect(p.fired()).toEqual(["pre-commit"]);
	});

	it("does not fire on `git am` at all, so nothing there to stand down", () => {
		// Measured at mantahostels#1705 and re-measured at mantahostels#1706 for `rebase --apply`: git runs
		// no prepare-commit-msg for either. `.husky/pre-applypatch` is the seam
		// that covers them, and mantahostels#1707 owns it.
		const p = probe();
		sideBranch(p, "side", { "side.txt": "side\n" });
		const patches = path.join(p.root, "patches");
		p.git("format-patch", "-1", "side", "-o", patches);
		p.precommitExits(1);
		p.reset();
		const file = fs
			.readdirSync(patches)
			.map((f) => path.join(patches, f))
			.find((f) => f.endsWith(".patch")) as string;
		expect(attempt(p.root, "am", file).code).toBe(0);
		expect(p.fired()).toEqual([]);
	});
});

describe("the routes that still run the whole stack", () => {
	const ready = (p: Probe) => {
		sideBranch(p, "side", { "side.txt": "side\n" });
		diverge(p);
		p.precommitExits(1);
		p.reset();
	};

	it("DOES gate a revert — git leaves nothing to tell one from a commit", () => {
		/*
		 * The incidental widening the hook's comment records, ruled deliberate at
		 * mantahostels#1706. Measured at mantahostels#1705: a clean `git revert` sets neither REVERT_HEAD
		 * nor CHERRY_PICK_HEAD, and the only files separating it from an ordinary
		 * commit — AUTO_MERGE, MERGE_MSG — are ones a killed merge can strand, so
		 * keying a stand-down on either would put a stale-file hole in the one hook
		 * `--no-verify` cannot skip.
		 */
		const p = probe();
		ready(p);
		const r = attempt(p.root, "revert", "--no-edit", "HEAD");
		expect(r.code).not.toBe(0);
		expect(p.fired()).toEqual(["pre-commit"]);
	});

	it.skipIf(!HAS_GITLEAKS)(
		"aborts a `git revert` that reintroduces a removed secret",
		() => {
			const p = probe();
			fs.writeFileSync(path.join(p.root, "creds.txt"), `${SECRET}\n`);
			p.git("add", "--", "creds.txt");
			p.git("commit", "-qm", "creds");
			fs.rmSync(path.join(p.root, "creds.txt"));
			p.git("commit", "-qm", "drop creds", "--", "creds.txt");
			p.precommitBody(`${SCAN} || exit 1\n`);
			const before = gitLog(p, "--format=%H", "-1").trim();

			const r = attempt(p.root, "revert", "--no-edit", "HEAD");
			expect(r.code).not.toBe(0);
			// The secret is in this repo's history by construction, so the claim is
			// that the revert did not commit: HEAD has not moved.
			expect(gitLog(p, "--format=%H", "-1").trim()).toBe(before);
		},
	);

	it("runs the whole stack once per commit of a multi-commit revert", () => {
		/*
		 * `git revert A B` reaches this hook once per commit with `sequencer`
		 * set, and never reaches `pre-commit` (measured at #1476). Today's
		 * behaviour, kept until the founder rules on #1503's round: a red names
		 * `git revert --abort`, which is what clears the sequence.
		 */
		const p = probe();
		diverge(p);
		fs.writeFileSync(path.join(p.root, "second.txt"), "second\n");
		p.git("add", "--", "second.txt");
		p.git("commit", "-qm", "second");
		p.reset();
		expect(attempt(p.root, "revert", "--no-edit", "HEAD", "HEAD~1").code).toBe(
			0,
		);
		expect(p.fired()).toEqual(["pre-commit", "pre-commit"]);

		p.precommitExits(1);
		p.reset();
		const r = attempt(p.root, "revert", "--no-edit", "HEAD", "HEAD~1");
		expect(r.code).not.toBe(0);
		expect(r.output).toContain("git revert --abort");
		expect(fs.existsSync(path.join(p.gitDir(), "sequencer"))).toBe(true);
	});

	it("lets a clean revert through, so the gating is not a wedge", () => {
		const p = probe();
		sideBranch(p, "side", { "side.txt": "side\n" });
		diverge(p);
		p.reset();
		expect(attempt(p.root, "revert", "--no-edit", "HEAD").code).toBe(0);
		expect(p.fired()).toEqual(["pre-commit"]);
	});

	it("gates a merge rather than standing it down — it sets none of the three", () => {
		// The separation that matters: a rebase sets CHERRY_PICK_HEAD, a merge sets
		// MERGE_HEAD and AUTO_MERGE, and a replay path widened onto either of the
		// latter would silently drop a merge from the whole stack to gitleaks
		// alone.
		const p = probe();
		ready(p);
		const r = attempt(p.root, "merge", "--no-verify", "side", "-m", "m");
		expect(r.code).not.toBe(0);
		expect(p.fired()).toEqual(["pre-commit"]);
	});
});

describe("the prepare-commit-msg hook's own linting", () => {
	it("is in check:sh's file set, which pre-commit's shell gate shares (#1828)", () => {
		// A husky hook nothing lints is a hook whose next edit breaks silently:
		// `npm run lint` never sees a shell file.
		const set = runInProcess(
			path.join(ROOT, "scripts/lib/formatters.js"),
			["shell-files", "--tracked"],
			{ cwd: ROOT },
		).stdout;
		expect(set.split("\n")).toContain(".husky/prepare-commit-msg");
	});
});

/*
 * git-fixture.ts (mantahostels#2068) leak-checks every instantiate() call itself, so a
 * relink failure — the template's own path surviving into a copy — already
 * throws before any test body below runs. What this proves instead is the
 * BEHAVIOURAL isolation the leak check does not: a commit made in one
 * instantiated copy must not reach a second, independent instantiation of
 * the same template. This build has no worktree or `objects/info/alternates`
 * for a copy to share back into the template through.
 */
describe("the copied fixture is isolated from its template (mantahostels#2068)", () => {
	it("a commit made in the copy leaves the template untouched", () => {
		const p = probe();
		fs.writeFileSync(path.join(p.root, "only-in-copy.txt"), "x\n");
		p.git("add", "--", "only-in-copy.txt");
		p.git("commit", "-qm", "only in the copy");
		expect(gitLog(p, "--oneline")).toContain("only in the copy");

		const fresh = probe();
		expect(gitLog(fresh, "--oneline")).not.toContain("only in the copy");
	});
});

/*
 * THE CLOSING-KEYWORD SEAMS (#138).
 *
 * The guard-commit-form core denies the same pattern at PreToolUse, but it
 * reads `-m`/`--message` values alone. These cases drive the four routes that
 * reach GitHub past it — `-F <file>`, a `-c`/`-C` reuse, a message typed into
 * $EDITOR, and a `--no-verify` commit — through real git. The pattern itself
 * is covered by scripts/check-commit-message-closes.test.ts.
 */
describe("the closing-keyword refusal (#138)", () => {
	/** Stages `body` into `f.txt` so each case has something to commit. */
	const stage = (p: Probe, body: string) => {
		fs.writeFileSync(path.join(p.root, "f.txt"), body);
		p.git("add", "--", "f.txt");
	};

	it("passes a message that references an issue without closing it", () => {
		const p = probe();
		stage(p, "a\n");
		const r = attempt(p.root, "commit", "-qm", "Refs #12 do a thing");
		expect(r.code).toBe(0);
		expect(gitLog(p, "--format=%s", "-1")).toContain("Refs #12");
	});

	it("refuses -m at prepare-commit-msg, quoting the keyword that matched", () => {
		const p = probe();
		stage(p, "b\n");
		const r = attempt(p.root, "commit", "-qm", "Fixes #12 do a thing");
		expect(r.code).not.toBe(0);
		expect(r.output).toContain("prepare-commit-msg:");
		expect(r.output).toContain("What matched: `Fixes #12`");
	});

	it("refuses -F <file>, which the PreToolUse guard cannot see, quoting the keyword that matched", () => {
		const p = probe();
		stage(p, "c\n");
		fs.writeFileSync(path.join(p.root, "msg.txt"), "Closes #13 via a file\n");
		const r = attempt(p.root, "commit", "-q", "-F", "msg.txt");
		expect(r.code).not.toBe(0);
		expect(r.output).toContain("What matched: `Closes #13`");
	});

	it("refuses --no-verify, which cannot skip prepare-commit-msg", () => {
		const p = probe();
		stage(p, "d\n");
		const r = attempt(p.root, "commit", "-q", "--no-verify", "-m", "Fixed #15");
		expect(r.code).not.toBe(0);
		expect(r.output).toContain("prepare-commit-msg:");
	});

	/*
	 * The one route prepare-commit-msg cannot cover, and the whole reason
	 * .husky/commit-msg exists: git runs prepare-commit-msg BEFORE the editor
	 * opens and hands it an empty message file (measured at #138). The
	 * assertion names the seam, not just the refusal — a pass here with
	 * "prepare-commit-msg:" in the output would mean the editor route is being
	 * caught by accident.
	 */
	it("refuses a message typed into $EDITOR, at commit-msg, quoting the keyword that matched", () => {
		const p = probe();
		stage(p, "e\n");
		let r: { code: number; output: string };
		try {
			const out = execFileSync("git", ["commit", "-q"], {
				cwd: p.root,
				encoding: "utf8",
				env: {
					...process.env,
					GIT_EDITOR: `sh -c 'printf "Resolves #14 typed\n" > "$1"' --`,
				},
				stdio: ["ignore", "pipe", "pipe"],
			});
			r = { code: 0, output: out };
		} catch (e) {
			const err = e as { status?: number; stdout?: string; stderr?: string };
			r = {
				code: err.status ?? 1,
				output: `${err.stdout ?? ""}${err.stderr ?? ""}`,
			};
		}
		expect(r.code).not.toBe(0);
		// `toContain("commit-msg:")` alone is satisfied by "prepare-commit-msg:",
		// so the seam is named by excluding the other one.
		expect(r.output).not.toContain("prepare-commit-msg:");
		expect(r.output).toContain("commit-msg:");
		expect(r.output).toContain("What matched: `Resolves #14`");
	});

	it("carries the rule text, not just the match", () => {
		const p = probe();
		stage(p, "f\n");
		const r = attempt(p.root, "commit", "-qm", "Fixes #12");
		expect(r.output).toContain("Refs #n");
	});

	/*
	 * A revert of a pre-#129 commit generates `Revert "Fixes #77 …"` verbatim,
	 * and sets none of the replay markers the hook stands down on — so the
	 * scanner drops the quoted subject line instead. Refusing here would strand
	 * a revert behind a message nobody wrote.
	 */
	it("lets a revert of a keyword-carrying commit through", () => {
		const p = probe();
		fs.writeFileSync(path.join(p.root, "g.txt"), "g\n");
		p.git("add", "--", "g.txt");
		execFileSync("git", ["commit", "-qm", "Fixes #77 add g"], {
			cwd: p.root,
			env: { ...process.env, HUSKY: "0" },
		});
		const r = attempt(p.root, "revert", "--no-edit", "HEAD");
		expect(r.code).toBe(0);
		expect(gitLog(p, "--format=%s", "-1")).toContain('Revert "Fixes #77');
	});

	it("refuses a message reused with -C, which the guard cannot see either, quoting the keyword that matched", () => {
		const p = probe();
		stage(p, "i\n");
		execFileSync("git", ["commit", "-qm", "Fixes #78 the original"], {
			cwd: p.root,
			env: { ...process.env, HUSKY: "0" },
		});
		stage(p, "j\n");
		const r = attempt(p.root, "commit", "-q", "-C", "HEAD");
		expect(r.code).not.toBe(0);
		expect(r.output).toContain("What matched: `Fixes #78`");
	});

	/*
	 * `cherry-pick --continue` reaches `commit-msg`, where `prepare-commit-msg` has already stood down on the
	 * same markers. Without a stand-down of its own, the replayed commit's own
	 * pre-#129 keyword strands the sequence behind a message nobody is writing.
	 */
	it("lets a cherry-pick conflict resolution replay a keyword commit", () => {
		const p = probe();
		const start = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], {
			cwd: p.root,
			encoding: "utf8",
		}).trim();

		p.git("checkout", "-q", "-b", "side");
		fs.writeFileSync(path.join(p.root, "conflict.txt"), "side\n");
		p.git("add", "--", "conflict.txt");
		execFileSync("git", ["commit", "-qm", "Fixes #79 the side edit"], {
			cwd: p.root,
			env: { ...process.env, HUSKY: "0" },
		});

		p.git("checkout", "-q", start);
		fs.writeFileSync(path.join(p.root, "conflict.txt"), "main\n");
		p.git("add", "--", "conflict.txt");
		p.git("commit", "-qm", "the main edit");

		expect(attempt(p.root, "cherry-pick", "side").code).not.toBe(0);
		fs.writeFileSync(path.join(p.root, "conflict.txt"), "resolved\n");
		p.git("add", "--", "conflict.txt");
		const r = attempt(p.root, "cherry-pick", "--continue");
		expect(r.code).toBe(0);
		expect(gitLog(p, "--format=%s", "-1")).toContain("Fixes #79");
	});

	it("fails closed when the scanner is missing", () => {
		const p = probe();
		fs.rmSync(path.join(p.root, "scripts/check-commit-message-closes.sh"));
		stage(p, "h\n");
		const r = attempt(p.root, "commit", "-qm", "an ordinary message");
		expect(r.code).not.toBe(0);
		expect(r.output).toContain("missing");
	});

	it("keeps .husky/commit-msg in check:sh's file set", () => {
		const set = runInProcess(
			path.join(ROOT, "scripts/lib/formatters.js"),
			["shell-files", "--tracked"],
			{ cwd: ROOT },
		).stdout;
		expect(set.split("\n")).toContain(".husky/commit-msg");
	});
});

describe("the review hold's Review-Tier: trailer (#3664)", () => {
	/** A pre-commit that leaves the stamp the review hold leaves on a pass. */
	const holding = (p: Probe) =>
		p.precommitBody(
			`t="$(git write-tree)"\nprintf '%s\\nescalated; areas=secrets; base=b; tree=%s; paths=f.txt\\n' "$t" "$t" >"$(git rev-parse --absolute-git-dir)/wfc-review-tier"\n${precommitStub(path.join(p.root, LOG), 0)}`,
		);
	const trailer = (p: Probe) =>
		gitLog(p, "-1", "--format=%(trailers:key=Review-Tier,valueonly)").trim();

	for (const [route, flags] of [
		["standing down on pre-commit's stamp", []],
		["running pre-commit itself under --no-verify", ["--no-verify"]],
	] as const)
		it(`writes it on a commit ${route}`, () => {
			const p = probe();
			holding(p);
			fs.writeFileSync(path.join(p.root, "f.txt"), "held\n");
			p.git("add", "--", "f.txt");
			const tree = execFileSync("git", ["write-tree"], {
				cwd: p.root,
				encoding: "utf8",
			}).trim();
			const r = attempt(p.root, "commit", "-qm", "land it", ...flags);
			expect(r.code).toBe(0);
			expect(trailer(p)).toBe(
				`escalated; areas=secrets; base=b; tree=${tree}; paths=f.txt`,
			);
		});
});
