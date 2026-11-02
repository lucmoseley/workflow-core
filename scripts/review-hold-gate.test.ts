// @vitest-environment node
/*
 * Pins the pre-commit hold on a declared sensitive path (#1622, spec #1612
 * §The hold): a session's shared-tree commit touching a declared glob is
 * refused until its `.codereview-pass-<sid>` marker records an escalated tier,
 * every matched area and the exact tree the commit carries. Break it and
 * unreviewed sensitive code lands on the shared `main`, where any neighbour's
 * push publishes it, or every session commit on a declared path is refused
 * with no way out. A linked worktree is refused nothing, but a marker that
 * would pass still leaves the trailer's stamp (#3714).
 *
 * Driven through real `git commit`s in a throwaway repo whose pre-commit hook
 * runs the live script, because the hold reads the index git builds for the
 * commit, which no stub reproduces; its wiring into `.husky/pre-commit` and the
 * adopter skeleton is read off those files.
 * `tree=` comes from `commit-paths.js --tree`, as review-hold.txt hands it to a
 * session, so a drift between that computation and the hook's fails here; the
 * Stop backstop and push guard read the same marker, so they are run on it too.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ledgerHead } from "./lib/arbiter-testkit";
import { mkScratchDir } from "./lib/git-fixture";
import { coreCall, HOOK } from "./lib/precommit-gate-testkit";
import { reviewSuffix } from "./lib/review-suffix";
import { runInProcess } from "./lib/run-in-process";
import { readShellConst } from "./lib/shell-const-testkit";

const GATE = path.resolve(__dirname, "review-hold-gate.sh");
const HOOK_ROOT = path.resolve(__dirname, "lib", "hook-root.sh");
const COMMIT_PATHS = path.resolve(__dirname, "commit-paths.js");
const MARKER_LIB = path.resolve(__dirname, "lib", "concision-marker.sh");
const BACKSTOP = path.resolve(__dirname, "concision-backstop.sh");
const DISPATCH = path.resolve(__dirname, "guard-dispatch.js");
const ARBITER = path.resolve(__dirname, "session-arbiter.js");
const WRITE_MARKER = path.resolve(__dirname, "write-review-marker.js");
const WIRING = `${coreCall("bash", "scripts/review-hold-gate.sh")} || exit "$?"`;
const SID = "session-under-test";
/** code-signal.sh's review floor: a change over it owes a review. */
const CODE_THRESHOLD = readShellConst(
	path.join(__dirname, "lib", "code-signal.sh"),
	"CODE_THRESHOLD",
);
const SECRET = "lib/secret.js";
const PRICE = "lib/pricing/quote.ts";
const PLAIN = "app/page.tsx";
/** Every area the seed declares, as a refusal lists them. */
const ALL_AREAS = "money, rewards, secrets";

let scratch: string;
let repo: string;
let hooks: string;

const marker = () =>
	path.join(repo, ".claude", "tmp", "markers", `.codereview-pass-${SID}`);

const quietEnv = () => {
	const env: Record<string, string | undefined> = {
		...process.env,
		CLAUDE_CODE_SESSION_ID: "",
		CLAUDE_CONFIG_DIR: scratch,
		// Off: commit-paths runs the mutation hold before the lock on these
		// sensitive paths (#1910), and the fixture has no Stryker.
		WFC_MODULES: process.env.WFC_MODULES?.split(",")
			.filter((m) => m !== "mutation")
			.join(","),
	};
	delete env.CLAUDE_PROJECT_DIR;
	delete env.GIT_INDEX_FILE;
	return env;
};

const git = (...args: string[]) => {
	const r = spawnSync("git", args, {
		cwd: repo,
		encoding: "utf8",
		env: quietEnv(),
	});
	if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
	return r.stdout.trim();
};
const write = (rel: string, text: string, root = repo) => {
	fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
	fs.writeFileSync(path.join(root, rel), text);
};
/**
 * Runs `call` with concision-marker.sh sourced and `args` as its positional
 * parameters. `env` is laid over `quietEnv()`, so it adds or overrides
 * variables and never drops the isolation; with no `input`, stdin is empty.
 */
const runMarkerLib = (
	call: string,
	args: string[],
	opts: { input?: string; env?: NodeJS.ProcessEnv } = {},
) =>
	spawnSync("bash", ["-c", `source "${MARKER_LIB}" && ${call}`, "_", ...args], {
		cwd: repo,
		encoding: "utf8",
		input: opts.input,
		env: { ...quietEnv(), ...opts.env },
	});

/** Any git command under the fixture's hooks, as a session runs it. */
const hookedGit = (
	args: string[],
	{ sid = SID, cwd = repo, projectDir = "" } = {},
) => {
	const env: Record<string, string | undefined> = {
		...quietEnv(),
		CLAUDE_CODE_SESSION_ID: sid,
		...(projectDir ? { CLAUDE_PROJECT_DIR: projectDir } : {}),
	};
	delete env.GIT_REFLOG_ACTION;
	return spawnSync("git", ["-c", `core.hooksPath=${hooks}`, ...args], {
		cwd,
		encoding: "utf8",
		env,
	});
};

/** A pathspec commit, as commit-paths.js makes; with no paths, the index as staged. */
const commit = (paths: string[], opts: Parameters<typeof hookedGit>[1] = {}) =>
	hookedGit(
		["commit", "-qm", "land", ...(paths.length > 0 ? ["--", ...paths] : [])],
		opts,
	);

/** What `commit-paths.js --tree` prints, the tree review-hold.txt names. */
const treeOf = (args: string[], cwd = repo) => {
	const r = runInProcess(COMMIT_PATHS, ["--tree", ...args], {
		cwd,
		env: quietEnv(),
	});
	expect(r.stderr).toBe("");
	expect(r.status).toBe(0);
	return r.stdout.trim();
};

const mark = (
	lines: Record<string, string>,
	base = git("rev-parse", "HEAD"),
) => {
	fs.mkdirSync(path.dirname(marker()), { recursive: true });
	fs.writeFileSync(
		marker(),
		`base=${base}\nfindings=2\n${Object.entries(lines)
			.map(([k, v]) => `${k}=${v}\n`)
			.join("")}`,
	);
};

/**
 * Commits a five-line SECRET, edits its first and last lines, and returns a
 * patch holding the first hunk alone.
 */
const halfPatch = () => {
	write(SECRET, "line 1\nline 2\nline 3\nline 4\nline 5\n");
	git("commit", "-qam", "five lines");
	write(SECRET, "line 1 mine\nline 2\nline 3\nline 4\nline 5 theirs\n");
	const patch = path.join(scratch, "mine.patch");
	const full = git("diff", "HEAD", "-U0", "--", SECRET);
	fs.writeFileSync(patch, `${full.split("\n@@ -5")[0]}\n`);
	return patch;
};

/** A `commit-paths.js --patch` commit, this file's pre-commit hook wired. */
const commitPatch = (patch: string, whole: string[]) =>
	runInProcess(
		COMMIT_PATHS,
		[
			"-m",
			"mine",
			"--patch",
			patch,
			...(whole.length > 0 ? ["--", ...whole] : []),
		],
		{
			cwd: repo,
			env: {
				...quietEnv(),
				CLAUDE_CODE_SESSION_ID: SID,
				GIT_CONFIG_COUNT: "1",
				GIT_CONFIG_KEY_0: "core.hooksPath",
				GIT_CONFIG_VALUE_0: hooks,
			},
		},
	);

/**
 * write-review-marker.js's marker for halfPatch's SECRET hunk plus PRICE
 * whole, after leaving the review artefacts it demands; their suffix is
 * SID's first eight characters, as lib/review-suffix.sh cuts it.
 */
