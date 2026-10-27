// @vitest-environment node
/*
 * guard-branch.js denies a branch move on the shared working tree
 * (mantahostels#110) and hands the rule over before an allowed worktree add
 * (mantahostels#1647). These are its boundary cases (§X11), run as the harness
 * runs it: the payload, real git trees, the rule store and the latch, end to
 * end. Which command earns which verdict is lib/branch-move.test.ts's; the
 * tree classes are lib/git-tree.test.ts's; the throw policy is
 * lib/refuse-on-throw.test.ts's (#2797).
 *
 * A throwaway repo stands in for the shared tree and a worktree of it for the
 * exempt case. Loosen a deny and a session can move the shared tree off `main`
 * under its neighbours; lose an allow and sanctioned worktree work is wedged.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failOpenLogPath, readFailOpenLog } from "./guard-log-fixture";
import { defineTemplate, mkScratchDir, trioTemplate } from "./lib/git-fixture";
import {
	buildBashPayload,
	nodeGuardOutput,
	runNodeGuard,
} from "./lib/pretool-guard-testkit";

const GUARD = path.resolve(__dirname, "guard-branch.js");

const { readRuleText } = require("./lib/rule-text") as {
	readRuleText: (id: string) => string;
};

let dir: string;
let config: string;
let shared: string;
let worktree: string;
let elsewhere: string;

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" });

/* Built once and copied (mantahostels#2016) via scripts/lib/git-fixture.ts,
 * whose header says what a naive copy breaks. */
const template = defineTemplate(trioTemplate());

const MOVED = "moves the shared working tree off its branch";

/** The hook output for `command` from `cwd`, or null; exit 0 and a quiet
 * stderr asserted on every call. */
const emission = (
	command: string,
	{
		cwd = shared,
		session = "test",
		env = {},
	}: { cwd?: string; session?: string; env?: NodeJS.ProcessEnv } = {},
) =>
	nodeGuardOutput(GUARD, buildBashPayload(command, session), {
		project: shared,
		config,
		cwd,
		env,
	});

