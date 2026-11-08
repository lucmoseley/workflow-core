// @vitest-environment node
/*
 * lib/commit-form.js, the guard-commit-form core (#2793), in process: which
 * commit forms skip the hooks, rewrite pushed history, carry a closing keyword
 * or leave a new file behind, denied or warned on under mantahostels#109's
 * split, and which are handed the commit rules instead. Every allow case below
 * is a shape that would otherwise be a false positive; do not thin them out.
 *
 * Each case calls `decide` on a context built from the production adapters —
 * kit-context.js's kitContext, with commit-form-host.js's buildHostPorts over
 * it — against a throwaway repo, a linked worktree of it, and an unrelated
 * repo. Real git and the real rule store. The log is collected, so a
 * fail-open is asserted on what it records.
 *
 * OVER §X8 (5)'S 10 S BUDGET (#2893): about 1,400 real git calls, most of
 * them the arranging done by the cases that write. Spec #2733 keeps git real
 * rather than faked.
 *
 * A case that only reads judges one view shared by the file: the template
 * with the paths the scope cases name committed into it and `origin/main` on
 * that commit, every file and directory then made read-only. A case that writes calls `writes()` before
 * its first write, or sits in a describe whose every case writes and runs it
 * `beforeEach`, and gets a fresh copy of the template. The opt-in is per case
 * because most describes pair a reading case with a writing one. The lock
 * fails the test's own write on the view; a write the core makes and
 * swallows (an error log, a latch) fails silently there instead.
 *
 * A deny's text is the decision's `deny`, a warn's the `prelude` it carries
 * with no rules, and a rules hand-over is the ids it names less the ids it
 * skips. Rendering them — the envelope, the once-a-session latch and the
 * emission ceiling — is the kit's, crossed in guard-commit-form.test.ts with
 * the rest of the program's boundary.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	defineTemplate,
	mkDirOutsideRepo,
	mkScratchDir,
	scratchBase,
	trioTemplate,
} from "./git-fixture";
import { armingPattern } from "./precommit-gate-harness";
import { buildBashPayload } from "./pretool-guard-testkit";

type Decision =
	| { deny: string }
	| { injectRules: string[]; skip?: string[]; prelude?: string }
	| null;

const req = createRequire(__filename);
const { decide } = req("./commit-form.js") as {
	decide: (command: string, ctx: object) => Decision;
};
const { buildHostPorts } = req("./commit-form-host.js") as {
	buildHostPorts: (root: string) => object;
};
const { kitContext, sharedReaders } = req("./kit-context.js") as {
	kitContext: (
		env: {
			root: string;
			payload: Record<string, unknown>;
			log: (what: string, detail?: string) => void;
		},
		readers: object,
	) => object;
	sharedReaders: (
		root: string,
		log: (what: string, detail?: string) => void,
	) => object;
};
const { hostRoot } = req("./host-root.js") as {
	hostRoot: (cwd: string) => string;
};
const { MODULES } = req("./workflow-core-config.js") as { MODULES: string[] };
const { readRuleText } = req("./rule-text.js") as {
	readRuleText: (id: string) => string;
};

let dir: string;
let shared: string;
let worktree: string;
let elsewhere: string;
/** The store's root, pointed at the temp dir. */
let config: string;
/** What the core logged this case, one line a record. */
let logs: string[];

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" });

/*
 * THE FIXTURE IS BUILT ONCE AND COPIED (mantahostels#2016), not rebuilt per
 * test, via lib/git-fixture.ts (mantahostels#2068) — its own header explains
 * what a naive copy breaks and why.
 */
const template = defineTemplate(trioTemplate());

type Verdict = "deny" | "warn" | "allow";

/**
 * The core's decision on `command`, run from `cwd` as `session`, with `env`
 * laid over the process's for the call. A null session leaves the payload's
 * `session_id` off.
 */
const judge = (
	command: string,
	cwd = shared,
	session: string | null = "test",
	env: Record<string, string> = {},
): Decision => {
	const saved = Object.keys(env).map((k) => [k, process.env[k]] as const);
	for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
	try {
		const root = hostRoot(cwd);
		const payload = buildBashPayload(command, session);
		const log = (what: string, detail?: string) => {
			logs.push(detail ? `${what}\t${detail}` : what);
		};
		return decide(command, {
			...kitContext({ root, payload, log }, sharedReaders(root, log)),
			/* The hook's own directory, which kitContext reads off the process. */
			fallbackCwd: cwd,
			...buildHostPorts(root),
		});
	} finally {
		for (const [k, v] of saved) vi.stubEnv(k, v);
	}
};

/** What the session reads: a deny's refusal or a warn's text; "" otherwise. */
const said = (d: Decision) => {
	if (d === null) return "";
	return "deny" in d ? d.deny : (d.prelude ?? "");
};

/** The core's text on `command`, as `run`'s callers read the session's. */
const run = (
	command: string,
	cwd = shared,
	session: string | null = "test",
	env: Record<string, string> = {},
) => said(judge(command, cwd, session, env));

/** A warn is a prelude handed with no rules; a rules hand-over is an allow. */
const verdictOf = (d: Decision): Verdict => {
	if (d === null) return "allow";
	if ("deny" in d) return "deny";
	return d.prelude && d.injectRules.length === 0 ? "warn" : "allow";
};

const verdict = (
	command: string,
	cwd = shared,
	env: Record<string, string> = {},
): Verdict => verdictOf(judge(command, cwd, "test", env));

/** The refusal `command` earns. Throws on anything but a deny. */
const readDenyReason = (
	command: string,
	cwd = shared,
	env: Record<string, string> = {},
) => {
	const d = judge(command, cwd, "test", env);
	if (d === null || !("deny" in d))
		throw new Error(`expected a deny for: ${command}`);
	return d.deny;
};

/** The rule ids a decision hands over, in its priority order: none on a deny. */
const handed = (d: Decision) => {
	if (d === null || "deny" in d) return [];
	const skip = new Set(d.skip ?? []);
	return d.injectRules.filter((id) => !skip.has(id));
};

/** The handed rules' fragments as guard-entry joins them, below the ceiling. */
const handedText = (d: Decision) =>
	handed(d)
		.map((id) => readRuleText(id))
		.join("\n\n");

/** The handed rules on one line, so a clause survives a re-wrap of its text. */
const handedProse = (d: Decision) => handedText(d).replace(/\s+/g, " ");

/** Everything the core logged this case. */
const logged = () => logs.join("\n");

/* The framing line of the `--amend` refusal (#4384). */
const AMEND = "This amend rewrites a commit already pushed";

/* The framing line of the closing-keyword refusal (#129). */
const CLOSES = "This commit message closes an issue server-side";

/* The framing line of the `--no-verify` refusal (mantahostels#975). */
const NO_VERIFY =
	"This flag skips none of the pre-commit gates on a plain commit or merge";

/** Points `ref` (the pushed ref, `origin/main` unless `landing` is on) at `at`'s HEAD. */
const pushHead = (at = shared, ref = "origin/main") =>
	git(at, "update-ref", `refs/remotes/${ref}`, "HEAD");

/** Points the case's paths, and the store's and host root's env, at `root`. */
const useFixture = (root: string) => {
	dir = root;
	config = path.join(root, "config");
	shared = path.join(root, "shared");
	worktree = path.join(root, "wt");
	elsewhere = path.join(root, "elsewhere");
	/* The store, the host root and the rule store read these at call time, so the
	 * arrangement, the core and the fragments all see the same sandbox. */
	vi.stubEnv("CLAUDE_CONFIG_DIR", config);
	vi.stubEnv("CLAUDE_PROJECT_DIR", shared);
};

/** Sets the mode of every directory under `root`, and of every file where given. */
const chmodTree = (root: string, dirMode: number, fileMode?: number) => {
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		const full = path.join(root, entry.name);
		if (entry.isDirectory()) chmodTree(full, dirMode, fileMode);
		else if (entry.isFile() && fileMode !== undefined)
			fs.chmodSync(full, fileMode);
	}
	fs.chmodSync(root, dirMode);
};

let view: string;
/** This case's own copy, once `writes()` has made one. */
let copy: string | null;
let owned: string[];

const SEEDED = [
	"GLOSSARY.md",
	"app/x.ts",
	"app/y.ts",
	"docs/roadmap-digest.md",
	"docs/x.md",
	"scripts/x.sh",
	"scripts/y.sh",
];

/* A view's name carries its worker's pid, so a run killed before afterAll
 * leaves a view the next run can tell is dead and unlock: scratch-sweep.js
 * cannot delete inside a read-only directory. */
const VIEW_PREFIX = "commit-form-view-";

const reclaimDeadViews = () => {
	const base = scratchBase();
	for (const name of fs.readdirSync(base)) {
		const pid = Number(name.slice(VIEW_PREFIX.length).split("-")[0]);
		if (!name.startsWith(VIEW_PREFIX) || !Number.isInteger(pid)) continue;
		try {
			process.kill(pid, 0);
			continue;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ESRCH") continue;
		}
		chmodTree(path.join(base, name), 0o755);
		fs.rmSync(path.join(base, name), { recursive: true, force: true });
	}
};

beforeAll(() => {
	reclaimDeadViews();
	view = mkScratchDir(`${VIEW_PREFIX}${process.pid}-`);
	template.instantiate(view);
	const seeded = path.join(view, "shared");
	for (const rel of SEEDED) {
		fs.mkdirSync(path.dirname(path.join(seeded, rel)), { recursive: true });
		fs.writeFileSync(path.join(seeded, rel), "x\n");
	}
	git(seeded, "add", ...SEEDED);
	git(seeded, "commit", "-qm", "seed");
	pushHead(seeded);
	chmodTree(view, 0o555, 0o444);
	// Root ignores the mode bits, and a write would then reach the next case.
	expect(() => fs.writeFileSync(path.join(seeded, "probe"), "")).toThrow(
		/EACCES/,
	);
});

beforeEach(() => {
	logs = [];
	copy = null;
	owned = [];
	useFixture(view);
});

afterEach(() => {
	for (const d of owned) fs.rmSync(d, { recursive: true, force: true });
});

afterAll(() => {
	chmodTree(view, 0o755);
	fs.rmSync(view, { recursive: true, force: true });
});

/** A writable directory of this case's own, outside every fixture. */
const scratch = () => {
	const d = mkScratchDir("commit-form-");
	owned.push(d);
	return d;
};

const writes = () => {
	if (copy !== null) throw new Error("writes() already ran in this case");
	copy = scratch();
	template.instantiate(copy);
	useFixture(copy);
};

/*
 * mantahostels#975. `--no-verify` stands down every pre-commit hook at once. It
 * is a DENY: it has no legitimate use (mantahostels#109).
 */