const writeMarker = (patch: string) => {
	leaveArtefacts();
	return runInProcess(
		WRITE_MARKER,
		[
			"--base",
			"HEAD",
			"--findings",
			"0",
			"--tier",
			"escalated",
			"--areas",
			"money,secrets",
			"--paths",
			`${SECRET},${PRICE}`,
			"--patch",
			patch,
		],
		{ cwd: repo, env: { ...quietEnv(), CLAUDE_CODE_SESSION_ID: SID } },
	);
};

const commitCount = () => git("rev-list", "--count", "HEAD");

/** Leaves the artefacts an escalated review owes, suffixed as SID's. */
const leaveArtefacts = (dir = path.join(repo, ".claude", "tmp")) => {
	fs.mkdirSync(dir, { recursive: true });
	for (const axis of ["standards", "spec", "focus"])
		fs.writeFileSync(
			path.join(dir, `review-${axis}${reviewSuffix(SID)}.md`),
			"- none\n",
		);
};

const expectRefused = (
	r: ReturnType<typeof commit>,
	fault: string,
	commits = "1",
) => {
	expect(r.status).toBe(1);
	expect(r.stderr).toContain(fault);
	expect(r.stderr).toContain("A COMMIT ON A DECLARED SENSITIVE PATH IS HELD");
	expect(r.stderr).toContain("rule:review-hold");
	expect(commitCount()).toBe(commits);
};

beforeEach(() => {
	scratch = mkScratchDir("review-hold-gate-");
	repo = path.join(scratch, "repo");
	fs.mkdirSync(repo);
	hooks = path.join(scratch, "hooks");
	git("init", "-q", "-b", "main");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");
	write(
		".claude/workflow-core.json",
		JSON.stringify({
			sensitivePaths: [
				{
					name: "secrets",
					description: "credentials",
					globs: ["lib/secret.js"],
				},
				{
					name: "money",
					description: "what a guest pays",
					globs: ["lib/pricing/**"],
				},
				{ name: "rewards", description: "reward-code redemption" },
			],
		}),
	);
	write(SECRET, "old\n");
	write(PRICE, "old\n");
	write(PLAIN, "old\n");
	git("add", "-A");
	git("commit", "-qm", "seed");
	fs.mkdirSync(hooks, { recursive: true });
	fs.writeFileSync(
		path.join(hooks, "pre-commit"),
		`#!/bin/sh\nexec bash "${GATE}"\n`,
		{ mode: 0o755 },
	);
});

afterEach(() => {
	fs.rmSync(scratch, { recursive: true, force: true });
});

describe("review-hold-gate.sh — wiring", () => {
	it("is wired into .husky/pre-commit, through the plugin root an adopter's shim sets", () => {
		expect(HOOK.split("\n")).toContain(WIRING);
	});
});

describe("review-hold-gate.sh — refusals", () => {
	it("refuses a staged sensitive glob with no marker, naming the area and the rule", () => {
		write(SECRET, "new\n");
		const r = commit([SECRET]);
		expectRefused(r, "there is no marker");
		expect(r.stderr).toContain("Areas touched: secrets.");
	});

	it("refuses a standard tier, naming it", () => {
		write(SECRET, "new\n");
		mark({ tier: "standard", areas: "secrets", tree: treeOf(["--", SECRET]) });
		expectRefused(commit([SECRET]), "its tier= is 'standard'");
	});

	it("refuses a marker with no tier= line, as a standard review's marker has", () => {
		write(SECRET, "new\n");
		mark({});
		expectRefused(commit([SECRET]), "it has no tier= line");
	});

	it("refuses a marker whose areas= misses a matched area, naming the missing one", () => {
		write(SECRET, "new\n");
		write(PRICE, "new\n");
		mark({
			tier: "escalated",
			areas: "secrets",
			tree: treeOf(["--", SECRET, PRICE]),
		});
		const r = commit([SECRET, PRICE]);
		expectRefused(r, "its areas= does not name money.");
		expect(r.stderr).toContain("Areas touched: money, secrets.");
	});

	it("refuses a stale tree= after an edit made once the marker was written", () => {
		write(SECRET, "reviewed\n");
		mark({ tier: "escalated", areas: "secrets", tree: treeOf(["--", SECRET]) });
		write(SECRET, "edited after review\n");
		expectRefused(
			commit([SECRET]),
			"its tree= is not the tree this commit carries",
		);
	});

	it("refuses a marker with no paths= line, which the Stop nag would read as a review of every path", () => {
		write(SECRET, "new\n");
		mark({ tier: "escalated", areas: "secrets", tree: treeOf(["--", SECRET]) });
		expectRefused(commit([SECRET]), "it has no paths= line");
	});

	it("refuses a marker whose paths= line names nothing, saying so", () => {
		write(SECRET, "new\n");
		mark({
			tier: "escalated",
			areas: "secrets",
			tree: treeOf(["--", SECRET]),
			paths: " , ",
		});
		expectRefused(commit([SECRET]), "its paths= names no path");
	});

	it("refuses a marker whose paths= misses a path the commit changes, naming it", () => {
		write(SECRET, "new\n");
		write(PLAIN, "new\n");
		mark({
			tier: "escalated",
			areas: "secrets",
			tree: treeOf(["--", SECRET, PLAIN]),
			paths: SECRET,
		});
		expectRefused(
			commit([SECRET, PLAIN]),
			`its paths= does not name ${PLAIN}.`,
		);
	});

	it("refuses a --patch commit whose whole path changed after write-review-marker.js wrote its marker", () => {
		const patch = halfPatch();
		write(PRICE, "new\n");
		expect(writeMarker(patch).status).toBe(0);
		write(PRICE, "newer\n");
		const r = commitPatch(patch, [PRICE]);
		expect(r.status).not.toBe(0);
		expect(r.stderr).toContain("its tree= is not the tree this commit carries");
		expect(r.stderr).toContain("rule:review-hold");
		expect(commitCount()).toBe("2");
	});
});

