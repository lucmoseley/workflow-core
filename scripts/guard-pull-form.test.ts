// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failOpenLogPath, readFailOpenLog } from "./guard-log-fixture";
import { defineTemplate, mkScratchDir, trioTemplate } from "./lib/git-fixture";
import {
	buildBashPayload,
	dispatchCoreOutput,
	runDispatchCore,
} from "./lib/pretool-guard-testkit";

const CORE = "guard-pull-form";

let dir: string;
let config: string;
let shared: string;
let worktree: string;
let elsewhere: string;

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" });

const template = defineTemplate(trioTemplate());

interface Spawn {
	cwd?: string;
	session?: string | null;
	env?: Record<string, string | undefined>;
}

const runGuard = (
	command: string,
	{ cwd = shared, session = "test", env = {} }: Spawn = {},
) =>
	runDispatchCore(CORE, buildBashPayload(command, session), {
		project: shared,
		config,
		cwd,
		env,
	});

const emission = (
	command: string,
	{ cwd = shared, session = "test", env = {} }: Spawn = {},
) =>
	dispatchCoreOutput(CORE, buildBashPayload(command, session), {
		project: shared,
		config,
		cwd,
		env,
	});

const verdict = (command: string, at: Spawn = {}) =>
	emission(command, at)?.permissionDecision === "deny" ? "deny" : "allow";

const readDenyReason = (command: string, at: Spawn = {}) => {
	const out = emission(command, at);
	if (out?.permissionDecision !== "deny")
		throw new Error(`expected a deny for: ${command}`);
	return out.permissionDecisionReason as string;
};

const { readRuleText } = require("./lib/rule-text") as {
	readRuleText: (id: string) => string;
};
const LAND_ROUTE =
	"Reconcile in your session's own worktree, never in the main checkout";