describe("--no-verify is denied — it silently disables the secrets scan", () => {
	it("takes its no-override line from the rule store (#4129)", () => {
		const rules = fs.mkdtempSync(path.join(os.tmpdir(), "commit-form-rules-"));
		fs.writeFileSync(path.join(rules, "self-spelt-escape.txt"), "ESCAPE.\n");
		try {
			expect(
				run('git commit --no-verify -m "msg" -- a.md', shared, "test", {
					WFC_RULES_DIR: rules,
				}),
			).toContain("There is no override, deliberately — ESCAPE. The git-hook");
		} finally {
			fs.rmSync(rules, { recursive: true, force: true });
		}
	});

	it.each([
		['git commit --no-verify -m "msg" -- a.md', "the full spelling"],
		[
			'git commit -n -m "msg" -- a.md',
			"the short form git reads as --no-verify",
		],
		['git commit --no-verif -m "msg" -- a.md', "an unambiguous abbreviation"],
		['git commit --no-veri -m "msg" -- a.md', "the shortest unambiguous one"],
		['git commit -nm "msg" -- a.md', "bundled ahead of the message flag"],
		['git commit -vn -m "msg" -- a.md', "bundled behind another short flag"],
		['npm run check && git commit -n -m "msg" -- a.md', "later in a chain"],
		['git commit --no-verify --amend -m "msg" -- a.md', "amending"],
		// Behind a reserved word (#1013).
		['{ git commit --no-verify -m "msg" -- a.md; }', "in a brace group"],
		['! git commit --no-verify -m "msg" -- a.md', "negated"],
		['if true; then git commit --no-verify -m "msg" -- a.md; fi', "in an if"],
		[
			'for f in a.md; do git commit --no-verify -m "msg" -- $f; done',
			"in a for loop",
		],
		[
			'while true; do git commit --no-verify -m "msg" -- a.md; done',
			"in a while loop",
		],
	])("%s — %s", (command) => {
		// exempt (mantahostels#2145): every `--no-verify` route shares one refusal, pinned by
		// "says what the flag skips, and offers no override" below.
		expect(verdict(command)).toBe("deny");
	});

	it("says what the flag skips, and offers no override", () => {
		const msg = readDenyReason('git commit --no-verify -m "msg" -- a.md');
		expect(msg).toContain("secrets scan");
		// The git-hook escape is named as the founder's, never handed over as a
		// command (#916).
		expect(msg).toContain("are the founder's to set, never yours");
		expect(msg).not.toContain("WFC_ALLOW_BRANCH=1");
	});

	it("does not leak the quote-masking sentinel into the message", () => {
		expect(run('git commit -n -m "Re-derive the figures"')).not.toContain(
			"QSTR",
		);
	});

	it.each([
		["git add -n .", "add's -n is --dry-run"],
		["git add -vN new.md", "and -N there is intent-to-add"],
	])("%s — %s, so it is allowed", (command) => {
		expect(verdict(command)).toBe("allow");
	});

	it.each([
		[
			'git commit --no-ver -m "msg" -- a.md',
			"ambiguous with --no-verbose, so git rejects it and nothing commits",
		],
		[
			'git commit -m "msg" -- --no-verify',
			"a path named that, past the -- separator",
		],
		[
			'git commit -m "never --no-verify" -- a.md',
			"the flag named inside the commit message",
		],
		['echo "git commit --no-verify"', "text that merely mentions it"],
		['{ git commit -m "msg" -- a.md; }', "a plain commit in a brace group"],
		[
			'if true; then git commit -m "msg" -- a.md; fi',
			"a plain commit in an if",
		],
	])("%s — %s", (command) => {
		expect(verdict(command)).toBe("allow");
	});

	it("is denied mid-merge too — a merge never needs the hooks skipped", () => {
		writes();
		git(shared, "checkout", "-q", "-b", "other");
		fs.writeFileSync(path.join(shared, "a.md"), "other\n");
		git(shared, "commit", "-qm", "other", "--", "a.md");
		git(shared, "checkout", "-q", "main");
		fs.writeFileSync(path.join(shared, "a.md"), "main\n");
		git(shared, "commit", "-qm", "main", "--", "a.md");
		expect(() => git(shared, "merge", "other")).toThrow();
		expect(verdict("git commit --no-verify")).toBe("deny");
	});

	it("does not read --no-edit as --no-verify", () => {
		// Denied, but for the AMEND reason — which is what proves it.
		const reason = readDenyReason(
			'git commit --no-edit --amend -m "msg" -- a.md',
		);
		expect(reason).toContain(AMEND);
		expect(reason).not.toContain("--no-verify");
	});

	it("is denied in a linked worktree too (mantahostels#1213)", () => {
		// It protects the secrets scan and the rest of the pre-commit gates,
		// which a worktree runs too.
		expect(verdict('git commit --no-verify -m "msg"', worktree)).toBe("deny");
		expect(verdict('git commit -n -m "msg"', worktree)).toBe("deny");
		expect(
			verdict(`git -C ${worktree} commit --no-verify -m "m"`, shared),
		).toBe("deny");
	});

	it("is denied mid-merge in a worktree too — both stand-downs at once", () => {
		writes();
		// The combination mantahostels#1213 made reachable.
		git(worktree, "checkout", "-q", "-b", "wt-other");
		fs.writeFileSync(path.join(worktree, "a.md"), "other\n");
		git(worktree, "commit", "-qm", "other", "--", "a.md");
		git(worktree, "checkout", "-q", "side");
		fs.writeFileSync(path.join(worktree, "a.md"), "side\n");
		git(worktree, "commit", "-qm", "side", "--", "a.md");
		expect(() => git(worktree, "merge", "wt-other")).toThrow();
		expect(verdict("git commit --no-verify", worktree)).toBe("deny");
	});

	it("is still allowed in an unrelated repository", () => {
		// Widening the walk went as far as this repo, and no further.
		expect(verdict('git commit --no-verify -m "msg"', elsewhere)).toBe("allow");
		expect(verdict(`git -C ${elsewhere} commit --no-verify -m "m"`)).toBe(
			"allow",
		);
	});
});

/*
 * #4384. `git commit --amend` on a commit already pushed forks from it: the
 * next push is a non-fast-forward, and landing again merges the commit and its
 * rewrite both. It binds in every working tree of this repo and stands down
 * mid-sequence, where HEAD is the replay's own commit. The view's HEAD, and
 * the worktree's behind it, are on `origin/main`.
 */
describe("`git commit --amend` is denied where HEAD is already pushed (#4384)", () => {
	it.each([
		['git commit --amend -m "msg"', "the full spelling"],
		["git commit --amend --no-edit", "the common no-edit form"],
		["git commit --amend", "no other flag at all"],
		['git commit --amend -m "msg" -- a.md', "with a pathspec"],
		["git commit --am --no-edit", "--am, the shortest unambiguous prefix"],
		["git commit --ame --no-edit", "--ame"],
		["git commit --amen --no-edit", "--amen"],
		['git commit -v --amend -m "msg"', "behind an unrelated flag"],
	])("%s — %s", (command) => {
		// exempt (mantahostels#2145): every route shares one refusal, pinned by "the
		// refusal names the pushed ref and the follow-up commit" below.
		expect(verdict(command)).toBe("deny");
	});

	it("the refusal names the pushed ref and the follow-up commit", () => {
		const reason = readDenyReason("git commit --amend --no-edit");
		expect(reason).toContain(`${AMEND}, as \`HEAD\` is on \`origin/main\``);
		expect(reason).toContain("non-fast-forward");
		expect(reason).toContain('git commit -m "…" -- <paths>');
	});

	it("allows an amend after an earlier commit in the same command and tree, whose new commit it amends", () => {
		expect(
			verdict(
				'git commit -m "one" -- docs/x.md && git commit --amend --no-edit',
			),
		).toBe("allow");
		expect(
			verdict(
				`git -C ${worktree} commit -m "one" -- a.md && git -C ${worktree} commit --amend --no-edit`,
			),
		).toBe("allow");
	});

	it("still denies an amend after an earlier commit in a different tree", () => {
		expect(
			readDenyReason(
				`git -C ${worktree} commit -m "one" -- a.md && git commit --amend --no-edit`,
			),
		).toContain(`${AMEND}, as \`HEAD\` is on \`origin/main\``);
	});

	it("still denies an amend whose earlier commit was itself refused", () => {
		expect(
			readDenyReason(
				'git commit -n -m "one" -- docs/x.md && git commit --amend --no-edit',
			),
		).toContain(NO_VERIFY);
	});

	it("judges a branch with an upstream against that upstream", () => {
		writes();
		git(shared, "checkout", "-q", "-b", "spike/x");
		fs.writeFileSync(path.join(shared, "a.md"), "spike\n");
		git(shared, "commit", "-qm", "spike", "--", "a.md");
		pushHead(shared, "origin/spike/x");
		git(shared, "config", "remote.origin.url", shared);
		git(
			shared,
			"config",
			"remote.origin.fetch",
			"+refs/heads/*:refs/remotes/origin/*",
		);
		git(shared, "branch", "-q", "--set-upstream-to=origin/spike/x");
		expect(readDenyReason("git commit --amend --no-edit")).toContain(
			`${AMEND}, as \`HEAD\` is on \`origin/spike/x\``,
		);
	});

	it("is denied where HEAD is strictly behind the pushed ref", () => {
		writes();
		fs.writeFileSync(path.join(shared, "a.md"), "pushed\n");
		git(shared, "commit", "-qm", "pushed", "--", "a.md");
		pushHead();
		git(shared, "reset", "-q", "--hard", "HEAD~1");
		expect(readDenyReason("git commit --amend --no-edit")).toContain(
			`${AMEND}, as \`HEAD\` is on \`origin/main\``,
		);
	});

	it("is denied in a linked worktree too, whose HEAD is pushed", () => {
		expect(readDenyReason("git commit --amend --no-edit", worktree)).toContain(
			AMEND,
		);
		expect(
			readDenyReason(`git -C ${worktree} commit --amend --no-edit`, shared),
		).toContain(AMEND);
	});

	it("reads a session worktree's own queue ref where the `landing` module is on (#4458)", () => {
		writes();
		const session = path.join(shared, ".claude", "worktrees", "q");
		git(shared, "worktree", "add", "-q", "--detach", session);
		fs.writeFileSync(path.join(session, "a.md"), "queued\n");
		git(session, "commit", "-qm", "queued", "--", "a.md");
		pushHead(session, "origin/queue/q");
		const env = { WFC_MODULES: "landing" };
		expect(
			readDenyReason("git commit --amend --no-edit", session, env),
		).toContain("as `HEAD` is on `origin/queue/q`");
	});

	it("allows an amend of a commit not yet pushed", () => {
		writes();
		pushHead();
		fs.writeFileSync(path.join(shared, "a.md"), "unpushed\n");
		git(shared, "commit", "-qm", "unpushed", "--", "a.md");
		expect(verdict("git commit --amend --no-edit")).toBe("allow");
		expect(logged()).toBe("");
	});

	it("allows, and records, an amend where git cannot say whether HEAD is pushed", () => {
		writes();
		// No origin/main in this copy, so the ancestry check errors.
		expect(verdict("git commit --amend --no-edit")).toBe("allow");
		expect(logged()).toMatch(
			/git could not say whether HEAD in .* is pushed — the amend allowed unchecked/,
		);
	});

	it("stands down mid-merge, where the commit being amended is the replay's", () => {
		writes();
		git(shared, "checkout", "-q", "-b", "other");
		fs.writeFileSync(path.join(shared, "a.md"), "other\n");
		git(shared, "commit", "-qm", "other", "--", "a.md");
		git(shared, "checkout", "-q", "main");
		fs.writeFileSync(path.join(shared, "a.md"), "main\n");
		git(shared, "commit", "-qm", "main", "--", "a.md");
		pushHead();
		expect(() => git(shared, "merge", "other")).toThrow();
		expect(verdict("git commit --amend --no-edit")).toBe("allow");
	});

	it("is still allowed in an unrelated repository", () => {
		expect(verdict("git commit --amend --no-edit", elsewhere)).toBe("allow");
	});

	it.each([
		['git commit -m "msg" -- a.md', "an ordinary pathspec commit"],
		[
			'git commit --allow-empty -m "msg" -- a.md',
			"--allow-empty, which shares only the first two letters",
		],
		['git commit --author "a <a@b.c>" -m "m" -- a.md', "--author"],
		['git commit -m "amend the figures" -- a.md', "the word inside a message"],
	])("allows %s — %s", (command) => {
		expect(verdict(command)).not.toBe("deny");
	});
});

/*
 * mantahostels#1539. `git commit -a`/`-am`/`--all` commits every dirty TRACKED
 * file, and a session's subagents share its worktree, so it takes a
 * subagent's unfinished edit under the session's message. It is a DENY in
 * every tree of this repo, stood down mid-sequence.
 */
describe("`git commit -a` is denied — it sweeps in every dirty tracked file", () => {
	const Sweeps = "This commit form sweeps in every dirty tracked file";

	it.each([
		['git commit -a -m "msg"', "-a"],
		['git commit -am "msg"', "-am, bundled with the message"],
		['git commit --all -m "msg"', "--all"],
		['git commit -v -a -m "msg"', "behind an unrelated flag"],
		[
			'git commit -m "one" -- docs/x.md && git commit -am "two"',
			"later in a chain",
		],
	])("%s — %s", (command) => {
		expect(readDenyReason(command)).toContain(Sweeps);
	});

	it("says to commit by pathspec instead", () => {
		const reason = readDenyReason('git commit -am "msg"');
		expect(reason).toContain(`${Sweeps}: git commit -am "…"`);
		expect(reason).toContain('git commit -m "…" -- <paths>');
	});

	it("is denied in a linked worktree too", () => {
		expect(readDenyReason('git commit -am "msg"', worktree)).toContain(Sweeps);
		expect(
			readDenyReason(`git -C ${worktree} commit --all -m "msg"`, shared),
		).toContain(Sweeps);
	});

	it("stands down mid-sequence", () => {
		writes();
		fs.mkdirSync(path.join(shared, ".git", "rebase-merge"), {
			recursive: true,
		});
		expect(verdict('git commit -am "msg"')).not.toBe("deny");
	});

	it("leaves -i/--include alone, which commits only what it names", () => {
		expect(verdict('git commit -i -m "msg" -- docs/x.md')).toBe("allow");
		expect(verdict('git commit --include -m "msg" -- docs/x.md')).toBe("allow");
	});

	it("is outranked by the --no-verify deny", () => {
		const reason = readDenyReason('git commit --no-verify -a -m "msg"');
		expect(reason).toContain(NO_VERIFY);
		expect(reason).not.toContain(Sweeps);
	});

	it("is outranked by the closing-keyword deny", () => {
		const reason = readDenyReason('git commit -am "Fixes #12"');
		expect(reason).toContain(CLOSES);
		expect(reason).not.toContain(Sweeps);
	});

	it("outranks the amend deny", () => {
		expect(readDenyReason("git commit -a --amend --no-edit")).toContain(Sweeps);
	});

	it("is still allowed in an unrelated repository", () => {
		expect(verdict('git commit -am "msg"', elsewhere)).toBe("allow");
	});
});

/*
 * mantahostels#1705 widened the same deny onto `git merge`, the second route that spells a
 * flag turning the gates off: `--no-verify` there skips `.husky/pre-merge-commit`,
 * which runs the whole of `.husky/pre-commit` over the merge's own content.
 * Nothing else about a merge is judged — it stages nothing.
 */
