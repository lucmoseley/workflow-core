// @vitest-environment node
/*
 * guard-recursive-dot-read.sh warns on a recursive `grep`/`rg` rooted at `.`,
 * leading with the same command with the root expanded (mantahostels#2717), and
 * hands over rule:heavy-tree-search on a search over node_modules, .next, .git
 * or build output (#2060).
 *
 * EVERY CASE RUNS AGAINST A FIXTURE REPO, not this one. The expansion is
 * computed from the tree at call time, so judging it against the live checkout
 * would rewrite the assertions every time a top-level file was added.
 *
 * Every allow case asserts SILENCE *and an empty fail-open log*. Silence alone
 * would pass for the wrong reason: a recorded fail-open — a damaged library, a
 * `.cwd` the payload never carried, a rewrite that did not render — also emits
 * nothing and exits 0, so without the log the allow suite would stay green on a
 * disarmed guard.
 *
 * It runs as a `PreToolUse` Bash hook (`self-plugin/hooks/hooks.json`,
 * `hooks/hooks.json`): break it and a recursive `grep` from `.` walks
 * `node_modules`, `.next` and `.git` unwarned, and a search rooted in one of
 * them goes without the rule; make it deny and a legitimate search is refused.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildBashPayload, guardOutput } from "./lib/pretool-guard-testkit";

const GUARD = path.resolve(__dirname, "guard-recursive-dot-read.sh");
const { projectSlug } = require("./lib/project-slug") as {
	projectSlug: (root: string) => string;
};

let dir: string;
let config: string;
/** The fixture repo, resolved through the same symlink flattening the guard uses. */
let repo: string;

/* What the fixture's tree expands to, in git's own order: the first path
 * component of each tracked file, then the untracked non-dot directory. */
const EXPANSION = ".claude .gitignore CLAUDE.md app newdir";

const git = (...args: string[]) =>
	spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "dot-read-"));
	config = path.join(dir, "config");
	fs.mkdirSync(config);
	/* The prefix carries `.` and `+` deliberately: the guard escapes the root
	 * one character at a time before putting it in an ERE, and a root of only
	 * word characters would let a broken escaper pass. */
	repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dot+repo.")));

	fs.mkdirSync(path.join(repo, "app"));
	fs.mkdirSync(path.join(repo, ".claude"));
	fs.writeFileSync(path.join(repo, "app", "a.ts"), "x\n");
	fs.writeFileSync(path.join(repo, ".claude", "settings.json"), "{}\n");
	fs.writeFileSync(path.join(repo, "CLAUDE.md"), "x\n");
	fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n.cache/\n");

	/* Untracked and unignored: a new directory must survive the expansion, so a
	 * source tree not yet committed is not silently dropped. */
	fs.mkdirSync(path.join(repo, "newdir"));
	fs.writeFileSync(path.join(repo, "newdir", "b.ts"), "x\n");
	/* Untracked DOT directory — tooling state nobody ignored. Dropped. */
	fs.mkdirSync(path.join(repo, ".mypy_cache"));
	fs.writeFileSync(path.join(repo, ".mypy_cache", "c"), "x\n");
	/* Untracked root scratch. */
	fs.writeFileSync(path.join(repo, ".scratch.out"), "x\n");
	/* Ignored outright. */
	fs.mkdirSync(path.join(repo, "node_modules"));
	fs.writeFileSync(path.join(repo, "node_modules", "d"), "x\n");

	git("init", "-q");
	git("add", "app/a.ts", ".claude/settings.json", "CLAUDE.md", ".gitignore");
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
	fs.rmSync(repo, { recursive: true, force: true });
});

/*
 * #2060: the no-recursive-search-over-heavy-trees rule left the always-loaded
 * CLAUDE.md for this guard, so its whole text must arrive on the trigger.
 */
const ruleText = fs
	.readFileSync(
		path.resolve(__dirname, "../docs/agents/rules/heavy-tree-search.txt"),
		"utf8",
	)
	.trim();

