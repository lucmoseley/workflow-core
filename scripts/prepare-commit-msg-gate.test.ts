// @vitest-environment node
// isolation-exempt: every fixture holds a stub at this path, which logs nothing.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineTemplate, mkScratchDir } from "./lib/git-fixture";
import { readGuardErrorsLog } from "./lib/guard-errors-log";
import { huskyHooks, installHuskyShim } from "./lib/husky-testkit";
import { registerTempCleanup } from "./lib/precommit-gate-harness";
import { ROOT } from "./lib/precommit-gate-testkit";
import { reviewTierStamp } from "./lib/review-tier-stamp.js";
import { runInProcess } from "./lib/run-in-process.js";
import { shellQuote } from "./lib/sh-quote.js";

const HOOK_REL = path.join(".husky", "prepare-commit-msg");
const HOOK = fs.readFileSync(path.join(ROOT, HOOK_REL), "utf8");
const ROWS_SOURCE = fs.readFileSync(
	path.join(ROOT, "scripts", "lib", "prepare-commit-msg-rows.js"),
	"utf8",
);
const PRECOMMIT = fs.readFileSync(
	path.join(ROOT, ".husky", "pre-commit"),
	"utf8",
);

const SCAN = `"\${WFC_GITLEAKS:-gitleaks}" git --staged --redact`;

const STAMP = "wfc-precommit-stamp";

const temps = registerTempCleanup();

const programStub = (exit: number, stderr: string) =>
	`module.exports = { PROGRAM: () => ({ exit: ${exit}, stdout: "", stderr: ${JSON.stringify(stderr)} }) };\n`;

const HOLD = "scripts/review-hold-gate.js";
const LOG = "fired.log";

const SECRET = `AKIA${"2QQ7WZ4KKPFXJ3RN"}`;

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
	fired: () => string[];
	reset: () => void;
	precommitExits: (code: number) => void;
	precommitBody: (body: string) => void;
	gitDir: (cwd?: string) => string;
}

function precommitStub(log: string, code: number): string {
	return (
		`echo "pre-commit" >> ${shellQuote(log)}\n` +
		(code === 0 ? `${parseStampBlock()}\nexit 0\n` : `exit ${code}\n`)
	);
}

const buildTemplate = (root: string) => {
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
	git("init", "-q", ".");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");

	const husky = path.join(root, ".husky");
	installHuskyShim(root);
	for (const f of ["prepare-commit-msg", "pre-merge-commit", "commit-msg"])
		fs.copyFileSync(path.join(ROOT, ".husky", f), path.join(husky, f));

	for (const rel of ["scripts/lib/local-hook.sh"]) {
		const dest = path.join(root, rel);
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.copyFileSync(path.join(ROOT, rel), dest);
	}
	for (const rel of [
		"scripts/check-commit-message-closes.js",
		"scripts/commit-msg-dispatch.js",
		"scripts/prepare-commit-msg-dispatch.js",
		"scripts/review-tier-trailer.js",
	])
		fs.symlinkSync(path.join(ROOT, rel), path.join(root, rel));

	const log = path.join(root, LOG);
	fs.writeFileSync(path.join(husky, "pre-commit"), precommitStub(log, 0));
	fs.writeFileSync(path.join(root, HOLD), programStub(0, ""));

	fs.writeFileSync(path.join(root, "base.txt"), "base\n");
	git("add", "--", "base.txt");
	git("commit", "-qm", "base");
};

const template = defineTemplate(buildTemplate);

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

function attempt(
	cwd: string,
	...args: string[]
): { code: number; output: string } {
	const r = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, GIT_EDITOR: "true" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	return { code: r.status ?? 1, output: `${r.stdout}${r.stderr}` };
}

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

function diverge(p: Probe): void {
	fs.writeFileSync(path.join(p.root, "base.txt"), "moved\n");
	p.git("commit", "-qm", "moved", "--", "base.txt");
}

const gitLog = (p: Probe, ...args: string[]) =>
	execFileSync("git", ["log", ...args], { cwd: p.root, encoding: "utf8" });