describe("`git merge --no-verify` is denied on the same reasoning (mantahostels#1705)", () => {
	it.each([
		['git merge other -m "msg"', "no flag at all"],
		["git merge --squash other", "a merge with an unrelated flag"],
		["git merge --abort", "clearing a refused merge"],
		["git merge --continue", "finishing a conflicted one"],
		[
			"git merge -n other",
			"-n, which under `git merge` is --no-stat and skips no gate",
		],
		["git merge --no-stat other", "the same flag spelled in full"],
		["git merge --no-commit other", "a different --no- flag"],
		[
			'git merge -m "never --no-verify" other',
			"the flag named inside the merge message",
		],
		[
			"git merge -m --no-verify other",
			"the flag taken as -m's value, which is what gitValueFlags is for",
		],
		["git merge --log other", "an optional-argument flag on its own"],
		["git merge -X ours other", "a strategy option carrying a real value"],
		['echo "git merge --no-verify"', "text that merely mentions it"],
	])("%s — %s, so it is allowed", (command) => {
		expect(verdict(command)).toBe("allow");
	});

	it.each([
		["git merge --no-verify other", "the full spelling"],
		['git merge --no-verify -m "msg" other', "carrying a message"],
		["git fetch && git merge --no-verify other", "later in a chain"],
	])("%s — %s", (command) => {
		// exempt (mantahostels#2145): reason pinned by "names the merge hook the flag skips".
		expect(verdict(command)).toBe("deny");
	});

	it.each([
		["git merge --log --no-verify other", "--log, whose argument is optional"],
		["git merge -S --no-verify other", "-S, likewise"],
		["git merge --gpg-sign --no-verify other", "the same flag spelled in full"],
		["git merge -Skey --no-verify other", "-S with its key stuck on"],
	])("%s — %s, still denied", (command) => {
		/*
		 * Each value is optional and taken only stuck on, so git reads the
		 * --no-verify after it as the flag and runs `git merge --log --no-verify
		 * side` with the hooks off (measured on git 2.43.0, #302).
		 */
		expect(verdict(command)).toBe("deny");
	});

	it.each([
		["git merge -X --no-verify other", "a strategy option"],
		["git merge -s --no-verify other", "a strategy name"],
		["git merge --into-name --no-verify other", "the merged-into name"],
		["git merge --cleanup --no-verify other", "a cleanup mode"],
	])("%s — %s swallows --no-verify, so it is allowed", (command) => {
		// Measured at #302: git takes --no-verify as the value, and the hooks run.
		expect(verdict(command)).toBe("allow");
	});

	it("names the merge hook the flag skips", () => {
		const msg = readDenyReason("git merge --no-verify other");
		expect(msg).toContain("secrets scan");
		expect(msg).toContain("pre-merge-commit");
	});

	it("is denied in a linked worktree too, as the commit spelling is", () => {
		// Same reasoning as mantahostels#1213's: the gates it stands down are ones a worktree
		// runs (mantahostels#344), so the shared-tree scoping does not reach this verdict.
		expect(verdict("git merge --no-verify other", worktree)).toBe("deny");
	});

	it("is still allowed in an unrelated repository", () => {
		expect(verdict("git merge --no-verify other", elsewhere)).toBe("allow");
	});
});

/*
 * mantahostels#1706 widens the same deny onto the three replay routes. `--no-verify` there
 * skips `.husky/pre-commit` on the resolution commit that finishes a rebase,
 * cherry-pick or revert — the commit carrying bytes no parent ever held.
 */
describe("`--no-verify` is denied on rebase, cherry-pick and revert (mantahostels#1706)", () => {
	it.each([
		["git rebase main", "no flag at all"],
		["git rebase --continue", "finishing a conflicted rebase"],
		["git rebase --abort", "clearing a refused one"],
		["git cherry-pick abc123", "a plain cherry-pick"],
		["git cherry-pick --abort", "clearing a refused one"],
		["git revert --no-edit HEAD", "a plain revert"],
		[
			"git rebase -n main",
			"-n, which under `git rebase` is --no-stat and skips no gate",
		],
		[
			"git cherry-pick -n abc123",
			"-n, which here is --no-commit — the replay is finished by a gated commit",
		],
		["git revert -n HEAD", "the same flag under revert"],
		["git cherry-pick --no-commit abc123", "that flag spelled in full"],
		["git rebase --no-stat main", "a different --no- flag"],
		["git cherry-pick -m 1 abc123", "the mainline number, which -m takes here"],
		[
			"git cherry-pick -m --no-verify abc123",
			"the flag swallowed as -m's mainline value",
		],
		["git rebase --onto main side", "--onto, which takes a real value"],
		["git rebase -x --no-verify main", "the flag swallowed as -x's command"],
		["git rebase -C --no-verify main", "the same, as -C's context count"],
		['echo "git rebase --no-verify"', "text that merely mentions it"],
	])("%s — %s, so it is allowed", (command) => {
		expect(verdict(command)).toBe("allow");
	});

	it.each([
		["git rebase --no-verify main", "rebase, the full spelling"],
		["git rebase --no-veri main", "rebase's shortest unambiguous prefix"],
		["git cherry-pick --no-verify abc123", "cherry-pick, the full spelling"],
		["git revert --no-verify HEAD", "revert, the full spelling"],
		["git fetch && git rebase --no-verify main", "later in a chain"],
	])("%s — %s", (command) => {
		// `--no-veri` is rebase's floor, measured on git 2.43.0 at mantahostels#1706.
		// exempt (mantahostels#2145): one `--no-verify` refusal for all five routes, pinned by
		// "names pre-applypatch in the deny, so the reader knows what was skipped".
		expect(verdict(command)).toBe("deny");
	});

	it("denies a cherry-pick/revert flag today's git does not have", () => {
		/*
		 * Measured on git 2.43.0 at mantahostels#1706, and RE-measure it with a resolvable
		 * revision: given a ref git cannot resolve, git dies on the revision
		 * before it reports the flag.
		 *
		 * So this arm guards nothing today and is kept anyway. Only the full
		 * spelling — there is no abbreviation floor to honour on a flag that does
		 * not exist.
		 */
		expect(verdict("git cherry-pick --no-verify abc123")).toBe("deny");
		expect(verdict("git cherry-pick --no-v abc123")).toBe("allow");
		expect(verdict("git revert --no-ver HEAD")).toBe("allow");
	});

	it.each([
		[
			"git rebase -S --no-verify main",
			"a signing flag with no value of its own",
		],
		["git rebase -m --no-verify main", "-m, which under rebase is --merge"],
		[
			"git cherry-pick -x --no-verify abc123",
			"a boolean flag under cherry-pick",
		],
	])("%s — %s, still denied", (command) => {
		// Unlisted value-taking flags err toward the deny (mantahostels#1705).
		expect(verdict(command)).toBe("deny");
	});

	it("is denied in a linked worktree too, as the other spellings are", () => {
		expect(verdict("git rebase --no-verify main", worktree)).toBe("deny");
	});

	it("is still allowed in an unrelated repository", () => {
		expect(verdict("git cherry-pick --no-verify abc123", elsewhere)).toBe(
			"allow",
		);
	});
});

/*
 * mantahostels#1707 finishes the widening on `git am`, the last route in mantahostels#1687's table.
 * `--no-verify` there skips `.husky/pre-applypatch`, the ONLY hook `git am`
 * offers — no `pre-commit`, no `prepare-commit-msg`, no `commit-msg`.
 *
 * `git am` is also the one subcommand of the five where `-n` must NOT be read
 * as `--no-verify`: it is `--no-scissors`, which changes how the patch's
 * message is cut and skips no hook at all.
 */
describe("`--no-verify` is denied on `git am` (mantahostels#1707)", () => {
	it.each([
		["git am patch.mbox", "no flag at all"],
		["git am --abort", "clearing a refused apply"],
		["git am --skip", "skipping the patch it stopped on"],
		["git am -3 patch.mbox", "the three-way fallback"],
		[
			"git am -n patch.mbox",
			"-n, which under `git am` is --no-scissors and skips no gate",
		],
		["git am --no-scissors patch.mbox", "that flag spelled in full"],
		["git am --no-utf8 patch.mbox", "a different --no- flag"],
		[
			"git am --directory --no-verify patch.mbox",
			"the flag swallowed as --directory's value, exactly as git reads it",
		],
		["git am -p --no-verify patch.mbox", "the same, under -p's strip count"],
		['echo "git am --no-verify"', "text that merely mentions it"],
	])("%s — %s, so it is allowed", (command) => {
		expect(verdict(command)).toBe("allow");
	});

	it.each([
		["git am --no-verify patch.mbox", "the full spelling"],
		["git am --no-v patch.mbox", "am's shortest unambiguous prefix"],
		["git am --no-ver patch.mbox", "a prefix in between"],
		["git am -3 --no-verify patch.mbox", "after a boolean flag"],
		["git fetch && git am --no-verify patch.mbox", "later in a chain"],
	])("%s — %s", (command) => {
		// `--no-v` is am's floor, measured on git 2.43.0 at mantahostels#1707: no other
		// `--no-v…` option exists under `am`, so git resolves it to --no-verify
		// and skips the hook. Every longer prefix resolves the same way.
		// exempt (mantahostels#2145): reason pinned by "names pre-applypatch in the deny, so
		// the reader knows what was skipped" below.
		expect(verdict(command)).toBe("deny");
	});

	it("names pre-applypatch in the deny, so the reader knows what was skipped", () => {
		const reason = readDenyReason("git am --no-verify patch.mbox");
		expect(reason).toContain("pre-applypatch");
		// The one named escape is for a DIFFERENT check and stays the only one.
		expect(reason).toContain("There is no override, deliberately");
	});

	it("is denied in a linked worktree too, as the other spellings are", () => {
		expect(verdict("git am --no-verify patch.mbox", worktree)).toBe("deny");
	});

	it("is still allowed in an unrelated repository", () => {
		expect(verdict("git am --no-verify patch.mbox", elsewhere)).toBe("allow");
	});
});

/*
 * THE PRE-EMPTIVE LIMB (mantahostels#1647, spec mantahostels#1762).
 *
 * The verdicts above fire ON the mistake. This fires ON the command, on
 * the clean branch, and hands the session the rule before it commits wrongly.
 *
 * Expectations are keyed by FRAGMENT ID, never by a string literal copied out
 * of the fragment; the mutation anchors below are the deliberate exception, on
 * the reasoning guard-branch.test.ts states in full.
 */
