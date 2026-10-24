// @vitest-environment node
/*
 * guard-branch-publish.sh denies a pull request and a push of any branch but
 * `main` or `spike/*` (#764). The allow-cases below are the #764 acceptance
 * list plus every shape the rule fragment promises passes.
 *
 * A throwaway repo stands in for the shared tree, with a linked worktree on
 * branch `side`.
 *
 * It is a `PreToolUse` hook in `self-plugin/hooks/hooks.json` and ships to adopters in
 * `hooks/hooks.json`: loosen a case and a session opens a pull request or
 * publishes a branch where work must land on `main`, or a sanctioned push to
 * `main` is refused.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeFailOpenLog, failOpenLogPath } from "./guard-log-fixture";
import { describeSharedParserLibrary } from "./guard-parse-fixture";
import { stubGhScript } from "./lib/gh-stub";
import { defineTemplate, mkScratchDir, trioTemplate } from "./lib/git-fixture";
import { denyFires } from "./lib/guard-fires-testkit";
import { buildBashPayload, spawnGuard } from "./lib/pretool-guard-testkit";

const GUARD = path.resolve(__dirname, "guard-branch-publish.sh");

// biome-ignore lint/suspicious/noExplicitAny: untyped CommonJS helpers
const { ruleText } = require("./lib/rule-text") as any;
// biome-ignore lint/suspicious/noExplicitAny: untyped CommonJS helpers
const { renderSessionRules } = require("./lib/adopter-skeleton") as any;

let dir: string;
let config: string;
let shared: string;
let worktree: string;
let elsewhere: string;

const template = defineTemplate(trioTemplate());

const payload = (command: string) => buildBashPayload(command, "test");

/** The refusal's prose, or null where the guard allowed. */
const denial = (
	command: string,
	cwd = shared,
	env: NodeJS.ProcessEnv = {},
): string | null => {
	const r = spawnGuard(GUARD, payload(command), {
		project: shared,
		config,
		cwd,
		env,
	});
	expect(r.status).toBe(0);
	if (!(r.stdout ?? "").trim()) return null;
	const out = JSON.parse(r.stdout).hookSpecificOutput;
	expect(out.permissionDecision).toBe("deny");
	return out.permissionDecisionReason as string;
};