describe("review-hold-gate.sh — the declaration it reads", () => {
	const readDeclared = () =>
		JSON.parse(
			fs.readFileSync(path.join(repo, ".claude/workflow-core.json"), "utf8"),
		);

	it("still holds when the working-tree declaration drops the area unstaged", () => {
		write(".claude/workflow-core.json", JSON.stringify({ sensitivePaths: [] }));
		write(SECRET, "new\n");
		expectRefused(commit([SECRET]), "there is no marker");
	});

	it("still holds when the working-tree declaration is broken unstaged", () => {
		write(".claude/workflow-core.json", "{ not json");
		write(SECRET, "new\n");
		expectRefused(commit([SECRET]), "there is no marker");
	});

	it("holds an area the staged declaration adds", () => {
		write(
			".claude/workflow-core.json",
			JSON.stringify({
				sensitivePaths: [
					...readDeclared().sensitivePaths,
					{ name: "pages", description: "the app", globs: ["app/**"] },
				],
			}),
		);
		write(PLAIN, "new\n");
		const r = commit([PLAIN, ".claude/workflow-core.json"]);
		expectRefused(r, "there is no marker");
		expect(r.stderr).toContain("Areas touched: pages.");
	});

	const Config = ".claude/workflow-core.json";
	const withMoney = (globs: string[]) =>
		JSON.stringify({
			sensitivePaths: readDeclared().sensitivePaths.map(
				(a: { name: string }) => (a.name === "money" ? { ...a, globs } : a),
			),
		});

	it.each([
		["empties the file", () => write(Config, "{}"), ALL_AREAS],
		[
			"declares none",
			() => write(Config, JSON.stringify({ sensitivePaths: [] })),
			ALL_AREAS,
		],
		["no longer parses", () => write(Config, "{ not json"), ALL_AREAS],
		["is deleted", () => fs.rmSync(path.join(repo, Config)), ALL_AREAS],
		["drops a glob", () => write(Config, withMoney([])), "money"],
		[
			"swaps a glob for another",
			() => write(Config, withMoney(["lib/pricing/x/**"])),
			"money",
		],
		[
			"removes a globless area",
			() =>
				write(
					Config,
					JSON.stringify({
						sensitivePaths: readDeclared().sensitivePaths.filter(
							(a: { name: string }) => a.name !== "rewards",
						),
					}),
				),
			"rewards",
		],
	])(
		"holds a commit whose declaration %s, under what it drops (#3905)",
		(_, edit, areas) => {
			edit();
			const r = commit([Config]);
			expectRefused(r, "there is no marker");
			expect(r.stderr).toContain(`Areas touched: ${areas}.`);
		},
	);

	it("names the fault of a staged declaration that will not parse (#3905)", () => {
		write(Config, "{ not json");
		expect(commit([Config]).stderr).toContain(
			"The staged .claude/workflow-core.json will not read",
		);
	});

	it("clears a narrowing commit on a marker naming what it drops", () => {
		write(Config, withMoney([]));
		mark({
			tier: "escalated",
			areas: "money",
			tree: treeOf(["--", Config]),
			paths: Config,
		});
		expect(commit([Config]).status).toBe(0);
	});

	it("leaves alone a commit that only widens a glob list", () => {
		write(Config, withMoney(["lib/pricing/**", "lib/quotes/**"]));
		expect(commit([Config]).status).toBe(0);
	});

	it("does not take a reordering of the declaration for a narrowing", () => {
		const cfg = readDeclared();
		write(
			Config,
			JSON.stringify({
				...cfg,
				sensitivePaths: [...cfg.sensitivePaths].reverse(),
			}),
		);
		expect(commit([Config]).status).toBe(0);
	});
});

describe("review-hold-gate.sh — a replay's own bytes pass, anything added is held (#3905)", () => {
	const hookEnv = () => {
		const env: Record<string, string | undefined> = {
			...quietEnv(),
			CLAUDE_CODE_SESSION_ID: SID,
			GIT_EDITOR: "true",
		};
		delete env.GIT_REFLOG_ACTION;
		return env;
	};
	const hooked = (...args: string[]) =>
		spawnSync("git", ["-c", `core.hooksPath=${hooks}`, ...args], {
			cwd: repo,
			encoding: "utf8",
			env: hookEnv(),
		});

	/**
	 * A commit on a side branch writing `theirs` over each path, and one on main
	 * writing `mine` over `conflicting`; returns the side commit.
	 */
	const divergedPick = (paths: string[], conflicting: string[]) => {
		git("checkout", "-qb", "side");
		for (const p of paths) write(p, "theirs\n");
		git("add", "-A");
		git("commit", "-qm", "theirs");
		const pick = git("rev-parse", "HEAD");
		git("checkout", "-q", "main");
		for (const p of conflicting) write(p, "mine\n");
		if (conflicting.length > 0) {
			git("add", "-A");
			git("commit", "-qm", "mine");
		}
		return pick;
	};
	/** Starts the pick unhooked, stopping on its conflict. */
	const stopOnConflict = (pick: string) =>
		expect(
			spawnSync("git", ["cherry-pick", pick], {
				cwd: repo,
				encoding: "utf8",
				env: quietEnv(),
			}).status,
		).toBe(1);
	const resolve = (rel: string, text: string) => {
		write(rel, text);
		git("add", "--", rel);
	};
	const held = (r: ReturnType<typeof commit>, before: string) =>
		expectRefused(r, "there is no marker", before);

	it.each([
		["git commit", ["commit", "-qm", "land"]],
		["git cherry-pick --continue", ["cherry-pick", "--continue"]],
	])(
		"holds a conflict on a glob resolved with new bytes, through %s",
		(_, args) => {
			stopOnConflict(divergedPick([SECRET], [SECRET]));
			resolve(SECRET, "SNEAK\n");
			const before = commitCount();
			held(hooked(...args), before);
			expect(fs.existsSync(path.join(repo, ".git", "CHERRY_PICK_HEAD"))).toBe(
				true,
			);
		},
	);

	it("holds bytes added on a glob the picked commit never touched", () => {
		stopOnConflict(divergedPick([PLAIN], [PLAIN]));
		resolve(PLAIN, "resolved\n");
		resolve(SECRET, "SNEAK\n");
		const before = commitCount();
		held(hooked("commit", "-qm", "land"), before);
	});

	it("holds an extra edit to a glob the picked commit changed cleanly", () => {
		stopOnConflict(divergedPick([PLAIN, SECRET], [PLAIN]));
		resolve(PLAIN, "resolved\n");
		resolve(SECRET, "theirs\nSNEAK\n");
		const before = commitCount();
		held(hooked("commit", "-qm", "land"), before);
	});

	it("passes a conflict off the globs, its glob change as the picked commit made it", () => {
		stopOnConflict(divergedPick([PLAIN, SECRET], [PLAIN]));
		resolve(PLAIN, "resolved\n");
		const r = hooked("commit", "-qm", "land");
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
	});

	it("passes a pick whose context drifted, its own change unaltered", () => {
		write(SECRET, "a\nb\nc\nd\ne\nf\ng\n");
		git("add", "-A");
		git("commit", "-qm", "seven lines");
		git("checkout", "-qb", "side");
		write(SECRET, "a\nb\nc\nd\ne\nf\nG\n");
		git("add", "-A");
		git("commit", "-qm", "theirs");
		const pick = git("rev-parse", "HEAD");
		git("checkout", "-q", "main");
		write(SECRET, "A\nb\nc\nd\ne\nf\ng\n");
		write(PLAIN, "mine\n");
		git("add", "-A");
		git("commit", "-qm", "mine");
		spawnSync("git", ["cherry-pick", "--no-commit", pick], {
			cwd: repo,
			env: quietEnv(),
		});
		fs.writeFileSync(path.join(repo, ".git", "CHERRY_PICK_HEAD"), `${pick}\n`);
		const r = hooked("commit", "-qm", "land");
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
	});

	it("passes a clean pick of a glob change, with no marker", () => {
		const pick = divergedPick([SECRET], []);
		const r = hooked("cherry-pick", pick);
		expect(r.status).toBe(0);
		expect(git("show", "HEAD:lib/secret.js")).toBe("theirs");
	});

	describe("on the replay path, which reaches no pre-commit", () => {
		beforeEach(() => {
			fs.rmSync(path.join(hooks, "pre-commit"));
			fs.writeFileSync(
				path.join(hooks, "prepare-commit-msg"),
				`#!/bin/sh\nexec bash "${GATE}"\n`,
				{ mode: 0o755 },
			);
		});

		it("passes a clean pick of a glob change, with no marker", () => {
			const r = hooked("cherry-pick", divergedPick([SECRET], []));
			expect(r.stderr).toBe("");
			expect(r.status).toBe(0);
			expect(git("show", `HEAD:${SECRET}`)).toBe("theirs");
		});

		it("holds --no-verify at a stopped pick on what it added", () => {
			stopOnConflict(divergedPick([SECRET], [SECRET]));
			resolve(SECRET, "SNEAK\n");
			const before = commitCount();
			const r = hooked("commit", "-qm", "land", "--no-verify");
			expect(r.status).toBe(1);
			expect(r.stderr).toContain("rule:review-hold");
			expect(commitCount()).toBe(before);
		});
	});

	it("clears a held pick on a marker for what it now carries", () => {
		stopOnConflict(divergedPick([SECRET], [SECRET]));
		resolve(SECRET, "reviewed\n");
		leaveArtefacts();
		const w = runInProcess(
			WRITE_MARKER,
			[
				"--base",
				"HEAD",
				"--findings",
				"0",
				"--tier",
				"escalated",
				"--areas",
				"secrets",
				"--paths",
				SECRET,
			],
			{ cwd: repo, env: { ...quietEnv(), CLAUDE_CODE_SESSION_ID: SID } },
		);
		expect(w.stderr).toBe("");
		const r = hooked("commit", "-qm", "land");
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
	});

	it.each(["rebase-merge", "rebase-apply"])(
		"holds a commit made with a %s directory beside it",
		(dir) => {
			fs.mkdirSync(path.join(repo, ".git", dir));
			write(SECRET, "new\n");
			git("add", "--", SECRET);
			const before = commitCount();
			held(hooked("commit", "-qm", "land"), before);
		},
	);

	it("refuses nothing on a replay in a linked worktree", () => {
		const wt = path.join(scratch, "wt");
		const pick = divergedPick([SECRET], []);
		git("worktree", "add", "-q", "--detach", wt, "HEAD");
		write(SECRET, "mine\n", wt);
		git("-C", wt, "commit", "-qam", "mine");
		spawnSync("git", ["-C", wt, "cherry-pick", pick], { env: quietEnv() });
		write(SECRET, "resolved\n", wt);
		git("-C", wt, "add", "--", SECRET);
		const r = spawnSync(
			"git",
			["-C", wt, "-c", `core.hooksPath=${hooks}`, "commit", "-qm", "land"],
			{ encoding: "utf8", env: hookEnv() },
		);
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
	});
});