describe("the rule reaches a session BEFORE it mis-commits (mantahostels#1647)", () => {
	// What a commit naming no gated path is handed, in injection order: the
	// three act rules, then the push rule (#2022, #2285).
	const plainCommitRules = [
		"commit-pathspec",
		"commit-show-diff",
		"commit-message",
		"push-cadence",
	];
	it("a correct pathspec commit is handed the rule and NOT refused", () => {
		const d = judge('git commit -m "x" -- a.md');
		expect(verdictOf(d)).toBe("allow");
		expect(handed(d)).toEqual(plainCommitRules);
		expect(said(d)).toBe("");
	});

	/*
	 * MUTATION ANCHORS. `toEqual(plainCommitRules)` keys on the ids, so it moves
	 * with a mutation to the fragment instead of catching it. One short literal
	 * per clause a session must actually receive, chosen to break if the clause
	 * is deleted and to survive an ordinary reword.
	 */
	it.each([
		["COMMIT BY PATHSPEC", "the operative instruction itself"],
		["git add -N", "the exception for a file git does not track"],
		["#1539", "the working-tree hazard"],
		["NEVER AMEND A PUSHED COMMIT", "the amend deny's rule"],
		["stand down mid-merge", "where the guard stands down"],
		["advisory", "the silence condition: a warn does not stop the commit"],
	])("the injection still carries %s — %s", (clause) => {
		expect(handedProse(judge('git commit -m "x" -- a.md'))).toContain(clause);
	});

	it("a warn outranks it: the warn hands over no rules", () => {
		writes();
		// A warn already carries the specific hazard it found; appending the
		// general rule underneath would bury it.
		fs.writeFileSync(path.join(shared, "new.md"), "new\n");
		const d = judge('git commit -m "x" -- new.md');
		expect(handed(d)).toEqual([]);
		expect(said(d)).toContain("git does not track yet");
		expect(said(d)).not.toContain("COMMIT BY PATHSPEC");
	});

	it("a deny carries its own refusal, not the rule", () => {
		const d = judge('git commit -n -m "x" -- a.md');
		expect(readDenyReason('git commit -n -m "x" -- a.md')).toContain(NO_VERIFY);
		expect(handed(d)).toEqual([]);
	});

	it.each([
		["git merge other", "the merge family stages no pathspec"],
		["git rebase main", "nor does a rebase"],
		["git cherry-pick HEAD", "nor a cherry-pick"],
		["git push origin main", "not an index command at all"],
		["npm run test", "not git at all"],
	])("%s is handed nothing — %s", (command) => {
		expect(judge(command)).toBeNull();
	});

	it("a payload with no session id is still handed the rules to render", () => {
		// Whether they reach the session is the kit's: it cannot latch what it
		// cannot key, so it says nothing (guard-commit-form.test.ts).
		expect(handed(judge('git commit -m "x" -- a.md', shared, null))).toEqual(
			plainCommitRules,
		);
	});

	it.each([
		["SHOW THE DIFF", "the diff limb"],
		["Conventional", "the banned prefix"],
		["AT MOST 72 CHARACTERS", "the subject's cap"],
		["THE BODY GIVES THE WHY", "where the why goes"],
		["Push before the turn's", "the push owed this turn"],
		["why the push is held", "the one alternative to pushing"],
	])("the injection carries %s — %s", (clause) => {
		expect(handedProse(judge('git commit -m "x" -- a.md'))).toContain(clause);
	});

	it.each([
		['node scripts/commit-paths.js -m "x" -- a.md', "the house commit route"],
		[
			'node "$CLAUDE_PROJECT_DIR"/scripts/commit-paths.js -m "x" -- a.md',
			"spelled at the project root",
		],
	])(
		"%s is handed the show-the-diff, message and push rules alone — %s",
		(command) => {
			// It runs no git the walk sees, and already commits by pathspec (#2022).
			expect(handed(judge(command))).toEqual([
				"commit-show-diff",
				"commit-message",
				"push-cadence",
			]);
		},
	);

	it("hands the landing twin of the push rule where `landing` is on (#2285)", () => {
		const d = judge('git commit -m "x" -- a.md', shared, "landing", {
			WFC_MODULES: "landing",
		});
		expect(handed(d)).toContain("push-cadence-landing");
		expect(handed(d)).not.toContain("push-cadence");
	});

	it("hands the plain push rule, not its landing twin, where `landing` is off (#2285)", () => {
		const d = judge('git commit -m "x" -- a.md');
		expect(handed(d)).toContain("push-cadence");
		expect(handed(d)).not.toContain("push-cadence-landing");
	});

	it("a node script that is not commit-paths.js is handed nothing", () => {
		expect(judge("node scripts/other.js -m x -- a.md")).toBeNull();
	});

	it("hands a root .md commit the act and push rules and nothing else", () => {
		// `a.md` is outside the mapped scope, is neither roadmap file, holds no
		// guard-registry region and is not a language Biome parses — so every one
		// of mantahostels#1805's §Gotchas ids is scoped out and this is the whole emission.
		const d = judge('git commit -m "x" -- a.md');
		expect(handed(d)).toEqual(plainCommitRules);
		// The four rules' 2,399 B at #2285 with the core root's spelling dropped,
		// as it varies by checkout, rounded up: a fragment growing past it is a
		// decision about every session's first commit.
		const pathless = handedText(d).replaceAll(
			path.resolve(__dirname, "..", ".."),
			"",
		);
		expect(Buffer.byteLength(pathless, "utf8")).toBeLessThan(2450);
	});
});

/*
 * THE §GOTCHAS CLUSTER ON THIS TRIGGER (mantahostels#1805, spec mantahostels#1762).
 *
 * Six more rules share `git commit`, and which of them a session is handed
 * turns on what the commit ACTUALLY NAMES — the ticket's acceptance criterion,
 * against the blanket per-subcommand request that would spend the
 * emission ceiling on rules that cannot fire.
 *
 * The scoping is expressed as an EXCLUSION (the decision's `skip`) rather than a
 * selection, because scripts/check-guard-registry.js reads the literal ids at
 * the call site: ids assembled into an array would every one report
 * UNPRINTED-RULE and the store's third assertion would stop meaning anything.
 */
const MODULES_ON = { WFC_MODULES: "roadmap,governance" };

describe("the §Gotchas rules are scoped by what the commit names (mantahostels#1805)", () => {
	/** The rule ids `command` is handed, sorted. */
	const idsIn = (command: string, env: Record<string, string> = MODULES_ON) =>
		handed(judge(command, shared, "test", env)).sort();

	/* A file the view does not carry, committed so the pathspec resolves
	 * against something real. */
	const withPaths = (...paths: string[]) => {
		for (const rel of paths) {
			fs.mkdirSync(path.dirname(path.join(shared, rel)), { recursive: true });
			fs.writeFileSync(path.join(shared, rel), "x\n");
		}
		git(shared, "add", ...paths);
		git(shared, "commit", "-qm", "fixture");
	};

	it.each([
		[
			"a mapped-scope path is handed the doc-map rule",
			["docs/x.md"],
			"doc-map-precommit",
			true,
		],
		[
			"a root GLOSSARY.md is handed the doc-map rule",
			["GLOSSARY.md"],
			"doc-map-precommit",
			true,
		],
		[
			"a commit touching no docs/ path is not",
			["app/x.ts"],
			"doc-map-precommit",
			false,
		],
		[
			"either roadmap file alone is handed the digest rule",
			["docs/roadmap-digest.md"],
			"digest-version-drift",
			true,
		],
		[
			"a docs/ commit naming neither roadmap file is not",
			["docs/x.md"],
			"digest-version-drift",
			false,
		],
		[
			"a guard is handed the registry rule",
			["scripts/x.sh"],
			"guard-registry-gate",
			true,
		],
		[
			"a commit reaching no region and no guard is not",
			["app/x.ts"],
			"guard-registry-gate",
			false,
		],
		[
			"a file Biome parses is handed the staged-gate rule",
			["app/x.ts"],
			"biome-staged-gate",
			true,
		],
		[
			"a commit of nothing Biome reads is not",
			["docs/x.md"],
			"biome-staged-gate",
			false,
		],
		[
			"a docs/ commit is handed the superseded rule",
			["docs/x.md"],
			"superseded-values-gate",
			true,
		],
		[
			"a commit outside docs/ is not",
			["app/x.ts"],
			"superseded-values-gate",
			false,
		],
		[
			"a docs/ commit is handed the machinery rule",
			["docs/x.md"],
			"machinery-superseded",
			true,
		],
		[
			"a commit outside docs/ is not handed the machinery rule",
			["app/x.ts"],
			"machinery-superseded",
			false,
		],
	])("%s", (_name, paths, id, expected) => {
		const got = idsIn(`git commit -m "x" -- ${(paths as string[]).join(" ")}`);
		expect(got.includes(id as string)).toBe(expected);
		// Whatever the scope, the pathspec rule is never scoped out: it is about
		// the act, not about a gate that will judge the result.
		expect(got).toContain("commit-pathspec");
	});

	/* A path each rule is scoped IN on, so only the module decides (#449). */
	it.each([
		["digest-version-drift", "roadmap", "docs/roadmap-digest.md"],
		["doc-map-precommit", "governance", "docs/x.md"],
		["superseded-values-gate", "governance", "docs/x.md"],
	])("%s is handed only where %s is on", (id, module, file) => {
		const cmd = `git commit -m "x" -- ${file}`;
		expect(idsIn(cmd, { WFC_MODULES: module })).toContain(id);
		const others = MODULES.filter((m) => m !== module).join(",");
		expect(idsIn(cmd, { WFC_MODULES: others })).not.toContain(id);
	});

	/*
	 * MUTATION ANCHORS, one clause per relocated bullet. The scope cases above
	 * key on the fragment ID and read the store through readRuleText, so they move
	 * with a mutation to the fragment instead of catching it — these are what
	 * fails when a clause is cut out of one.
	 */
	it.each([
		[
			"docs/x.md",
			"doc-map-precommit",
			"#390",
			"the ticket that put it in pre-commit",
		],
		[
			"docs/x.md",
			"doc-map-precommit",
			"SKIPs, PRINTING NOTHING",
			"the mid-merge trap",
		],
		[
			"docs/roadmap-digest.md",
			"digest-version-drift",
			"COMMIT `docs/reference-roadmap.html` AND",
			"the headline imperative",
		],
		[
			"docs/roadmap-digest.md",
			"digest-version-drift",
			"check-digest-version.js",
			"the checker that fails",
		],
		[
			"docs/roadmap-digest.md",
			"digest-version-drift",
			"#910",
			"where it fires first",
		],
		[
			"scripts/x.sh",
			"guard-registry-gate",
			"THIS COMMIT REACHES THE GUARD REGISTRY",
			"the headline imperative",
		],
		[
			"scripts/x.sh",
			"guard-registry-gate",
			"--review",
			"the command that clears the WARN",
		],
		[
			"scripts/x.sh",
			"guard-registry-gate",
			"carries one that lies",
			"what it FAILs on",
		],
		[
			"app/x.ts",
			"biome-staged-gate",
			"READS ONLY THIS COMMIT'S OWN STAGED PATHS",
			"the headline imperative",
		],
		["app/x.ts", "biome-staged-gate", "#179", "the ticket that measured it"],
		[
			"app/x.ts",
			"biome-staged-gate",
			"biome migrate --write",
			"the one route it misses",
		],
		[
			"docs/x.md",
			"machinery-superseded",
			"percent spelling AND the\ndecimal",
			"both spellings, which is the whole obligation",
		],
		[
			"docs/x.md",
			"superseded-values-gate",
			"A SUPERSEDED FIGURE LEFT LIVE",
			"the headline imperative",
		],
		[
			"docs/x.md",
			"superseded-values-gate",
			"still\nbeing stated as current",
			"the operative middle limb",
		],
		[
			"docs/x.md",
			"superseded-values-gate",
			"#1474",
			"the pointer assertion that fires first",
		],
	])("%s keeps %s's %s — %s", (file, _id, clause) => {
		expect(
			handedText(
				judge(`git commit -m "x" -- ${file}`, shared, "test", MODULES_ON),
			),
		).toContain(clause);
	});

	it.each([
		["git add -N docs/x.md", "intent-to-add is not committing"],
		["git add docs/x.md", "nor is staging"],
	])("%s is handed the act and push rules alone — %s", (command) => {
		// SCOPING IS `commit`-ONLY. `git add` runs none of these gates, reads a
		// pre-add index, and contributes no pathspec words — scan_commit fills
		// those for `commit` alone — so scoping it would judge the wrong file set.
		// It still gets the act and push rules, which are unscoped.
		const got = idsIn(command);
		expect(got).toEqual([
			"commit-message",
			"commit-pathspec",
			"commit-show-diff",
			"push-cadence",
		]);
	});

	/*
	 * A commit-paths.js call is scoped off the paths it would land, as a
	 * `git commit` pathspec is (#2147). It never gets commit-pathspec: it already
	 * commits by pathspec (#2022).
	 */
	const commitPathsDocs = [
		"commit-show-diff",
		"commit-message",
		"doc-map-precommit",
		"guard-registry-gate",
		"superseded-values-gate",
		"machinery-superseded",
		"push-cadence",
	].sort();

	it("a commit-paths.js call naming a docs/ path is handed the gate rules a git commit of it is (#2147)", () => {
		expect(idsIn('node scripts/commit-paths.js -m "x" -- docs/x.md')).toEqual(
			commitPathsDocs,
		);
		// The git commit is handed commit-pathspec on top; which of them fit
		// the ceiling is the kit's (#2285).
		expect(idsIn('git commit -m "x" -- docs/x.md')).toEqual(
			[...commitPathsDocs, "commit-pathspec"].sort(),
		);
	});

	it("a commit-paths.js call naming no gated path is handed the act and push rules alone (#2147)", () => {
		expect(idsIn('node scripts/commit-paths.js -m "--" -- a.md')).toEqual([
			"commit-message",
			"commit-show-diff",
			"push-cadence",
		]);
	});

	it("records a commit-paths.js call run where no repo root resolves", () => {
		const opaque = mkDirOutsideRepo("not-a-repo-");
		try {
			expect(
				idsIn(
					`cd ${opaque} && node scripts/commit-paths.js -m "x" -- docs/x.md`,
				),
			).toEqual(["commit-message", "commit-show-diff", "push-cadence"]);
		} finally {
			fs.rmSync(opaque, { recursive: true, force: true });
		}
		expect(logged()).toMatch(
			/the repo root did not resolve in .* — the scoped §Gotchas rules were not selected/,
		);
	});

	it("records nothing for a commit-paths.js call in the shared tree", () => {
		idsIn('node scripts/commit-paths.js -m "x" -- docs/x.md');
		expect(logged()).toBe("");
	});

	it("records a commit-paths.js call whose directory it cannot resolve", () => {
		expect(
			idsIn('cd "$(pwd)" && node scripts/commit-paths.js -m "x" -- docs/x.md'),
		).toEqual(["commit-message", "commit-show-diff", "push-cadence"]);
		expect(logged()).toMatch(
			/a commit-paths\.js call's directory is unknown — the scoped §Gotchas rules were not selected/,
		);
	});

	it("records a --patch file it cannot read", () => {
		idsIn('node scripts/commit-paths.js -m "x" --patch absent.patch');
		expect(logged()).toMatch(
			/could not read the --patch file of a commit-paths\.js call in .* — the scoped §Gotchas rules did not see its files/,
		);
	});

	it("a commit-paths.js --patch call is scoped off the files its patch names (#2147)", () => {
		writes();
		withPaths("docs/p.md");
		fs.writeFileSync(path.join(shared, "docs/p.md"), "x\ny\n");
		const patch = path.join(shared, "own.patch");
		fs.writeFileSync(patch, git(shared, "diff", "HEAD", "--", "docs/p.md"));
		try {
			expect(
				idsIn('node scripts/commit-paths.js -m "x" --patch own.patch'),
			).toEqual(commitPathsDocs);
		} finally {
			fs.rmSync(patch);
			git(shared, "checkout", "--", "docs/p.md");
		}
	});

	it("hands every path-scoped id on the widest commit, the push rule last", () => {
		// Which of them fit the emission ceiling, and the deferral of the rest, is
		// the kit's (guard-commit-form.test.ts). The push rule binds after the
		// commit, so it is the lowest priority (#2285).
		const command =
			'git commit -m "x" -- docs/roadmap-digest.md scripts/y.sh app/y.ts';
		expect(
			handed(judge(command, shared, "test", { WFC_MODULES: "roadmap" })),
		).toEqual([
			"commit-pathspec",
			"commit-show-diff",
			"commit-message",
			"digest-version-drift",
			"guard-registry-gate",
			"biome-staged-gate",
			"machinery-superseded",
			"push-cadence",
		]);
	});

	/*
	 * THE CLOSING-KEYWORD REFUSAL (mantahostels#2592, raised from an advisory injection to a
	 * deny at #129), the one verdict on this trigger decided by the commit's
	 * MESSAGE rather than by its paths.
	 */
	it.each([
		["closes #12", true, "the spelling the fragment names"],
		["Closes #12", true, "capitalised"],
		["CLOSES #12", true, "shouted"],
		["close #12", true, "the bare stem"],
		["closed #12", true, "the past tense"],
		["fixes #12", true, "the `fix` family, which the fragment does not spell"],
		["fix #12", true, "its stem"],
		["fixed #12", true, "its past tense"],
		["resolves #12", true, "the `resolve` family"],
		["resolve #12", true, "its stem"],
		["resolved #12", true, "its past tense"],
		["Closes: #12", true, "the trailer spelling, with a colon"],
		["Closes  #12", true, "spaced"],
		["refs #12", false, "the sanctioned form"],
		["see #12", false, "a bare citation"],
		["encloses #12", false, "a word merely ENDING in a keyword"],
		["closes the gap", false, "the keyword with no issue number after it"],
		["closes 12", false, "a number with no `#`"],
		/* mantahostels#2652's three spellings. GitHub honours the cross-repo and URL forms
		 * and closes on them, so a session writing one got no rule while the
		 * issue closed on the push anyway. */
		["closes owner/repo#12", true, "the cross-repo reference"],
		[
			"closes https://github.com/owner/repo/issues/12",
			true,
			"the issue URL, which carries no `#` at all",
		],
		[
			"fixes#12",
			true,
			"glued, which GitHub does not honour (#2660) — a deliberate overmatch",
		],
		[
			"closes hostels#12",
			false,
			"a bare repo name with no owner, which GitHub does not honour either",
		],
		[
			"closes https://github.com/owner/repo/pull/12",
			false,
			"a pull-request URL, which is not the issue-closing form",
		],
	])(
		"a message reading %s is refused, quoting what matched: %s (%s)",
		(message, expected, _why) => {
			const command = `git commit -m "${message}" -- a.md`;
			if (!expected) {
				expect(verdict(command)).not.toBe("deny");
				return;
			}
			const reason = readDenyReason(command);
			expect(reason).toContain(CLOSES);
			// The refusal quotes back what matched, in the session's own case —
			// every positive case above is exactly its own match, boundary
			// characters aside.
			expect(reason).toContain(`What matched: \`${message}\``);
		},
	);

	it("reads a keyword in the SECOND -m, git joining them into one message", () => {
		const reason = readDenyReason(
			'git commit -m "tidy the injector" -m "Closes #2592" -- a.md',
		);
		expect(reason).toContain("What matched: `Closes #2592`");
	});

	it("reads a keyword in the FIRST -m, a second one after it", () => {
		const reason = readDenyReason(
			'git commit -m "Closes #2592" -m "tidy the injector" -- a.md',
		);
		expect(reason).toContain("What matched: `Closes #2592`");
	});

	/* The declared project dir holds no store, so a read resolving its own
	 * root would answer the core's fragment, never this one. */
	it("reads the rule under the root the entry resolved (#3142)", () => {
		const root = mkScratchDir("closes-root-");
		const declared = mkScratchDir("closes-elsewhere-");
		const own = path.join(root, "docs", "agents", "rules");
		fs.mkdirSync(own, { recursive: true });
		fs.writeFileSync(path.join(own, "commit-closes-keyword.txt"), "own rule");
		vi.stubEnv("CLAUDE_PROJECT_DIR", declared);
		vi.stubEnv("WFC_RULES_DIR", undefined);
		try {
			const ports = buildHostPorts(root) as {
				closingRefusal: (match: string) => string;
			};
			expect(ports.closingRefusal("Closes #1")).toContain("own rule");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
			fs.rmSync(declared, { recursive: true, force: true });
		}
	});

	it("does not read a message passed by file, which is the rule's stated blind spot", () => {
		expect(verdict("git commit -F /tmp/msg.txt -- a.md")).not.toBe("deny");
	});

	it("is refused in a linked worktree and mid-merge alike", () => {
		writes();
		// Judged above the mid-sequence stand-down: GitHub reads the pushed
		// message, so neither the tree the commit was written in nor a merge in
		// progress changes what it does (#129).
		expect(verdict('git commit -m "Closes #12"', worktree)).toBe("deny");
		git(worktree, "checkout", "-q", "-b", "wt-closes");
		fs.writeFileSync(path.join(worktree, "a.md"), "other\n");
		git(worktree, "commit", "-qm", "other", "--", "a.md");
		git(worktree, "checkout", "-q", "side");
		fs.writeFileSync(path.join(worktree, "a.md"), "side\n");
		git(worktree, "commit", "-qm", "side", "--", "a.md");
		expect(() => git(worktree, "merge", "wt-closes")).toThrow();
		expect(verdict('git commit -m "Closes #12"', worktree)).toBe("deny");
	});

	/* MUTATION ANCHOR: the cases above key on the framing line and the matched
	 * text, so the fragment the refusal splices in could be gutted under them. */
	it("states what to write instead, and that the amend is not the escape", () => {
		const reason = readDenyReason('git commit -m "Closes #12" -- a.md');
		expect(reason).toContain("Write `Refs #n` instead");
		expect(reason).toContain("`git commit --amend` is denied (#4384)");
	});
});

