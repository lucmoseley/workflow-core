// @vitest-environment node
/*
 * The guard-commit-form core of guard-dispatch.js (mantahostels#117) end to
 * end, the boundary set (§X11), the dispatcher entry run on it alone: each
 * exit path, each input channel, each production adapter crossed once for
 * real, and the fail-open record. Which commit forms are denied, warned on or
 * handed the rules — every branch of the core — is lib/commit-form.test.ts's,
 * in process; the entry's payload faults and the throw policy are
 * guard-dispatch's own tests' (#3224).
 *
 * The guard compares the target tree against CLAUDE_PROJECT_DIR's, so a
 * throwaway repo stands in for this one, with a linked worktree of it, and an
 * unrelated repo for the exempt case.
 *
 * The program runs through lib/run-in-process.js.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFailOpenLog } from "./guard-log-fixture";
import {
	defineTemplate,
	mkDirOutsideRepo,
	mkScratchDir,
	trioTemplate,
} from "./lib/git-fixture";
import { buildBashPayload } from "./lib/pretool-guard-testkit";
import { runInProcess } from "./lib/run-in-process";

const DISPATCH = path.resolve(__dirname, "guard-dispatch.js");
const CORE = "guard-commit-form";

let dir: string;
let shared: string;
let worktree: string;
let elsewhere: string;
/** The config root, pointed at the temp dir so no test reads ~/.claude. */
let config: string;

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" });

/*
 * THE FIXTURE IS BUILT ONCE AND COPIED (mantahostels#2016), not rebuilt per test, via
 * scripts/lib/git-fixture.ts (mantahostels#2068) — its own header explains what a
 * naive copy breaks and why.
 */
const template = defineTemplate(trioTemplate());

interface At {
	cwd?: string;
	project?: string;
	env?: Record<string, string>;
}

/**
 * The guard's run on `stdin`, from `cwd`, with CLAUDE_PROJECT_DIR at
 * `project`.
 */
const guard = (
	stdin: string,
	{ cwd = shared, project = shared, env = {} }: At = {},
) =>
	runInProcess(DISPATCH, ["--only", CORE], {
		cwd,
		stdin,
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: project,
			CLAUDE_CONFIG_DIR: config,
			...env,
		},
	});

/** The payload Claude Code sends on a Bash call, as the guard reads it. */
const payload = (command: string, session: string | null = "test") =>
	JSON.stringify({
		hook_event_name: "PreToolUse",
		...buildBashPayload(command, session),
	});

/**
 * The guard's `hookSpecificOutput` on `command`, or null where it said
 * nothing. A guard that CRASHED also emits no verdict, so the exit status and
 * stderr are asserted on every call.
 */
const emission = (
	command: string,
	session: string | null = "test",
	at: At = {},
) => {
	const r = guard(payload(command, session), at);
	expect(r.status).toBe(0);
	expect(r.stderr).toBe("");
	const out = r.stdout.trim();
	return out ? JSON.parse(out).hookSpecificOutput : null;
};

/** The fail-open log this case's guard runs wrote. */
const failOpenLog = () => readFailOpenLog(config, shared);

/* The store's Node accessor, so a test asks for a rule by id rather than
 * holding a second copy of its text. */
const { readRuleText: storeText } = createRequire(__filename)(
	"./lib/rule-text",
) as { readRuleText: (id: string) => string };

/** A fragment as the guard renders it in the fixture host: push-cadence's
 * `{command:}` lines expand against the host's config, read at call time. */
const readRuleText = (id: string) => {
	const saved = process.env.CLAUDE_PROJECT_DIR;
	process.env.CLAUDE_PROJECT_DIR = shared;
	try {
		return storeText(id);
	} finally {
		if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR;
		else process.env.CLAUDE_PROJECT_DIR = saved;
	}
};

/* What a commit naming no gated path is handed, in `injectRules` order. */
const commitRule = () =>
	["commit-pathspec", "commit-show-diff", "commit-message", "push-cadence"]
		.map((id) => readRuleText(id))
		.join("\n\n");

/* The framing line of the `--no-verify` refusal (mantahostels#975). */
const NO_VERIFY =
	"This flag skips none of the pre-commit gates on a plain commit or merge";

/** Puts a file on disk that git has never been told about. */
const newFile = (rel: string, text = "new\n") => {
	fs.mkdirSync(path.dirname(path.join(shared, rel)), { recursive: true });
	fs.writeFileSync(path.join(shared, rel), text);
};