describe("review-hold-gate.sh — passes", () => {
	it("passes a pathspec commit whose marker matches, with something else staged in the shared index", () => {
		write(PLAIN, "staged by someone else\n");
		git("add", "--", PLAIN);
		write(SECRET, "new\n");
		write(PRICE, "new\n");
		const tree = treeOf(["--", SECRET, PRICE]);
		mark({
			tier: "escalated",
			areas: "money, secrets",
			tree,
			paths: `${SECRET}, ${PRICE}`,
		});
		const r = commit([SECRET, PRICE]);
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
		expect(git("rev-parse", "HEAD^{tree}")).toBe(tree);
	});

	it("passes an index commit whose tree= is git write-tree's, at the mission-critical tier", () => {
		write(SECRET, "new\n");
		git("add", "--", SECRET);
		mark({
			tier: "mission-critical",
			areas: "secrets",
			tree: git("write-tree"),
			paths: SECRET,
		});
		const r = commit([]);
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
	});

	it("passes a commit-paths.js --patch commit whose tree= commit-paths.js --tree --patch printed", () => {
		const patch = halfPatch();
		mark({
			tier: "escalated",
			areas: "secrets",
			tree: treeOf(["--patch", patch]),
			paths: SECRET,
		});
		const r = commitPatch(patch, []);
		expect(r.stderr).not.toContain("review hold");
		expect(r.status).toBe(0);
		expect(git("show", `HEAD:${SECRET}`)).toBe(
			"line 1 mine\nline 2\nline 3\nline 4\nline 5",
		);
	});

	it("passes a --patch commit with a whole path beside it on the marker write-review-marker.js wrote, unedited (#2647)", () => {
		const patch = halfPatch();
		write(PRICE, "new\n");
		const w = writeMarker(patch);
		expect(w.stderr).toBe("");
		expect(w.status).toBe(0);
		const r = commitPatch(patch, [PRICE]);
		expect(r.stderr).not.toContain("review hold");
		expect(r.status).toBe(0);
		expect(git("show", `HEAD:${SECRET}`)).toBe(
			"line 1 mine\nline 2\nline 3\nline 4\nline 5",
		);
		expect(git("show", `HEAD:${PRICE}`)).toBe("new");
	});

	it("passes a commit with no session id", () => {
		write(SECRET, "new\n");
		const r = commit([SECRET], { sid: "" });
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
	});

	it("passes a commit in a linked worktree with no marker, in silence (#3714)", () => {
		const wt = path.join(scratch, "wt");
		git("worktree", "add", "-q", "--detach", wt);
		write(SECRET, "new\n", wt);
		const r = commit([SECRET], { cwd: wt });
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
	});

	it("leaves a commit touching no glob alone, with no marker", () => {
		write(PLAIN, "new\n");
		const r = commit([PLAIN]);
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
	});
});