/*
 * mantahostels#495. Which words of a commit are its pathspec, read by the
 * untracked-path warn: an option's value is not one, and a flag-shaped word
 * past `--` is.
 */
describe("a commit's pathspec words are read apart from its option values", () => {
	beforeEach(writes);

	it("does not read an option's value as a pathspec", () => {
		// Each of these ends in a word that is a value, naming an untracked file.
		for (const [command, file] of [
			["git commit -m msg", "msg"],
			['git commit --message "msg"', "msg"],
			["git commit -F msgfile", "msgfile"],
			["git commit -t template.txt", "template.txt"],
		]) {
			fs.writeFileSync(path.join(shared, file), "x\n");
			expect(verdict(command)).toBe("allow");
		}
	});

	it("reads a value glued to its flag without eating the next word", () => {
		// `-mmsg` carries its own value, so `new.md` after it IS a pathspec.
		fs.writeFileSync(path.join(shared, "new.md"), "new\n");
		expect(verdict("git commit -mmsg new.md")).toBe("warn");
	});

	it("reads a flag-shaped word after -- as the pathspec it is", () => {
		// Past a bare `--`, `-weird-file` is a path git will commit, not an
		// option.
		fs.writeFileSync(path.join(shared, "-weird-file"), "x\n");
		expect(verdict('git commit -m "msg" -- -weird-file')).toBe("warn");
	});
});

/*
 * mantahostels#182. Every case above puts its whole command on one line. A commit message
 * with a body does not, and that was enough to make the guard read the pathspec
 * wrong in BOTH directions — the cause being in the shared parser rather than
 * here (see shell-parse.test.ts, "logical lines").
 *
 * A commit naming pathspecs lost them; and a leftover word on the message's
 * first line could read as a path.
 */
describe("a multi-line commit message leaves the pathspec in view", () => {
	const cases: [string, string][] = [
		[
			"a quoted message spanning lines",
			'git commit -m "Subject line\n\nBody."',
		],
		[
			"the heredoc-through-a-command-substitution form",
			"git commit -m \"$(cat <<'EOF'\nSubject line\n\nBody.\nEOF\n)\"",
		],
		[
			"a message body carrying a shell metacharacter",
			'git commit -m "Subject line\n\nBody (with parens); and more."',
		],
		[
			"a message whose first line is a single word",
			'git commit -m "Subject\n\nBody."',
		],
	];

	it.each(cases)("%s — reads the pathspec after it", (_label, command) => {
		writes();
		fs.writeFileSync(path.join(shared, "new.md"), "new\n");
		const msg = run(`${command} -- new.md`);
		expect(msg).toContain("new.md");
		expect(msg).not.toContain("Subject");
	});

	it.each(cases)(
		"%s — reads no word of it as a pathspec",
		(_label, command) => {
			writes();
			for (const word of ["Subject", "line", "Body."])
				fs.writeFileSync(path.join(shared, word), "x\n");
			expect(verdict(command)).toBe("allow");
		},
	);

	it("still denies --no-verify carrying a multi-line message", () => {
		// The deny reads flags on the first line, so it never depended on the join.
		expect(
			readDenyReason('git commit -n -m "Subject line\n\nBody."'),
		).toContain(NO_VERIFY);
	});
});

describe("mid-sequence, the amend deny stands down", () => {
	beforeEach(() => {
		writes();
		pushHead();
	});

	it.each([
		["rebase-merge", "an interactive rebase"],
		["rebase-apply", "a `git am`-style rebase"],
	])("%s marks %s in progress", (marker) => {
		fs.mkdirSync(path.join(shared, ".git", marker), { recursive: true });
		expect(verdict("git commit --amend --no-edit")).toBe("allow");
	});

	it.each([
		["CHERRY_PICK_HEAD", "a cherry-pick"],
		["REVERT_HEAD", "a revert"],
	])("%s marks %s in progress", (marker) => {
		fs.writeFileSync(
			path.join(shared, ".git", marker),
			git(shared, "rev-parse", "HEAD"),
		);
		expect(verdict("git commit --amend --no-edit")).toBe("allow");
	});
});

describe("text that merely mentions a commit is not a commit", () => {
	it.each([
		['grep -rn "git commit -n" docs/', "a search"],
		["echo 'git commit -n foo'", "a single-quoted mention"],
		['echo "a | git commit -n"', "a pipe inside a quoted string"],
		["cat <<EOF > f.md\ngit commit -n foo\nEOF", "a heredoc body"],
		[
			"cat <<'EOF' > f.md\ngit commit -n foo\nEOF",
			"a quoted heredoc delimiter",
		],
	])("%s — %s", (command) => {
		expect(verdict(command)).toBe("allow");
	});

	it("<< inside a quoted string does not open a heredoc", () => {
		// Otherwise it swallows every line after it, the commit included.
		expect(verdict('echo "a << b"\ngit commit -n foo')).toBe("deny");
		// The segment echoed back must be the commit, not the echo.
		expect(readDenyReason('echo "a << b"\ngit commit -n foo')).toContain(
			"everywhere else: git commit -n foo",
		);
	});

	it("leaves git subcommands it has no business in alone", () => {
		for (const command of [
			"git status",
			"git diff --cached",
			"git log --oneline",
			"git worktree add -b sync /tmp/wt main",
		]) {
			expect(verdict(command)).toBe("allow");
		}
	});
});