/** Everything lib/guard-log.sh recorded during this test, or "". */
const failOpenLog = (projectDir = repo) => {
	const file = path.join(
		config,
		"projects",
		projectSlug(projectDir),
		"guard-errors.log",
	);
	return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
};

interface Options {
	/** Where the shell stands, as the payload reports it. */
	cwd?: string;
	projectDir?: string;
	omitCwd?: boolean;
	rawInput?: string;
	/** The payload's `.permission_mode`. */
	permissionMode?: string;
}

/** The whole hook output for `command`, parsed. Null where it said nothing. */
const emission = (command: string, opts: Options = {}) => {
	const projectDir = opts.projectDir ?? repo;
	const payload: Record<string, unknown> = buildBashPayload(
		command,
		"s-dot-read",
	);
	if (!opts.omitCwd) payload.cwd = opts.cwd ?? projectDir;
	if (opts.permissionMode) payload.permission_mode = opts.permissionMode;

	return guardOutput(GUARD, payload, {
		project: projectDir,
		config,
		/* A tmpdir, NOT the fixture: spawning from the repo would let `git -C`
		 * and the root comparison both succeed off the process's own directory,
		 * and the guard would pass whether or not it reads the payload. */
		cwd: dir,
		stdin: opts.rawInput,
		env: {
			/* Set by a hook or a worktree, these point `git -C <fixture> ls-files`
			 * at the LIVE index and the expansion stops being the fixture's. */
			GIT_DIR: undefined,
			GIT_WORK_TREE: undefined,
			GIT_INDEX_FILE: undefined,
		},
	});
};

/** The warning, asserted to take no decision: the command runs as written. */
const warning = (command: string, opts: Options = {}) => {
	const out = emission(command, opts);
	expect(out).not.toBeNull();
	expect(out.permissionDecision).toBeUndefined();
	return out.additionalContext as string;
};

/** The expanded command the warning leads with — every line of it. */
const replacement = (context: string) => {
	const [command, prose] = context.split(
		"\n\nThat is your search with its root expanded",
	);
	expect(prose).toBeDefined();
	return command;
};