describe("review-hold-gate.sh — the marker's other readers", () => {
	const code = Array.from(
		{ length: CODE_THRESHOLD + 1 },
		(_, i) => `export const x${i} = ${i};\n`,
	).join("");
	const hookEnv = (root = repo) => ({
		...quietEnv(),
		CLAUDE_PROJECT_DIR: root,
		TMPDIR: scratch,
	});
	const authored = (rel: string, body: string, root = repo) => {
		write(rel, body, root);
		const r = runInProcess(ARBITER, ["record", rel, SID], {
			env: hookEnv(root),
		});
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
	};
	type Author = "this session" | "a neighbour";
	/** Write `rel`, recorded as this session's own edit or left a neighbour's. */
	const writeAs = (by: Author, rel: string, body: string) =>
		by === "this session" ? authored(rel, body) : write(rel, body);
	const stopNag = (root = repo) => {
		const r = spawnSync(BACKSTOP, ["stop"], {
			cwd: root,
			encoding: "utf8",
			input: JSON.stringify({ session_id: SID }),
			env: hookEnv(root),
		});
		return r.stdout.trim() ? (JSON.parse(r.stdout).reason as string) : "";
	};
	const expectStopClear = () => {
		const reason = stopNag();
		expect(reason).not.toContain("without a review");
		expect(reason).not.toContain("was rejected");
	};
	const pushWarn = () => {
		const r = runInProcess(DISPATCH, ["--only", "guard-push-rules"], {
			cwd: repo,
			stdin: JSON.stringify({
				hook_event_name: "PreToolUse",
				session_id: SID,
				tool_name: "Bash",
				tool_input: { command: "git push origin main" },
			}),
			env: hookEnv(),
		});
		return r.stdout.trim()
			? (JSON.parse(r.stdout).hookSpecificOutput?.additionalContext ?? "")
			: "";
	};
	/** Records this session's start point, as concision-backstop.sh's `start` does. */
	const startHere = () => {
		const start = git("rev-parse", "HEAD");
		fs.mkdirSync(path.dirname(marker()), { recursive: true });
		fs.writeFileSync(
			path.join(path.dirname(marker()), `.concision-base-${SID}`),
			start,
		);
		return start;
	};
	const markWith = (base: string, paths = PRICE) =>
		mark(
			{
				tier: "escalated",
				areas: "money",
				tree: treeOf(["--", PRICE]),
				paths,
			},
			base,
		);

	/*
	 * #1745 F1: a staged review diffs HEAD, so its marker's `base=` is HEAD and
	 * vouches for nothing committed before it.
	 */
	describe("a staged-review marker, after an earlier commit", () => {
		/**
		 * Start, commit `lib/earlier.ts` (as this session, or as a neighbour),
		 * change a sensitive path; returns the start point.
		 */
		const session = (earlierBy: Author) => {
			const start = startHere();
			writeAs(earlierBy, "lib/earlier.ts", code);
			// What commit-paths.js does for a new file.
			git("add", "-N", "lib/earlier.ts");
			expect(commit(["lib/earlier.ts"]).status).toBe(0);
			// What post-commit does; an unledgered commit is nobody's (#3108).
			if (earlierBy === "this session")
				ledgerHead(repo, { ...hookEnv(), CLAUDE_CODE_SESSION_ID: SID });
			authored(PRICE, code);
			return start;
		};

		it("passes the hold but leaves the Stop nag and the push warning owed for this session's earlier commit where base= is HEAD", () => {
			session("this session");
			markWith(git("rev-parse", "HEAD"));
			const r = commit([PRICE]);
			expect(r.stderr).toBe("");
			expect(r.status).toBe(0);
			expect(stopNag()).toContain("ahead of this session's start point");
			expect(pushWarn()).toContain("ahead of this session's start point");
		});

		it("passes the hold, the Stop nag and the push warning where base= is HEAD and the earlier commit is a neighbour's", () => {
			session("a neighbour");
			markWith(git("rev-parse", "HEAD"));
			const r = commit([PRICE]);
			expect(r.stderr).toBe("");
			expect(r.status).toBe(0);
			expectStopClear();
			expect(pushWarn()).not.toContain("no code review covers");
		});

		it("passes the Stop nag and the push warning where base= is the start point a review covering the earlier commit used", () => {
			markWith(session("this session"), `lib/earlier.ts, ${PRICE}`);
			expect(commit([PRICE]).status).toBe(0);
			expectStopClear();
			expect(pushWarn()).not.toContain("no code review covers");
		});

		// #1840 F1: without paths= nothing bounds what a staged review vouches for.
		it("leaves the Stop nag owed where base= is HEAD, the earlier commit is a neighbour's and the marker has no paths=", () => {
			session("a neighbour");
			mark({ tier: "escalated", areas: "money", tree: treeOf(["--", PRICE]) });
			const reason = stopNag();
			expect(reason).toContain(
				"its base= is ahead of this session's start point and it has no paths= line",
			);
			expect(reason).toContain("Run the code-review skill");
		});

		// The hold refuses nothing in a worktree, so there the Stop nag and the
		// push warning are the only checks a marker's fault meets.
		it("leaves the Stop nag owed in a worktree for a commit landed with a staged marker that has no paths= (#1840)", () => {
			const wt = path.join(scratch, "wt");
			git("worktree", "add", "-q", "--detach", wt);
			const markers = path.join(wt, ".claude", "tmp", "markers");
			fs.mkdirSync(markers, { recursive: true });
			fs.writeFileSync(
				path.join(markers, `.concision-base-${SID}`),
				git("rev-parse", "HEAD"),
			);
			write("lib/earlier.ts", code, wt);
			const wtGit = (...args: string[]) => git("-C", wt, ...args);
			wtGit("add", "lib/earlier.ts");
			wtGit("commit", "-qm", "neighbour");
			const reviewed = wtGit("rev-parse", "HEAD");
			authored(PRICE, code, wt);
			wtGit("add", PRICE);
			expect(commit([PRICE], { cwd: wt }).status).toBe(0);
			fs.writeFileSync(
				path.join(markers, `.codereview-pass-${SID}`),
				`base=${reviewed}\nfindings=1\ntier=escalated\nareas=money\n`,
			);
			expect(stopNag(wt)).toContain(
				"its base= is ahead of this session's start point and it has no paths= line",
			);
		});

		it("names the rejection to a session the Stop nag already fired on at the escalated tier (#1772)", () => {
			session("this session");
			expect(stopNag()).toContain("`escalated` review tier is owed");
			markWith(git("rev-parse", "HEAD"));
			expect(commit([PRICE]).status).toBe(0);
			const reason = stopNag();
			expect(reason).toContain("ahead of this session's start point");
			expect(reason).toContain("Run the code-review skill");
			expect(stopNag()).toBe("");
		});
	});

	/*
	 * #1769: a staged review diffs only the commit's paths, so its marker's
	 * `paths=` bounds what it vouches for.
	 */
	describe("a staged-review marker, with session code outside its commit", () => {
		const otherFile = "lib/other.ts";
		/** With `nagFirst`, the Stop nag fires before the marker is written. */
		const holdThenCommit = (otherBy: Author, { nagFirst = false } = {}) => {
			startHere();
			writeAs(otherBy, otherFile, code);
			authored(PRICE, code);
			if (nagFirst)
				expect(stopNag()).toContain("`escalated` review tier is owed");
			markWith(git("rev-parse", "HEAD"));
			const r = commit([PRICE]);
			expect(r.stderr).toBe("");
			expect(r.status).toBe(0);
		};

		it("leaves the Stop nag owed for this session's uncommitted file outside paths=, and the push warning once it is committed (#1840)", () => {
			holdThenCommit("this session");
			const reason = stopNag();
			expect(reason).toContain(`its paths= leaves out ${otherFile}`);
			expect(reason).toMatch(
				/one of the session's whole change sets base=[0-9a-f]{40}, its start point, and names every path this session wrote in paths=/,
			);
			git("add", "-N", otherFile);
			expect(commit([otherFile]).status).toBe(0);
			expect(pushWarn()).toContain(`its paths= leaves out ${otherFile}`);
		});

		it("names the rejection to a session the Stop nag already fired on at the escalated tier, once per marker written (#1772)", () => {
			holdThenCommit("this session", { nagFirst: true });
			const rejected = `its paths= leaves out ${otherFile}`;
			const reason = stopNag();
			expect(reason).toContain(rejected);
			expect(reason).toContain("Run the code-review skill");
			expect(stopNag()).toBe("");
			// A different marker, still rejected for paths=.
			mark(
				{
					tier: "mission-critical",
					areas: "money",
					tree: git("rev-parse", "HEAD^{tree}"),
					paths: PRICE,
				},
				git("rev-parse", "HEAD~1"),
			);
			expect(stopNag()).toContain(rejected);
		});

		it("passes the Stop nag where the file outside paths= is a neighbour's", () => {
			holdThenCommit("a neighbour");
			expectStopClear();
		});

		it("passes the Stop nag and the push warning where paths= names the file too", () => {
			holdThenCommit("this session");
			// A whole-session review after the commit: no hold reads its tree=.
			mark(
				{
					tier: "escalated",
					areas: "money",
					tree: git("rev-parse", "HEAD^{tree}"),
					paths: `${otherFile}, ${PRICE}`,
				},
				git("rev-parse", "HEAD~1"),
			);
			expectStopClear();
			git("add", "-N", otherFile);
			expect(commit([otherFile]).status).toBe(0);
			expect(pushWarn()).not.toContain("no code review covers");
		});
	});

	it.each([
		["a standard review's marker, without the hold's lines", ""],
		[
			"a marker carrying the hold's lines",
			"tier=escalated\nareas=secrets\ntree=abc\n",
		],
	])("leaves %s valid to pass_valid", (_, extra) => {
		const head = git("rev-parse", "HEAD");
		fs.mkdirSync(path.dirname(marker()), { recursive: true });
		fs.writeFileSync(marker(), `base=${head}\nfindings=0\n${extra}`);
		const r = runMarkerLib(`pass_valid "$1" "$2"`, [marker(), head]);
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
	});

	it.each([
		["a, c", "b\n", 0],
		["a, b, c", "", 1],
	])(
		"marker_unlisted against paths=%s prints %j and exits %i (#1840)",
		(paths, out, status) => {
			fs.mkdirSync(path.dirname(marker()), { recursive: true });
			fs.writeFileSync(marker(), `paths=${paths}\n`);
			const r = runMarkerLib(`marker_unlisted "$1" paths`, [marker()], {
				input: "a\nb\n",
			});
			expect(r.stdout).toBe(out);
			expect(r.status).toBe(status);
		},
	);

	it("marker_unlisted exits 2 where its filter faults", () => {
		const bin = path.join(scratch, "failing-grep");
		fs.mkdirSync(bin, { recursive: true });
		fs.writeFileSync(path.join(bin, "grep"), "#!/bin/sh\nexit 2\n", {
			mode: 0o755,
		});
		fs.mkdirSync(path.dirname(marker()), { recursive: true });
		fs.writeFileSync(marker(), "paths=a\n");
		const r = runMarkerLib(`marker_unlisted "$1" paths`, [marker()], {
			input: "a\nb\n",
			env: { PATH: `${bin}:${process.env.PATH}` },
		});
		expect(r.stdout).toBe("");
		expect(r.status).toBe(2);
	});
});