describe("trees this guard has no business in", () => {
	it("an unrelated repository is left alone", () => {
		expect(verdict(`git -C ${elsewhere} commit -n -m "msg"`)).toBe("allow");
		expect(verdict('git commit -n -m "msg"', elsewhere)).toBe("allow");
	});

	it("resolves a leading cd, so the tree is judged not the caller's cwd", () => {
		expect(verdict(`cd ${shared} && git commit -n -m "msg"`, elsewhere)).toBe(
			"deny",
		);
		expect(
			readDenyReason(`cd ${shared} && git commit -n -m "msg"`, elsewhere),
		).toContain('everywhere else: git commit -n -m "…"');
	});

	it("resolves git -C, including from inside a worktree", () => {
		expect(verdict(`git -C ${elsewhere} commit -n -m "msg"`, worktree)).toBe(
			"allow",
		);
		expect(
			readDenyReason(`git -C ${shared} commit -n -m "msg"`, worktree),
		).toContain(NO_VERIFY);
	});

	it("judges a worktree spelt through $CLAUDE_JOB_DIR instead of failing open on it", () => {
		writes();
		// The recipe was `"$CLAUDE_JOB_DIR/tmp/<name>"` until #1732, and a hook
		// process inherits CLAUDE_JOB_DIR, so the path resolves (mantahostels#183).
		const env = { CLAUDE_JOB_DIR: dir };
		git(shared, "worktree", "add", "-q", "-b", "recipe", path.join(dir, "tmp"));
		expect(
			readDenyReason(
				'cd "$CLAUDE_JOB_DIR/tmp" && git commit -n -m "msg"',
				elsewhere,
				env,
			),
		).toContain(NO_VERIFY);
		expect(logged()).toBe("");
	});

	it("resolves a quoted literal path through the quote masking", () => {
		expect(
			readDenyReason(`cd "${shared}" && git commit -n -m "msg"`, elsewhere),
		).toContain(NO_VERIFY);
		expect(
			readDenyReason(`git -C "${shared}" commit -n -m "msg"`, elsewhere),
		).toContain(NO_VERIFY);
	});

	it("fails open on a path it genuinely cannot resolve", () => {
		// The deliberate residual (#312): a command substitution, directly or
		// through a name, stays unjudged. An unset name is judged.
		expect(verdict('cd "$(mktemp -d)" && git commit -n -m "msg"')).toBe(
			"allow",
		);
		expect(verdict('D=$(mktemp -d); cd "$D" && git commit -n -m "msg"')).toBe(
			"allow",
		);
	});
});

describe("a commit form it cannot judge is recorded, not just allowed", () => {
	it("logs a commit whose working tree cannot be resolved", () => {
		// An unexpanded variable in the cd target: the guard does not know which
		// tree this commits against, so it allows — and that is a commit form it
		// declined to judge, not a command it never had to.
		run('cd $TARGET && git commit -n -m "x"');
		expect(logged()).toMatch(
			/could not resolve the working tree for a git commit/,
		);
	});

	it("says nothing about an unresolvable cd carrying no commit at all", () => {
		run("cd $TARGET && npm run build");
		expect(logged()).toBe("");
	});

	it("says nothing about a commit in a directory that is in no repo (mantahostels#253)", () => {
		// The directory exists and git refuses for it — a confident "not a
		// repository", not an unknown: nothing committed there reaches this repo.
		const opaque = mkDirOutsideRepo("not-a-repo-");
		try {
			run(`git -C ${opaque} commit -n -m "x"`, shared, "test");
		} finally {
			fs.rmSync(opaque, { recursive: true, force: true });
		}
		expect(logged()).toBe("");
	});

	it("logs a commit where git failed for some other reason (mantahostels#253)", () => {
		// A commit form the guard declined to judge, so is_shared_tree() returns 2
		// and the guard records it. git's own answer cannot pick this case out: a
		// `.git` pointing at a gitdir that is gone exits 128 printing the same
		// "not a git repository" as the case above.
		const broken = path.join(scratch(), "broken-repo");
		fs.mkdirSync(broken);
		fs.writeFileSync(
			path.join(broken, ".git"),
			`gitdir: ${path.join(dir, "no-such-gitdir")}\n`,
		);
		run(`git -C ${broken} commit -n -m "x"`, shared, "test");
		expect(logged()).toMatch(
			/git could not answer for .*broken-repo — a git commit there was allowed unchecked/,
		);
	});

	it("says nothing about a commit in a directory that does not exist", () => {
		// git fails before it commits anything, so an absolute path with nothing at
		// it is no more this repo than another repo is (mantahostels#208).
		run(`git -C ${path.join(dir, "gone")} commit -n -m "x"`);
		expect(logged()).toBe("");
	});
});

describe("an unset variable in the target is the cwd (#312, #326)", () => {
	const unsetLine =
		"`$UNSET_326` is unset in this call; shell variables do not carry over between Bash calls.";

	it.each([
		[AMEND, 'cd "$UNSET_326" && git commit --amend -m "x" -- a.md'],
		[NO_VERIFY, 'git -C "$UNSET_326" commit --no-verify -m "x" -- a.md'],
		[NO_VERIFY, 'git -C "$UNSET_326" merge --no-verify topic'],
		[CLOSES, 'git -C "$UNSET_326" commit -m "Fixes #1" -- a.md'],
	])(
		"refuses with %s, naming the variable after the framing line",
		(framing, command) => {
			const r = readDenyReason(command);
			// The framing paragraph, the line, then the refusal's own body.
			const from = r.slice(r.indexOf(framing)).split("\n\n");
			expect(from[1]).toBe(unsetLine);
			expect(from[2]).not.toBe("");
			expect(logged()).toBe("");
		},
	);

	it("keeps the tree scope of the cwd it lands in", () => {
		expect(
			readDenyReason('git -C "$UNSET_326" commit -n -m "x" -- a.md', worktree),
		).toContain(unsetLine);
		expect(verdict('git -C "$UNSET_326" commit -n -m "x"', elsewhere)).toBe(
			"allow",
		);
	});

	it("judges the untracked-pathspec and directory warns there too", () => {
		writes();
		fs.mkdirSync(path.join(shared, "d"));
		fs.writeFileSync(path.join(shared, "d", "old.md"), "old\n");
		git(shared, "add", "d/old.md");
		git(shared, "commit", "-qm", "d");
		fs.writeFileSync(path.join(shared, "d", "old.md"), "edited\n");
		fs.writeFileSync(path.join(shared, "d", "new.md"), "new\n");
		expect(run('git -C "$UNSET_326" commit -m "x" -- d/new.md')).toContain(
			"git does not track yet",
		);
		expect(run('git -C "$UNSET_326" commit -m "x" -- d')).toContain(
			"does not track yet",
		);
	});

	it("adds no line where no variable reached the tree", () => {
		expect(readDenyReason('git commit -n -m "x"')).not.toContain(
			"is unset in this call",
		);
		expect(readDenyReason('W=""; git -C "$W" commit -n -m "x"')).not.toContain(
			"is unset in this call",
		);
	});

	it("keeps the logged fail-open for a $(…) target", () => {
		expect(verdict('cd "$(pwd)" && git commit -n -m "x"')).toBe("allow");
		expect(logged()).toMatch(
			/could not resolve the working tree for a git commit/,
		);
	});
});

/** The escape both untracked-path warns offer: the commit script first, the hand-typed intent-add after it. */
const expectScriptAheadOfAddN = (out: string) => {
	const script = out.indexOf("node scripts/commit-paths.js");
	expect(script).toBeGreaterThan(-1);
	expect(out.indexOf("git add -N <path>")).toBeGreaterThan(script);
};

describe("the untracked-path warn spells the commit script where it is installed (#343)", () => {
	it("spells the script at the plugin root in an install's warn", () => {
		writes();
		// A plugin install: the core's scripts with no package.json beside them.
		const root = path.join(scratch(), "plugin");
		fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
		fs.writeFileSync(path.join(root, "scripts", "commit-paths.js"), "");
		fs.writeFileSync(path.join(shared, "new.md"), "new\n");
		expect(
			run('git commit -m "x" -- new.md', shared, "test", {
				WFC_SCRIPT_ROOT: root,
			}),
		).toContain(`node ${root}/scripts/commit-paths.js`);
	});
});

/*
 * mantahostels#1612. docs/agents/guard-registry.md §Conventions' headline rule — commit by
 * pathspec — is unsatisfiable for a file git does not track yet: the pathspec
 * matches nothing, git exits 1 and commits nothing.
 */
describe("a pathspec commit warns when it names a path git does not track", () => {
	/** Puts a file on disk that git has never been told about. */
	const newFile = (rel: string, text = "new\n") => {
		fs.mkdirSync(path.dirname(path.join(shared, rel)), { recursive: true });
		fs.writeFileSync(path.join(shared, rel), text);
	};

	it("names the untracked path and hands back the commit script, then the add -N escape (#587)", () => {
		writes();
		newFile("new.md");
		const out = run('git commit -m "x" -- new.md');
		expect(out).toContain("git does not track yet");
		expect(out).toContain("new.md");
		expectScriptAheadOfAddN(out);
		expect(out).toContain("#1612");
	});

	it("says nothing when every path named is already tracked", () => {
		expect(verdict('git commit -m "x" -- a.md')).toBe("allow");
	});

	it("warns when one untracked path rides along with a tracked one", () => {
		writes();
		newFile("new.md");
		expect(verdict('git commit -m "x" -- a.md new.md')).toBe("warn");
	});

	it("warns without the -- separator too", () => {
		writes();
		newFile("new.md");
		expect(verdict('git commit -m "x" new.md')).toBe("warn");
	});

	it("warns on a directory holding nothing git tracks", () => {
		writes();
		newFile("fresh/new.md");
		expect(verdict('git commit -m "x" -- fresh')).toBe("warn");
	});

	it("leaves a directory git already tracks something in to mantahostels#1651", () => {
		writes();
		// git accepts the pathspec and commits the tracked file, silently
		// leaving the untracked one behind — a warn, but not this one's.
		newFile("also-new.md");
		const out = run('git commit -m "x" -- .');
		expect(out).not.toContain("#1612");
		expect(out).toContain("#1651");
	});

	it("says nothing about a path that is not there at all", () => {
		// A typo, or mantahostels#495's flag-shaped path: `git add -N` is no advice for a
		// file that is not there.
		expect(verdict('git commit -m "msg" -- -weird-file')).toBe("allow");
		expect(verdict('git commit -m "msg" -- typo.md')).toBe("allow");
	});

	it("warns on an ignored path too, and offers the -f the escape needs", () => {
		writes();
		// git rejects the pathspec for an ignored file just the same, so the
		// harm is identical — but plain `git add -N` would refuse it.
		fs.writeFileSync(path.join(shared, ".gitignore"), "ignored.md\n");
		git(shared, "add", ".gitignore");
		git(shared, "commit", "-qm", "ignore");
		newFile("ignored.md");
		expect(run('git commit -m "x" -- ignored.md')).toContain("git add -f -N");
	});

	it("says nothing when the pathspec word's text cannot be read", () => {
		writes();
		newFile("new.md");
		expect(verdict('git commit -m "x" -- "$PATHS"')).toBe("allow");
	});

	it("is outranked by the --no-verify deny in the same command", () => {
		writes();
		newFile("new.md");
		expect(verdict('git commit --no-verify -m "x" -- new.md')).toBe("deny");
		expect(readDenyReason('git commit --no-verify -m "x" -- new.md')).toContain(
			NO_VERIFY,
		);
	});

	it("is suppressed mid-merge, where git refuses a partial commit itself", () => {
		writes();
		newFile("new.md");
		fs.writeFileSync(
			path.join(shared, ".git", "MERGE_HEAD"),
			git(shared, "rev-parse", "HEAD"),
		);
		expect(verdict('git commit -m "x" -- new.md')).toBe("allow");
	});

	it("binds in a linked worktree too", () => {
		writes();
		// git rejects an unmatchable pathspec byte-identically in every tree.
		fs.writeFileSync(path.join(worktree, "new.md"), "new\n");
		expect(verdict('git commit -m "x" -- new.md', worktree)).toBe("warn");
	});

	it("leaves a word git cannot answer for unjudged, and records it", () => {
		// A path outside the repo: git exits 128, so the word is left unjudged
		// rather than guessed at — and mantahostels#147's rule is that every fail-open is
		// logged, or a broken git reads exactly like a clean verdict.
		expect(
			verdict(`git commit -m "x" -- ${path.join(dir, "outside.md")}`),
		).toBe("allow");
		expect(logged()).toContain("left unjudged for mantahostels#1612");
	});

	it("needs no session id", () => {
		writes();
		newFile("new.md");
		expect(run('git commit -m "x" -- new.md', shared, null)).toContain(
			"git does not track yet",
		);
	});
});

/*
 * mantahostels#1651. The residual mantahostels#1612 leaves. A pathspec word naming a DIRECTORY that
 * holds one tracked file and one untracked file is accepted by git: it commits
 * the tracked one, exits 0 and leaves the new one behind. mantahostels#1612's harm with no
 * signal at all — which is why this is a second verdict rather than a widening
 * of mantahostels#1612's loop, whose "tracks nothing" test deliberately clears such a word.
 */
