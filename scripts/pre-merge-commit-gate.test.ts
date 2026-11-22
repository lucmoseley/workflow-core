// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defineTemplate, mkScratchDir } from "./lib/git-fixture";
import { huskyHooks, installHuskyShim } from "./lib/husky-testkit";
import { registerTempCleanup } from "./lib/precommit-gate-harness";
import { ROOT } from "./lib/precommit-gate-testkit";
import { runInProcess } from "./lib/run-in-process.js";
import { shellQuote } from "./lib/sh-quote.js";

const HOOK_REL = path.join(".husky", "pre-merge-commit");
const HOOK = fs.readFileSync(path.join(ROOT, HOOK_REL), "utf8");

const temps = registerTempCleanup();

const LOG = "fired.log";

const SECRET = `AKIA${"2QQ7WZ4KKPFXJ3RN"}`;

const SCAN = `"\${WFC_GITLEAKS:-gitleaks}" git --staged --redact`;

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
	fired: () => string[];
	reset: () => void;
	precommitExits: (code: number) => void;
}

const buildStubText = (name: string, logFile: string, code: number) =>
	`echo ${shellQuote(name)} >> ${shellQuote(logFile)}\nexit ${code}\n`;

const buildTemplate = (root: string) => {
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
	git("init", "-q", ".");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");

	const husky = path.join(root, ".husky");
	installHuskyShim(root);
	fs.copyFileSync(
		path.join(ROOT, HOOK_REL),
		path.join(husky, "pre-merge-commit"),
	);

	const log = path.join(root, LOG);
	fs.writeFileSync(
		path.join(husky, "pre-commit"),
		buildStubText("pre-commit", log, 0),
	);

	fs.writeFileSync(path.join(root, "base.txt"), "base\n");
	fs.writeFileSync(path.join(root, "shared.txt"), "shared\n");
	git("add", "--", "base.txt", "shared.txt");
	git("commit", "-qm", "base");
};

const template = defineTemplate(buildTemplate);

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
		fs.writeFileSync(path.join(husky, name), buildStubText(name, log, code));

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

const readLog = (p: Probe, ...args: string[]) =>
	execFileSync("git", ["log", ...args], { cwd: p.root, encoding: "utf8" });

describe(".husky/pre-merge-commit", () => {
	it("is the hook husky actually dispatches", () => {
		expect(fs.existsSync(path.join(ROOT, HOOK_REL))).toBe(true);
		expect(huskyHooks()).toContain("pre-merge-commit");
	});

	it("runs the whole of .husky/pre-commit rather than a copied gate list", () => {
		expect(HOOK).toMatch(/sh -e "\$here\/pre-commit"/);
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
		const p = probe();
		fs.writeFileSync(
			path.join(p.root, ".husky", "pre-commit"),
			`git diff --cached --name-only > ${shellQuote(path.join(p.root, "staged.txt"))}\n` +
				`git ls-files > ${shellQuote(path.join(p.root, "tracked.txt"))}\n`,
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
		expect(read("tracked.txt")).toContain("base.txt");
		expect(read("tracked.txt").length).toBeGreaterThan(3);
	});

	it("refuses the merge commit on a red gate, leaving the merge in progress and offering git merge --abort", () => {
		const p = probe();
		sideBranch(p, "side", { "side.txt": "side\n" });
		fs.writeFileSync(path.join(p.root, "base.txt"), "moved\n");
		p.git("commit", "-qm", "moved", "--", "base.txt");
		p.precommitExits(1);
		const before = readLog(p, "--format=%H", "-1").trim();

		const r = merge(p, "side");
		expect(r.output).toContain("the gates above refused this merge's content");
		expect(r.code).not.toBe(0);
		expect(readLog(p, "--format=%H", "-1").trim()).toBe(before);
		expect(fs.existsSync(path.join(p.root, ".git", "MERGE_HEAD"))).toBe(true);
		expect(r.output).toContain("git merge --abort");
	});

	it("does not let `git commit` past the refusal without the same gates", () => {
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
			const p = probe();
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
			expect(readLog(p, "--format=%s", "-1").trim()).toBe("moved");
		},
	);

	it("is skipped entirely by `git merge --no-verify`", () => {
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

		fs.writeFileSync(path.join(p.root, "unrelated.txt"), "x\n");
		p.git("add", "--", "unrelated.txt");
		p.precommitExits(0);
		p.git("commit", "-qm", "unrelated", "--", "unrelated.txt");
		expect(readLog(p, "--format=%s", "-1").trim()).toBe("unrelated");
		p.git("worktree", "remove", "--force", wt);
	});
});

describe("the copied fixture is isolated from its template (mantahostels#2068)", () => {
	it("a commit made in the copy leaves the template untouched", () => {
		const p = probe();
		fs.writeFileSync(path.join(p.root, "only-in-copy.txt"), "x\n");
		p.git("add", "--", "only-in-copy.txt");
		p.git("commit", "-qm", "only in the copy");
		expect(readLog(p, "--oneline").toString()).toContain("only in the copy");

		const fresh = probe();
		expect(readLog(fresh, "--oneline").toString()).not.toContain(
			"only in the copy",
		);
	});
});