beforeEach(() => {
	dir = mkScratchDir("guard-branch-publish-");
	config = path.join(dir, "claude-config");
	shared = path.join(dir, "shared");
	worktree = path.join(dir, "wt");
	elsewhere = path.join(dir, "elsewhere");
	template.instantiate(dir);
	for (const branch of ["feature-x", "spike/x"])
		execFileSync("git", ["branch", branch], { cwd: shared });
	execFileSync("git", ["tag", "v1.2.3"], { cwd: shared });
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("a pull request is denied", () => {
	it.each([
		"gh pr create",
		"gh pr create --fill --base main",
		"gh pr new -t x -b y",
		"gh -R owner/repo pr create --fill",
		"gh pr -R owner/repo create --fill",
		'gh pr "create" --fill',
		"gh 'pr' create --fill",
		"timeout 30 gh pr create --fill",
		"/usr/bin/gh pr create",
		"git status && gh pr create --fill",
		"gh api repos/o/r/pulls -f title=x -f head=feature-x -f base=main",
		"gh api /repos/o/r/pulls --method POST --input body.json",
		"gh api -X POST repos/o/r/pulls",
		"gh api 'repos/o/r/pulls?x=y' -f title=x",
		"gh api graphql -f query='mutation { createPullRequest(input: {}) { clientMutationId } }'",
	])("%s", (command) => {
		const why = denial(command);
		expect(why).toContain("opens a pull request");
		expect(why).toContain(ruleText("branch-publish"));
	});
});

describe("a merge of a Dependabot pull request is denied with the Dependabot rule (#2020)", () => {
	/* The stub answers `gh pr view`'s --jq verdict and logs its cwd and argv,
	 * so a case can say whether the lookup ran, where, and against which PR. */
	const ghAnswering = (verdict: string) =>
		stubGhScript(
			dir,
			`#!/bin/sh\necho "$PWD: $*" >> ${dir}/gh-calls\n${verdict}\n`,
		).env;
	const calls = () =>
		fs.existsSync(`${dir}/gh-calls`)
			? fs.readFileSync(`${dir}/gh-calls`, "utf8")
			: "";
	const unchecked = () =>
		fs.readFileSync(failOpenLogPath(config, shared), "utf8");

	it.each([
		"gh pr merge dependabot/npm_and_yarn/next-16.3.8 --squash",
		"gh pr merge 'dependabot/github_actions/x' --auto",
	])("%s, from the branch named alone", (command) => {
		const why = denial(command, shared, ghAnswering("exit 1"));
		expect(why).toContain("merges a Dependabot pull request");
		expect(why).toContain(ruleText("dependabot-merge"));
		expect(calls()).toBe("");
	});

	it.each([
		["gh pr merge 12 --squash", "pr view 12 --json"],
		["gh -R o/r pr merge 12", "pr view 12 -R o/r --json"],
		["gh --repo=o/r pr merge 12", "pr view 12 -R o/r --json"],
		["gh -Ro/r pr merge 12", "pr view 12 -R o/r --json"],
		["gh pr -R o/r merge 12", "pr view 12 -R o/r --json"],
		["gh pr --repo=o/r merge 12", "pr view 12 -R o/r --json"],
		["gh pr merge -b 'a body' 12 --repo o/r", "pr view 12 -R o/r --json"],
		["gh pr merge --squash", "pr view --json"],
		[
			"timeout 30 gh pr merge https://github.com/o/r/pull/3",
			"pr view https://github.com/o/r/pull/3 --json",
		],
	])("%s, from the PR gh pr view reads as Dependabot's", (command, view) => {
		const why = denial(command, shared, ghAnswering("echo true"));
		expect(why).toContain(ruleText("dependabot-merge"));
		expect(calls()).toContain(view);
	});

	it("looks the PR up from the directory the command runs in", () => {
		denial(
			`cd ${elsewhere} && gh pr merge 12`,
			shared,
			ghAnswering("echo true"),
		);
		expect(calls()).toContain(`${elsewhere}: pr view 12`);
	});

	it.each([
		"gh pr merge 12 --squash",
		"gh pr merge --disable-auto 12",
		"gh pr merge --help",
		"echo gh pr merge 12",
	])("%s passes silently where it is not Dependabot's merge", (command) => {
		expect(denial(command, shared, ghAnswering("echo false"))).toBeNull();
	});

	it.each([
		["gh pr merge 12", "could not be looked up", "exit 1"],
		["GH_REPO=o/r gh pr merge 12", "GH_REPO override", "echo true"],
		['gh pr merge "$N"', "unreadable pr merge selector", "echo true"],
	])("allows %s unlooked-up, and records it", (command, record, verdict) => {
		expect(denial(command, shared, ghAnswering(verdict))).toBeNull();
		expect(unchecked()).toContain(record);
	});
});

describe("what it leaves alone on gh", () => {
	it.each([
		"gh pr list --state all",
		"gh pr view 12",
		"gh pr create --help",
		"gh api repos/o/r/pulls",
		"gh api repos/o/r/pulls --jq '.[].title'",
		"gh api repos/o/r/pulls/3/comments -f body=x",
		"gh api graphql -f query='{ viewer { login } }'",
		"gh issue create -t x -b y",
		"echo gh pr create",
		"grep -n 'gh pr create' CLAUDE.md",
	])("%s", (command) => {
		expect(denial(command)).toBeNull();
	});
});

describe("a push of a branch other than main is denied", () => {
	it.each([
		["git push origin feature-x", "feature-x"],
		["git push -u origin feature-x", "feature-x"],
		["git push origin +feature-x", "feature-x"],
		["git push origin main feature-x", "feature-x"],
		["git push origin HEAD:feature-y", "feature-y"],
		["git push origin main:refs/heads/other", "other"],
		["git push origin refs/heads/feature-x", "feature-x"],
		["git push origin never-created", "never-created"],
		["git -C ../wt push origin HEAD", "side"],
		["git push origin feature-x > out.txt 2>&1", "feature-x"],
		["git push origin feature-x 2>/dev/null", "feature-x"],
		// Behind a launcher wrapper (#1731).
		["env X=1 git push origin feature-x", "feature-x"],
		["timeout 60 git push origin feature-x", "feature-x"],
		["command git push origin feature-x", "feature-x"],
	])("%s", (command, branch) => {
		const why = denial(command);
		expect(why).toContain(`a branch other than main, ${branch}`);
		expect(why).toContain(ruleText("branch-publish"));
	});

	it.each(["git push --all origin", "git push --mirror origin"])(
		"%s pushes every branch",
		(command) => {
			expect(denial(command)).toContain("pushes every local branch");
		},
	);

	it("denies a tag created earlier in the same command, and names the remedy (#1033)", () => {
		const why = denial("git tag rounds/x HEAD && git push origin rounds/x");
		expect(why).toContain("a branch other than main, rounds/x");
		expect(why).toContain("push it as `refs/tags/<name>`");
	});

	it("denies a bare push from a worktree on a feature branch, naming the branch", () => {
		expect(denial("git push", worktree)).toContain(
			"the branch the tree is on, side",
		);
	});
});

describe("the sanctioned pushes pass", () => {
	it.each([
		"git push",
		"git push origin",
		"git push origin main",
		"git push -u origin main",
		"git push origin HEAD",
		"git push origin HEAD:main",
		"git push origin feature-x:main",
		"git push origin refs/heads/main",
		"git push origin spike/x",
		"git push origin v1.2.3",
		"git push origin tag v1.2.3",
		"git push origin refs/tags/v9",
		"git push origin refs/tags/rounds/x",
		"git tag rounds/x HEAD && git push origin refs/tags/rounds/x",
		"git push --tags origin",
		"git push --follow-tags origin main",
		"git push origin --delete feature-x",
		"git push origin :feature-x",
		"git push --dry-run origin feature-x",
		"git push --help",
		"git -C ../wt push origin HEAD:main",
		// A redirection is the shell's, never a refspec.
		"git push origin main 2>&1 | tail -4",
		"git push origin main > out.txt 2>&1",
		"git push origin main 2>/dev/null",
		"git push origin main >out",
		"git push 2> err.txt",
	])("%s", (command) => {
		expect(denial(command)).toBeNull();
	});

	it("judges `env -C` against the cwd, a named LIMIT, so a worktree's HEAD passes as main's", () => {
		expect(denial("env -C ../wt git push origin HEAD")).toBeNull();
	});

	it("passes a bare push from a detached worktree, which git refuses itself", () => {
		execFileSync("git", ["checkout", "-q", "--detach"], { cwd: worktree });
		expect(denial("git push", worktree)).toBeNull();
	});

	it("does not judge a push in another repo", () => {
		execFileSync("git", ["branch", "feature-x"], { cwd: elsewhere });
		expect(denial("git push origin feature-x", elsewhere)).toBeNull();
	});
});

/* #1733: a force-push or deletion of `main` prints rule:main-rewind. The
 * literal anchor fails if the fragment's force-push sentence is dropped. */
describe("a force-push or deletion of main is denied with the rewind rule", () => {
	it.each([
		["git push --force", "force-pushes `main`"],
		["git push -f origin main", "force-pushes `main`"],
		["git push -uf origin main", "force-pushes `main`"],
		["git push --force-with-lease origin main", "force-pushes `main`"],
		["git push --force-with-lease=main:abc origin main", "force-pushes `main`"],
		["git push origin +main", "force-pushes `main`"],
		["git push origin +HEAD:main", "force-pushes `main`"],
		["git push origin +feature-x:refs/heads/main", "force-pushes `main`"],
		["git -C ../wt push -f origin HEAD:main", "force-pushes `main`"],
		["git push origin :main", "deletes `main` on the remote"],
		["git push origin --delete main", "deletes `main` on the remote"],
		["git push --force-w origin main", "force-pushes `main`"],
		["git push --force-with=x origin main", "force-pushes `main`"],
		["git push origin --dele main", "deletes `main` on the remote"],
		["git push origin :heads/main", "deletes `main` on the remote"],
		["git push -f origin HEAD:heads/main", "force-pushes `main`"],
	])("%s is denied, naming that it %s", (command, what) => {
		const why = denial(command);
		expect(why).toContain(what);
		expect(why).toContain("A force-push to `main`");
		expect(why).toContain(ruleText("main-rewind"));
	});

	/* #1759: guard-pull-form.sh prints the same fragment, so its needle must
	 * not credit itself with this refusal too. */
	it.each([
		["git push --force", "main-force-push"],
		["git push origin --delete main", "main-remote-delete"],
	])("%s counts once, as this guard's %s", (command, needle) => {
		expect(denyFires(denial(command) as string)).toEqual([
			`guard:guard-branch-publish.sh/${needle}`,
		]);
	});

	it.each([
		"git push --force-with-lease --no-force-with-lease origin main",
		"git push --force-w --no-force-w origin main",
		"git push origin HEAD:heads/main",
		"git push -f origin spike/x",
		"git push origin +spike/x",
		"git push --dry-run -f origin main",
		"git push origin --delete feature-x",
	])("%s passes", (command) => {
		expect(denial(command)).toBeNull();
	});
});

describe("with the landing module on, `landing` takes `main`'s place (#2409)", () => {
	const landing = { WFC_MODULES: "landing" };

	it.each([
		"git push",
		"git push origin main",
		"git push origin HEAD:main",
		"git -C ../wt push origin HEAD:main",
	])("%s is denied, as only the lander moves main", (command) => {
		const why = denial(command, shared, landing);
		expect(why).toContain("only the lander moves");
		expect(why).toContain(ruleText("branch-publish-landing"));
	});

	it.each([
		"git push origin main:landing",
		"git -C ../wt push origin HEAD:landing",
		"git push origin refs/heads/main:refs/heads/landing",
		"git push origin spike/x",
		"git push origin -f spike/x",
		"git push origin v1.2.3",
		"git push origin --delete feature-x",
	])("%s passes", (command) => {
		expect(denial(command, shared, landing)).toBeNull();
	});

	it.each([
		["git push -f origin main:landing", "force-pushes `landing`"],
		["git push origin +main:landing", "force-pushes `landing`"],
		["git push origin --delete landing", "deletes `landing` on the remote"],
		["git push origin :landing", "deletes `landing` on the remote"],
	])("%s is denied, naming that it %s", (command, what) => {
		const why = denial(command, shared, landing);
		expect(why).toContain(what);
		expect(why).toContain(ruleText("landing-rewind"));
	});

	it("still denies a feature branch, with the landing route's text", () => {
		expect(denial("git push origin feature-x", shared, landing)).toContain(
			ruleText("branch-publish-landing"),
		);
	});

	it("leaves main's pushes and landing's refusal as they were with it off", () => {
		expect(denial("git push origin main")).toBeNull();
		expect(denial("git push origin main:landing")).toContain(
			ruleText("branch-publish"),
		);
	});
});

describe("an adopter", () => {
	/* The rule left the rules file for this guard, which prints it (#2035). */
	it("is handed the rule by the guard, not its rendered session rules", () => {
		const text = renderSessionRules({
			modules: [],
			founder: "A Founder",
			pluginRoot: path.resolve(__dirname, ".."),
			ciCheck: null,
		});
		expect(text).not.toContain("`rule:branch-publish`");
		expect(denial("gh pr create --fill")).toContain("NEVER A PULL REQUEST");
	});

	it("runs the guard from the plugin's hook manifest", () => {
		const manifest = JSON.parse(
			fs.readFileSync(path.resolve(__dirname, "../hooks/hooks.json"), "utf8"),
		);
		const bash = manifest.hooks.PreToolUse.filter(
			(g: { matcher?: string }) => g.matcher === "Bash",
		).flatMap((g: { hooks: { command: string }[] }) => g.hooks);
		expect(bash.map((h: { command: string }) => h.command)).toContain(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: the plugin-root variable, not a JS template
			"${CLAUDE_PLUGIN_ROOT}/scripts/guard-branch-publish.sh",
		);
	});
});

describeSharedParserLibrary({
	guard: GUARD,
	denyCommand: "gh pr create --fill",
	ctx: () => ({ dir, shared, elsewhere }),
});

describeFailOpenLog({
	guard: GUARD,
	denied: payload("gh pr create --fill"),
	fieldless: { session_id: "test", tool_name: "Bash", tool_input: {} },
	fieldlessMatch: /no command in payload/,
	benign: payload("git status"),
	ctx: () => ({ dir, config, project: shared }),
});