describe("review-tier-trailer.sh — the trailer a passing hold leaves (#3664)", () => {
	const Trailer = path.resolve(__dirname, "review-tier-trailer.sh");
	const Prepare = fs.readFileSync(
		path.resolve(__dirname, "..", ".husky", "prepare-commit-msg"),
		"utf8",
	);
	const stamp = (sid = SID) =>
		path.join(repo, ".git", `wfc-review-tier-${sid}`);
	const trailers = () =>
		git("log", "-1", "--format=%(trailers:key=Review-Tier,valueonly)");

	beforeEach(() => {
		fs.writeFileSync(
			path.join(hooks, "prepare-commit-msg"),
			`#!/bin/sh\nexec bash "${Trailer}" "$1"\n`,
			{ mode: 0o755 },
		);
	});

	describe("a tree that moves under the later gates (#3905)", () => {
		/** The hold, then a later gate during which a neighbour stages `rel`. */
		const neighbourStages = (rel: string, text: string, root = repo) => {
			const abs = path.join(root, rel);
			fs.writeFileSync(
				path.join(hooks, "pre-commit"),
				`#!/bin/sh\nbash "${GATE}" || exit "$?"\nmkdir -p "${path.dirname(abs)}"\nprintf '${text}\\n' >"${abs}"\ngit add -- "${rel}"\n`,
				{ mode: 0o755 },
			);
		};
		const markStaged = () => {
			write(SECRET, "reviewed\n");
			git("add", "--", SECRET);
			mark({
				tier: "escalated",
				areas: "secrets",
				tree: git("write-tree"),
				paths: SECRET,
			});
		};

		it("refuses a bare commit whose reviewed sensitive change gained a neighbour's file", () => {
			markStaged();
			neighbourStages(PLAIN, "neighbour");
			expectRefused(
				commit([]),
				"its tree= is not the tree this commit carries",
			);
		});

		it("refuses a bare commit whose reviewed sensitive file a neighbour re-staged", () => {
			markStaged();
			neighbourStages(SECRET, "SNEAK");
			expectRefused(
				commit([]),
				"its tree= is not the tree this commit carries",
			);
		});

		it("refuses a bare commit the hold passed off the globs, once a neighbour stages one", () => {
			write(PLAIN, "new\n");
			git("add", "--", PLAIN);
			neighbourStages(SECRET, "SNEAK");
			const r = commit([]);
			expectRefused(r, "there is no marker");
			expect(r.stderr).toContain("Areas touched: secrets.");
			expect(r.stderr).toContain("the staged tree moved");
			expect(r.stderr).toContain("commit-paths.js");
		});

		it("lets a commit off the globs go on where a neighbour's file is off them too", () => {
			write(PLAIN, "new\n");
			git("add", "--", PLAIN);
			neighbourStages("app/other.tsx", "neighbour");
			const r = commit([]);
			expect(r.stderr).toBe("");
			expect(r.status).toBe(0);
			expect(trailers()).toBe("");
			expect(fs.existsSync(stamp())).toBe(false);
		});

		it("refuses nothing in a linked worktree", () => {
			const wt = path.join(scratch, "wt");
			git("worktree", "add", "-q", "--detach", wt);
			write(PLAIN, "new\n", wt);
			git("-C", wt, "add", "--", PLAIN);
			neighbourStages(SECRET, "SNEAK", wt);
			const r = commit([], { cwd: wt, projectDir: repo });
			expect(r.stderr).toBe("");
			expect(r.status).toBe(0);
			expect(git("-C", wt, "show", `HEAD:${SECRET}`)).toBe("SNEAK");
		});
	});

	it("is run by .husky/prepare-commit-msg on each of a passing commit's exits, through the plugin root", () => {
		expect(Prepare).toMatch(
			/^ {2}trailer="\$\{WFC_PLUGIN_ROOT:-\$here\/\.\.\}\/scripts\/review-tier-trailer\.sh"$/m,
		);
		expect(Prepare.match(/^ +review_tier_trailer "\$\{1-\}"$/gm)).toHaveLength(
			3,
		);
	});

	describe("in a linked worktree (#3714)", () => {
		let wt: string;
		const readWtTrailer = () =>
			git(
				"-C",
				wt,
				"log",
				"-1",
				"--format=%(trailers:key=Review-Tier,valueonly)",
			);
		const wtStamp = () =>
			path.join(
				git("-C", wt, "rev-parse", "--absolute-git-dir"),
				`wfc-review-tier-${SID}`,
			);

		/** write-review-marker.js from the worktree, for SECRET; `env` over quietEnv(). */
		const writeWtMarker = (env: NodeJS.ProcessEnv = {}) =>
			runInProcess(
				WRITE_MARKER,
				[
					"--base",
					"HEAD",
					"--findings",
					"0",
					"--tier",
					"escalated",
					"--areas",
					"secrets",
					"--paths",
					SECRET,
				],
				{
					cwd: wt,
					env: { ...quietEnv(), CLAUDE_CODE_SESSION_ID: SID, ...env },
				},
			);

		beforeEach(() => {
			wt = path.join(scratch, "wt");
			git("worktree", "add", "-q", "--detach", wt);
		});

		it("strips the old trailer from an amend adding an unreviewed edit to a glob (#3906)", () => {
			write(SECRET, "new\n", wt);
			git("-C", wt, "add", "--", SECRET);
			mark({
				tier: "escalated",
				areas: "secrets",
				tree: git("-C", wt, "write-tree"),
				paths: SECRET,
			});
			expect(commit([], { cwd: wt, projectDir: repo }).status).toBe(0);
			expect(readWtTrailer()).toContain("escalated");
			write(SECRET, "newer\n", wt);
			git("-C", wt, "add", "--", SECRET);
			const r = hookedGit(["commit", "--amend", "--no-edit"], {
				cwd: wt,
				projectDir: repo,
			});
			expect(r.status).toBe(0);
			expect(r.stderr).toContain("no review of this commit is recorded");
			expect(readWtTrailer()).toBe("");
		});

		// The harness sets CLAUDE_PROJECT_DIR to the shared tree on every Bash
		// call, so the marker the writer leaves there is the one the gate reads.
		it("trails a commit whose marker write-review-marker.js wrote from the worktree, the host's tree unchanged", () => {
			const base = git("-C", wt, "rev-parse", "HEAD");
			write(SECRET, "new\n", wt);
			const artefacts = path.join(wt, ".claude", "tmp");
			leaveArtefacts(artefacts);
			const written = writeWtMarker({ CLAUDE_PROJECT_DIR: repo });
			expect(written.stderr).toBe("");
			expect(written.status).toBe(0);
			const tree = treeOf(["--", SECRET], wt);
			const r = commit([SECRET], { cwd: wt, projectDir: repo });
			expect(r.stderr).toBe("");
			expect(r.status).toBe(0);
			expect(readWtTrailer()).toBe(
				`escalated; areas=secrets; base=${base}; tree=${tree}; paths=${SECRET}`,
			);
			expect(fs.existsSync(wtStamp())).toBe(false);
			expect(fs.existsSync(stamp())).toBe(false);
		});

		// A shell with the variable unset: the hook takes its host from
		// hook-root.sh, so writer and hold meet in the shared tree's store.
		it("trails a commit with CLAUDE_PROJECT_DIR unset, the artefacts and the marker in the shared tree (#3830)", () => {
			fs.writeFileSync(
				path.join(hooks, "pre-commit"),
				`#!/bin/sh\n. "${HOOK_ROOT}"\nexec bash "${GATE}"\n`,
				{ mode: 0o755 },
			);
			const base = git("-C", wt, "rev-parse", "HEAD");
			write(SECRET, "new\n", wt);
			leaveArtefacts();
			const written = writeWtMarker();
			expect(written.stderr).toBe("");
			expect(written.status).toBe(0);
			expect(fs.existsSync(marker())).toBe(true);
			const tree = treeOf(["--", SECRET], wt);
			const r = commit([SECRET], { cwd: wt });
			expect(r.stderr).toBe("");
			expect(r.status).toBe(0);
			expect(readWtTrailer()).toBe(
				`escalated; areas=secrets; base=${base}; tree=${tree}; paths=${SECRET}`,
			);
		});

		it("names the marker's fault and does not refuse where its tree= is stale, leaving no trailer or stamp (#3830)", () => {
			write(SECRET, "reviewed\n", wt);
			mark({
				tier: "escalated",
				areas: "secrets",
				tree: treeOf(["--", SECRET], wt),
				paths: SECRET,
			});
			write(SECRET, "edited after the review\n", wt);
			const r = commit([SECRET], { cwd: wt, projectDir: repo });
			expect(r.stderr).toContain(
				`pre-commit: this commit lands with no Review-Tier: trailer. The marker ${marker()} does not clear it: its tree= is not the tree this commit carries`,
			);
			expect(r.stderr).toContain(
				"git reset --soft HEAD~, record the review of exactly this change with scripts/write-review-marker.js",
			);
			expect(r.status).toBe(0);
			expect(readWtTrailer()).toBe("");
			expect(fs.existsSync(wtStamp())).toBe(false);
		});
	});

	it("writes the marker's tier, areas, base, tree and paths on a held commit, and consumes the stamp", () => {
		const base = git("rev-parse", "HEAD");
		write(SECRET, "new\n");
		write(PRICE, "new\n");
		const tree = treeOf(["--", SECRET, PRICE]);
		mark({
			tier: "mission-critical",
			areas: "money, secrets",
			tree,
			paths: `${SECRET}, ${PRICE}`,
		});
		const r = commit([SECRET, PRICE]);
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
		expect(trailers()).toBe(
			`mission-critical; areas=money,secrets; base=${base}; tree=${tree}; paths=${SECRET},${PRICE}`,
		);
		expect(fs.existsSync(stamp())).toBe(false);
	});

	it("says so where the stamp lost its value, writing none", () => {
		write(SECRET, "new\n");
		git("add", "--", SECRET);
		fs.writeFileSync(stamp(), `${git("write-tree")}\n`);
		const msg = path.join(scratch, "msg");
		fs.writeFileSync(msg, "land\n");
		const r = spawnSync("bash", [Trailer, msg], {
			cwd: repo,
			encoding: "utf8",
			env: { ...quietEnv(), CLAUDE_CODE_SESSION_ID: SID },
		});
		expect(r.stderr).toContain("could not be read");
		expect(r.status).toBe(0);
		expect(fs.readFileSync(msg, "utf8")).toBe("land\n");
	});

	it("leaves nothing behind on a commit off the globs", () => {
		write(PLAIN, "new\n");
		expect(commit([PLAIN]).status).toBe(0);
		expect(trailers()).toBe("");
		expect(fs.existsSync(stamp())).toBe(false);
	});

	it("writes none on a commit the hold does not reach, and none from a stamp of another tree", () => {
		write(PLAIN, "new\n");
		fs.writeFileSync(
			stamp(),
			`${"a".repeat(40)}\nescalated; areas=secrets; tree=${"a".repeat(40)}; paths=${SECRET}\n`,
		);
		const r = commit([PLAIN]);
		expect(r.status).toBe(0);
		expect(trailers()).toBe("");
		expect(fs.existsSync(stamp())).toBe(false);
	});

	it("writes none from a stamp of this very tree that a later refusal stranded, on a commit the hold skips", () => {
		write(SECRET, "new\n");
		git("add", "--", SECRET);
		const tree = git("write-tree");
		fs.writeFileSync(
			stamp(),
			`${tree}\nescalated; areas=secrets; base=${"b".repeat(40)}; tree=${tree}; paths=${SECRET}\n`,
		);
		const r = commit([], { sid: "" });
		expect(r.status).toBe(0);
		expect(trailers()).toBe("");
	});

	describe("a trailer no stamp vouches for (#3906)", () => {
		const Typed = "Review-Tier: mission-critical; areas=secrets; tree=x";
		const commitTyped = (...message: string[]) =>
			hookedGit(["commit", "-q", ...message.flatMap((m) => ["-m", m])]);
		/** The trailer script alone on a message holding `text`, as the session `sid`. */
		const trailerOn = (text: string, sid = SID) => {
			const msg = path.join(scratch, "msg");
			fs.writeFileSync(msg, text);
			const r = spawnSync("bash", [Trailer, msg], {
				cwd: repo,
				encoding: "utf8",
				env: { ...quietEnv(), CLAUDE_CODE_SESSION_ID: sid },
			});
			return { ...r, text: () => fs.readFileSync(msg, "utf8") };
		};

		it.each([
			["as git spells it", Typed],
			["in another case and spacing", "review-tier : escalated; tree=x"],
			["folded", `${Typed}\n  ; paths=a,b`],
		])("strips one typed %s, and says so", (_, typed) => {
			write(PLAIN, "new\n");
			git("add", "--", PLAIN);
			const r = commitTyped("land", `Signed-off-by: a <a@b>\n${typed}`);
			expect(r.status).toBe(0);
			expect(r.stderr).toContain("no review of this commit is recorded");
			expect(trailers()).toBe("");
			expect(git("log", "-1", "--format=%B")).toBe(
				"land\n\nSigned-off-by: a <a@b>",
			);
		});

		it("leaves a message carrying none as it was, saying nothing", () => {
			write(PLAIN, "new\n");
			git("add", "--", PLAIN);
			const r = commitTyped("land", "Not-a-Review-Tier: kept");
			expect(r.stderr).toBe("");
			expect(git("log", "-1", "--format=%B")).toBe(
				"land\n\nNot-a-Review-Tier: kept",
			);
		});

		it("replaces one typed on a commit the hold passed with its own, and says nothing of a strip", () => {
			write(SECRET, "new\n");
			git("add", "--", SECRET);
			const tree = git("write-tree");
			mark({ tier: "escalated", areas: "secrets", tree, paths: SECRET });
			const r = commitTyped("land", Typed);
			expect(r.status).toBe(0);
			expect(r.stderr).toBe("");
			expect(trailers()).toContain("escalated; areas=secrets;");
			expect(trailers()).not.toContain("mission-critical");
		});

		it("strips one where the stamp cannot be read, as the fault says", () => {
			fs.writeFileSync(stamp(), `${git("write-tree")}\n`);
			const r = trailerOn(`land\n\n${Typed}\n`);
			expect(r.status).toBe(0);
			expect(r.stderr).toContain("could not be read");
			expect(r.text()).not.toContain("Review-Tier");
		});

		it("strips one with no session, on the founder's own terminal", () => {
			write(PLAIN, "new\n");
			git("add", "--", PLAIN);
			const r = trailerOn(`land\n\n${Typed}\n`, "");
			expect(r.status).toBe(0);
			expect(r.stderr).toContain("no review of this commit is recorded");
			expect(r.text()).not.toContain("Review-Tier");
		});

		it("says a line stands unvouched where it cannot read the message, and goes on", () => {
			const r = spawnSync("bash", [Trailer, path.join(scratch, "absent")], {
				cwd: repo,
				encoding: "utf8",
				env: { ...quietEnv(), CLAUDE_CODE_SESSION_ID: SID },
			});
			expect(r.status).toBe(0);
			expect(r.stderr).toContain("stands unvouched");
			expect(r.stderr).not.toContain("lands with no Review-Tier");
		});

		it("keeps a reviewed commit's trailer through an amend that only rewords it", () => {
			write(SECRET, "new\n");
			git("add", "--", SECRET);
			const tree = git("write-tree");
			mark({ tier: "escalated", areas: "secrets", tree, paths: SECRET });
			expect(commit([]).status).toBe(0);
			const value = trailers();
			const body = git("log", "-1", "--format=%B");
			const r = hookedGit([
				"commit",
				"--amend",
				"-qm",
				`reworded${body.slice(4)}`,
			]);
			expect(r.stderr).toBe("");
			expect(r.status).toBe(0);
			expect(git("log", "-1", "--format=%s")).toBe("reworded");
			expect(trailers()).toBe(value);
		});

		it("strips one a reword adds to a commit carrying none", () => {
			write(PLAIN, "new\n");
			expect(commit([PLAIN]).status).toBe(0);
			const r = hookedGit(["commit", "--amend", "-qm", `land\n\n${Typed}`]);
			expect(r.status).toBe(0);
			expect(trailers()).toBe("");
		});

		it("strips one typed by hand mid-rebase, whose replays never reach the script", () => {
			write(PLAIN, "new\n");
			git("add", "--", PLAIN);
			const rebasing = path.join(repo, ".git", "rebase-merge");
			fs.mkdirSync(rebasing);
			const r = commitTyped("land", Typed);
			fs.rmSync(rebasing, { recursive: true });
			expect(r.status).toBe(0);
			expect(trailers()).toBe("");
		});

		it("strips one the picked commit does not carry, resolving a cherry-pick by hand", () => {
			const picked = git("rev-parse", "HEAD");
			write(PLAIN, "new\n");
			git("add", "--", PLAIN);
			fs.writeFileSync(
				path.join(repo, ".git", "CHERRY_PICK_HEAD"),
				`${picked}\n`,
			);
			const r = commitTyped("land", Typed);
			expect(r.status).toBe(0);
			expect(trailers()).toBe("");
		});

		it("keeps the trailer a cherry-pick replays, the review being of that change", () => {
			write(SECRET, "new\n");
			git("add", "--", SECRET);
			const tree = git("write-tree");
			mark({ tier: "escalated", areas: "secrets", tree, paths: SECRET });
			expect(commit([]).status).toBe(0);
			const reviewed = git("rev-parse", "HEAD");
			const value = trailers();
			git("reset", "-q", "--hard", "HEAD~");
			const r = hookedGit(["cherry-pick", reviewed]);
			expect(r.status).toBe(0);
			expect(trailers()).toBe(value);
		});
	});

	describe("a stamp in the shared tree, with a neighbour committing (#3906)", () => {
		const Neighbour = "neighbour-session";
		/** The hold as session SID runs it on a private index, its commit still to come. */
		const privateEnv = () => ({
			...quietEnv(),
			CLAUDE_CODE_SESSION_ID: SID,
			GIT_INDEX_FILE: path.join(scratch, "private-index"),
		});
		const inPrivate = (...args: string[]) =>
			spawnSync("git", args, {
				cwd: repo,
				encoding: "utf8",
				env: privateEnv(),
			}).stdout.trim();
		const holdAsSession = () => {
			inPrivate("read-tree", "HEAD");
			write(SECRET, "new\n");
			inPrivate("add", "--", SECRET);
			const tree = inPrivate("write-tree");
			mark({ tier: "escalated", areas: "secrets", tree, paths: SECRET });
			const held = spawnSync("bash", [GATE], {
				cwd: repo,
				encoding: "utf8",
				env: privateEnv(),
			});
			expect(held.status).toBe(0);
			return tree;
		};

		it("neither clears nor consumes it, so this session's commit keeps its trailer", () => {
			const tree = holdAsSession();
			const before = fs.readFileSync(stamp(), "utf8");
			write(PLAIN, "new\n");
			const theirs = commit([PLAIN], { sid: Neighbour });
			expect(theirs.status).toBe(0);
			expect(trailers()).toBe("");
			expect(fs.readFileSync(stamp(), "utf8")).toBe(before);
			const msg = path.join(scratch, "msg");
			fs.writeFileSync(msg, "land\n");
			const r = spawnSync("bash", [Trailer, msg], {
				cwd: repo,
				encoding: "utf8",
				env: privateEnv(),
			});
			expect(r.stderr).toBe("");
			expect(r.status).toBe(0);
			expect(fs.readFileSync(msg, "utf8")).toContain(`tree=${tree}`);
			expect(fs.existsSync(stamp())).toBe(false);
		});

		it("gives the neighbour's commit no trailer of this session's", () => {
			holdAsSession();
			const msg = path.join(scratch, "msg");
			fs.writeFileSync(msg, "theirs\n");
			const r = spawnSync("bash", [Trailer, msg], {
				cwd: repo,
				encoding: "utf8",
				env: { ...quietEnv(), CLAUDE_CODE_SESSION_ID: Neighbour },
			});
			expect(r.status).toBe(0);
			expect(r.stderr).toBe("");
			expect(fs.readFileSync(msg, "utf8")).toBe("theirs\n");
			expect(fs.existsSync(stamp())).toBe(true);
		});

		it("sweeps a stamp a dead session stranded a day ago, and no fresher one", () => {
			fs.writeFileSync(stamp("dead"), "x\nunheld\n");
			const dayAgo = new Date(Date.now() - 25 * 3_600_000);
			fs.utimesSync(stamp("dead"), dayAgo, dayAgo);
			fs.writeFileSync(stamp(Neighbour), "x\nunheld\n");
			write(PLAIN, "new\n");
			expect(commit([PLAIN]).status).toBe(0);
			expect(fs.existsSync(stamp("dead"))).toBe(false);
			expect(fs.existsSync(stamp(Neighbour))).toBe(true);
		});

		it("keeps a session id out of the stamp's path", () => {
			const r = spawnSync(
				"bash",
				[
					"-c",
					`source "${path.join(path.dirname(GATE), "lib", "review-tier-stamp.sh")}" && wfc_review_tier_stamp /g`,
				],
				{
					encoding: "utf8",
					env: { ...quietEnv(), CLAUDE_CODE_SESSION_ID: "../a b" },
				},
			);
			expect(r.stdout.trim()).toBe("/g/wfc-review-tier-___a_b");
		});
	});
});
