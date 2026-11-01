// @vitest-environment node
/*
 * Pins the pre-commit hold on a declared sensitive path (#1622, spec #1612
 * §The hold): a session's shared-tree commit touching a declared glob is
 * refused until its `.codereview-pass-<sid>` marker records an escalated tier,
 * every matched area and the exact tree the commit carries. Break it and
 * unreviewed sensitive code lands on the shared `main`, where any neighbour's
 * push publishes it, or every session commit on a declared path is refused
 * with no way out.
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
import { runInProcess } from "./lib/run-in-process";
import { readShellConst } from "./lib/shell-const-testkit";

const GATE = path.resolve(__dirname, "review-hold-gate.sh");
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

/** A pathspec commit, as commit-paths.js makes; with no paths, the index as staged. */
const commit = (paths: string[], { sid = SID, cwd = repo } = {}) => {
	const env: Record<string, string | undefined> = {
		...quietEnv(),
		CLAUDE_CODE_SESSION_ID: sid,
	};
	delete env.GIT_REFLOG_ACTION;
	return spawnSync(
		"git",
		[
			"-c",
			`core.hooksPath=${hooks}`,
			"commit",
			"-qm",
			"land",
			...(paths.length > 0 ? ["--", ...paths] : []),
		],
		{ cwd, encoding: "utf8", env },
	);
};

/** What `commit-paths.js --tree` prints, the tree review-hold.txt names. */
const treeOf = (args: string[]) => {
	const r = runInProcess(COMMIT_PATHS, ["--tree", ...args], {
		cwd: repo,
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
	for (const axis of ["standards", "spec"])
		write(`.claude/tmp/review-${axis}-${SID.slice(0, 8)}.md`, "- none\n");
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

const expectRefused = (r: ReturnType<typeof commit>, fault: string) => {
	expect(r.status).toBe(1);
	expect(r.stderr).toContain(fault);
	expect(r.stderr).toContain("A COMMIT ON A DECLARED SENSITIVE PATH IS HELD");
	expect(r.stderr).toContain("rule:review-hold");
	expect(commitCount()).toBe("1");
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
					{ name: "pages", description: "the app", globs: ["app/**"] },
				],
			}),
		);
		write(PLAIN, "new\n");
		const r = commit([PLAIN, ".claude/workflow-core.json"]);
		expectRefused(r, "there is no marker");
		expect(r.stderr).toContain("Areas touched: pages.");
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

	it("passes a commit in a linked worktree", () => {
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

		// The hold skips a worktree, so there the Stop nag and the push warning
		// are the only readers of the marker.
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
	const stamp = () => path.join(repo, ".git", "wfc-review-tier");
	const trailers = () =>
		git("log", "-1", "--format=%(trailers:key=Review-Tier,valueonly)");

	beforeEach(() => {
		fs.writeFileSync(
			path.join(hooks, "prepare-commit-msg"),
			`#!/bin/sh\nexec bash "${Trailer}" "$1"\n`,
			{ mode: 0o755 },
		);
	});

	it("is run by .husky/prepare-commit-msg on both of a passing commit's exits, through the plugin root", () => {
		expect(Prepare).toMatch(
			/^ {2}trailer="\$\{WFC_PLUGIN_ROOT:-\$here\/\.\.\}\/scripts\/review-tier-trailer\.sh"$/m,
		);
		expect(
			Prepare.match(/^ {2}review_tier_trailer "\$\{1-\}"$/gm),
		).toHaveLength(2);
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

	const runTrailer = (msg: string, env: Record<string, string> = {}) =>
		spawnSync("bash", [Trailer, msg], {
			cwd: repo,
			encoding: "utf8",
			env: { ...quietEnv(), ...env },
		});

	it("says on stderr that the commit lands with no trailer where git names no git directory (#3716)", () => {
		const msg = path.join(scratch, "MSG");
		fs.writeFileSync(msg, "land\n");
		const r = runTrailer(msg, { GIT_DIR: path.join(scratch, "no-such-git") });
		expect(r.status).toBe(0);
		expect(r.stderr).toBe(
			"prepare-commit-msg: git named no git directory to read the review hold's stamp from, so this commit lands with no Review-Tier: trailer.\n",
		);
		expect(fs.readFileSync(msg, "utf8")).toBe("land\n");
	});

	it("consumes no stamp and logs nothing on an empty message path, as a direct run of the hook hands (#3716)", () => {
		fs.writeFileSync(
			stamp(),
			"t\nescalated; areas=a; base=b; tree=t; paths=p\n",
		);
		const r = runTrailer("");
		expect(r.status).toBe(0);
		expect(r.stderr).toBe("");
		expect(fs.existsSync(stamp())).toBe(true);
	});
});