describe("a recursive search rooted at . is warned on, led by the fix", () => {
	it.each([
		[
			'grep -rln "PAT" --include=*.js .',
			'grep -rln "PAT" --include=*.js <EXP>',
			"a flag with a joined value",
		],
		["grep -rn PAT .", "grep -rn PAT <EXP>", "the bare form"],
		["grep -R PAT .", "grep -R PAT <EXP>", "-R as the recursive flag"],
		[
			"grep --recursive PAT .",
			"grep --recursive PAT <EXP>",
			"the long spelling",
		],
		["grep -rn PAT ./", "grep -rn PAT <EXP>", "`./` as the root"],
		["rg -l PAT .", "rg -l PAT <EXP>", "rg, which is recursive with no flag"],
		[
			"grep -rn -e PAT .",
			"grep -rn -e PAT <EXP>",
			"a pattern given by flag, so the only bare word is the root",
		],
		[
			"grep -rn PAT . | head -3",
			"grep -rn PAT <EXP> | head -3",
			"a pipe after the root, kept",
		],
		[
			'grep -rn "a b" .',
			'grep -rn "a b" <EXP>',
			"a quoted pattern holding a space, kept quoted",
		],
		[
			"ls; grep -rn PAT .",
			"ls; grep -rn PAT <EXP>",
			"a search in a later segment",
		],
		[
			"grep -rn @CMD@ .",
			"grep -rn @CMD@ <EXP>",
			"a literal @CMD@, which the splice must not eat",
		],
		/* mantahostels#2717: allowed in silence, pattern eaten. */
		[
			"grep -r --color PAT .",
			"grep -r --color PAT <EXP>",
			"--color takes its value joined or not at all, so it eats nothing",
		],
		[
			"grep -rT PAT .",
			"grep -rT PAT <EXP>",
			"-T is grep's --initial-tab and takes no value",
		],
		[
			"rg -r X PAT .",
			"rg -r X PAT <EXP>",
			"-r is rg's --replace and DOES take one",
		],
		[
			"grep -rn PAT .\necho done",
			"grep -rn PAT <EXP>\necho done",
			"a command of two lines, led by both",
		],
		/* No path names the root at all (#1731). */
		["rg PAT", "rg PAT <EXP>", "rg with no path, which searches ."],
		["grep -rn PAT", "grep -rn PAT <EXP>", "grep -r with no path"],
		[
			"rg -n PAT | head -3",
			"rg -n PAT <EXP> | head -3",
			"no path, with a pipe after the search, kept",
		],
		[
			"ls; rg 'a b' 2>/dev/null",
			"ls; rg 'a b' 2>/dev/null <EXP>",
			"no path, quoted and redirected, in a later segment",
		],
		["rg -e PAT", "rg -e PAT <EXP>", "no path, the pattern given by flag"],
		[
			"git log | grep -rn PAT",
			"git log | grep -rn PAT <EXP>",
			"grep -r with no path behind a pipe, which it ignores",
		],
		[
			"grep -rhn PAT .",
			"grep -rhn PAT <EXP>",
			"grep's -h, which is --no-filename and not help",
		],
		["rg --files", "rg --files <EXP>", "rg --files, which takes no pattern"],
		[
			"rg -r X .",
			"rg -r X . <EXP>",
			"-r takes X, so `.` is the pattern and no path is named",
		],
	])("%s → %s — %s", (command, expected) => {
		expect(replacement(warning(command))).toBe(
			expected.replace("<EXP>", EXPANSION),
		);
	});

	it("says why the root costs a prompt, and names the tickets", () => {
		const reason = warning("grep -rn PAT .");
		expect(reason).toContain("permission prompt");
		expect(reason).toContain("Read(./.env)");
		expect(reason).toContain("#2717");
		expect(reason).toContain("#482");
		expect(reason).toContain(repo);
	});

	it.each([
		["", "the project directory spelled out in full"],
		["/", "the same with a trailing slash"],
	])("grep -rn PAT <root>%s — %s", (suffix) => {
		/* mantahostels#2717 F2. */
		expect(replacement(warning(`grep -rn PAT ${repo}${suffix}`))).toBe(
			`grep -rn PAT ${EXPANSION}`,
		);
	});

	it("says grep reads what git ignores, and rg is not told so, since it skips it (#1731)", () => {
		expect(warning("grep -rn PAT .")).toContain("node_modules");
		expect(warning("rg -l PAT .")).not.toContain("node_modules");
	});

	it("names the session's permission mode, reading an absent one as default (#1731)", () => {
		expect(warning("grep -rn PAT .")).toContain("`default` permission");
		expect(
			warning("grep -rn PAT .", { permissionMode: "acceptEdits" }),
		).toContain("`acceptEdits` permission");
	});

	it("says the rewrite widens an rg search, which skips hidden dirs by default", () => {
		/* mantahostels#2717 F5. */
		expect(warning("rg -l PAT .")).toContain("WIDENS");
	});

	it("leaves out a tracked root file the working tree no longer holds", () => {
		/* mantahostels#2717 F4. */
		fs.rmSync(path.join(repo, "CLAUDE.md"));
		const fix = replacement(warning("grep -rn PAT ."));
		expect(fix).not.toContain("CLAUDE.md");
		expect(fix).toContain("app");
	});

	it("leaves out a tracked root symlink whose target is not there", () => {
		/* mantahostels#2717 F-1. */
		fs.symlinkSync("nowhere", path.join(repo, "dangling"));
		git("add", "dangling");
		const fix = replacement(warning("grep -rn PAT ."));
		expect(fix).not.toContain("dangling");
		expect(fix).toContain("app");
	});

	it("drops what no search wants and keeps what a shorter rewrite would lose", () => {
		const fix = replacement(warning("grep -rn PAT ."));
		// Gitignored, and out without being named.
		expect(fix).not.toContain("node_modules");
		// Untracked tooling state, and untracked root scratch.
		expect(fix).not.toContain(".mypy_cache");
		expect(fix).not.toContain(".scratch.out");
		// The two classes the rejected rewrites lost: dot-dirs, and new dirs.
		expect(fix).toContain(".claude");
		expect(fix).toContain("newdir");
	});
});

