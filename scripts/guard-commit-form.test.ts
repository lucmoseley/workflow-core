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
 * throwaway repo stands in for the shared tree, a worktree of it for the
 * exempt case, and an unrelated repo for the other.
 *
 * The program runs through lib/run-in-process.js.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFailOpenLog } from "./guard-log-fixture";
import { writeFaultyGit } from "./lib/git-fault-fake";
import {
	defineTemplate,
	mkDirOutsideRepo,
	mkScratchDir,
	trioTemplate,
} from "./lib/git-fixture";
import { buildBashPayload, readHookLines } from "./lib/pretool-guard-testkit";
import { runInProcess } from "./lib/run-in-process";

const DISPATCH = path.resolve(__dirname, "guard-dispatch.js");
const CORE = "guard-commit-form";
const ARBITER = path.resolve(__dirname, "session-arbiter.js");
const HOOKS = "self-plugin/hooks/hooks.json";

// The arbiter is CommonJS, required here only to ARRANGE a foreign claim the
// guard then reads back.
// biome-ignore lint/suspicious/noExplicitAny: a CJS module has no types to import
const store: any = createRequire(__filename)("./lib/arbiter-store.js");
// biome-ignore lint/suspicious/noExplicitAny: a CJS module has no types to import
const proc: any = createRequire(__filename)("./lib/arbiter-proc.js");

let dir: string;
let shared: string;
let worktree: string;
let elsewhere: string;
/** The write ledger's root, pointed at the temp dir so no test reads ~/.claude. */
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
 * `project`. CLAUDE_CODE_SESSION_ID is emptied unless `env` sets it, so a
 * real session's id cannot leak in as the guard's fallback.
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
			CLAUDE_CODE_SESSION_ID: "",
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

/**
 * Runs the arbiter CLI, failing the test on a non-zero exit — runInProcess
 * does not throw on one itself.
 */
const arbiter = (args: string[]) => {
	const r = runInProcess(ARBITER, args, {
		cwd: shared,
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: shared,
			CLAUDE_CONFIG_DIR: config,
		},
	});
	if (r.status !== 0)
		throw new Error(
			`session-arbiter.js ${args.join(" ")} exited ${r.status}\n${r.stdout}${r.stderr}`,
		);
	return r.stdout;
};

/** What the post-write core records after an Edit: note that `session` wrote `file`. */
const recordWrite = (file: string, session = "test") =>
	arbiter(["record", file, session]);

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

/* The framing line of the sweeping-index refusal (mantahostels#2145). */
const SWEEPS = "This commit form sweeps the shared index";

/** Puts something in the shared index, which is what the bare-commit warn reads. */
const stageSomething = (at = shared, file = "a.md") => {
	fs.writeFileSync(path.join(at, file), `${Math.random()}\n`);
	git(at, "add", file);
};

/** Puts a file on disk that git has never been told about. */
const newFile = (rel: string, text = "new\n") => {
	fs.mkdirSync(path.dirname(path.join(shared, rel)), { recursive: true });
	fs.writeFileSync(path.join(shared, rel), text);
};

/**
 * A live session other than the committer, holding `subject` with the tree's
 * current bytes pinned — the arrangement mantahostels#1558's test fires on.
 * The store reads its config dir and project root at call time, so this
 * describe's arrangement and the guard see the same sandbox.
 */