describe("a pathspec commit warns when a directory word leaves a new file behind", () => {
	const newFile = (rel: string, text = "new\n") => {
		fs.mkdirSync(path.dirname(path.join(shared, rel)), { recursive: true });
		fs.writeFileSync(path.join(shared, rel), text);
	};

	/** A tracked, modified file and an untracked sibling, both under `docs/`. */
	const mixedDir = () => {
		fs.mkdirSync(path.join(shared, "docs"), { recursive: true });
		fs.writeFileSync(path.join(shared, "docs", "old.md"), "old\n");
		git(shared, "add", "docs/old.md");
		git(shared, "commit", "-qm", "docs");
		fs.writeFileSync(path.join(shared, "docs", "old.md"), "edited\n");
		newFile("docs/new.md");
	};

	it("names the untracked file left behind and hands back the commit script, then the add -N escape (#587)", () => {
		writes();
		mixedDir();
		const out = run('git commit -m "x" -- docs');
		expect(out).toContain("does not track yet");
		expect(out).toContain("docs/new.md");
		expectScriptAheadOfAddN(out);
		expect(out).toContain("#1651");
	});

	it("warns, never denies — the commit still lands", () => {
		writes();
		mixedDir();
		expect(verdict('git commit -m "x" -- docs')).toBe("warn");
	});

	it("covers the repo root spelled as a dot", () => {
		writes();
		mixedDir();
		expect(run('git commit -m "x" -- .')).toContain("docs/new.md");
	});

	it("says nothing when the pathspec names tracked files alone", () => {
		writes();
		mixedDir();
		expect(verdict('git commit -m "x" -- docs/old.md')).toBe("allow");
	});

	it("says nothing when the directory holds nothing untracked", () => {
		writes();
		fs.mkdirSync(path.join(shared, "docs"), { recursive: true });
		fs.writeFileSync(path.join(shared, "docs", "old.md"), "old\n");
		git(shared, "add", "docs/old.md");
		git(shared, "commit", "-qm", "docs");
		fs.writeFileSync(path.join(shared, "docs", "old.md"), "edited\n");
		expect(verdict('git commit -m "x" -- docs')).toBe("allow");
	});

	it("says nothing when the only untracked contents are gitignored", () => {
		writes();
		fs.writeFileSync(path.join(shared, ".gitignore"), "docs/scratch/\n");
		git(shared, "add", ".gitignore");
		fs.mkdirSync(path.join(shared, "docs"), { recursive: true });
		fs.writeFileSync(path.join(shared, "docs", "old.md"), "old\n");
		git(shared, "add", "docs/old.md");
		git(shared, "commit", "-qm", "docs");
		fs.writeFileSync(path.join(shared, "docs", "old.md"), "edited\n");
		newFile("docs/scratch/junk.md");
		expect(verdict('git commit -m "x" -- docs')).toBe("allow");
	});

	it("leaves mantahostels#1612's own message and trigger untouched", () => {
		writes();
		// A word matching nothing tracked is still mantahostels#1612's, byte for byte.
		newFile("new.md");
		const out = run('git commit -m "x" -- new.md');
		expect(out).toContain("#1612");
		expect(out).not.toContain("#1651");
	});

	it("is outranked by mantahostels#1612 when one command triggers both", () => {
		writes();
		mixedDir();
		newFile("loose.md");
		const out = run('git commit -m "x" -- docs loose.md');
		expect(out).toContain("#1612");
		expect(out).not.toContain("#1651");
	});

	it("caps a long list with a count rather than printing it whole", () => {
		writes();
		mixedDir();
		for (let i = 0; i < 14; i++) newFile(`docs/n${i}.md`);
		const out = run('git commit -m "x" -- docs');
		expect(out).toContain("and 5 more");
		// git lists them sorted, so docs/new.md is last of the fifteen and one
		// of the five cut.
		expect(out).not.toContain("docs/new.md");
	});

	it("spends one budget across the whole message, not one per word", () => {
		writes();
		// Two directory words, eight new files each: ten named, six counted —
		// not ten named per word.
		mixedDir();
		fs.writeFileSync(path.join(shared, "src.md"), "src\n");
		git(shared, "add", "src.md");
		git(shared, "commit", "-qm", "src");
		fs.mkdirSync(path.join(shared, "src"), { recursive: true });
		fs.writeFileSync(path.join(shared, "src", "kept.md"), "kept\n");
		git(shared, "add", "src/kept.md");
		git(shared, "commit", "-qm", "src dir");
		for (let i = 0; i < 7; i++) newFile(`docs/d${i}.md`);
		for (let i = 0; i < 8; i++) newFile(`src/s${i}.md`);
		const out = run('git commit -m "x" -- docs src');
		expect(out).toContain("and 6 more");
	});

	it("is suppressed mid-merge, like the other pathspec verdicts", () => {
		writes();
		mixedDir();
		fs.writeFileSync(
			path.join(shared, ".git", "MERGE_HEAD"),
			git(shared, "rev-parse", "HEAD"),
		);
		expect(verdict('git commit -m "x" -- docs')).toBe("allow");
	});

	it("binds in a linked worktree too", () => {
		writes();
		fs.mkdirSync(path.join(worktree, "docs"), { recursive: true });
		fs.writeFileSync(path.join(worktree, "docs", "old.md"), "old\n");
		git(worktree, "add", "docs/old.md");
		git(worktree, "commit", "-qm", "docs");
		fs.writeFileSync(path.join(worktree, "docs", "old.md"), "edited\n");
		fs.writeFileSync(path.join(worktree, "docs", "new.md"), "new\n");
		expect(verdict('git commit -m "x" -- docs', worktree)).toBe("warn");
	});

	it("says nothing when the pathspec word's text cannot be read", () => {
		writes();
		mixedDir();
		expect(verdict('git commit -m "x" -- "$PATHS"')).toBe("allow");
	});

	it("says nothing about a glob — the verdict is scoped to a directory word", () => {
		writes();
		// A quoted glob git expands itself has the same silent harm, and is the
		// verdict's known residual: the boundary is a word that IS a directory.
		mixedDir();
		expect(verdict(`git commit -m "x" -- 'docs/*'`)).toBe("allow");
	});

	it("needs no session id", () => {
		writes();
		mixedDir();
		expect(run('git commit -m "x" -- docs', shared, null)).toContain("#1651");
	});

	it("leaves a word git cannot answer for unjudged, and records it", () => {
		// A directory outside the repo: git exits 128, so the word is left
		// unjudged rather than guessed at, and mantahostels#147's rule is that it is logged.
		expect(verdict(`git commit -m "x" -- ${dir}`)).toBe("allow");
		expect(logged()).toContain("left unjudged for mantahostels#1651");
	});
});

/*
 * mantahostels#3280.
 *
 * D1: mantahostels#1612 rests on "git rejects the whole commit". That is false
 * of `git add -N x && git commit … -- x …` — the escape mantahostels#1612
 * itself prints. The guard judges PreToolUse, so x is untracked here and
 * tracked by the time git runs: the commit succeeds.
 *
 * D2: mantahostels#1651 describes a commit that SUCCEEDS and leaves scratch
 * behind, so it is the lowest-ranked warn.
 */