describe(".husky/prepare-commit-msg", () => {
	it("is the hook husky actually dispatches", () => {
		expect(fs.existsSync(path.join(ROOT, HOOK_REL))).toBe(true);
		expect(huskyHooks()).toContain("prepare-commit-msg");
	});

	it("runs the whole of .husky/pre-commit rather than a copied gate list", () => {
		expect(ROWS_SOURCE).toMatch(
			/spawnSync\("sh", \["-e", path\.join\(ctx\.husky, "pre-commit"\)\]/,
		);
		const code = HOOK.split("\n").filter((l) => !l.trimStart().startsWith("#"));
		expect(code.join("\n")).not.toMatch(/node scripts\/|npm run|gitleaks/);
		expect(ROWS_SOURCE.split('["git", "--staged", "--redact"]').length).toBe(2);
	});

	it("refuses every commit when its dispatcher is missing", () => {
		const p = probe();
		fs.rmSync(path.join(p.root, "scripts/prepare-commit-msg-dispatch.js"));
		fs.writeFileSync(path.join(p.root, "m.txt"), "m\n");
		p.git("add", "--", "m.txt");
		const before = gitLog(p, "--format=%H", "-1").trim();

		const r = attempt(p.root, "commit", "-m", "m");
		expect(r.code).not.toBe(0);
		expect(r.output).toContain(
			"prepare-commit-msg-dispatch.js is missing, so this commit's route cannot be read.\n  Refusing rather than gating it as an ordinary commit (#1503).",
		);
		expect(gitLog(p, "--format=%H", "-1").trim()).toBe(before);
	});

	it("refuses in one line when the dispatcher's lib/hook-entry.js will not load", () => {
		const p = probe();
		const entry = path.join(p.root, "scripts/prepare-commit-msg-dispatch.js");
		fs.rmSync(entry);
		fs.copyFileSync(
			path.join(ROOT, "scripts/prepare-commit-msg-dispatch.js"),
			entry,
		);
		for (const name of fs.readdirSync(path.join(ROOT, "scripts/lib")))
			if (!["hook-entry.js", "local-hook.sh"].includes(name))
				fs.symlinkSync(
					path.join(ROOT, "scripts/lib", name),
					path.join(p.root, "scripts/lib", name),
				);
		fs.writeFileSync(path.join(p.root, "m.txt"), "m\n");
		p.git("add", "--", "m.txt");
		const before = gitLog(p, "--format=%H", "-1").trim();

		const r = attempt(p.root, "commit", "-m", "m");
		expect(r.code).not.toBe(0);
		expect(r.output).toContain(
			"prepare-commit-msg: the dispatcher threw: Cannot find module './lib/hook-entry.js'\n",
		);
		expect(r.output).not.toContain("    at ");
		expect(gitLog(p, "--format=%H", "-1").trim()).toBe(before);
	});
});

describe("the premise: what --no-verify does and does not skip", () => {
	it("skips pre-commit but NOT prepare-commit-msg on `git commit`", () => {
		const p = probe();
		fs.writeFileSync(path.join(p.root, "c.txt"), "c\n");
		p.git("add", "--", "c.txt");
		p.precommitExits(1);
		p.reset();

		const r = attempt(p.root, "commit", "--no-verify", "-m", "c");
		expect(r.code).not.toBe(0);
		expect(r.output).toContain("--no-verify cannot turn it off");
		expect(p.fired()).toEqual(["pre-commit"]);
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
			sideBranch(p, "side", { "creds.txt": `${SECRET}\n` });
			diverge(p);
			p.precommitBody(`${SCAN} || exit 1\n`);
			const before = gitLog(p, "--format=%H", "-1").trim();

			const r = attempt(p.root, "merge", "--no-verify", "side", "-m", "merged");
			expect(r.code).not.toBe(0);
			expect(gitLog(p, "--format=%H", "-1").trim()).toBe(before);
			expect(gitLog(p, "-p", "HEAD")).not.toContain(SECRET);
			expect(fs.existsSync(path.join(p.gitDir(), "MERGE_HEAD"))).toBe(true);
		},
	);

	it("lets a clean `git commit --no-verify` through", () => {
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
		const p = probe();
		fs.writeFileSync(path.join(p.root, "b.txt"), "b\n");
		p.git("add", "--", "b.txt");
		p.reset();

		expect(attempt(p.root, "commit", "-m", "b").code).toBe(0);
		expect(p.fired()).toEqual(["pre-commit"]);
	});

	it("makes an ordinary `git merge` run it exactly once too", () => {
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

		fs.writeFileSync(path.join(p.gitDir(), STAMP), `${tree}\n`);
		p.reset();
		expect(attempt(wt, "commit", "--no-verify", "-m", "b").code).not.toBe(0);
		expect(p.fired()).toEqual(["pre-commit"]);

		fs.writeFileSync(path.join(p.gitDir(wt), STAMP), `${tree}\n`);
		p.reset();
		expect(attempt(wt, "commit", "--no-verify", "-m", "b").code).toBe(0);
		expect(p.fired()).toEqual([]);
		p.git("worktree", "remove", "--force", wt);
	});

	it("is written by .husky/pre-commit only on its own exit 0", () => {
		const p = probe();
		fs.writeFileSync(path.join(p.root, "b.txt"), "b\n");
		p.git("add", "--", "b.txt");
		p.precommitExits(1);
		attempt(p.root, "commit", "-m", "b");
		expect(fs.existsSync(path.join(p.gitDir(), STAMP))).toBe(false);
	});
});

describe("the replay path: cherry-pick, rebase and rebase --continue", () => {
	const readBaseBranch = (p: Probe) =>
		execFileSync("git", ["symbolic-ref", "--short", "HEAD"], {
			cwd: p.root,
			encoding: "utf8",
		}).trim();

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

	function conflictedRebase(p: Probe): void {
		const base = conflictingBranches(p);
		p.git("checkout", "-q", "side");
		expect(attempt(p.root, "rebase", base).code).not.toBe(0);
	}

	it("runs gitleaks and not the gate stack, which is the whole design", () => {
		const p = probe();
		sideBranch(p, "side", { "side.txt": "side\n" });
		diverge(p);
		p.precommitExits(1);
		p.reset();

		const r = attempt(p.root, "cherry-pick", "side");
		expect(p.fired()).toEqual([]);
		if (HAS_GITLEAKS) expect(r.code).toBe(0);
	});

	it.skipIf(!HAS_GITLEAKS)(
		"aborts a cherry-pick replaying a secret, naming `git cherry-pick --abort`",
		() => {
			const p = probe();
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
			expect(gitLog(p, "-p", "HEAD")).not.toContain(SECRET);
			expect(fs.existsSync(path.join(p.gitDir(), "CHERRY_PICK_HEAD"))).toBe(
				true,
			);
		},
	);

	it.skipIf(!HAS_GITLEAKS)(
		"aborts a rebase replaying a secret, naming `git rebase --abort`",
		() => {
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
			expect(fs.readFileSync(path.join(p.root, "f.txt"), "utf8")).toContain(
				SECRET,
			);
			expect(fs.existsSync(path.join(p.gitDir(), "rebase-merge"))).toBe(true);
		},
	);

	it.skipIf(!HAS_GITLEAKS)(
		"lets a clean `git rebase --continue` through",
		() => {
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
			expect(gitLog(p, "--format=%H", "-1").trim()).toBe(before);
		},
	);

	it("runs the whole stack once per commit of a multi-commit revert", () => {
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
		const p = probe();
		ready(p);
		const r = attempt(p.root, "merge", "--no-verify", "side", "-m", "m");
		expect(r.code).not.toBe(0);
		expect(p.fired()).toEqual(["pre-commit"]);
	});
});

describe("the prepare-commit-msg hook's own linting", () => {
	it("is in check:sh's file set, which pre-commit's shell gate shares (#1828)", () => {
		const set = runInProcess(
			path.join(ROOT, "scripts/lib/formatters.js"),
			["shell-files", "--tracked"],
			{ cwd: ROOT },
		).stdout;
		expect(set.split("\n")).toContain(".husky/prepare-commit-msg");
	});
});

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

describe("the closing-keyword refusal (#138)", () => {
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
		fs.rmSync(path.join(p.root, "scripts/check-commit-message-closes.js"));
		stage(p, "h\n");
		const r = attempt(p.root, "commit", "-qm", "an ordinary message");
		expect(r.code).not.toBe(0);
		expect(r.output).toContain(
			"check-commit-message-closes.js is missing, so the closing-keyword scan did not run.\n  Refusing rather than passing the message unread (#138).",
		);
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

function loggingTo(p: Probe): string {
	for (const rel of ["scripts/lib/guard-log.sh", "scripts/lib/guard-root.sh"])
		fs.copyFileSync(path.join(ROOT, rel), path.join(p.root, rel));
	const config = mkScratchDir("prepare-commit-msg-config-");
	temps.push(config);
	vi.stubEnv("CLAUDE_CONFIG_DIR", config);
	return config;
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("the review hold on a cherry-pick's replay path (#3905)", () => {
	const refusing = (p: Probe) =>
		fs.writeFileSync(
			path.join(p.root, HOLD),
			programStub(1, "the hold refused this pick\n"),
		);
	const sideCommit = (p: Probe, rel: string) => {
		p.git("checkout", "-qb", "side");
		fs.writeFileSync(path.join(p.root, rel), "theirs\n");
		p.git("add", "--", rel);
		p.git("commit", "-qm", "theirs");
		const sha = gitLog(p, "-1", "--format=%H").trim();
		p.git("checkout", "-q", "-");
		return sha;
	};

	it("refuses a clean pick the hold refuses, naming the abort", () => {
		const p = probe();
		const pick = sideCommit(p, "f.txt");
		refusing(p);
		const r = attempt(p.root, "cherry-pick", pick);
		expect(r.code).not.toBe(0);
		expect(r.output).toContain("the hold refused this pick");
		expect(r.output).toContain("git cherry-pick --abort");
		expect(fs.existsSync(path.join(p.gitDir(), "CHERRY_PICK_HEAD"))).toBe(true);
	});

	it("refuses --no-verify at a stopped pick, which reaches no pre-commit", () => {
		const p = probe();
		const pick = sideCommit(p, "f.txt");
		fs.writeFileSync(path.join(p.root, "f.txt"), "mine\n");
		p.git("add", "--", "f.txt");
		p.git("commit", "-qm", "mine");
		expect(attempt(p.root, "cherry-pick", pick).code).toBe(1);
		fs.writeFileSync(path.join(p.root, "f.txt"), "SNEAK\n");
		p.git("add", "--", "f.txt");
		refusing(p);
		const r = attempt(p.root, "commit", "-qm", "land", "--no-verify");
		expect(r.code).toBe(1);
		expect(r.output).toContain("the hold refused this pick");
	});

	it("passes where the hold is missing, saying so and logging it (#4051)", () => {
		const p = probe();
		const pick = sideCommit(p, "f.txt");
		fs.rmSync(path.join(p.root, HOLD));
		const config = loggingTo(p);
		const r = attempt(p.root, "cherry-pick", pick);
		expect(r.code).toBe(0);
		expect(r.output).toContain("this cherry-pick went unchecked");
		expect(readGuardErrorsLog(config)).toMatch(
			/\tprepare-commit-msg\treview-hold-gate\.js is missing — this cherry-pick went unchecked for a sensitive-path review\n$/,
		);
	});

	it("passes where the trailer script is missing, saying so and logging it (#4051)", () => {
		const p = probe();
		fs.rmSync(path.join(p.root, "scripts", "review-tier-trailer.js"));
		const config = loggingTo(p);
		fs.writeFileSync(path.join(p.root, "f.txt"), "new\n");
		p.git("add", "--", "f.txt");
		const r = attempt(p.root, "commit", "-qm", "land");
		expect(r.code).toBe(0);
		expect(r.output).toContain("lands with no Review-Tier: trailer");
		expect(readGuardErrorsLog(config)).toMatch(
			/\tprepare-commit-msg\treview-tier-trailer\.js is missing — this commit lands with no Review-Tier: trailer and no check that its tree stayed put\n$/,
		);
	});

	it("takes no hold on a rebase", () => {
		const p = probe();
		sideCommit(p, "f.txt");
		fs.writeFileSync(path.join(p.root, "g.txt"), "mine\n");
		p.git("add", "--", "g.txt");
		p.git("commit", "-qm", "mine");
		refusing(p);
		expect(attempt(p.root, "rebase", "side").code).toBe(0);
	});
});

describe("the review hold's Review-Tier: trailer (#3664)", () => {
	beforeEach(() => {
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", "session-under-test");
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	const refusingTrailer = (p: Probe) => {
		const trailer = path.join(p.root, "scripts", "review-tier-trailer.js");
		fs.rmSync(trailer);
		fs.writeFileSync(
			trailer,
			programStub(1, "the hold refused the moved tree\n"),
		);
	};
	const stampFor = (p: Probe, name: string) =>
		fs.writeFileSync(
			reviewTierStamp(path.join(p.root, ".git"), name) as string,
			"t\nescalated\n",
		);
	const commitHeld = (p: Probe, message: string, flags: string[] = []) => {
		fs.writeFileSync(path.join(p.root, "f.txt"), "held\n");
		p.git("add", "--", "f.txt");
		const before = gitLog(p, "-1", "--format=%H");
		const r = attempt(p.root, "commit", "-qm", message, ...flags);
		return { ...r, moved: gitLog(p, "-1", "--format=%H") !== before };
	};

	it.each([
		["standing down on pre-commit's stamp", []],
		["running pre-commit itself under --no-verify", ["--no-verify"]],
	])(
		"refuses a commit %s where the trailer step refuses it (#3905)",
		(_, flags) => {
			const p = probe();
			p.precommitBody(precommitStub(path.join(p.root, LOG), 0));
			refusingTrailer(p);
			stampFor(p, "session-under-test");
			const r = commitHeld(p, "land it", flags);
			expect(r.code).toBe(1);
			expect(r.output).toContain("the hold refused the moved tree");
			expect(r.moved).toBe(false);
		},
	);

	it("starts no trailer on a commit with no stamp of this session's and no Review-Tier: line, which it would leave as it is (#5153)", () => {
		const p = probe();
		refusingTrailer(p);
		stampFor(p, "another-session");
		const r = commitHeld(p, "land it");
		expect(r.code).toBe(0);
		expect(r.output).not.toContain("the hold refused the moved tree");
		expect(r.moved).toBe(true);
	});

	it.each([["Review-Tier: escalated"], ["review-tier : escalated"]])(
		"starts the trailer on a message carrying %s, which it may strip (#5153)",
		(line) => {
			const p = probe();
			refusingTrailer(p);
			const r = commitHeld(p, `land it\n\n${line}`);
			expect(r.code).toBe(1);
			expect(r.output).toContain("the hold refused the moved tree");
		},
	);

	it("starts the trailer on this session's stamp, the id's other characters read as _ (#5153)", () => {
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", "a.b/c");
		const p = probe();
		refusingTrailer(p);
		stampFor(p, "a_b_c");
		const r = commitHeld(p, "land it");
		expect(r.code).toBe(1);
		expect(r.output).toContain("the hold refused the moved tree");
	});

	const dummyId = "x";
	const stampPrefix = path
		.basename(reviewTierStamp(".", dummyId) as string)
		.slice(0, -dummyId.length);
	const shellStamp = path.join(
		"$(git rev-parse --absolute-git-dir)",
		`${stampPrefix}$CLAUDE_CODE_SESSION_ID`,
	);
	const holding = (p: Probe) =>
		p.precommitBody(
			`t="$(git write-tree)"\nprintf '%s\\nescalated; areas=secrets; base=b; tree=%s; paths=f.txt\\n' "$t" "$t" >"${shellStamp}"\n${precommitStub(path.join(p.root, LOG), 0)}`,
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