const neighbour = (subject: string, name: string) => {
	fs.mkdirSync(path.join(config, "sessions"), { recursive: true });
	fs.writeFileSync(
		path.join(config, "sessions", `${process.pid}.json`),
		JSON.stringify({
			pid: process.pid,
			sessionId: "alice",
			procStart: proc.readProcStartOf(process.pid),
			status: "idle",
			cwd: shared,
			name,
		}),
	);
	const saved = [process.env.CLAUDE_CONFIG_DIR, process.env.CLAUDE_PROJECT_DIR];
	process.env.CLAUDE_CONFIG_DIR = config;
	process.env.CLAUDE_PROJECT_DIR = shared;
	try {
		const me = store.identify("alice");
		store.acquire(subject, me);
		store.recordContent(subject, me);
	} finally {
		for (const [k, v] of [
			["CLAUDE_CONFIG_DIR", saved[0]],
			["CLAUDE_PROJECT_DIR", saved[1]],
		] as const) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
};

/** Makes the one write ledger on record unreadable. */
const lockLedger = () => {
	// The ledger's directory is keyed by a slug of the repo path, which is a
	// temp dir here.
	const projects = path.join(config, "projects");
	const ledgers = fs
		.readdirSync(projects)
		.flatMap((slug) => {
			const w = path.join(projects, slug, "writes");
			return fs.existsSync(w)
				? fs.readdirSync(w).map((f) => path.join(w, f))
				: [];
		})
		.filter((p) => fs.statSync(p).isFile());
	expect(ledgers).toHaveLength(1);
	fs.chmodSync(ledgers[0], 0o000);
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
		const out = emission('git commit -am "x"');
		expect(out.hookEventName).toBe("PreToolUse");
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toContain(SWEEPS);
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
		// A warn without hookEventName is dropped silently, leaving two of the
		// three verdicts inert.
		const out = emission("git add a.md");
		expect(out.hookEventName).toBe("PreToolUse");
		expect(out.permissionDecision).toBeUndefined();
		expect(out.additionalContext).toContain("#63");
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
		stageSomething();
		const warned = emission('git commit -m "x"', "sess-C");
		expect(warned.additionalContext).toContain("takes the whole index");
		expect(warned.additionalContext).not.toContain("COMMIT BY PATHSPEC");
		git(shared, "commit", "-qm", "drain");
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

	it("attributes the staged paths through CLAUDE_CODE_SESSION_ID where the payload has no session id", () => {
		stageSomething(shared, "a.md");
		recordWrite("a.md");
		expect(
			emission('git commit -m "msg"', null, {
				env: { CLAUDE_CODE_SESSION_ID: "test" },
			}),
		).toBeNull();
	});

	it("warns index-wide where neither the payload nor the environment names a session", () => {
		stageSomething(shared, "a.md");
		recordWrite("a.md");
		const msg = emission('git commit -m "msg"', null).additionalContext;
		expect(msg).toContain("a.md");
		expect(msg).toContain("could not be read");
	});

	it("reads the shared tree off CLAUDE_PROJECT_DIR, a first commit's index included", () => {
		// `git diff --cached HEAD` errors on an unborn branch, which would have
		// made the guard silent on the very first commit of a repo.
		const fresh = path.join(dir, "fresh");
		fs.mkdirSync(fresh);
		git(fresh, "init", "-q", "-b", "main", ".");
		git(fresh, "config", "core.hooksPath", path.join(dir, "no-hooks"));
		fs.writeFileSync(path.join(fresh, "a.md"), "a\n");
		git(fresh, "add", "a.md");
		const out = emission('git commit -m "init"', null, {
			cwd: fresh,
			project: fresh,
		});
		expect(out.additionalContext).toContain("a.md");
	});

	it("leaves the shared tree alone where CLAUDE_PROJECT_DIR names another repo", () => {
		expect(
			emission('git commit -am "x"', "test", { project: elsewhere }),
		).toBeNull();
	});

	it("allows, recorded, where CLAUDE_PROJECT_DIR is no repository", () => {
		// With the repo unknown no tree is the shared one, and refusing would
		// wedge every git call in a repo git cannot read (lib/refuse-on-throw.js).
		const opaque = mkDirOutsideRepo("not-a-repo-");
		try {
			const r = guard(payload('git commit -am "x"'), { project: opaque });
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
			emission('cd "$CLAUDE_JOB_DIR/tmp" && git commit -am "msg"', "test", at)
				?.permissionDecision,
		).toBeUndefined();
		expect(
			emission(
				'cd "$CLAUDE_JOB_DIR/shared" && git commit -am "msg"',
				"test",
				at,
			).permissionDecision,
		).toBe("deny");
	});

	it("judges the tree the hook runs in, a linked worktree exempt", () => {
		expect(
			emission('git commit -am "msg"', "test", { cwd: worktree })
				?.permissionDecision,
		).toBeUndefined();
	});
});

