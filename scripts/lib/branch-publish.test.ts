// @vitest-environment node
/*
 * lib/branch-publish.js, a PreToolUse dispatcher core (#2792), denies a pull
 * request and a push of any branch but `main` or `spike/*` (#764). The
 * allow-cases below are the #764 acceptance list plus every shape the rule
 * fragment promises passes.
 *
 * Module cases, run in process through lib/guard-core-testkit.ts over real
 * git: a throwaway repo stands in for the shared tree, with a linked worktree
 * on branch `side`, and a stub `gh` (WFC_GH) answers the merge lookup. The
 * hook line, stdin and the stdout a refusal needs are
 * scripts/guard-dispatch.test.ts's boundary set.
 *
 * Loosen a case and a session opens a pull request or publishes a branch
 * where work must land on `main`, or a sanctioned push to `main` is refused.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubGhScript } from "./gh-stub";
import {
	defineTemplate,
	mkDirOutsideRepo,
	mkScratchDir,
	trioTemplate,
} from "./git-fixture";
import { runCore } from "./guard-core-testkit";
import { denyFires } from "./guard-fires-testkit";
import { buildBashPayload } from "./pretool-guard-testkit";
import { shellQuote } from "./sh-quote.js";

// biome-ignore lint/suspicious/noExplicitAny: untyped CommonJS helpers
const { readRuleText } = require("./rule-text") as any;
// biome-ignore lint/suspicious/noExplicitAny: untyped CommonJS helpers
const { renderSessionRules } = require("./adopter-skeleton") as any;
const { loadCores } = require("./guard-core-load.js") as {
	loadCores: (event: string) => Record<string, unknown>[];
};
const REWIND_RULE_FALLBACK =
	"Never move `main` backwards; the rule could not be read from docs/agents/rules/main-rewind.txt. Restore that file from origin/main, or revert the change that removed it, then read it before doing anything else.";

let dir: string;
let shared: string;
let worktree: string;
let elsewhere: string;
let logs: string[];

const template = defineTemplate(trioTemplate());

/** The refusal's prose, or null where the core allowed. */
function denial(
	command: string,
	cwd = shared,
	env: Record<string, string> = {},
	payload: Record<string, unknown> = buildBashPayload(command, "test"),
): string | null {
	/* The host's lookup runs through lib/gh.js, which reads WFC_GH off the
	 * process. */
	if (env.WFC_GH) vi.stubEnv("WFC_GH", env.WFC_GH);
	const r = runCore("guard-branch-publish", payload, {
		root: shared,
		cwd,
		env,
	});
	logs.push(...r.logs);
	if (!r.output) return null;
	expect(r.output.permissionDecision).toBe("deny");
	return r.output.permissionDecisionReason as string;
}

beforeEach(() => {
	dir = mkScratchDir("branch-publish-");
	shared = path.join(dir, "shared");
	worktree = path.join(dir, "wt");
	elsewhere = path.join(dir, "elsewhere");
	template.instantiate(dir);
	for (const branch of ["feature-x", "spike/x"])
		execFileSync("git", ["branch", branch], { cwd: shared });
	execFileSync("git", ["tag", "v1.2.3"], { cwd: shared });
	logs = [];
	vi.stubEnv("WFC_MODULES", "");
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

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
		expect(why).toContain(readRuleText("branch-publish"));
	});
});