describe("a search that does not read the whole project directory passes untouched", () => {
	it.each([
		["grep -rn PAT app docs", "an explicit directory list"],
		["grep -n PAT .", "not recursive, so it reads one file"],
		["grep -rn PAT app", "one directory"],
		["rg -l PAT app", "rg, scoped"],
		["git grep -n PAT .", "git grep, which this guard does not read"],
		["npm run test:changed", "no search at all"],
		['echo "grep -rn PAT ."', "a search inside a quoted string runs nothing"],
		[
			"grep -rn PAT ..",
			"the parent directory, which is a different tree entirely",
		],
		["grep -d recurse PAT .", "recursion this guard does not read"],
		["git log | rg PAT", "no path, fed by a pipe, so rg reads stdin"],
		["rg PAT < /tmp/f", "no path, fed by a redirect"],
		[
			'echo "rg PAT"; rg PAT',
			"the search's text twice, so which one runs is unreadable",
		],
		["git ls-files | xargs rg PAT", "no path, handed its paths by xargs"],
		["grep PAT", "no path and not recursive, so grep reads stdin"],
		["rg --version", "no search at all"],
		["/usr/bin/grep -rn PAT .", "a path-spelled command word"],
		[
			"grep -rn PAT $PWD",
			"a shell variable only the shell can expand, and this guard must not",
		],
	])("%s — %s", (command) => {
		expect(emission(command)).toBeNull();
		expect(failOpenLog()).toBe("");
	});

	it.each([
		[
			"cd app && grep -rn PAT .",
			"after a cd, `.` is a tree this guard never read",
		],
		["cd app; grep -rn PAT .", "the same with a plain separator"],
		["pushd app; grep -rn PAT .", "pushd moves it too"],
	])("%s — %s", (command) => {
		/* Firing here would hand back a rewrite naming the ROOT's entries while
		 * the shell stands in app/, so every path in it is wrong and the
		 * corrected command fails outright. */
		expect(emission(command)).toBeNull();
		expect(failOpenLog()).toBe("");
	});

	/* Each still walks the heavy trees, so #2060's rule arrives, alone. */
	it.each([
		[
			'grep -rn "a . b" .',
			"two standalone dots, so which one is the root is unreadable",
		],
		["grep -rn PAT .|head -3", "`.` welded to a pipe is not a standalone word"],
		[
			'grep -rn PAT "."',
			"a quoted root, which the raw string does not carry as a standalone word",
		],
		["grep -rn PAT . <ROOT>", "the root named twice, . once and in full once"],
	])("%s — %s gets no rewrite", (command) => {
		const context = warning(command.replace("<ROOT>", repo));
		expect(context).not.toContain("That is your search with its root expanded");
		expect(context).toContain(ruleText);
		expect(failOpenLog()).toBe("");
	});

	it("allows a . root while the shell stands somewhere else", () => {
		// There, `.` is not this repo and the guard knows nothing about it.
		expect(emission("grep -rn PAT .", { cwd: "/tmp" })).toBeNull();
		expect(failOpenLog()).toBe("");
	});
});

describe("auto and bypassPermissions, which show no prompt (#1731)", () => {
	it.each(["auto", "bypassPermissions"])(
		"%s passes rg and warns grep without naming a prompt",
		(permissionMode) => {
			for (const command of ["rg -l PAT .", "rg PAT"])
				expect(emission(command, { permissionMode })).toBeNull();
			const reason = warning("grep -rn PAT .", { permissionMode });
			expect(reason).not.toContain("permission prompt");
			expect(reason).toContain("node_modules");
			expect(failOpenLog()).toBe("");
		},
	);
});