describe("each production adapter, crossed for real", () => {
	it("reads a live neighbour's claim out of the arbiter store (mantahostels#1539)", () => {
		fs.mkdirSync(path.join(shared, "docs"), { recursive: true });
		fs.writeFileSync(path.join(shared, "docs/a.md"), "committed\n");
		git(shared, "add", "-A");
		git(shared, "commit", "-qm", "seed");
		fs.writeFileSync(path.join(shared, "docs/a.md"), "alice's unsaved edit\n");
		neighbour("docs/a.md", "Wayfinder 1584");
		const out = emission('git commit -m "x" -- docs/a.md').additionalContext;
		expect(out).toContain("This commit names docs/a.md");
		expect(out).toContain("(Wayfinder 1584)");
		expect(out).toContain("Swept: docs/a.md (Wayfinder 1584)");
	});

	it("reads this session's write ledger, silencing a commit of its own work", () => {
		stageSomething(shared, "a.md");
		recordWrite("a.md");
		expect(
			emission('git commit -m "msg"')?.additionalContext ?? "",
		).not.toContain("never wrote");
		stageSomething(shared, "b.md");
		expect(
			emission('git commit -m "msg"', "test2").additionalContext,
		).toContain("never wrote");
	});

	it("falls back index-wide on a ledger it cannot read, and records why (mantahostels#135, mantahostels#3278)", () => {
		stageSomething(shared, "a.md");
		recordWrite("a.md"); // would silence it, if the read succeeded
		lockLedger();
		const msg = emission('git commit -m "msg"').additionalContext;
		expect(msg).toContain("a.md");
		expect(msg).toContain("could not be read");
		expect(msg).not.toContain("never wrote");
		expect(failOpenLog()).toMatch(
			/the write ledger could not be read — the write ledger was unread/,
		);
	});

	it("records an index git cannot read, rather than reading it as empty", () => {
		stageSomething();
		fs.writeFileSync(path.join(shared, ".git", "index"), "not an index at all");
		expect(
			emission('git commit -m "x"')?.additionalContext ?? "",
		).not.toContain("takes the whole index");
		expect(failOpenLog()).toMatch(/git could not read the index/);
	});

	it("reads a merge in progress off the git dir", () => {
		git(shared, "checkout", "-q", "-b", "other");
		fs.writeFileSync(path.join(shared, "a.md"), "other\n");
		git(shared, "commit", "-qm", "other", "--", "a.md");
		git(shared, "checkout", "-q", "main");
		fs.writeFileSync(path.join(shared, "a.md"), "main\n");
		git(shared, "commit", "-qm", "main", "--", "a.md");
		expect(() => git(shared, "merge", "other")).toThrow();
		expect(
			emission('git commit -am "merge"')?.permissionDecision,
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

describe("the sweep warn counts as a fire", () => {
	it("the registry needle matches what it prints (mantahostels#3278)", () => {
		fs.mkdirSync(path.join(shared, "docs"), { recursive: true });
		fs.writeFileSync(path.join(shared, "docs/a.md"), "committed\n");
		git(shared, "add", "-A");
		git(shared, "commit", "-qm", "seed");
		fs.writeFileSync(path.join(shared, "docs/a.md"), "alice's unsaved edit\n");
		neighbour("docs/a.md", "Wayfinder 1584");
		const r = guard(payload('git commit -m "x" -- docs/a.md'));
		expect(r.stdout).toContain("swept in under your message");
		// One transcript holding one hook_success attachment: the record Claude
		// Code writes when a PreToolUse hook speaks, carrying this run's own
		// stdout under the command line the guard is registered with.
		const [command] = readHookLines(HOOKS, "guard-dispatch.js");
		const corpus = fs.mkdtempSync(path.join(dir, "fires-"));
		fs.writeFileSync(
			path.join(corpus, "s1.jsonl"),
			`${JSON.stringify({
				type: "attachment",
				uuid: "a1",
				timestamp: "2026-09-07T09:00:00.000Z",
				attachment: {
					type: "hook_success",
					toolUseID: "toolu_01",
					command,
					stdout: r.stdout,
				},
			})}\n`,
		);
		/* The counter reads the HOST'S registrations for the hook roster (#1,
		 * lib/core-hooks.js `readHostHookSources`), so it is this repo the
		 * counter must read, not the git fixture, which has none. */
		const counted = runInProcess(
			path.resolve(__dirname, "count-guard-fires.js"),
			["--dir", corpus],
			{
				env: {
					...process.env,
					CLAUDE_PROJECT_DIR: path.resolve(__dirname, ".."),
				},
			},
		);
		expect(counted.status).toBe(0);
		expect(counted.stdout).toContain(
			"sweep-warn 1 across 1 session(s) (2026-09-07)",
		);
	});
});

describe("a hung git under the arbiter store (#2891)", () => {
	const { HOOK_GIT_TIMEOUT_MS } = createRequire(__filename)("./lib/git.js") as {
		HOOK_GIT_TIMEOUT_MS: number;
	};

	it(
		"fails the sweep check open on a hung blob read, overrunning once, the log naming it",
		() => {
			/* Three neighbour claims whose pins the tree still holds: unlatched,
			 * each would pay its own ceiling, 9 s in all. */
			const claimed = ["a.md", "b.md", "c.md"];
			fs.mkdirSync(path.join(shared, "docs"), { recursive: true });
			for (const f of claimed)
				fs.writeFileSync(path.join(shared, "docs", f), "committed\n");
			git(shared, "add", "-A");
			git(shared, "commit", "-qm", "seed");
			for (const f of claimed) {
				fs.writeFileSync(path.join(shared, "docs", f), "alice's edit\n");
				neighbour(`docs/${f}`, "Wayfinder 1584");
			}
			/* Only the store's HEAD-blob read hangs, each hang tallied; the
			 * guard's own git answers. It crosses the real timeout, as only a
			 * real process can be killed past it; the sleep outlives it. */
			const hung = writeFaultyGit(
				{ argPrefix: "HEAD:" },
				{ sleep: 30 },
				{ under: dir },
			);
			const out = emission(
				'git commit -m "x" -- docs/a.md docs/b.md docs/c.md',
				"test",
				{ env: { WFC_GIT: hung.git } },
			);
			expect(hung.hits()).toBe(1);
			expect(JSON.stringify(out)).not.toContain("swept in under your message");
			expect(failOpenLog()).toContain(
				`a git read in the arbiter store overran ${HOOK_GIT_TIMEOUT_MS} ms — the mantahostels#1539 sweep check was skipped for this pathspec commit`,
			);
		},
		// One ceiling overrun, two more for the guard's real work.
		3 * HOOK_GIT_TIMEOUT_MS,
	);
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