describe("a merge of a Dependabot pull request is denied with the Dependabot rule (#2020)", () => {
	/* The stub answers `gh pr view`'s --jq verdict and logs its cwd and argv,
	 * so a case can say whether the lookup ran, where, and against which PR. */
	const ghAnswering = (verdict: string) =>
		stubGhScript(
			dir,
			`#!/bin/sh\necho "$PWD: $*" >> ${shellQuote(dir)}/gh-calls\n${verdict}\n`,
		).env;
	const readCalls = () =>
		fs.existsSync(`${dir}/gh-calls`)
			? fs.readFileSync(`${dir}/gh-calls`, "utf8")
			: "";

	it.each([
		"gh pr merge dependabot/npm_and_yarn/next-16.3.8 --squash",
		"gh pr merge 'dependabot/github_actions/x' --auto",
	])("%s, from the branch named alone", (command) => {
		const why = denial(command, shared, ghAnswering("exit 1"));
		expect(why).toContain("merges a Dependabot pull request");
		expect(why).toContain(readRuleText("dependabot-merge"));
		expect(readCalls()).toBe("");
	});

	it.each([
		["gh pr merge 12 --squash", "pr view 12 --json"],
		["gh -R o/r pr merge 12", "pr view 12 -R o/r --json"],
		["gh --repo=o/r pr merge 12", "pr view 12 -R o/r --json"],
		["gh -Ro/r pr merge 12", "pr view 12 -R o/r --json"],
		["gh pr -R o/r merge 12", "pr view 12 -R o/r --json"],
		["gh pr --repo=o/r merge 12", "pr view 12 -R o/r --json"],
		// Quoted or escaped, the flag reads as the unquoted one (#4268).
		[`gh "-Ro/r" pr merge 12`, "pr view 12 -R o/r --json"],
		["gh \\-Ro/r pr merge 12", "pr view 12 -R o/r --json"],
		[`gh pr "--repo=o/r" merge 12`, "pr view 12 -R o/r --json"],
		["gh pr merge -b 'a body' 12 --repo o/r", "pr view 12 -R o/r --json"],
		["gh pr merge --squash", "pr view --json"],
		[
			"timeout 30 gh pr merge https://github.com/o/r/pull/3",
			"pr view https://github.com/o/r/pull/3 --json",
		],
	])("%s, from the PR gh pr view reads as Dependabot's", (command, view) => {
		const why = denial(command, shared, ghAnswering("echo true"));
		expect(why).toContain(readRuleText("dependabot-merge"));
		expect(readCalls()).toContain(view);
	});

	it("looks the PR up from the directory the command runs in", () => {
		denial(
			`cd ${elsewhere} && gh pr merge 12`,
			shared,
			ghAnswering("echo true"),
		);
		expect(readCalls()).toContain(`${elsewhere}: pr view 12`);
	});

	it.each([
		"gh pr merge 12 --squash",
		"gh pr merge --disable-auto 12",
		"gh pr merge --help",
		"echo gh pr merge 12",
	])("%s passes silently where it is not Dependabot's merge", (command) => {
		expect(denial(command, shared, ghAnswering("echo false"))).toBeNull();
		expect(logs).toEqual([]);
	});

	it.each([
		["gh pr merge 12", "could not be looked up", "exit 1"],
		["GH_REPO=o/r gh pr merge 12", "GH_REPO override", "echo true"],
		['gh pr merge "$N"', "unreadable pr merge selector", "echo true"],
	])("allows %s unlooked-up, and records it", (command, record, verdict) => {
		expect(denial(command, shared, ghAnswering(verdict))).toBeNull();
		expect(logs.join("\n")).toContain(record);
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
		expect(why).toContain(readRuleText("branch-publish"));
	});

	it("judges `env -C` against the tree it moves to, as `git -C` is (#4009)", () => {
		expect(denial("env -C ../wt git push origin HEAD")).toContain(
			"a branch other than main, side",
		);
		expect(
			denial(`env -C ${shared} git push origin HEAD`, worktree),
		).toBeNull();
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
		expect(why).toContain(readRuleText("main-rewind"));
	});

	/* #1759: the guard-pull-form core prints the same fragment, so its needle must
	 * not credit itself with this refusal too. */
	it.each([
		["git push --force", "main-force-push"],
		["git push origin --delete main", "main-remote-delete"],
	])("%s counts once, as this guard's %s", (command, needle) => {
		expect(denyFires(denial(command) as string)).toEqual([
			`guard:guard-dispatch.js/${needle}`,
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

	/* lib/main-rewind.js's fallback (#1777): a forced push of `main` is known
	 * bad, so a store that cannot give the rule still refuses it. */
	it("still refuses where the store cannot give the rule, naming its file", () => {
		vi.stubEnv("WFC_RULES_DIR", path.join(dir, "no-rules"));
		vi.stubEnv("WFC_RULES_FALLBACK_DIR", path.join(dir, "no-rules"));
		expect(denial("git push --force origin main")).toBe(
			`This force-pushes \`main\`: git push --force origin main\n\n${REWIND_RULE_FALLBACK}`,
		);
	});
});

describe("with the landing module on, work lands through queue refs, never main or landing (#4485)", () => {
	beforeEach(() => {
		vi.stubEnv("WFC_MODULES", "landing");
	});

	it.each([
		"git push",
		"git push origin main",
		"git push origin HEAD:main",
		"git -C ../wt push origin HEAD:main",
	])("%s is denied, as only the lander moves main", (command) => {
		const why = denial(command);
		expect(why).toContain("only the lander moves");
		expect(why).toContain("so it has no queue ref");
		expect(why).toContain(readRuleText("branch-publish-landing"));
	});

	it.each([
		"git push origin HEAD:landing",
		"git -C ../wt push origin HEAD:landing",
		"git push origin refs/heads/main:refs/heads/landing",
	])("%s is denied, as landing takes no push", (command) => {
		const why = denial(command);
		expect(why).toContain(
			"This pushes to `landing`, which takes no push: work lands through queue refs",
		);
		expect(why).toContain("so it has no queue ref");
		expect(why).toContain(readRuleText("branch-publish-landing"));
	});

	it.each([
		"git push origin spike/x",
		"git push origin -f spike/x",
		"git push origin v1.2.3",
		"git push origin --delete feature-x",
	])("%s passes", (command) => {
		expect(denial(command)).toBeNull();
	});

	it.each([
		["git push -f origin HEAD:landing", "force-pushes `landing`"],
		["git push origin +HEAD:landing", "force-pushes `landing`"],
		["git push origin --delete landing", "deletes `landing` on the remote"],
		["git push origin :landing", "deletes `landing` on the remote"],
	])("%s is denied, naming that it %s", (command, what) => {
		const why = denial(command);
		expect(why).toContain(what);
		expect(why).toContain(readRuleText("landing-rewind"));
	});

	it("still denies a feature branch, with the landing route's text", () => {
		expect(denial("git push origin feature-x")).toContain(
			readRuleText("branch-publish-landing"),
		);
	});
});

describe("with the landing module on, a session pushes its own queue ref (#4458)", () => {
	/* The session's worktree, cut where session-checkout.js cuts one. */
	let own: string;
	const Own = "queue/q1";
	beforeEach(() => {
		vi.stubEnv("WFC_MODULES", "landing");
		own = path.join(shared, ".claude", "worktrees", "q1");
		execFileSync("git", ["worktree", "add", "-q", "--detach", own], {
			cwd: shared,
		});
	});

	/** The refusal from the session's worktree, which names its own ref. */
	const refusal = (command: string) => {
		const why = denial(command, own);
		expect(why).toContain(`Your session's queue ref is \`${Own}\``);
		expect(why).toContain(`git push origin HEAD:refs/heads/${Own}`);
		expect(why).toContain(readRuleText("queue-ref"));
		return why;
	};

	it.each([
		"git push origin HEAD:queue/q1",
		"git push origin HEAD:refs/heads/queue/q1",
		"git push -u origin HEAD:queue/q1",
	])("%s passes, a creation or fast-forward of its own ref", (command) => {
		expect(denial(command, own)).toBeNull();
	});

	it.each([
		[
			"git push origin HEAD:queue/other",
			"`queue/other`, another session's queue ref",
		],
		[
			"git push origin HEAD:queue/q1-x",
			"`queue/q1-x`, another session's queue ref",
		],
		[
			"git push origin HEAD:queue/q1/x",
			"`queue/q1/x`, another session's queue ref",
		],
		["git push -f origin HEAD:queue/q1", "force-pushes `queue/q1`"],
		["git push origin +HEAD:queue/q1", "force-pushes `queue/q1`"],
		[
			"git push --force-with-lease origin HEAD:queue/q1",
			"force-pushes `queue/q1`",
		],
		["git push -f origin HEAD:queue/other", "another session's queue ref"],
		["git push origin --delete queue/q1", "deletes the queue ref `queue/q1`"],
		["git push origin :queue/other", "deletes the queue ref `queue/other`"],
		[
			"git push origin :refs/heads/queue/q1",
			"deletes the queue ref `queue/q1`",
		],
		[
			"git push origin HEAD:lander/batch-0",
			"pushes to `lander/batch-0`, which only the lander writes",
		],
		[
			"git push -f origin HEAD:lander/iso-1",
			"pushes to `lander/iso-1`, which only the lander writes",
		],
		[
			"git push origin --delete lander/batch-0",
			"deletes `lander/batch-0`, which only the lander writes",
		],
		[
			"git push origin HEAD:dropped/q1",
			"pushes to `dropped/q1`, which only the lander writes",
		],
		[
			"git push origin :dropped/other",
			"deletes `dropped/other`, which only the lander writes",
		],
	])("%s is denied: %s", (command, what) => {
		expect(refusal(command)).toContain(what);
	});

	it("names the launch, and no queue ref, for a queue push from outside a worktree", () => {
		for (const cwd of [shared, worktree]) {
			const why = denial("git push origin HEAD:queue/q1", cwd);
			expect(why).toContain(
				"This pushes to the queue ref `queue/q1` from outside a worktree",
			);
			expect(why).toContain("so it has no queue ref");
			expect(why).toContain("start-session.sh <session-name>`");
			expect(why).not.toContain("Your session's queue ref");
		}
		expect(denial("git push origin HEAD:lander/batch-0")).toContain(
			"start-session.sh <session-name>`",
		);
	});

	it("reads a session whose tree git cannot resolve as one with no queue ref, refusing all the same", () => {
		const nowhere = mkDirOutsideRepo("branch-publish-nowhere-");
		try {
			for (const [command, what] of [
				[
					`git -C ${own} push origin HEAD:queue/q1`,
					"This pushes to the queue ref `queue/q1` from outside a worktree",
				],
				[
					`git -C ${own} push origin HEAD:lander/batch-0`,
					"pushes to `lander/batch-0`, which only the lander writes",
				],
				[
					`git -C ${own} push origin --delete queue/q1`,
					"deletes the queue ref `queue/q1`",
				],
			]) {
				const why = denial(command, nowhere);
				expect(why).toContain(what);
				expect(why).toContain("so it has no queue ref");
				expect(why).toContain(readRuleText("queue-ref"));
			}
		} finally {
			fs.rmSync(nowhere, { recursive: true, force: true });
		}
	});

	it.each([
		"git push origin spike/x",
		"git push origin -f spike/x",
		"git push origin v1.2.3",
		"git push origin refs/heads/main:refs/tags/queue/q2",
		"git push origin --delete feature-x",
	])("%s passes from the worktree as before", (command) => {
		expect(denial(command, own)).toBeNull();
	});

	it.each([
		["git push origin HEAD:main", "branch-publish-landing"],
		["git push origin HEAD:landing", "branch-publish-landing"],
		["git push origin feature-x", "branch-publish-landing"],
		["git push -f origin HEAD:landing", "landing-rewind"],
		["git push origin --delete landing", "landing-rewind"],
	])(
		"%s is refused from the worktree, naming its own queue ref",
		(command, rule) => {
			const why = denial(command, own);
			expect(why).toContain(`Your session's queue ref is \`${Own}\``);
			expect(why).toContain(`git push origin HEAD:refs/heads/${Own}`);
			expect(why).toContain(readRuleText(rule));
		},
	);

	it("leaves a queue ref a branch like any other with landing off", () => {
		vi.stubEnv("WFC_MODULES", "");
		expect(denial("git push origin HEAD:queue/q1", own)).toContain(
			"a branch other than main, queue/q1",
		);
		expect(denial("git push origin --delete queue/q1", own)).toBeNull();
	});
});

it("leaves main's pushes and landing's refusal as they were with landing off", () => {
	expect(denial("git push origin main")).toBeNull();
	expect(denial("git push origin HEAD:landing")).toContain(
		readRuleText("branch-publish"),
	);
});

describe("an adopter", () => {
	/* The rule left the rules file for this guard, which prints it (#2035). */
	it("is handed the rule by the guard, not its rendered session rules", () => {
		const text = renderSessionRules({
			modules: [],
			founder: "A Founder",
			pluginRoot: path.resolve(__dirname, "..", ".."),
			ciCheck: null,
		});
		expect(text).not.toContain("`rule:branch-publish`");
		expect(denial("gh pr create --fill")).toContain("NEVER A PULL REQUEST");
	});

	it("runs the core from the dispatcher's manifest, on Bash, failing closed", () => {
		const row = loadCores("PreToolUse").find(
			(c) => c.name === "guard-branch-publish",
		);
		expect(row).toMatchObject({ tools: "Bash", failure: "closed" });
	});
});

describe("the fail-open record", () => {
	it("records a payload whose shape no longer carries what it reads", () => {
		expect(
			denial(
				"",
				shared,
				{},
				{
					session_id: "test",
					tool_name: "Bash",
					tool_input: {},
				},
			),
		).toBeNull();
		expect(logs.join("\n")).toMatch(/no command in payload/);
	});

	it("says nothing about an ordinary action it judged and passed", () => {
		expect(denial("git status")).toBeNull();
		expect(logs).toEqual([]);
	});

	it("records a push whose tree it cannot resolve, and allows it (mantahostels#147)", () => {
		expect(denial('git -C "$W" push origin feature-x')).toBeNull();
		expect(logs.join("\n")).toContain(
			"could not resolve the working tree for a git push — branch publish allowed unchecked",
		);
	});
});

describe("the cases a mutant must not survive (#2792)", () => {
	const ghAnswering = (verdict: string) =>
		stubGhScript(
			dir,
			`#!/bin/sh\necho "$PWD: $*" >> ${shellQuote(dir)}/gh-calls\n${verdict}\n`,
		).env;
	const readCalls = () =>
		fs.existsSync(`${dir}/gh-calls`)
			? fs.readFileSync(`${dir}/gh-calls`, "utf8")
			: "";
	const noRules = () => {
		vi.stubEnv("WFC_RULES_DIR", path.join(dir, "no-rules"));
		vi.stubEnv("WFC_RULES_FALLBACK_DIR", path.join(dir, "no-rules"));
	};

	it.each([
		['git push origin "$B"', "unreadable push refspec"],
		['git push origin --delete "$B"', "unreadable push deletion"],
	])("allows %s, and records it as an %s", (command, record) => {
		expect(denial(command)).toBeNull();
		expect(logs).toEqual([`${record} — push allowed unchecked`]);
	});

	it.each([
		"git push origin --delete refs/heads/main",
		"git push origin :refs/heads/main",
	])("%s is denied as a deletion of main", (command) => {
		expect(denial(command)).toContain("deletes `main` on the remote");
	});

	it.each([
		"git push origin :heads/landing",
		"git push origin --delete refs/heads/landing",
	])("%s is denied as a deletion of landing, with landing on", (command) => {
		vi.stubEnv("WFC_MODULES", "landing");
		expect(denial(command)).toContain("deletes `landing` on the remote");
	});

	it("passes a deletion of landing, and refuses a forced push to it as any branch, with landing off", () => {
		expect(denial("git push origin --delete landing")).toBeNull();
		const why = denial("git push -f origin HEAD:landing");
		expect(why).toContain("a branch other than main, landing");
		expect(why).toContain(readRuleText("branch-publish"));
	});

	it("reads a -R stuck on between pr and its verb", () => {
		denial("gh pr -Ro/r merge 12", shared, ghAnswering("echo true"));
		expect(readCalls()).toContain("pr view 12 -R o/r --json");
	});

	it("takes merge's own --repo over the one before pr", () => {
		denial(
			"gh -R a/b pr merge 12 --repo o/r",
			shared,
			ghAnswering("echo true"),
		);
		expect(readCalls()).toContain("pr view 12 -R o/r --json");
	});

	it("runs the lookup with exactly the argv the verdict needs", () => {
		/* printf, not echo: dash's echo would fold the jq's doubled backslashes. */
		const { env } = stubGhScript(
			dir,
			`#!/bin/sh\nprintf '%s\\n' "$*" > ${shellQuote(dir)}/gh-calls\necho true\n`,
		);
		denial("gh pr merge 12", shared, env);
		expect(readCalls()).toBe(
			`pr view 12 --json headRefName,author --jq (.headRefName | startswith("dependabot/")) or (.author.login | test("^(app/)?dependabot(\\\\[bot\\\\])?$"))\n`,
		);
	});

	it("passes --disable-auto even where the PR is Dependabot's, looking nothing up", () => {
		expect(
			denial("gh pr merge --disable-auto 12", shared, ghAnswering("echo true")),
		).toBeNull();
		expect(readCalls()).toBe("");
	});

	it.each([
		['gh pr merge 12 -R "$R"', "unreadable pr merge repo"],
		['cd "$D" && gh pr merge 12', "pr merge in an unknown directory"],
	])("allows %s unlooked-up, and records it as %s", (command, record) => {
		expect(denial(command, shared, ghAnswering("echo true"))).toBeNull();
		expect(logs).toEqual([`${record} — merge allowed unchecked`]);
		expect(readCalls()).toBe("");
	});

	it("denies a POST to pulls carried by --input alone", () => {
		expect(denial("gh api repos/o/r/pulls --input body.json")).toContain(
			"through the REST API",
		);
	});

	it.each([
		"gh api -X post repos/o/r/pulls",
		"gh api repos/o/r/pulls -f title=x stray",
	])(
		"%s is denied: the method in any case, the endpoint the first bare word",
		(command) => {
			expect(denial(command)).toContain("through the REST API");
		},
	);

	it("passes a merge whose lookup answers nothing, recording nothing", () => {
		expect(denial("gh pr merge 12", shared, ghAnswering("true"))).toBeNull();
		expect(logs).toEqual([]);
	});

	it("reads the PR from merge's first bare word", () => {
		expect(
			denial("gh pr merge 12 dependabot/x", shared, ghAnswering("echo false")),
		).toBeNull();
		expect(readCalls()).toContain("pr view 12 --json");
	});

	it.each([
		[
			"git push origin feature-x && git push origin feature-y",
			"This publishes a branch other than main, feature-x: git push origin feature-x ",
		],
		[
			"gh pr create && gh api -X POST repos/o/r/pulls",
			"This opens a pull request: gh pr create ",
		],
		/* The segment keeps the space before `&&`: unmask trims the leading whitespace alone. */
	])("names the first of two refusals in %s", (command, first) => {
		expect(denial(command)?.split("\n")[0]).toBe(first);
	});

	it("passes a GET to pulls that carries a field", () => {
		expect(denial("gh api -X GET repos/o/r/pulls -f state=open")).toBeNull();
	});

	it("shows a quoted word masked and the segment unpadded in the refusal", () => {
		expect(
			denial('git status && gh pr create --title "x y"')?.split("\n")[0],
		).toBe('This opens a pull request: gh pr create --title "…"');
	});

	it("judges every push before any gh call, as the bash guard's walks ran", () => {
		expect(
			denial("gh pr create --fill && git push origin feature-x"),
		).toContain("a branch other than main, feature-x");
	});

	it("records nothing a walk meets after the refusal", () => {
		expect(
			denial('git push origin feature-x && git -C "$W" push'),
		).not.toBeNull();
		expect(logs).toEqual([]);
	});

	it.each([
		[
			"gh pr create",
			"",
			"This opens a pull request: gh pr create\n\nWork lands on `main` directly — no branch on the remote, and never a pull request; the rule could not be read from docs/agents/rules/branch-publish.txt. Restore that file from origin/main, or revert the change that removed it, then read it before doing anything else.",
		],
		[
			"git push origin main",
			"landing",
			"This pushes to main, which only the lander moves: git push origin main\n\nThis session runs outside a worktree under SHARED/.claude/worktrees/, so it has no queue ref. Launch it in its own worktree with `scripts/start-session.sh <session-name>`, which cuts `.claude/worktrees/<session-name>/` and starts the session there; its queue ref is then `queue/<session-name>`.\n\nWork lands through your session's queue ref — never a push to `main` or `landing`, no other branch on the remote, and never a pull request; the rule could not be read from docs/agents/rules/branch-publish-landing.txt. Restore that file from origin/main, or revert the change that removed it, then read it before doing anything else.",
		],
		[
			"git push origin :landing",
			"landing",
			"This deletes `landing` on the remote: git push origin :landing\n\nThis session runs outside a worktree under SHARED/.claude/worktrees/, so it has no queue ref. Launch it in its own worktree with `scripts/start-session.sh <session-name>`, which cuts `.claude/worktrees/<session-name>/` and starts the session there; its queue ref is then `queue/<session-name>`.\n\nNever force-push or delete `landing` or a queue ref; the rule could not be read from docs/agents/rules/landing-rewind.txt. Restore that file from origin/main, or revert the change that removed it, then read it before doing anything else.",
		],
		[
			"git push origin HEAD:lander/batch-0",
			"landing",
			"This pushes to `lander/batch-0`, which only the lander writes: git push origin HEAD:lander/batch-0\n\nThis session runs outside a worktree under SHARED/.claude/worktrees/, so it has no queue ref. Launch it in its own worktree with `scripts/start-session.sh <session-name>`, which cuts `.claude/worktrees/<session-name>/` and starts the session there; its queue ref is then `queue/<session-name>`.\n\nPush your work to your session's own queue ref, a creation or a fast-forward, never forced; the rule could not be read from docs/agents/rules/queue-ref.txt. Restore that file from origin/main, or revert the change that removed it, then read it before doing anything else.",
		],
		[
			"gh pr merge dependabot/x",
			"",
			"This merges a Dependabot pull request: gh pr merge dependabot/x\n\nNever merge a Dependabot pull request; the rule could not be read from docs/agents/rules/dependabot-merge.txt. Restore that file from origin/main, or revert the change that removed it, then read it before doing anything else.",
		],
	])(
		"still refuses %s where the store cannot give its rule, naming the file",
		(command, modules, reason) => {
			vi.stubEnv("WFC_MODULES", modules);
			noRules();
			expect(denial(command)).toBe(reason.replace("SHARED", shared));
		},
	);
});