beforeEach(() => {
	dir = mkScratchDir("guard-branch-");
	config = path.join(dir, "claude-config");
	shared = path.join(dir, "shared");
	worktree = path.join(dir, "wt");
	elsewhere = path.join(dir, "elsewhere");
	template.instantiate(dir);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("the guard, end to end", () => {
	it("refuses a branch move as JSON on exit 0, carrying the whole rule (mantahostels#87)", () => {
		const out = emission("git checkout -b manual-sync-2026-08-03");
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toContain(
			`${MOVED}: git checkout -b manual-sync-2026-08-03`,
		);
		expect(out.permissionDecisionReason).toContain(
			readRuleText("branch-shared-tree"),
		);
		expect(out.additionalContext).toBeUndefined();
	});

	it("resolves a leading cd against the real tree, from another repo's cwd", () => {
		expect(
			emission(`cd ${shared} && git checkout -b foo`, { cwd: elsewhere })
				.permissionDecision,
		).toBe("deny");
	});

	it("leaves a linked worktree and an unrelated repository alone", () => {
		expect(emission("git checkout -b another", { cwd: worktree })).toBeNull();
		expect(emission(`git -C ${elsewhere} checkout -b foo`)).toBeNull();
		expect(fs.existsSync(failOpenLogPath(config, shared))).toBe(false);
	});

	it("passes a file restore naming a real file, and refuses a name that is also a real branch", () => {
		fs.mkdirSync(path.join(shared, "docs"));
		fs.writeFileSync(path.join(shared, "docs", "x.md"), "x\n");
		git(shared, "add", "docs/x.md");
		git(shared, "commit", "-qm", "docs");
		expect(emission("git checkout docs")).toBeNull();
		// A tag is no branch: only refs/heads/ outranks the path.
		git(shared, "tag", "docs");
		expect(emission("git checkout docs")).toBeNull();
		git(shared, "branch", "docs");
		expect(emission("git checkout docs").permissionDecision).toBe("deny");
	});

	it("hands the rule before the sanctioned recipe, once a session, and again to a new session (mantahostels#1647)", () => {
		const first = emission("git worktree add -b s1 /tmp/w1 main", {
			session: "sess-A",
		});
		expect(first.permissionDecision).toBeUndefined();
		expect(first.additionalContext).toContain(
			readRuleText("branch-shared-tree"),
		);
		expect(
			emission("git worktree add -b s2 /tmp/w2 main", { session: "sess-A" }),
		).toBeNull();
		expect(
			emission("git worktree add -b s3 /tmp/w3 main", { session: "sess-B" }),
		).not.toBeNull();
	});

	it.each([
		["landing", true],
		["suites", false],
	])(
		"hands the origin/landing upstream line only with the landing module on — modules %s (#2409)",
		(modules, told) => {
			const out = emission("git checkout main", {
				env: { WFC_MODULES: modules },
			});
			expect(out.additionalContext).toContain(
				readRuleText("branch-shared-tree"),
			);
			expect(out.additionalContext.includes("origin/landing")).toBe(told);
		},
	);

	it("passes the whole sanctioned recipe in silence, logging nothing (mantahostels#208)", () => {
		const fresh = path.join(dir, "recipe-wt");
		const out = emission(
			`WT=${fresh} && git worktree add --detach "$WT" main && git -C "$WT" checkout -b side3`,
		);
		expect(out.permissionDecision).toBeUndefined();
		expect(fs.existsSync(failOpenLogPath(config, shared))).toBe(false);
	});

	it("is silent on a command that is no branch move", () => {
		expect(emission("git status")).toBeNull();
	});
});

describe("a refusal whose rule it cannot read still refuses (mantahostels#1648)", () => {
	it("refuses with an empty store, names the fragment's file, and records no fail-open", () => {
		const store = fs.mkdtempSync(path.join(dir, "store-"));
		const out = emission("git checkout -b foo", {
			env: { WFC_RULES_DIR: store },
		});
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toContain(
			"docs/agents/rules/branch-shared-tree.txt",
		);
		expect(fs.existsSync(failOpenLogPath(config, shared))).toBe(false);
	});
});

describe("the fail-open record", () => {
	const run = (stdin: string, project = shared, env: NodeJS.ProcessEnv = {}) =>
		runNodeGuard(GUARD, null, { project, config, cwd: project, stdin, env });

	it("treats an empty payload as nothing to check, not a fault", () => {
		const r = run("");
		expect([r.status, r.stdout, r.stderr]).toEqual([0, "", ""]);
		expect(fs.existsSync(failOpenLogPath(config, shared))).toBe(false);
	});

	it.each([
		[
			"a payload that is not JSON",
			"{not json",
			/payload did not parse as JSON/,
		],
		[
			"a payload carrying no command",
			JSON.stringify({ session_id: "t", tool_name: "Bash", tool_input: {} }),
			/no command in payload/,
		],
	])("records %s, allowing", (_l, stdin, match) => {
		const r = run(stdin);
		expect([r.status, r.stdout, r.stderr]).toEqual([0, "", ""]);
		const [line] = readFailOpenLog(config, shared).trim().split("\n");
		expect(line?.split("\t")).toEqual([
			expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
			"guard-branch.js",
			expect.stringMatching(match),
		]);
	});

	it("records a checkout whose working tree cannot be resolved, allowing", () => {
		expect(emission("cd $TARGET && git checkout -b foo")).toBeNull();
		expect(readFailOpenLog(config, shared)).toMatch(
			/could not resolve the working tree for a git checkout/,
		);
	});

	it("refuses, logged, where its core throws", () => {
		// A copy of the entry beside a core that throws; every other lib is the
		// real one, linked.
		const at = path.join(dir, "broken");
		const lib = path.join(at, "scripts", "lib");
		fs.mkdirSync(lib, { recursive: true });
		fs.copyFileSync(GUARD, path.join(at, "scripts", "guard-branch.js"));
		for (const f of fs.readdirSync(path.join(__dirname, "lib")))
			if (f !== "branch-move.js")
				fs.symlinkSync(path.join(__dirname, "lib", f), path.join(lib, f));
		fs.writeFileSync(
			path.join(lib, "branch-move.js"),
			'module.exports = { decide() { throw new Error("broke"); } };\n',
		);
		const out = nodeGuardOutput(
			path.join(at, "scripts", "guard-branch.js"),
			buildBashPayload("git status", "test"),
			{ project: shared, config, cwd: shared },
		);
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toBe(
			"guard-branch.js could not judge this command, so it refuses it: broke",
		);
		expect(readFailOpenLog(config, shared)).toMatch(
			/core threw — the command was refused\tbroke/,
		);
	});

	it("records a repo git cannot answer for at all, allowing every command", () => {
		// The most complete fail-open the guard has, and silent before
		// mantahostels#147.
		const notARepo = path.join(dir, "not-a-repo");
		fs.mkdirSync(notARepo, { recursive: true });
		const r = run(
			JSON.stringify(buildBashPayload("git checkout -b foo", "test")),
			notARepo,
			/* Otherwise git walks up out of the fixture into a real repository
			 * (mantahostels#3149, mantahostels#3158). */
			{ GIT_CEILING_DIRECTORIES: dir },
		);
		expect([r.status, r.stdout, r.stderr]).toEqual([0, "", ""]);
		// The core's own words, not the kit's "guard threw" wrapper.
		expect(readFailOpenLog(config, notARepo).split("\t")[2]).toMatch(
			/^git could not resolve a git dir/,
		);
	});
});

/*
 * git-fixture.ts (mantahostels#2068) leak-checks every instantiate() itself;
 * what mantahostels#2085 asks for here is the BEHAVIOURAL isolation a leak
 * would cause.
 */
describe("the copied fixture is isolated from its template (mantahostels#2085)", () => {
	const freshCopy = () => {
		const fresh = mkScratchDir("guard-branch-fresh-");
		try {
			template.instantiate(fresh);
		} catch (err) {
			fs.rmSync(fresh, { recursive: true, force: true });
			throw err;
		}
		return fresh;
	};

	it("the copy's core.hooksPath is relinked, not left pointing at the template", () => {
		// Anchoring on `fresh` — this instance's own root — is what tells a
		// relinked path apart from a leaked one: the template's own no-hooks dir
		// is exists-and-empty too.
		const fresh = freshCopy();
		try {
			const hooksPath = git(
				path.join(fresh, "shared"),
				"config",
				"core.hooksPath",
			).trim();
			expect(hooksPath).toBe(path.join(fresh, "no-hooks"));
			expect(fs.existsSync(hooksPath)).toBe(true);
			expect(fs.readdirSync(hooksPath)).toEqual([]);
		} finally {
			fs.rmSync(fresh, { recursive: true, force: true });
		}
	});

	it("a commit made in the copied worktree leaves the template untouched", () => {
		// The worktree shares its parent's object store, so a stale gitdir
		// pointer here writes into the template rather than failing loudly.
		fs.writeFileSync(path.join(worktree, "c.md"), "c\n");
		git(worktree, "add", "c.md");
		git(worktree, "commit", "-qm", "worktree copy only", "--", "c.md");
		expect(git(worktree, "log", "--oneline")).toContain("worktree copy only");

		const fresh = freshCopy();
		try {
			expect(git(path.join(fresh, "wt"), "log", "--oneline")).not.toContain(
				"worktree copy only",
			);
		} finally {
			fs.rmSync(fresh, { recursive: true, force: true });
		}
	});
});