beforeEach(() => {
	dir = mkScratchDir("guard-commit-form-");
	config = path.join(dir, "config");
	shared = path.join(dir, "shared");
	worktree = path.join(dir, "wt");
	elsewhere = path.join(dir, "elsewhere");
	template.instantiate(dir);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("each exit path", () => {
	it("a deny is the refusal on exit 0, with no context", () => {
		const out = emission('git commit -n -m "x" -- a.md');
		expect(out.hookEventName).toBe("PreToolUse");
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toContain(NO_VERIFY);
		expect(out.additionalContext).toBeUndefined();
	});

	it("a closing-keyword deny carries the rule file's text and the way out", () => {
		const reason = emission(
			'git commit -m "Fixes #1" -- a.md',
		).permissionDecisionReason;
		expect(reason).toContain("What matched: `Fixes #1`");
		expect(reason).toContain(readRuleText("commit-closes-keyword"));
		expect(reason).toContain(
			"Rewrite the message with a non-closing reference and commit again.",
		);
	});

	it("a warn is context with no decision, keyed by the field Claude Code reads", () => {
		// A warn without hookEventName is dropped silently, leaving the warns
		// inert.
		newFile("new.md");
		const out = emission('git commit -m "x" -- new.md');
		expect(out.hookEventName).toBe("PreToolUse");
		expect(out.permissionDecision).toBeUndefined();
		expect(out.additionalContext).toContain("#1612");
	});

	it("a clean pathspec commit is handed the rules, and not refused", () => {
		const out = emission('git commit -m "x" -- a.md');
		expect(out.hookEventName).toBe("PreToolUse");
		expect(out.permissionDecision).toBeUndefined();
		expect(out.additionalContext).toBe(commitRule());
	});

	it.each([
		["git merge other", "a merge, which stages no pathspec"],
		["npm run test", "not git at all"],
	])("%s says nothing — %s", (command) => {
		const r = guard(payload(command));
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
		expect(r.stderr).toBe("");
		expect(failOpenLog()).toBe("");
	});
});

/*
 * THE RULES' ONCE-A-SESSION LATCH (mantahostels#1647) and the kit's ceiling,
 * which render the core's hand-over.
 */
describe("the commit rules are handed over once a session", () => {
	it("says it once per session, and again for a different session", () => {
		expect(emission('git commit -m "x" -- a.md', "sess-A")).not.toBeNull();
		expect(emission('git commit -m "x" -- a.md', "sess-A")).toBeNull();
		expect(emission('git commit -m "x" -- a.md', "sess-B")).not.toBeNull();
	});

	it("a warn outranks it, and leaves it unlatched for the next commit", () => {
		// The rule is not spent by a warn — the next clean commit in the same
		// session still gets it.
		newFile("new.md");
		const warned = emission('git commit -m "x" -- new.md', "sess-C");
		expect(warned.additionalContext).toContain("#1612");
		expect(warned.additionalContext).not.toContain("COMMIT BY PATHSPEC");
		expect(
			emission('git commit -m "x" -- a.md', "sess-C").additionalContext,
		).toBe(commitRule());
	});

	it("hands the push rule on a session's first commit-paths.js call and not its second (#2285)", () => {
		const command = 'node scripts/commit-paths.js -m "x" -- a.md';
		expect(emission(command, "cp-push").additionalContext).toContain(
			readRuleText("push-cadence"),
		);
		expect(emission(command, "cp-push")).toBeNull();
	});

	it("defers what the ceiling cannot hold to the next commit, the push rule first", () => {
		// This trigger's gate ids fit in one emission on this repo's own
		// modules; with governance on as well they do not (#449).
		fs.mkdirSync(path.join(shared, "docs"), { recursive: true });
		fs.mkdirSync(path.join(shared, "scripts"), { recursive: true });
		fs.mkdirSync(path.join(shared, "app"), { recursive: true });
		for (const rel of ["docs/roadmap-digest.md", "scripts/y.sh", "app/y.ts"])
			fs.writeFileSync(path.join(shared, rel), "x\n");
		git(shared, "add", "-A");
		git(shared, "commit", "-qm", "fixture");
		const command =
			'git commit -m "x" -- docs/roadmap-digest.md scripts/y.sh app/y.ts';
		const at = { env: { WFC_MODULES: "roadmap" } };
		const first = emission(command, "wide", at).additionalContext as string;
		expect(Buffer.byteLength(first, "utf8")).toBeLessThanOrEqual(4000);
		expect(first).toContain(readRuleText("machinery-superseded"));
		expect(first).not.toContain(readRuleText("push-cadence"));
		expect(emission(command, "wide", at).additionalContext).toBe(
			readRuleText("push-cadence"),
		);
	});
});

describe("each input channel", () => {
	it("hands no rules where the payload carries no session id, rather than wedging", () => {
		// The kit cannot latch what it cannot key, so it says nothing and allows
		// (mantahostels#103 §6).
		expect(emission('git commit -m "x" -- a.md', null)).toBeNull();
		expect(failOpenLog()).toMatch(/no session_id in payload/);
	});

	it("reads this repo off CLAUDE_PROJECT_DIR, an unborn one included", () => {
		const fresh = path.join(dir, "fresh");
		fs.mkdirSync(fresh);
		git(fresh, "init", "-q", "-b", "main", ".");
		git(fresh, "config", "core.hooksPath", path.join(dir, "no-hooks"));
		const out = emission('git commit -n -m "init"', null, {
			cwd: fresh,
			project: fresh,
		});
		expect(out.permissionDecision).toBe("deny");
	});

	it("leaves this repo alone where CLAUDE_PROJECT_DIR names another repo", () => {
		expect(
			emission('git commit -n -m "x"', "test", { project: elsewhere }),
		).toBeNull();
	});

	it("allows, recorded, where CLAUDE_PROJECT_DIR is no repository", () => {
		// With the repo unknown no tree is this repo's, and refusing would
		// wedge every git call in a repo git cannot read (lib/refuse-on-throw.js).
		const opaque = mkDirOutsideRepo("not-a-repo-");
		try {
			const r = guard(payload('git commit -n -m "x"'), { project: opaque });
			expect(r.status).toBe(0);
			expect(r.stdout).toBe("");
			expect(readFailOpenLog(config, opaque)).toMatch(
				/git could not resolve a git dir for .* — command allowed unchecked/,
			);
		} finally {
			fs.rmSync(opaque, { recursive: true, force: true });
		}
	});

	it("expands a variable the hook inherits, so $CLAUDE_JOB_DIR names a tree (mantahostels#183)", () => {
		git(shared, "worktree", "add", "-q", "-b", "recipe", path.join(dir, "tmp"));
		const at = { cwd: elsewhere, env: { CLAUDE_JOB_DIR: dir } };
		expect(
			emission('cd "$CLAUDE_JOB_DIR/tmp" && git commit -n -m "msg"', "test", at)
				.permissionDecision,
		).toBe("deny");
		expect(failOpenLog()).toBe("");
	});

	it("judges the tree the hook runs in, a linked worktree included", () => {
		expect(
			emission('git commit -n -m "msg"', "test", { cwd: worktree })
				.permissionDecision,
		).toBe("deny");
		expect(
			emission('git commit -n -m "msg"', "test", { cwd: elsewhere }),
		).toBeNull();
	});
});

describe("each production adapter, crossed for real", () => {
	it("reads whether HEAD is on the pushed ref (#4384)", () => {
		const amend = (session: string) =>
			emission("git commit --amend --no-edit", session)?.permissionDecision;
		// No origin/main yet: git cannot answer, so the amend is allowed, recorded.
		expect(amend("p1")).toBeUndefined();
		expect(failOpenLog()).toMatch(
			/git could not say whether HEAD in .* is pushed — the amend allowed unchecked/,
		);
		git(shared, "update-ref", "refs/remotes/origin/main", "HEAD");
		const out = emission("git commit --amend --no-edit", "p2");
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toContain(
			"This amend rewrites a commit already pushed, as `HEAD` is on `origin/main`",
		);
		fs.writeFileSync(path.join(shared, "a.md"), "unpushed\n");
		git(shared, "commit", "-qm", "unpushed", "--", "a.md");
		expect(amend("p3")).toBeUndefined();
	});

	it("reads a merge in progress off the git dir", () => {
		git(shared, "checkout", "-q", "-b", "other");
		fs.writeFileSync(path.join(shared, "a.md"), "other\n");
		git(shared, "commit", "-qm", "other", "--", "a.md");
		git(shared, "checkout", "-q", "main");
		fs.writeFileSync(path.join(shared, "a.md"), "main\n");
		git(shared, "commit", "-qm", "main", "--", "a.md");
		git(shared, "update-ref", "refs/remotes/origin/main", "HEAD");
		expect(() => git(shared, "merge", "other")).toThrow();
		expect(
			emission("git commit --amend --no-edit")?.permissionDecision,
		).toBeUndefined();
	});

	it("lists what git tracks under a pathspec word (mantahostels#1612, mantahostels#1651)", () => {
		newFile("new.md");
		expect(emission('git commit -m "x" -- new.md').additionalContext).toContain(
			"#1612",
		);
		fs.rmSync(path.join(shared, "new.md"));
		fs.mkdirSync(path.join(shared, "docs"), { recursive: true });
		fs.writeFileSync(path.join(shared, "docs", "old.md"), "old\n");
		git(shared, "add", "docs/old.md");
		git(shared, "commit", "-qm", "docs");
		newFile("docs/new.md");
		const out = emission('git commit -m "x" -- docs').additionalContext;
		expect(out).toContain("#1651");
		expect(out).toContain("docs/new.md");
	});

	it("reads a --pathspec-from-file list off disk (mantahostels#3324)", () => {
		newFile("new.md");
		newFile("paths.txt", "new.md\n");
		const cmd =
			'git add -N --pathspec-from-file paths.txt && git commit -m "x" -- new.md';
		expect(emission(cmd).additionalContext).not.toContain("#1612");
		fs.writeFileSync(path.join(shared, "paths.txt"), "other.md\n");
		expect(emission(cmd, "test2").additionalContext).toContain("#1612");
	});

	it("reads the files a commit-paths.js --patch file names (#2147)", () => {
		newFile("docs/p.md", "x\n");
		git(shared, "add", "docs/p.md");
		git(shared, "commit", "-qm", "fixture");
		fs.writeFileSync(path.join(shared, "docs/p.md"), "x\ny\n");
		fs.writeFileSync(
			path.join(shared, "own.patch"),
			git(shared, "diff", "HEAD", "--", "docs/p.md"),
		);
		const doc = readRuleText("doc-map-precommit");
		expect(
			emission('node scripts/commit-paths.js -m "x" --patch own.patch')
				.additionalContext,
		).toContain(doc);
		expect(
			emission('node scripts/commit-paths.js -m "x" -- a.md', "test2")
				.additionalContext,
		).not.toContain(doc);
	});
});

/*
 * scripts/lib/git-fixture.ts (mantahostels#2068) exposes neither `template` nor
 * `pathBearingFiles`: the helper leak-checks every instantiate() call
 * itself (proven in git-fixture.test.ts), so THIS beforeEach already throws
 * before any test body runs were the copy still pointing at the template. What
 * is left to assert here, and what mantahostels#2068's acceptance criteria ask for, is
 * what that scan cannot see: that relink() wrote THIS instance's own path
 * rather than some third, wrong one, and — the BEHAVIOURAL limb — that a write
 * made in the instantiated copy does not reach a second, independent
 * instantiation of the same template.
 */
describe("the copied fixture is isolated from its template (mantahostels#2016, mantahostels#2068)", () => {
	const freshCopy = () => {
		const fresh = mkScratchDir("guard-commit-form-fresh-");
		try {
			template.instantiate(fresh);
		} catch (err) {
			fs.rmSync(fresh, { recursive: true, force: true });
			throw err;
		}
		return fresh;
	};

	it("each copy's core.hooksPath is relinked, not left pointing at the template", () => {
		// Writing a commit into the copy's own real .git (the shape this
		// replaced) proves nothing about relinking: nothing that write touches
		// is one of git-fixture's path carriers, so it cannot fail on a relink
		// regression. This instead reads back the relinked file directly.
		// Asserting merely "exists and is empty" would pass even with relink()
		// disabled: the template's own no-hooks dir is exists-and-empty too, so a
		// stale pointer left aimed at the TEMPLATE would read identically.
		// Anchoring on `dir` — this instance's own root — is what tells a
		// relinked path apart from a leaked one. What these assertions catch
		// that checkForLeak() cannot is a relink writing some third, wrong path,
		// which can hit one copy and not the other — hence both (mantahostels#2193 review).
		// Reading the beforeEach instance rather than minting a second one
		// (mantahostels#2232) rests on this block sitting last in the file, so that
		// instance is a LATE instantiation. Run this test alone — it.only, or
		// -t — and it becomes the first, and "relink is still correct on a copy
		// after the first" goes unasserted. "a commit made in the copied
		// WORKTREE leaves the template untouched" keeps freshCopy(), where a
		// second, independent instance IS the assertion.
		for (const repo of [shared, elsewhere]) {
			const hooksPath = git(repo, "config", "core.hooksPath").trim();
			expect(hooksPath).toBe(path.join(dir, "no-hooks"));
			expect(fs.existsSync(hooksPath)).toBe(true);
			expect(fs.readdirSync(hooksPath)).toEqual([]);
		}
	});

	it("a commit made in the copied WORKTREE leaves the template untouched", () => {
		// The worktree shares its parent's object store, so a stale gitdir
		// pointer here writes into the template rather than failing loudly.
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

	// A commit made in the 'elsewhere' copy's own real .git (dropped here,
	// mantahostels#2193) has the same defect mantahostels#2178 fixed for the shared-copy test above:
	// nothing that write touches is a git-fixture path carrier, so it cannot
	// fail on a relink regression. "each copy's core.hooksPath is relinked"
	// above reads `elsewhere` as well as `shared` in its place.
	//
	// A bare exists-and-empty assertion on core.hooksPath (dropped here, mantahostels#2233)
	// is a strict subset of that same test, which already says why it catches
	// nothing. guard-pull-form carried no such duplicate.
});