describe("the warns a pathspec commit is owed (mantahostels#3280)", () => {
	const doc = "docs/a.md";

	const newFile = (rel: string, text = "new\n") => {
		fs.mkdirSync(path.dirname(path.join(shared, rel)), { recursive: true });
		fs.writeFileSync(path.join(shared, rel), text);
	};

	beforeEach(() => {
		writes();
		newFile(doc, "committed\n");
		git(shared, "add", "-A");
		git(shared, "commit", "-qm", "seed");
		fs.writeFileSync(path.join(shared, doc), "an unsaved edit\n");
	});

	describe("D1 — a word an earlier segment intent-adds", () => {
		it("suppresses mantahostels#1612, a false positive there", () => {
			newFile("new.md");
			const out = run(
				`git add -N new.md && git commit -m "x" -- ${doc} new.md`,
			);
			expect(out).not.toContain("#1612");
		});

		it("suppresses in a linked worktree too, where mantahostels#1612 binds", () => {
			// Which is why the record is taken above the shared-tree gate.
			fs.writeFileSync(path.join(worktree, "new.md"), "new\n");
			expect(
				verdict('git add -N new.md && git commit -m "x" -- new.md', worktree),
			).toBe("allow");
		});

		it("still fires on -n, which stages nothing at all", () => {
			newFile("new.md");
			const out = run(
				`git add -n new.md && git commit -m "x" -- ${doc} new.md`,
			);
			// "mantahostels#1612", not the sentence: mantahostels#1651's text carries the same words.
			expect(out).toContain("#1612");
		});

		it("still fires on a bundle carrying both — -nN is a dry run", () => {
			newFile("new.md");
			expect(
				run(`git add -nN new.md && git commit -m "x" -- ${doc} new.md`),
			).toContain("#1612");
		});

		it("suppresses through a bundled -N, e.g. `git add -vN`", () => {
			newFile("new.md");
			expect(
				run(`git add -vN new.md && git commit -m "x" -- ${doc} new.md`),
			).not.toContain("#1612");
		});

		it("suppresses only the word actually intent-added", () => {
			newFile("new.md");
			newFile("other.md");
			const out = run(
				`git add -N new.md && git commit -m "x" -- new.md other.md`,
			);
			expect(out).toContain("other.md");
			expect(out).not.toContain("new.md");
		});

		it("suppresses nothing when the add comes AFTER the commit", () => {
			newFile("new.md");
			expect(
				run(`git commit -m "x" -- ${doc} new.md && git add -N new.md`),
			).toContain("#1612");
		});

		it("suppresses across a `./` spelling difference (mantahostels#3315)", () => {
			// The unnormalised string compare read one file as two and fired mantahostels#1612.
			newFile("new.md");
			const out = run(
				`git add -N ./new.md && git commit -m "x" -- ${doc} new.md`,
			);
			expect(out).not.toContain("#1612");
		});

		it("suppresses across a doubled slash in the commit's own word (mantahostels#3315)", () => {
			newFile("new.md");
			const out = run(
				`git add -N new.md && git commit -m "x" -- ${doc} .//new.md`,
			);
			expect(out).not.toContain("#1612");
		});

		it("resolves the word against the add segment's own cwd", () => {
			// `git -C` can differ per segment, so an absolute-path comparison is
			// the only one that holds.
			fs.mkdirSync(path.join(shared, "sub"), { recursive: true });
			newFile("sub/new.md");
			const out = run(
				`git -C ${path.join(shared, "sub")} add -N new.md && git commit -m "x" -- ${doc} sub/new.md`,
			);
			expect(out).not.toContain("#1612");
		});

		it("suppresses a DIRECTORY word the intent-add lands inside (mantahostels#3318)", () => {
			// git tracks src/new.md by the time the commit runs, so `-- src`
			// commits it and exits 0.
			newFile("src/new.md");
			const out = run(
				`git add -N src/new.md && git commit -m "x" -- ${doc} src`,
			);
			expect(out).not.toContain("#1612");
		});

		it("does not let an add under a prefix-sharing sibling suppress the word (mantahostels#3318)", () => {
			// /repo/srcx/other.md is not under /repo/src, so `src` keeps its warn.
			newFile("src/new.md");
			newFile("srcx/other.md");
			const out = run(`git add -N srcx/other.md && git commit -m "x" -- src`);
			expect(out).toContain("#1612");
		});

		it("suppresses a FILE word an intent-add of the directory covers (mantahostels#3321)", () => {
			// `git add -N src` intent-adds every untracked file under src, so
			// src/new.md is tracked by the time the commit runs.
			newFile("src/new.md");
			const out = run(
				`git add -N src && git commit -m "x" -- ${doc} src/new.md`,
			);
			expect(out).not.toContain("#1612");
		});

		it("does not let an add of a prefix-sharing sibling directory suppress the file (mantahostels#3321)", () => {
			newFile("src/new.md");
			newFile("srcx/other.md");
			expect(
				run(`git add -N srcx && git commit -m "x" -- src/new.md`),
			).toContain("#1612");
		});

		it("does not suppress an IGNORED file a plain add of the directory skips (mantahostels#3321)", () => {
			// `git add -N src` leaves src/x.log untracked, so that commit really
			// does fail.
			fs.writeFileSync(path.join(shared, ".gitignore"), "*.log\n");
			newFile("src/x.log");
			expect(run(`git add -N src && git commit -m "x" -- src/x.log`)).toContain(
				"#1612",
			);
		});

		it("suppresses that ignored file once the add carries -f (mantahostels#3321)", () => {
			fs.writeFileSync(path.join(shared, ".gitignore"), "*.log\n");
			newFile("src/x.log");
			const out = run(
				`git add -f -N src && git commit -m "x" -- ${doc} src/x.log`,
			);
			expect(out).not.toContain("#1612");
		});

		it("reads the long --force spelling too (mantahostels#3321)", () => {
			fs.writeFileSync(path.join(shared, ".gitignore"), "*.log\n");
			newFile("src/x.log");
			const out = run(
				`git add --force -N src && git commit -m "x" -- ${doc} src/x.log`,
			);
			expect(out).not.toContain("#1612");
		});

		it("reads -f out of a bundle too, e.g. `git add -fN` (mantahostels#3321)", () => {
			fs.writeFileSync(path.join(shared, ".gitignore"), "*.log\n");
			newFile("src/x.log");
			const out = run(
				`git add -fN src && git commit -m "x" -- ${doc} src/x.log`,
			);
			expect(out).not.toContain("#1612");
		});

		it("expands the directory argument against the add segment's own cwd (mantahostels#3321)", () => {
			fs.mkdirSync(path.join(shared, "sub"), { recursive: true });
			newFile("sub/src/new.md");
			const out = run(
				`git -C ${path.join(shared, "sub")} add -N src && git commit -m "x" -- ${doc} sub/src/new.md`,
			);
			expect(out).not.toContain("#1612");
		});

		/**
		 * A `--pathspec-from-file` list at `rel`, one pathspec per line.
		 * `terminated: false` leaves the last element with no separator after it —
		 * git stages it all the same, so the guard has to read it (mantahostels#3324).
		 */
		const listFile = (
			rel: string,
			lines: string[],
			sep = "\n",
			terminated = true,
		) => {
			newFile(rel, lines.join(sep) + (terminated ? sep : ""));
			return rel;
		};

		it("reads the last line of a list with no terminator after it (mantahostels#3324)", () => {
			newFile("new.md");
			listFile("paths.txt", ["new.md"], "\n", false);
			const out = run(
				`git add -N --pathspec-from-file paths.txt && git commit -m "x" -- ${doc} new.md`,
			);
			expect(out).not.toContain("#1612");
		});

		it("reads the last element of an unterminated NUL list too (mantahostels#3324)", () => {
			newFile("new.md");
			newFile("other.md");
			listFile("paths.bin", ["other.md", "new.md"], "\0", false);
			const out = run(
				`git add -N --pathspec-from-file paths.bin --pathspec-file-nul && git commit -m "x" -- ${doc} new.md`,
			);
			expect(out).not.toContain("#1612");
		});

		it("records a DIRECTORY named as the list, rather than reading it per line (mantahostels#3324)", () => {
			// A directory passes `-r`, so without the `-f` test the read fails once
			// per line with nothing logged and the commit looks judged.
			newFile("new.md");
			fs.mkdirSync(path.join(shared, "listdir"), { recursive: true });
			expect(
				run(
					`git add -N --pathspec-from-file listdir && git commit -m "x" -- new.md`,
				),
			).toContain("#1612");
			expect(logged()).toMatch(/could not read the pathspec list/);
		});

		it("suppresses through a --pathspec-from-file list (mantahostels#3324)", () => {
			newFile("new.md");
			listFile("paths.txt", ["new.md"]);
			const out = run(
				`git add -N --pathspec-from-file paths.txt && git commit -m "x" -- ${doc} new.md`,
			);
			expect(out).not.toContain("#1612");
		});

		it("reads the --pathspec-from-file=<file> spelling too (mantahostels#3324)", () => {
			newFile("new.md");
			listFile("paths.txt", ["new.md"]);
			const out = run(
				`git add -N --pathspec-from-file=paths.txt && git commit -m "x" -- ${doc} new.md`,
			);
			expect(out).not.toContain("#1612");
		});

		it("suppresses every line of the list, not just the first (mantahostels#3324)", () => {
			newFile("new.md");
			newFile("other.md");
			listFile("paths.txt", ["new.md", "other.md"]);
			const out = run(
				`git add -N --pathspec-from-file paths.txt && git commit -m "x" -- ${doc} new.md other.md`,
			);
			expect(out).not.toContain("#1612");
		});

		it("expands a DIRECTORY line of the list, as a bare word is expanded (mantahostels#3324)", () => {
			newFile("src/new.md");
			listFile("paths.txt", ["src"]);
			const out = run(
				`git add -N --pathspec-from-file paths.txt && git commit -m "x" -- ${doc} src/new.md`,
			);
			expect(out).not.toContain("#1612");
		});

		it("resolves the list file against the add segment's own cwd (mantahostels#3324)", () => {
			fs.mkdirSync(path.join(shared, "sub"), { recursive: true });
			newFile("sub/new.md");
			listFile("sub/paths.txt", ["new.md"]);
			const out = run(
				`git -C ${path.join(shared, "sub")} add -N --pathspec-from-file paths.txt && git commit -m "x" -- ${doc} sub/new.md`,
			);
			expect(out).not.toContain("#1612");
		});

		it("reads a NUL-separated list under --pathspec-file-nul (mantahostels#3324)", () => {
			// The flag is spelled AFTER --pathspec-from-file, which is why it is
			// read in the pre-pass rather than in the word walk.
			newFile("new.md");
			listFile("paths.bin", ["new.md"], "\0");
			const out = run(
				`git add -N --pathspec-from-file paths.bin --pathspec-file-nul && git commit -m "x" -- ${doc} new.md`,
			);
			expect(out).not.toContain("#1612");
		});

		it("takes a NUL list literally — no CR is stripped off it (mantahostels#3324)", () => {
			// The bytes git stages are `new.md\r`, so a guard that stripped the CR
			// would credit a path git never intent-added.
			newFile("new.md");
			listFile("paths.bin", ["new.md\r"], "\0");
			expect(
				run(
					`git add -N --pathspec-from-file paths.bin --pathspec-file-nul && git commit -m "x" -- new.md`,
				),
			).toContain("#1612");
		});

		it("strips the CR off a CRLF-separated list, as git does (mantahostels#3324)", () => {
			newFile("new.md");
			listFile("paths.txt", ["new.md"], "\r\n");
			const out = run(
				`git add -N --pathspec-from-file paths.txt && git commit -m "x" -- ${doc} new.md`,
			);
			expect(out).not.toContain("#1612");
		});

		it("suppresses nothing when the list comes from stdin, and records it (mantahostels#3324)", () => {
			// `-` is git's stdin spelling and the hook payload carries no stdin, so
			// the commit keeps its warn. The log entry is what
			// tells that apart from a list this guard read and found empty.
			newFile("new.md");
			expect(
				run(`git add -N --pathspec-from-file - && git commit -m "x" -- new.md`),
			).toContain("#1612");
			expect(logged()).toMatch(/takes its paths from stdin/);
		});

		it("records a list file it could not read, rather than reading none (mantahostels#3324)", () => {
			newFile("new.md");
			expect(
				run(
					`git add -N --pathspec-from-file absent.txt && git commit -m "x" -- new.md`,
				),
			).toContain("#1612");
			expect(logged()).toMatch(/could not read the pathspec list/);
		});

		it("suppresses nothing on a C-quoted line, which it does not decode (mantahostels#3324)", () => {
			newFile("new.md");
			listFile("paths.txt", ['"new.md"']);
			expect(
				run(
					`git add -N --pathspec-from-file paths.txt && git commit -m "x" -- new.md`,
				),
			).toContain("#1612");
		});

		it("records nothing off the list under -n, which stages nothing (mantahostels#3324)", () => {
			newFile("new.md");
			listFile("paths.txt", ["new.md"]);
			expect(
				run(
					`git add -nN --pathspec-from-file paths.txt && git commit -m "x" -- new.md`,
				),
			).toContain("#1612");
		});

		it("does not record an IGNORED file under a directory line without -f (mantahostels#3324)", () => {
			fs.writeFileSync(path.join(shared, ".gitignore"), "*.log\n");
			newFile("src/x.log");
			listFile("paths.txt", ["src"]);
			expect(
				run(
					`git add -N --pathspec-from-file paths.txt && git commit -m "x" -- src/x.log`,
				),
			).toContain("#1612");
		});

		it("records nothing off a list an earlier segment redirects into (mantahostels#3327)", () => {
			// The list on disk names new.md and the command overwrites it before git
			// reads it, so the guard opens bytes git never sees. Crediting them
			// suppresses the warn on a commit that leaves new.md behind.
			newFile("new.md");
			listFile("paths.txt", ["new.md"]);
			expect(
				run(
					`printf 'other.md\\n' > paths.txt && git add -N --pathspec-from-file paths.txt && git commit -m "x" -- new.md`,
				),
			).toContain("#1612");
			expect(logged()).toMatch(
				/is rewritten by a redirect in the same command/,
			);
		});

		it("still suppresses where the redirect names some other file (mantahostels#3327)", () => {
			newFile("new.md");
			listFile("paths.txt", ["new.md"]);
			const out = run(
				`printf 'x\\n' > log.txt && git add -N --pathspec-from-file paths.txt && git commit -m "x" -- ${doc} new.md`,
			);
			expect(out).not.toContain("#1612");
		});

		it("still suppresses through a list the command APPENDS to (mantahostels#3327)", () => {
			// `>>` can only add pathspecs, so what the guard read is a subset of what
			// git stages and the suppression stands.
			newFile("new.md");
			listFile("paths.txt", ["new.md"]);
			const out = run(
				`printf 'other.md\\n' >> paths.txt && git add -N --pathspec-from-file paths.txt && git commit -m "x" -- ${doc} new.md`,
			);
			expect(out).not.toContain("#1612");
		});

		it("treats a redirect target it cannot read as the list itself (mantahostels#3327)", () => {
			newFile("new.md");
			listFile("paths.txt", ["new.md"]);
			expect(
				run(
					`printf 'x\\n' > $LIST && git add -N --pathspec-from-file paths.txt && git commit -m "x" -- new.md`,
				),
			).toContain("#1612");
		});

		it("reads the >| spelling as a clobber into the list (mantahostels#3327)", () => {
			newFile("new.md");
			listFile("paths.txt", ["new.md"]);
			expect(
				run(
					`printf 'other.md\\n' >| paths.txt && git add -N --pathspec-from-file paths.txt && git commit -m "x" -- new.md`,
				),
			).toContain("#1612");
		});

		it("reads a redirect written with no space before its target (mantahostels#3327)", () => {
			// `echo other.md>paths.txt` is one word to this guard and two to bash.
			newFile("new.md");
			listFile("paths.txt", ["new.md"]);
			expect(
				run(
					`echo other.md>paths.txt && git add -N --pathspec-from-file paths.txt && git commit -m "x" -- new.md`,
				),
			).toContain("#1612");
		});

		it("reads an ABSOLUTE redirect target, which no basename arm catches (mantahostels#3327)", () => {
			newFile("new.md");
			listFile("paths.txt", ["new.md"]);
			expect(
				run(
					`printf 'other.md\\n' > ${path.join(shared, "paths.txt")} && git add -N --pathspec-from-file paths.txt && git commit -m "x" -- new.md`,
				),
			).toContain("#1612");
		});

		it("reads a descriptor-prefixed redirect into the list (mantahostels#3327)", () => {
			// `2> paths.txt` writes no pathspec list in practice; reading it costs a
			// false warn, and not reading the prefix at all would cost a lost one.
			newFile("new.md");
			listFile("paths.txt", ["new.md"]);
			expect(
				run(
					`printf 'x\\n' 2> paths.txt && git add -N --pathspec-from-file paths.txt && git commit -m "x" -- new.md`,
				),
			).toContain("#1612");
		});

		it("matches a redirect target by name where it resolves elsewhere (mantahostels#3327)", () => {
			// The redirect names `../paths.txt` against a list read from `sub/`, so
			// the two never compare equal as paths.
			fs.mkdirSync(path.join(shared, "sub"), { recursive: true });
			newFile("sub/new.md");
			listFile("sub/paths.txt", ["new.md"]);
			expect(
				run(
					`printf 'x\\n' > ../paths.txt && git -C ${path.join(shared, "sub")} add -N --pathspec-from-file paths.txt && git commit -m "x" -- sub/new.md`,
				),
			).toContain("#1612");
		});
	});

	describe("D2 — mantahostels#1651's verdict is deferred to the emission foot", () => {
		/** A tracked, modified file and an untracked sibling under `src/`. */
		const mixedDir = () => {
			fs.mkdirSync(path.join(shared, "src"), { recursive: true });
			fs.writeFileSync(path.join(shared, "src", "old.md"), "old\n");
			git(shared, "add", "src/old.md");
			git(shared, "commit", "-qm", "src");
			fs.writeFileSync(path.join(shared, "src", "old.md"), "edited\n");
			newFile("src/new.md");
		};

		it("loses to mantahostels#1612 in a later segment", () => {
			mixedDir();
			newFile("loose.md");
			const out = run(
				'git commit -m "x" -- src && git commit -m "y" -- loose.md',
			);
			expect(out).toContain("#1612");
			expect(out).not.toContain("#1651");
		});

		it("still fires where nothing later claims the slot", () => {
			mixedDir();
			expect(run('git commit -m "x" -- src')).toContain("#1651");
		});

		it("still binds in a linked worktree, where the walk returns early", () => {
			fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
			fs.writeFileSync(path.join(worktree, "src", "old.md"), "old\n");
			git(worktree, "add", "src/old.md");
			git(worktree, "commit", "-qm", "src");
			fs.writeFileSync(path.join(worktree, "src", "old.md"), "edited\n");
			fs.writeFileSync(path.join(worktree, "src", "new.md"), "new\n");
			expect(run('git commit -m "x" -- src', worktree)).toContain("#1651");
		});

		it("still loses to mantahostels#1612, which is decided before it", () => {
			mixedDir();
			newFile("loose.md");
			const out = run('git commit -m "x" -- src loose.md');
			expect(out).toContain("#1612");
			expect(out).not.toContain("#1651");
		});
	});
});

describe("the doc-map rule's scope", () => {
	it("is the pattern .husky/pre-commit arms check-doc-map.js on", () => {
		const own = /const DOC_MAP_SCOPE =\s*\/(.+)\/;/.exec(
			fs.readFileSync(path.resolve(__dirname, "commit-form.js"), "utf8"),
		);
		expect(own?.[1]).toBe(
			new RegExp(armingPattern("scripts/check-doc-map.js")).source,
		);
	});
});