describe("it fails open, and says so in the record", () => {
	it("on a payload that is not JSON", () => {
		expect(emission("grep -rn PAT .", { rawInput: "not json" })).toBeNull();
		expect(failOpenLog()).toContain("guard-recursive-dot-read.sh");
	});

	it("on a payload carrying no .cwd, which disarms it entirely", () => {
		expect(emission("grep -rn PAT .", { omitCwd: true })).toBeNull();
		expect(failOpenLog()).toContain("no .cwd");
	});

	it("on a top-level name it cannot put in a command line unescaped", () => {
		fs.mkdirSync(path.join(repo, "a b"));
		fs.writeFileSync(path.join(repo, "a b", "x"), "x\n");
		git("add", "a b/x");
		expect(emission("grep -rn PAT .")).toBeNull();
		expect(failOpenLog()).toContain("outside [A-Za-z0-9._-]");
	});

	it("on a root git cannot list, leaving nothing to expand to", () => {
		fs.rmSync(path.join(repo, ".git"), { recursive: true, force: true });
		for (const f of fs.readdirSync(repo))
			fs.rmSync(path.join(repo, f), { recursive: true, force: true });
		expect(emission("grep -rn PAT .")).toBeNull();
		expect(failOpenLog()).toContain("no usable entry");
	});
});

/** What the hook says to `command` in `auto` mode, or "". */
const said = (command: string, opts: Options = {}) =>
	emission(command, { permissionMode: "auto", ...opts })?.additionalContext ??
	"";

describe("a search over a heavy tree is handed the rule", () => {
	beforeEach(() => {
		fs.mkdirSync(path.join(repo, "dist"));
		fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\ndist/\n");
	});

	it.each([
		["grep -rn PAT node_modules", "grep into node_modules"],
		["grep -rn PAT app node_modules/", "node_modules among several roots"],
		["rg PAT node_modules", "rg, which reads an ignored tree it is named"],
		["rg PAT .git", "rg into .git"],
		["grep -r -e PAT .next", "a pattern by flag, so .next is the root"],
		["grep -rn PAT dist", "build output git ignores"],
		["find node_modules -name x", "find into node_modules"],
		["find . -name x", "find from the repo root, which holds them all"],
		["find -name x", "find with no start point, which is ."],
		["watch -n 5 'grep -r PAT .git'", "watch, its command in one word"],
		["watch find . -name x", "watch, its command in several words"],
		["watch grep -r PAT .", "a grep at the root under watch"],
		["grep -r PAT", "a grep naming no path, standing at the root"],
	])("%s — %s", (command) => {
		expect(said(command)).toContain(ruleText);
		expect(failOpenLog()).toBe("");
	});

	it("rides beside the dot-root warning in one envelope", () => {
		const context = warning("grep -rn PAT .");
		expect(replacement(context)).toBe(`grep -rn PAT ${EXPANSION}`);
		expect(context).toContain(ruleText);
	});

	it("is said once a session, and the warning then goes alone", () => {
		expect(said("grep -rn PAT node_modules")).toContain(ruleText);
		expect(said("grep -rn PAT node_modules")).toBe("");
		const context = warning("grep -rn PAT .");
		expect(context).toContain("That is your search with its root expanded");
		expect(context).not.toContain(ruleText);
	});
});

describe("a search clear of the heavy trees is handed no rule", () => {
	it.each([
		["grep -rn PAT app", "a source directory"],
		["grep -n PAT node_modules/x.js", "not recursive"],
		["grep -rn PAT node_modules/vitest", "inside one package, not across"],
		["grep -rn PAT build", "a build directory git does not ignore"],
		["rg PAT .", "rg at the root, which skips what git ignores"],
		["find app -name x", "find under a source directory"],
		["find . -maxdepth 1 -name x", "find from the root, bounded"],
		[
			"find . -name node_modules -prune -o -name x -print",
			"find from the root, pruned",
		],
		["cd app && find . -name x", "find from a subdirectory"],
		['echo "grep -rn PAT node_modules"', "a search inside a quoted string"],
	])("%s — %s", (command) => {
		expect(said(command)).toBe("");
		expect(failOpenLog()).toBe("");
	});

	it("reaches a grep at the root spelled from a subdirectory", () => {
		const cwd = path.join(repo, "app");
		expect(said("grep -rn PAT ..", { cwd })).toContain(ruleText);
	});

	it("passes a find from the root while the shell stands elsewhere", () => {
		expect(said("find . -name x", { cwd: os.tmpdir() })).toBe("");
		expect(failOpenLog()).toBe("");
	});
});