beforeEach(() => {
	dir = mkScratchDir("guard-pull-form-");
	config = path.join(dir, "claude-config");
	shared = path.join(dir, "shared");
	worktree = path.join(dir, "wt");
	elsewhere = path.join(dir, "elsewhere");
	template.instantiate(dir);
	git(shared, "config", "branch.main.merge", "refs/heads/landing");
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("each exit path", () => {
	it("refuses as permissionDecision JSON on exit 0, naming the land route", () => {
		const r = runGuard("git pull --rebase");
		expect(r.status).toBe(0);
		const out = JSON.parse(r.stdout).hookSpecificOutput;
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toContain(
			"This reconciles the shared `main` by rewriting or merging, not by fast-forward: git pull --rebase\n\n",
		);
		expect(out.permissionDecisionReason).toContain(LAND_ROUTE);
		expect(out.permissionDecisionReason).toContain("session-checkout.js land");
		expect(out.additionalContext).toBeUndefined();
	});

	it("passes an allowed --ff-only pull in silence", () => {
		expect(emission("git pull --ff-only")).toBeNull();
	});

	it("says nothing about an ordinary command it judged and passed", () => {
		const r = runGuard("git status");
		expect([r.status, r.stdout]).toEqual([0, ""]);
		expect(fs.existsSync(failOpenLogPath(config, shared))).toBe(false);
	});

	it("allows, recorded, in a directory git cannot resolve to a repo at all", () => {
		const notARepo = path.join(dir, "not-a-repo");
		fs.mkdirSync(notARepo);
		const r = runDispatchCore(
			CORE,
			buildBashPayload("git rebase main", "test"),
			{
				project: notARepo,
				config,
				cwd: notARepo,
				env: { GIT_CEILING_DIRECTORIES: dir },
			},
		);
		expect([r.status, r.stdout]).toEqual([0, ""]);
		expect(readFailOpenLog(config, notARepo).split("\t")[2]).toMatch(
			/^git could not resolve a git dir/,
		);
	});
});

describe("each production read, crossed once", () => {
	it("reads pull.ff from the target tree's config", () => {
		git(shared, "config", "pull.ff", "only");
		expect(emission("git pull")).toBeNull();
		expect(verdict("git pull --rebase")).toBe("deny");
	});

	it("asks git whether a reset's word is a commit, and which branch is out", () => {
		fs.writeFileSync(path.join(shared, "b.md"), "b\n");
		git(shared, "add", "b.md");
		git(shared, "commit", "-qm", "second", "--", "b.md");
		expect(readDenyReason("git reset --hard HEAD~1")).toBe(
			`This moves the shared \`main\` to another commit, dropping whatever came after it if that commit is behind — to move \`main\` forward, \`git merge --ff-only <commit>\`: git reset --hard HEAD~1\n\n${readRuleText("main-rewind")}`,
		);
		expect(verdict("git reset a.md")).toBe("allow");
		expect(verdict("git reset --hard HEAD~5")).toBe("deny");
		expect(verdict("git reset --soft main")).toBe("allow");
		expect(verdict("git reset --soft side")).toBe("deny");
	});

	it.each([
		"git update-ref refs/heads/main HEAD",
		"git reset --hard HEAD~1",
		"git branch -f main HEAD",
		"git branch -D main",
		"git branch -m side main",
		"git checkout -B main HEAD",
		"git switch -C main HEAD",
	])(
		"%s stays refused, naming the repair script only where git cannot read main (#3198)",
		(command) => {
			expect(readDenyReason(command)).not.toContain("repair-main");
			for (const broken of ["", "\0".repeat(41)]) {
				fs.writeFileSync(path.join(shared, ".git/refs/heads/main"), broken);
				expect(readDenyReason(command)).toContain(
					"node scripts/repair-main.js",
				);
			}
		},
	);

	it("refuses, from a linked worktree, a write to the shared HEAD by each route (#3997)", () => {
		const write = "symbolic-ref HEAD refs/heads/side";
		for (const command of [
			`git --git-dir=${shared}/.git ${write}`,
			`GIT_DIR=${shared}/.git git ${write}`,
			`GIT_COMMON_DIR=${shared}/.git git ${write}`,
			`git -C ${shared} -c alias.s=symbolic-ref s HEAD refs/heads/side`,
		])
			expect(readDenyReason(command, { cwd: worktree }), command).toContain(
				"points the shared tree's HEAD away from `main`",
			);
	});

	it("reads an alias off the config the tree sees, as git does (#4009)", () => {
		git(shared, "config", "alias.u", "update-ref");
		git(shared, "config", "alias.st", "status");
		git(shared, "config", "alias.sh", "!true");
		const move = "refs/heads/main HEAD~1";
		expect(readDenyReason(`git u ${move}`, { cwd: worktree })).toContain(
			"writes `main` directly",
		);
		expect(readDenyReason(`git sh ${move}`, { cwd: worktree })).toContain(
			"or alias I cannot read",
		);
		expect(verdict("git st", { cwd: worktree })).toBe("allow");
		expect(verdict(`git -C ${elsewhere} u ${move}`)).toBe("allow");
	});

	it("reads a directory's presence for a cd that may fail, from where it stands (#4009)", () => {
		const move = "git update-ref refs/heads/main HEAD~1";
		expect(verdict(`cd ${elsewhere}; ${move}`)).toBe("allow");
		expect(readDenyReason(`cd ${path.join(dir, "absent")}; ${move}`)).toContain(
			"writes `main` directly",
		);
		expect(readDenyReason(`env ${move}`, { cwd: worktree })).toContain(
			"writes `main` directly",
		);
	});

	it("reads a linked worktree's git directory, and its .git file, as that tree (#3997)", () => {
		const own = git(worktree, "rev-parse", "--absolute-git-dir").trim();
		for (const named of [own, `${worktree}/.git`]) {
			const flag = `git --git-dir=${named}`;
			const atWorktree = { cwd: worktree };
			expect(
				verdict(`${flag} symbolic-ref HEAD refs/heads/side`, atWorktree),
			).toBe("allow");
			expect(
				readDenyReason(`${flag} update-ref refs/heads/main HEAD`, atWorktree),
			).toContain("writes `main` directly");
		}
	});

	it("names the repair script from a linked worktree too (#3198)", () => {
		fs.writeFileSync(path.join(shared, ".git/refs/heads/main"), "");
		expect(
			readDenyReason("git update-ref refs/heads/main HEAD", { cwd: worktree }),
		).toContain("node scripts/repair-main.js");
	});

	it("classes the tree a command lands in", () => {
		expect(verdict("git pull --rebase", { cwd: worktree })).toBe("allow");
		expect(verdict("git reset --hard", { cwd: worktree })).toBe("allow");
		expect(verdict("git pull --rebase", { cwd: elsewhere })).toBe("allow");
		expect(verdict(`git -C ${shared} pull --rebase`, { cwd: worktree })).toBe(
			"deny",
		);
		expect(
			verdict("git update-ref refs/heads/main HEAD", { cwd: worktree }),
		).toBe("deny");
	});

	it("records a bare pull whose tree it cannot resolve, and allows it", () => {
		expect(emission("cd $TARGET && git pull")).toBeNull();
		expect(readFailOpenLog(config, shared)).toMatch(
			/could not resolve the working tree for a git pull — the reconciliation allowed unchecked/,
		);
	});

	it("stands the reconciliation down on a resolved tree once cut over, still judging an unresolved one (#4229)", () => {
		git(shared, "config", "--unset", "branch.main.merge");
		expect(emission("git merge origin/main")).toBeNull();
		expect(readDenyReason('git -C "$W" merge origin/main')).toContain(
			"session-checkout.js land",
		);
	});

	it("the rule id resolves through the session accessor", () => {
		expect(
			execFileSync(path.resolve(__dirname, "lib/rule-text.sh"), [
				"rule:main-rewind",
			]).toString(),
		).toContain(readRuleText("main-rewind"));
	});
});

describe("the copied fixture is isolated from its template (mantahostels#2068)", () => {
	const freshCopy = () => {
		const fresh = mkScratchDir("guard-pull-form-fresh-");
		try {
			template.instantiate(fresh);
		} catch (err) {
			fs.rmSync(fresh, { recursive: true, force: true });
			throw err;
		}
		return fresh;
	};

	it("a commit made in the copied WORKTREE leaves the template untouched", () => {
		fs.writeFileSync(path.join(worktree, "c.md"), "c\n");
		git(worktree, "add", "c.md");
		git(worktree, "commit", "-qm", "worktree copy only", "--", "c.md");
		expect(git(worktree, "log", "--oneline")).toContain("worktree copy only");

		const fresh = freshCopy();
		try {
			expect(
				git(path.join(fresh, "shared"), "log", "--all", "--oneline"),
			).not.toContain("worktree copy only");
		} finally {
			fs.rmSync(fresh, { recursive: true, force: true });
		}
	});

	it("each copy's core.hooksPath is relinked, not left pointing at the template", () => {
		for (const repo of [shared, elsewhere]) {
			const hooksPath = git(repo, "config", "core.hooksPath").trim();
			expect(hooksPath).toBe(path.join(dir, "no-hooks"));
			expect(fs.existsSync(hooksPath)).toBe(true);
			expect(fs.readdirSync(hooksPath)).toEqual([]);
		}
	});
});
