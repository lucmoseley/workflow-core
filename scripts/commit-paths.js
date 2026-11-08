#!/usr/bin/env node
/*
 * commit-paths.js — commit named paths in one call, new files included: the
 * prescribed `git commit -m "…" -- <paths>` without its failure on a path git
 * does not track yet (#583; spec #574, ruled at #481).
 *
 *   node scripts/commit-paths.js -m "<message>" -- <path>...
 *   node scripts/commit-paths.js -F <file|-> -- <path>...
 *   node scripts/commit-paths.js -m "<message>" --patch <file> [-- <path>...]
 *   node scripts/commit-paths.js --tree [--patch <file>] -- <path>...
 *   node scripts/commit-paths.js --check [--patch <file>] [-m <message> | -F <file|->] -- <path>...
 *
 * --TREE (#1695) prints the tree that commit would carry on today's HEAD,
 * built by the same private-index code and refused on the same grounds, and
 * writes nothing: the one computation of a pathspec commit's tree, which the
 * review hold's `tree=` and the `refs/reviewed/` pin both take. It takes no
 * message, runs no tests, and logs no outcome line.
 *
 * --CHECK (#4207) gives the verdict that commit would get and makes none: it
 * builds the same private index, runs the same pre-lock gates, test run and
 * mutation hold, then the hooks over that index as the --patch commit runs
 * them — pre-commit, and with a message prepare-commit-msg and commit-msg —
 * and stops before the commit object. Without a message the message checks
 * are skipped, saying so. The worktree's index is never touched, no outcome
 * line is logged, and finish removes the stand-down stamps the hooks leave
 * keyed to its tree, so no later commit stands down on a check; a kill
 * mid-run may leave them.
 *
 * --PATCH (#801) commits some of a file's changed lines and not the rest, so
 * a session's work in one file can be split across commits, and never writes
 * the working tree. The patch — the hunks of `git diff HEAD -U0 -- <file>` this
 * commit is to carry, the rest deleted — is applied to HEAD's blob in a private
 * index (`GIT_INDEX_FILE`), any whole paths after `--` are added to that same
 * index, and the commit is made from it with no pathspec. The worktree's index
 * is then reset to the new HEAD for every path committed: skipped, it would
 * still hold the old blob and stage the reverse of this commit for the next
 * bare `git commit` (docs/agents/partial-commit.md). The patch's lines must
 * already be in this tree's files, or the commit is refused (#4338).
 *
 * The --patch commit is made step by step, never by `git commit`, which
 * routes the message through `COMMIT_EDITMSG`, one file for every commit the
 * worktree runs at once (#2638): see commitIndex.
 *
 * ORDER: every refusal, then the pre-lock gates, then the pre-lock test run,
 * then the pre-lock mutation hold, then intent-add, then commit. Under
 * --patch: every refusal, the private index built on HEAD, the pre-lock gates,
 * the pre-lock test run, the pre-lock mutation hold, each slow gate's index
 * rebuilt before and after it, the commit. Nothing is written to the
 * worktree's index before the last refusal has passed.
 *
 * THE PRE-LOCK TEST RUN (#1651, spec #1639). Where test-gate.js says the
 * declared `commands.test` is gated at commit, it runs here, before the commit
 * takes the index lock, so the worktree's other git commands are not held up
 * for a suite's length. It runs in a throwaway worktree
 * (lib/isolated-worktree.js) holding HEAD plus every named path as on disk, in
 * its index and on disk alike, and no other file, so an unsaved edit the commit
 * does not carry cannot turn it red or green (#1760); stdin closed, through
 * `sh -c`. Its only other files are the gitignored ones that helper links in,
 * `node_modules` among them, and those the host's `worktreeLinks` declares
 * (#1767): a suite needing any other gitignored file goes red here. A green
 * writes the key of the commit's own changes (lib/commit-key.js) to a stamp
 * of this run's own in the per-worktree git directory, named to the
 * commit's hooks alone by $WFC_TEST_STAMP; the
 * hook's test gate stands down on it where the key still matches, and runs the
 * suite in the lock otherwise. The key is taken again after the run, and where
 * it moved — a named file edited while it ran — no stamp is written (#1652). Under --patch the run sees the
 * patch's own private index, rebuilt and re-keyed after it alike (#1653).
 * The worktree goes when the suite ends, and one a kill leaves is swept by the
 * next run. The stamp and the private index go at exit however the run ends — a throw
 * or a signal included (#1680) — except that a git child outliving a signal
 * sent to this process alone may write the private index back, and a SIGKILL
 * sent down the process tree kills the sweeper too, leaving both; under
 * --patch a SIGKILL during a git child that locks the private index also
 * leaves git's own `.index.lock`, refusing a later run that reuses this pid. No leftover opens
 * anything (#1639 story 20).
 * Where the tests are gated at push, no command is declared, or the config
 * cannot be read, nothing runs here and the hook acts alone.
 *
 * THE PRE-LOCK MUTATION HOLD (#1910, spec #1871). Where mutation-hold-gate.js
 * says it would run Stryker on the private index, it runs here, after the
 * test run, through that same script. Its green is stamped as the test run's is, by $WFC_MUTATION_STAMP
 * and gate `mutation`, and the hook's hold stands down on it alike.
 *
 * THE PRE-LOCK GATES (#1763). Before either slow gate, the hook's own gates
 * above them — .husky/pre-commit down to GATES_END — run on the same
 * private index, in this worktree as the hook runs them, so a lint finding
 * that takes a second refuses before a suite that takes twenty minutes. The
 * hook runs every one of them again in the lock: they cost seconds, and no
 * stamp stands them down. A hook carrying no such line
 * runs them in the lock alone, and `.husky/pre-commit.local` is never run
 * here, its contract being that it runs after every core gate.
 *
 * Per path: tracked in the index or HEAD (a deleted one, staged or not,
 * included) passes; untracked, on disk and not ignored is intent-added
 * (`git add -N`) so the pathspec reaches it;
 * ignored is refused, naming the matching rule; on disk nowhere and untracked
 * is refused; a directory is refused where it holds any untracked, unignored
 * file, listing them — git would commit its tracked files and leave those
 * behind with exit 0 (mantahostels#1651).
 *
 * Every path goes to git as `:(literal)<path>`, so a `*` in a filename is a
 * character, not a glob — never through `--literal-pathspecs`, whose
 * environment variable the hooks would inherit.
 *
 * The hook stack runs unchanged: a plain `git commit`, or under --patch the
 * same hooks run in git's order, carrying only the pre-lock stamps above. No `--amend`, `-a` or `--no-verify`.
 *
 * cli-args-exempt: its own parseArgs refuses every unknown flag, `--help`
 * included, before anything is written.
 *
 * Joins no §N3 family: it is not a check, guard, generator or report, and its
 * exits extend the tracker scripts' alphabet (spec #528) instead. Exits: 0
 * committed, or under --tree printed, or under --check every gate passed; 2
 * refused, nothing written (usage, no paths, unknown, ignored, a directory
 * with untracked files or no tracked ones, nothing to commit, a patch not cut
 * against HEAD, not applying to it or whose lines this tree lacks); 3 a pre-lock gate or the
 * pre-lock test run was red or the pre-lock mutation hold refused, nothing written — or under --check a hook refused, nothing written — or git or a hook refused once the index was touched, the
 * intent-add entries left in place so the same command re-run after the fix
 * just works — the output above being the work either way; 4
 * (--patch only) the commit landed but the worktree's index was not reset — never
 * re-run, do what the output says.
 */

const { spawn, spawnSync } = require("node:child_process");
const { spawnGitSync } = require("./lib/git.js");
const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const path = require("node:path");

const core = require("./lib/arbiter-core.js");
const { shellQuote } = require("./lib/sh-quote.js");
const { isUnder } = require("./lib/is-under.js");
const { numstatPaths } = require("./lib/patch-files.js");
const { notInTree } = require("./lib/patch-in-tree.js");
const { formatHeader, parseHeader } = require("./lib/hunk-header.js");
const { CHILD_MAX_BUFFER } = require("./lib/child-buffer.js");
const { caught } = require("./lib/caught.js");
const {
	commitKey,
	stampVariable,
	stampFile,
	writeStamp,
} = require("./lib/commit-key.js");
const { testGate } = require("./lib/test-gate.js");
const { isHoldArmable, readConfig } = require("./lib/workflow-core-config.js");
const { runInTree } = require("./lib/isolated-worktree.js");
const { trimEndRun } = require("./lib/trim-run.js");
const { readText } = require("./lib/file-read.js");

const NAME = "commit-paths";
const USAGE = `usage: node scripts/${NAME}.js (-m <message> | -F <file|->) -- <path>...
       node scripts/${NAME}.js (-m <message> | -F <file|->) --patch <file> [-- <path>...]
       node scripts/${NAME}.js --tree [--patch <file>] -- <path>...
       node scripts/${NAME}.js --check [--patch <file>] [-m <message> | -F <file|->] -- <path>...`;

/** @param {string} text */
const out = (text) => writeFd(1, text);
/** @param {string} text */
const err = (text) => writeFd(2, text);

/** Each exit's name in the outcome log. @type {Record<number, string>} */
const OUTCOMES = {
	0: "committed",
	2: "refused",
	3: "git-refused",
	4: "committed-unsettled",
};

/** Milliseconds the pre-lock test run and mutation hold took; `finish` logs it. */
let preLockMs = 0;
/** @param {number} ms */
function countPreLockMs(ms) {
	preLockMs += ms;
}

/** The slow gates run before the lock, in lib/commit-key.js's stamp facility (#1904), in their order. */
const SLOW_GATES = /** @type {const} */ (["test", "mutation"]);

/** @typedef {typeof SLOW_GATES[number]} SlowGate */

/** The line in .husky/pre-commit above which sits every core gate but the slow ones (#1763). */
const GATES_END =
	"# ---- end of the gates commit-paths runs before its suite ----";

/** @typedef {{index: string, messageFile: string, stamps: Record<SlowGate, string>, gates: string}} RunFiles */

/** @typedef {{ms: number}|{why: string}} SlowRun a green's milliseconds, or why the hook runs the gate instead */

/** @typedef {{gate: SlowGate, label: string, run: () => SlowRun}} DueGate */

/**
 * This run's private index — --patch's, or the pre-lock run's — --patch's
 * message file, each slow
 * gate's green stamp, the copy of the hook's gates it runs, and their sweeper.
 * @type {(RunFiles & {sweeper: import("node:child_process").ChildProcess})|null}
 */
let runFiles = null;

/** Set by --tree or --check, which commit nothing, so that finish logs no outcome. */
let commitsNothing = false;

/** Set by --check, whose refusals say nothing was committed. */
let checkOnly = false;

/** The review hold's stamp names, one per session (#3906). */
const REVIEW_TIER_STAMP = path.join(__dirname, "lib", "review-tier-stamp.sh");

/**
 * --check's private index and git directory, set by armStampRemoval once its
 * hooks may run and read by finish, through removeHookStamps, however the run
 * ends.
 * @type {{index: string, gitDir: string}|null}
 */
let checkedIndex = null;

/** @param {RunFiles} files */
const armStampRemoval = ({ index }) => {
	checkedIndex = { index, gitDir: path.dirname(index) };
};

/**
 * --check: removes each stamp the hooks leave keyed to the private index's
 * tree — pre-commit's stand-down stamp (mantahostels#1705) and this session's
 * review-hold stamp (#3664) — which a commit's prepare-commit-msg would have
 * consumed. One holding another tree is a neighbour commit's, and stays. Each
 * stamp it cannot judge is named, as one a later commit may stand down on.
 */
function removeHookStamps() {
	if (!checkedIndex) return;
	const { index, gitDir } = checkedIndex;
	checkedIndex = null;
	/** @param {string} what @param {string} why */
	const leftBehind = (what, why) =>
		err(
			`${NAME}: ${what} may be left in ${gitDir} (${why}); a later commit of the checked tree could stand its gates down on it. Remove it by hand.\n`,
		);
	const tree = spawnGitSync(["write-tree"], {
		encoding: "utf8",
		env: { ...process.env, GIT_INDEX_FILE: index },
	});
	if (tree.status !== 0)
		return leftBehind(
			"a hook's stamp",
			`git could not write the checked tree: ${(tree.stderr ?? "").trim()}`,
		);
	const stamps = [path.join(gitDir, "wfc-precommit-stamp")];
	const review = spawnSync(
		"bash",
		[
			"-c",
			'. "$1" && review_tier_stamp "$2"',
			"bash",
			REVIEW_TIER_STAMP,
			gitDir,
		],
		{ encoding: "utf8" },
	);
	if (review.status !== 0)
		leftBehind(
			"this session's review-hold stamp",
			`${REVIEW_TIER_STAMP} would not name it`,
		);
	else if (review.stdout.trim()) stamps.push(review.stdout.trim());
	for (const stamp of stamps) {
		const read = readText(stamp);
		if (read.state === "unreadable") leftBehind(stamp, read.message);
		if (read.state !== "read") continue;
		if (read.data.split("\n", 1)[0] === tree.stdout.trim())
			fs.rmSync(stamp, { force: true });
	}
}

function removeRunFiles() {
	if (!runFiles) return;
	fs.rmSync(runFiles.index, { force: true });
	fs.rmSync(runFiles.messageFile, { force: true });
	for (const stamp of Object.values(runFiles.stamps))
		fs.rmSync(stamp, { force: true });
	fs.rmSync(runFiles.gates, { force: true });
	runFiles.sweeper.stdin?.destroy();
}

/**
 * Append this run's outcome line and exit. A log that cannot be written says so
 * and changes nothing about the exit.
 * @type {(code: number) => never}
 */
const finish = (code) => {
	runPostCommit();
	removeHookStamps();
	removeRunFiles();
	if (commitsNothing) process.exit(code);
	try {
		const log = core.paths.commitPathsLog();
		fs.mkdirSync(path.dirname(log), { recursive: true });
		fs.appendFileSync(
			log,
			`${new Date().toISOString()}\t${OUTCOMES[code]}\t${(preLockMs / 1000).toFixed(1)}\n`,
		);
	} catch (e) {
		const { code: errCode, message } = caught(e);
		err(
			`${NAME}: could not append the outcome line (${errCode ?? message}).\n`,
		);
	}
	process.exit(code);
};

/** @type {(text: string, code: number) => never} */
const fail = (text, code) => {
	err(`${NAME}: ${text}\n`);
	return finish(code);
};

/** Set once the --patch commit has landed, until runPostCommit has run. */
let owedPostCommit = false;
const owePostCommit = () => {
	owedPostCommit = true;
};

/** Set once `git add -N` has run: a fault after it can no longer say "nothing written". */
let touched = false;
const markTouched = () => {
	touched = true;
};

/** @param {string} p */
const literal = (p) => `:(literal)${p}`;
/** A path as `git diff --name-only` gives it, from any directory. @param {string} p */
const topLiteral = (p) => `:(top,literal)${p}`;

/**
 * @param {string[]} args
 * @param {string} [index] a private index, as GIT_INDEX_FILE
 * @param {string} [input] stdin
 * @param {NodeJS.ProcessEnv} [extra] more environment, for this child alone
 * @returns {{status: number, stdout: string, stderr: string}}
 */
function git(args, index, input, extra) {
	const env = { ...process.env, ...extra };
	if (index) env.GIT_INDEX_FILE = index;
	const r = spawnGitSync(args, {
		encoding: "utf8",
		env,
		input,
	});
	if (r.error) fail(`could not run git (${r.error.message})`, touched ? 3 : 2);
	return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

/** @param {number} ms */
const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;

/** This worktree's top level. @type {string|undefined} */
let rootCache;
function readRoot() {
	// Git's one newline, not `trim()`: a checkout's name can end in whitespace.
	rootCache ??= fs.realpathSync(
		git(["rev-parse", "--show-toplevel"]).stdout.replace(/\n$/, ""),
	);
	return rootCache;
}

/** @param {string} stdout */
const nulList = (stdout) => stdout.split("\0").filter(Boolean);

/**
 * Walked token by token, so a message that is itself `--` is a value, not the
 * separator.
 * @param {string[]} argv
 * @returns {{message: string, paths: string[], patch: string|null, tree: boolean, check: boolean}}
 */
function parseArgs(argv) {
	let dash = -1;
	/** @type {string|null} */
	let message = null;
	/** @type {string|null} */
	let patch = null;
	let tree = false;
	let check = false;
	for (let i = 0; i < argv.length; i++) {
		const opt = argv[i];
		if (opt === "--") {
			dash = i;
			break;
		}
		if (opt === "--tree") {
			// Set as soon as seen, so a refusal after it logs no outcome either.
			tree = true;
			commitsNothing = true;
			continue;
		}
		if (opt === "--check") {
			check = true;
			checkOnly = true;
			commitsNothing = true;
			continue;
		}
		refuseOption(opt, { patch, message });
		const value = argv[++i];
		if (value === undefined) fail(`${opt} needs a value.\n${USAGE}`, 2);
		if (opt === "--patch") patch = readArgFile(value, value, "patch");
		else message = readMessageOf(opt, value);
	}
	const paths = dash === -1 ? [] : argv.slice(dash + 1);
	if (tree && check)
		fail(
			`give --tree or --check, not both: one prints the tree, the other runs its gates. Nothing written.\n${USAGE}`,
			2,
		);
	const given = requireMessage(message, { tree, check });
	refuseNoPaths({ patch, dash, paths });
	return { message: given, paths, patch, tree, check };
}

/**
 * The message `-m` gives, or `-F` reads from a file or `-` for stdin.
 * @param {string | undefined} opt
 * @param {string} value
 */
const readMessageOf = (opt, value) =>
	opt === "-m"
		? value
		: readArgFile(value === "-" ? 0 : value, value, "message");

/**
 * The message, refused where none was given or it is blank — or, under
 * --tree, where one was. Under --check none is "", its message checks skipped.
 * @param {string | null} message
 * @param {{tree: boolean, check: boolean}} mode
 * @returns {string}
 */
function requireMessage(message, { tree, check }) {
	if (tree) {
		if (message !== null)
			fail(`--tree commits nothing, so it takes no message.\n${USAGE}`, 2);
		return "";
	}
	if (check && message === null) return "";
	if (message === null || !message.trim())
		fail(`no commit message. Nothing written.\n${USAGE}`, 2);
	return message;
}

/**
 * Refuses a plain commit with no paths after `--`.
 * @param {{patch: string | null, dash: number, paths: string[]}} a
 */
function refuseNoPaths({ patch, dash, paths }) {
	if (patch === null && (dash === -1 || paths.length === 0))
		fail(
			`no paths after \`--\`. A commit with none would take whatever the index holds. Nothing written.\n${USAGE}`,
			2,
		);
}

/**
 * Refuses an unknown option, or a second patch or message.
 * @param {string | undefined} opt
 * @param {{patch: string | null, message: string | null}} seen
 */
function refuseOption(opt, { patch, message }) {
	if (opt !== "-m" && opt !== "-F" && opt !== "--patch")
		fail(`unknown option ${opt}. Nothing written.\n${USAGE}`, 2);
	if (opt === "--patch" && patch !== null)
		fail(
			`give --patch once; one patch may cover several files. Nothing written.\n${USAGE}`,
			2,
		);
	if (opt !== "--patch" && message !== null)
		fail(`give the message once, by -m or -F. Nothing written.\n${USAGE}`, 2);
}

/**
 * An option's file, read whole; a read failure refuses, naming `what`.
 * @param {string | number} source  a path, or 0 for stdin
 * @param {string} value  the option's value as given
 * @param {string} what
 * @returns {string}
 */
function readArgFile(source, value, what) {
	try {
		return fs.readFileSync(source, "utf8");
	} catch (e) {
		return fail(
			`could not read the ${what} from ${value} (${caught(e).code}).`,
			2,
		);
	}
}

/**
 * @param {string} p
 * @returns {"dir"|"file"|null}
 */
function readDiskKind(p) {
	try {
		return fs.lstatSync(p).isDirectory() ? "dir" : "file";
	} catch {
		return null;
	}
}

/**
 * The files git tracks at or under `p`, or the refusal git gave for the word
 * (a path outside the repository, say). A file is tracked where the index
 * lists it, or where HEAD does and it is gone from disk, a `git mv` source
 * (#1794) or a `git rm` — so a file untracked with `git rm --cached` and still
 * on disk meets the ignore check (#2363).
 * Residual: on an unborn branch there is no HEAD to read, so a `git mv`
 * source still refuses.
 * @param {string} p
 * @param {"dir"|"file"|null} kind
 */
function trackedUnder(p, kind) {
	const indexed = lsFiles(p);
	if (kind === "file" || !hasHeadCommit()) return indexed;
	const inIndex = new Set(indexed);
	return lsFiles(p, "--with-tree=HEAD").filter(
		(f) => inIndex.has(f) || readDiskKind(f) === null,
	);
}

/**
 * `git ls-files` at or under `p`, refusing on git's error.
 * @param {string} p
 * @param {string[]} flags
 */
function lsFiles(p, ...flags) {
	const r = git(["ls-files", "-z", ...flags, "--", literal(p)]);
	if (r.status !== 0) fail(`${p}: ${r.stderr.trim()}. Nothing written.`, 2);
	return nulList(r.stdout);
}

/**
 * The `git check-ignore -v` rule ignoring `p`, or null where none does. With
 * `-v` git exits 0 on a matching `!` rule too, which re-includes the path
 * (#1663). `-z`, which needs `--stdin`, splits the rule's fields where a `:`
 * in a source or pattern would not.
 * @param {string} p
 */
function readIgnoreRule(p) {
	const r = git(["check-ignore", "-v", "-z", "--stdin"], undefined, `${p}\0`);
	if (r.status === 1) return null;
	if (r.status !== 0)
		return fail(
			`git could not say whether ${p} is ignored (${r.stderr.trim()}). Nothing written.`,
			2,
		);
	const [source, line, pattern, file] = r.stdout.split("\0");
	if (pattern?.startsWith("!")) return null;
	return `${source}:${line}:${pattern}\t${file}`;
}

/**
 * Classify every path word, refusing on the first unsafe one; return the words
 * git does not track yet, to intent-add.
 * @param {string[]} paths
 */
function classify(paths) {
	/** @type {string[]} */
	const toAdd = [];
	for (const p of paths) {
		const kind = readDiskKind(p);
		const tracked = trackedUnder(p, kind);
		if (kind === "dir") {
			assertDirectoryCommittable(p, tracked);
			continue;
		}
		if (tracked.length > 0) continue;
		if (kind === null)
			fail(
				`${p} exists nowhere — not on disk, not tracked. Check the spelling. Nothing written.`,
				2,
			);
		const rule = readIgnoreRule(p);
		if (rule)
			fail(
				`${p} is ignored (${rule}). Scratch is not committed; if it should be, change the ignore rule first. Nothing written.`,
				2,
			);
		toAdd.push(p);
	}
	return toAdd;
}

/**
 * A directory passes only where git tracks something under it and nothing
 * under it is untracked; anything else refuses.
 * @param {string} p
 * @param {string[]} tracked
 */
function assertDirectoryCommittable(p, tracked) {
	const r = git([
		"ls-files",
		"-z",
		"--others",
		"--exclude-standard",
		"--",
		literal(p),
	]);
	if (r.status !== 0)
		fail(
			`git could not list the untracked files under ${p} (${r.stderr.trim()}). Nothing written.`,
			2,
		);
	const untracked = nulList(r.stdout);
	if (untracked.length > 0)
		fail(
			`${p} is a directory holding ${untracked.length} file(s) git does not track:\n${untracked.map((u) => `  ${u}`).join("\n")}\ngit would commit the tracked files under it and leave these behind. Name the ones that are yours as paths instead. Nothing written.`,
			2,
		);
	if (tracked.length > 0) return;
	const rule = readIgnoreRule(p);
	fail(
		rule
			? `${p} is ignored (${rule}). Scratch is not committed; if it should be, change the ignore rule first. Nothing written.`
			: `${p} is a directory holding nothing git tracks. Name the files in it you mean to add. Nothing written.`,
		2,
	);
}

/**
 * The files a patch touches — a rename's new name only — read from the top
 * level: from a subdirectory `git apply` drops every path outside it as if it
 * were not in the patch. Null where git cannot parse the patch.
 * @param {string} root
 * @param {string} patch
 */
function readPatchFiles(root, patch) {
	const r = git(
		["-C", root, "apply", "--numstat", "-z", "--unidiff-zero", "-"],
		undefined,
		patch,
	);
	if (r.status !== 0) return { files: null, why: r.stderr.trim() };
	return { files: numstatPaths(r.stdout), why: "" };
}

/** @typedef {import("./lib/patch-in-tree.js").PatchSection} PatchSection */

/**
 * Each `diff --git` section of `patch` with the file it touches; a section
 * git names no file for is left out.
 * @param {string} root
 * @param {string} patch
 * @returns {PatchSection[]}
 */
function readPatchSections(root, patch) {
	/** @type {PatchSection[]} */
	const sections = [];
	for (const section of patch.split(/^(?=diff --git )/m)) {
		const file = readPatchFiles(root, section).files?.[0];
		if (file) sections.push({ section, file });
	}
	return sections;
}

/**
 * The patch's files whose `index <old>..` line names a blob other than
 * `base`'s: a patch cut against something else, or this command re-run after
 * its commit landed, where a zero-context hunk that only adds lines applies
 * again and lands them twice. A section with no `index` line, or a new file's
 * all-zero one, is left to `git apply`.
 * @param {PatchSection[]} sections
 * @param {string} base
 */
function stalePreimages(sections, base) {
	const stale = [];
	for (const { section, file } of sections) {
		const pre = /^index ([0-9a-f]+)\.\./m.exec(section)?.[1];
		if (!pre || /^0+$/.test(pre)) continue;
		const blob = readBlobSha(base, file);
		if (!blob.startsWith(pre))
			stale.push(
				`${file} (cut against ${pre}, HEAD holds ${blob ? blob.slice(0, pre.length) : "no such file"})`,
			);
	}
	return stale;
}

/** `path`'s blob sha at `rev`, or "" where it has none. @type {(rev: string, file: string) => string} */
const readBlobSha = (rev, file) =>
	git(["rev-parse", "-q", "--verify", `${rev}:${file}`]).stdout.trim();

/** @param {string} sha */
const printCommitted = (sha) =>
	out(`committed ${git(["log", "-1", "--format=%h %s", sha, "--"]).stdout}`);

/**
 * `cut` with each hunk's new-side start recomputed from its old-side start and
 * the hunks kept above it in the same file. `git apply --unidiff-zero` places a
 * hunk with no old lines at its new-side line, which still counts the lines of
 * any hunk cut from above it (#1659).
 * @param {string} cut the patch as the session cut it
 * @returns {string}
 */
function renumberHunks(cut) {
	let shift = 0;
	let oldLeft = 0;
	let newLeft = 0;
	return cut
		.split("\n")
		.map((line) => {
			if (oldLeft > 0 || newLeft > 0) {
				if (line[0] !== "+" && line[0] !== "\\") oldLeft--;
				if (line[0] !== "-" && line[0] !== "\\") newLeft--;
				return line;
			}
			if (line.startsWith("--- ")) shift = 0;
			const h = renumberHeader(line, shift);
			if (!h) return line;
			({ oldLeft, newLeft } = h);
			shift += newLeft - oldLeft;
			return h.line;
		})
		.join("\n");
}

/**
 * A hunk header `line` with its new-side start moved to its old-side start
 * plus `shift`, and its two counts; null where `line` is not a header.
 * @param {string} line
 * @param {number} shift
 */
function renumberHeader(line, shift) {
	const h = parseHeader(line);
	if (!h) return null;
	// A zero-length side's start is the line before it, not its first.
	const above = h.oldStart - (h.oldCount === 0 ? 0 : 1) + shift;
	const newStart = above + (h.newCount === 0 ? 0 : 1);
	return {
		line: formatHeader({ ...h, newStart }),
		oldLeft: h.oldCount,
		newLeft: h.newCount,
	};
}

/**
 * --patch: commit the patch's hunks, plus `whole` as on disk, from a private
 * index, leaving the worktree's index and the working tree alone until the
 * commit has landed.
 * @param {string} message
 * @param {string} cut the patch as the session cut it
 * @param {string[]} whole
 * @returns {never}
 */
function commitPatch(message, cut, whole) {
	const { patch, root, sections } = preparePatch(cut, whole);

	// The commit itself is made from this private index, so its sweeper starts
	// whatever the test gate.
	const files = sweptRunFiles();
	const { index } = files;

	const patchBuild = { index, whole, root, patch, sections };
	const base = buildOnHead(patchBuild);
	// A refused rebuild exits, nothing written, rather than falling back to
	// the hook (#1653).
	const stampEnv = preLockRun(
		() => files,
		(privateIndex) => buildIndex({ ...patchBuild, index: privateIndex }, base),
	);

	// Every path the commit changes, a rename's both sides included, which
	// `git apply --numstat` reports only the new name of.
	const changed = nulList(
		git(["diff", "--cached", "--name-only", "-z", "--no-renames", base], index)
			.stdout,
	);
	const sha = commitIndex(message, files, base, stampEnv);

	resetIndex(changed);
	runPostCommit();

	out(git(["show", "--stat", "--format=", sha]).stdout);
	printCommitted(sha);
	return finish(0);
}

/**
 * `git commit -m <message>` from the private index, made step by step so the
 * message never passes through `$GIT_DIR/COMMIT_EDITMSG` (#2638). git's own
 * commit writes it there, hands its hooks that path and reads the message back
 * from it; a private index takes no lock on the worktree's, so a second commit
 * running alongside in the same worktree overwrites it and each lands under
 * the other's message. Here it lives in this run's own file. The hooks run as
 * runCommitHooks runs them; post-commit is left owed to runPostCommit. The
 * message is signed where `commit.gpgSign` says. The ref update names `base`
 * as HEAD's old value, so a HEAD another commit in this worktree moved since
 * the index was built refuses, nothing written.
 * @param {string} message
 * @param {RunFiles} files
 * @param {string} base
 * @param {NodeJS.ProcessEnv|undefined} stampEnv
 * @returns {string} the commit's sha
 */
function commitIndex(message, files, base, stampEnv) {
	const { tree, cleaned } = runCommitHooks(files, base, stampEnv, message);
	const run = inIndex(files.index, stampEnv);
	const sign =
		run(["config", "--type=bool", "--get", "commit.gpgSign"]).stdout.trim() ===
		"true"
			? ["-S"]
			: [];
	const sha = stdoutOrRefuse(
		run(["commit-tree", ...sign, tree, "-p", base], cleaned),
	).trim();
	const subject = cleaned.split("\n", 1)[0];
	stdoutOrRefuse(
		run(["update-ref", "-m", `commit: ${subject}`, "HEAD", sha, base]),
	);
	markTouched();
	owePostCommit();
	return sha;
}

/**
 * git over the private index, with `GIT_EDITOR=:` and the pre-lock stamps.
 * @param {string} index
 * @param {NodeJS.ProcessEnv|undefined} stampEnv
 * @returns {(args: string[], input?: string) => ReturnType<typeof git>}
 */
const inIndex = (index, stampEnv) => (args, input) =>
	git(args, index, input, { ...stampEnv, GIT_EDITOR: ":" });

/**
 * git's stdout, or a refusal relaying its output.
 * @param {ReturnType<typeof git>} r
 * @returns {string}
 */
function stdoutOrRefuse(r) {
	if (r.status === 0) return r.stdout;
	out(r.stdout);
	err(r.stderr);
	return fail(
		checkOnly
			? `a hook refused (exit ${r.status}), so a commit of these paths would be refused; the output above is the work. Nothing written.`
			: `git or a hook refused the commit (exit ${r.status}); the output above is the work. The worktree's index and the working tree were never touched, so re-running the same command after the fix is safe.`,
		3,
	);
}

/**
 * The hooks git's commit runs before it writes the commit object, over the
 * private index: pre-commit, then — unless `message` is "" — prepare-commit-msg
 * `<file> message` and commit-msg `<file>`, each seeing the private index and
 * `GIT_EDITOR=:`. The tree is the index as pre-commit leaves it, refused where
 * it matches the base's. The message is cleaned by `commit.cleanup` as `-m`'s
 * is, before the hooks see it and again after.
 * @param {RunFiles} files
 * @param {string|null} base null on an unborn branch
 * @param {NodeJS.ProcessEnv|undefined} stampEnv
 * @param {string} message
 * @returns {{tree: string, cleaned: string}}
 */
function runCommitHooks({ index, messageFile }, base, stampEnv, message) {
	const run = inIndex(index, stampEnv);
	/** git runs every hook with its stdout sent to stderr. */
	const hook = (/** @type {string[]} */ ...args) => {
		const r = run(["hook", "run", "--ignore-missing", ...args]);
		err(r.stderr);
		return { ...r, stderr: "" };
	};
	const cleanup = run(["config", "--get", "commit.cleanup"]).stdout.trim();
	/** @param {string} text */
	const clean = (text) =>
		cleanup === "verbatim"
			? text
			: stdoutOrRefuse(
					run(
						cleanup === "strip"
							? ["stripspace", "--strip-comments"]
							: ["stripspace"],
						text,
					),
				);

	stdoutOrRefuse(hook("pre-commit"));
	const tree = stdoutOrRefuse(run(["write-tree"])).trim();
	if (
		base !== null &&
		tree === git(["rev-parse", `${base}^{tree}`]).stdout.trim()
	)
		fail(
			"the pre-commit hook left the index matching HEAD, so there is nothing to commit. Read what the hook printed above for what it unstaged. Nothing written.",
			3,
		);
	if (message === "") return { tree, cleaned: "" };

	fs.writeFileSync(messageFile, clean(message));
	stdoutOrRefuse(hook("prepare-commit-msg", "--", messageFile, "message"));
	stdoutOrRefuse(hook("commit-msg", "--", messageFile));
	const cleaned = clean(fs.readFileSync(messageFile, "utf8"));
	if (!cleaned.trim())
		fail(
			"the prepare-commit-msg or commit-msg hook left the message empty, so git made no commit. Read what that hook printed above. Nothing written.",
			3,
		);
	return { tree, cleaned };
}

/**
 * What git's commit runs once its commit has landed and the index matches it:
 * post-commit, whose exit git ignores, then the auto maintenance. Run after
 * the worktree's index is reset, because post-commit's claim release reads it,
 * and before the reset it still holds the old copies, reading every committed
 * file as still uncommitted (#3565). finish runs it too, so a reset that fails
 * still runs the hook on the commit that landed.
 *
 * Residual: after a failed reset the hook reads the old copies still in the
 * index, so its claim release keeps every committed file's claim.
 */
function runPostCommit() {
	if (!owedPostCommit) return;
	const env = { GIT_EDITOR: ":" };
	owedPostCommit = false;
	// git runs every hook with its stdout sent to stderr.
	const r = git(
		["hook", "run", "--ignore-missing", "post-commit"],
		undefined,
		undefined,
		env,
	);
	err(r.stderr);
	git(["maintenance", "run", "--auto", "--quiet"], undefined, undefined, env);
}

/**
 * The patch renumbered, the top level it applies from and its sections as
 * cut; refuses where `whole` or the patch cannot be committed together.
 * @param {string} cut the patch as the session cut it
 * @param {string[]} whole
 */
function preparePatch(cut, whole) {
	classify(whole);
	const patch = renumberHunks(cut);
	const root = readRoot();
	const patched = readPatched(root, patch);

	refuseWholeInPatch(whole, patched);
	const sections = readPatchSections(root, cut);
	refuseNotInTree(root, sections);

	if (!hasHeadCommit())
		fail("--patch needs a HEAD to apply the patch to. Nothing written.", 2);
	// A commit made by commit-tree takes no second parent and clears no
	// sequencer state, so it would land as a plain commit mid-operation.
	for (const ref of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"])
		if (git(["rev-parse", "-q", "--verify", ref]).status === 0)
			fail(
				`${ref} is set: a merge, cherry-pick or revert is in progress, and --patch commits outside one. Finish or abort it first. Nothing written.`,
				2,
			);
	return { patch, root, sections };
}

/**
 * Refuses a patch whose post-image this tree's files lack — lines, mode or
 * binary content (#4338, #4339) — the next bare commit staging the reverse of
 * it. Takes the cut's sections, whose new-side lines number the file they
 * were cut from.
 * @param {string} root
 * @param {PatchSection[]} sections
 */
function refuseNotInTree(root, sections) {
	const checkout = {
		fileMode: readBoolConfig(root, "core.fileMode"),
		symlinks: readBoolConfig(root, "core.symlinks"),
	};
	// A typechange is a delete and a create of one path; its delete is judged
	// by the create.
	const created = new Set(
		sections
			.filter((s) => /^new file mode /m.test(s.section))
			.map((s) => s.file),
	);
	const refusals = [];
	for (const s of sections) {
		if (created.has(s.file) && /^deleted file mode /m.test(s.section)) continue;
		const tree = readTreeFile(root, s.file, checkout);
		if (tree === false) continue;
		const why = notInTree(s.section, tree);
		if (why !== null) refusals.push(`${s.file} (${why})`);
	}
	if (refusals.length > 0)
		fail(
			`the patch's lines, modes or contents are not in this tree's files for ${refusals.join("; ")}. --patch never writes the working tree, so this tree would show the commit reversed. Cut the patch from \`git diff HEAD -U0 -- <path>\` (\`--binary\` for a binary file) in the tree you commit from. Nothing written.`,
			2,
		);
}

/**
 * A boolean git config key's value in `root`, true where it is unset: git's
 * default for core.fileMode and core.symlinks alike.
 * @param {string} root
 * @param {string} key
 */
function readBoolConfig(root, key) {
	const r = git(["-C", root, "config", "--type=bool", key]);
	if (r.status === 1) return true;
	if (r.status !== 0)
		fail(`git could not read ${key} (${r.stderr.trim()}). Nothing written.`, 2);
	return r.stdout.trim() !== "false";
}

/**
 * A top-level path as git would store it — its text cleaned by its
 * attributes, so a CRLF checkout reads as its LF diff does; a symlink's
 * target; a submodule's `Subproject commit` line — with its blob sha and
 * the modes git would read it as; null where nothing is on disk there; false
 * for a directory that is no repository of its own, such as an uninitialised
 * submodule, where git sees no change to judge. The clean writes the blob to
 * the object store, where gc prunes it if unused.
 * @param {string} root
 * @param {string} file
 * @param {{fileMode: boolean, symlinks: boolean}} checkout
 * @returns {import("./lib/patch-in-tree.js").TreeFile|null|false}
 */
function readTreeFile(root, file, checkout) {
	const p = path.join(root, file);
	let stat;
	try {
		stat = fs.lstatSync(p);
	} catch {
		return null;
	}
	if (stat.isSymbolicLink()) {
		const text = fs.readlinkSync(p);
		const blob = readGit(
			["-C", root, "hash-object", "--stdin"],
			`git could not hash ${file}'s symlink target`,
			text,
		).trim();
		return { text, blob, modes: ["120000"] };
	}
	if (stat.isDirectory()) {
		const top = git(["-C", p, "rev-parse", "--show-toplevel"]);
		if (top.status !== 0 || top.stdout.trim() !== fs.realpathSync(p))
			return false;
		const blob = readGit(
			["-C", p, "rev-parse", "HEAD"],
			`git could not read submodule ${file}'s HEAD`,
		).trim();
		return { text: `Subproject commit ${blob}\n`, blob, modes: ["160000"] };
	}
	const blob = readGit(
		["-C", root, "hash-object", "-w", "--", file],
		`git could not read ${file} from the working tree`,
	).trim();
	// git's own test of the executable bit: the owner's.
	const diskMode = stat.mode & 0o100 ? "100755" : "100644";
	const modes = checkout.fileMode ? [diskMode] : ["100644", "100755"];
	// Without symlinks git checks a link out as a file holding its target.
	if (!checkout.symlinks) modes.push("120000");
	return {
		text: readGit(
			["cat-file", "blob", blob],
			`git could not read back ${file}'s cleaned blob`,
		),
		blob,
		modes,
	};
}

/**
 * git's stdout for `args`; refuses with `why` and git's stderr where it fails.
 * @param {string[]} args
 * @param {string} why
 * @param {string} [input]
 */
function readGit(args, why, input) {
	const r = git(args, undefined, input);
	if (r.status !== 0) fail(`${why} (${r.stderr.trim()}). Nothing written.`, 2);
	return r.stdout;
}

/**
 * The files the patch touches; refuses a patch git cannot read or one that
 * touches nothing.
 * @param {string} root
 * @param {string} patch
 * @returns {string[]}
 */
function readPatched(root, patch) {
	const { files, why } = readPatchFiles(root, patch);
	if (!files)
		fail(`git could not read the patch (${why}). Nothing written.`, 2);
	const patched = files;
	if (patched.length === 0)
		fail("the patch touches no file. Nothing written.", 2);
	return patched;
}

/**
 * A whole path takes the working-tree file whole, the lines the patch leaves
 * out included.
 * @param {string[]} whole
 * @param {string[]} patched
 */
function refuseWholeInPatch(whole, patched) {
	const prefix = git(["rev-parse", "--show-prefix"]).stdout.trim();
	for (const p of whole) {
		const rel = trimEndRun(
			path.posix.normalize(
				prefix + path.relative(process.cwd(), path.resolve(p)),
			),
			"/",
		);
		const hit = patched.find((q) => rel === "." || isUnder(q, [rel]));
		if (hit)
			fail(
				`${hit} is in the patch and also named whole after \`--\`, which would commit the whole working-tree file. Leave it to the patch. Nothing written.`,
				2,
			);
	}
}

/**
 * @typedef {{index: string, whole: string[], root: string, patch: string, sections: PatchSection[]}} PatchBuild
 */

/**
 * Builds the private index on HEAD; returns the HEAD it was built on.
 * @param {PatchBuild} b
 * @returns {string}
 */
function buildOnHead(b) {
	const base = git(["rev-parse", "HEAD"]).stdout.trim();
	buildIndex(b, base);
	return base;
}

/**
 * The private index: `base`, the whole paths as on disk, and the patch
 * applied; refuses where any step fails or nothing would change.
 * @param {PatchBuild} b
 * @param {string} base
 */
function buildIndex({ index, whole, root, patch, sections }, base) {
	fs.rmSync(index, { force: true });
	const tree = git(["read-tree", base], index);
	if (tree.status !== 0)
		fail(
			`git could not read HEAD into a private index (${tree.stderr.trim()}). Nothing written.`,
			2,
		);
	// A path gone from disk is staged as a removal. `git add -A` stages that
	// too, but exits 1 where the path is now gitignored — a file being
	// untracked and ignored in one commit (#1960).
	const gone = whole.filter((p) => readDiskKind(p) === null);
	const present = whole.filter((p) => !gone.includes(p));
	/** @type {[string[], string[]][]} */
	const steps = [
		[gone, ["rm", "-r", "--cached", "--quiet", "--ignore-unmatch", "--"]],
		[present, ["add", "-A", "--"]],
	];
	for (const [paths, args] of steps) {
		if (paths.length === 0) continue;
		const r = git([...args, ...paths.map(literal)], index);
		if (r.status !== 0)
			fail(
				`git could not stage ${paths.join(", ")} (${r.stderr.trim()}). Nothing written.`,
				2,
			);
	}
	const stale = stalePreimages(sections, base);
	if (stale.length > 0)
		fail(
			`the patch was not cut against HEAD for ${stale.join("; ")}. Where this command already committed it, it is done; otherwise cut it again from \`git diff HEAD -U0 -- <path>\`. Nothing written.`,
			2,
		);
	const r = git(
		["-C", root, "apply", "--cached", "--unidiff-zero", "-"],
		index,
		patch,
	);
	if (r.status !== 0)
		fail(
			`the patch does not apply to HEAD (${r.stderr.trim()}). Cut it from \`git diff HEAD -U0 -- <path>\`, which diffs against HEAD rather than the index. Nothing written.`,
			2,
		);
	if (git(["diff", "--cached", "--quiet", base], index).status === 0)
		fail(
			"nothing to commit — the patch and paths leave HEAD as it is. Nothing written.",
			2,
		);
}

/**
 * Brings the worktree's index to the new HEAD for every path committed; a
 * failure exits 4, saying how to do it by hand. Anything staged in those paths
 * is unstaged with it, and stays in the working tree.
 * @param {string[]} changed
 */
function resetIndex(changed) {
	const r = git(["reset", "-q", "--", ...changed.map(topLiteral)]);
	if (r.status === 0) return;
	err(r.stdout + r.stderr);
	fail(
		`git refused to bring the index to the commit (exit ${r.status}). Do not re-run this command: the commit has landed. Reset the index yourself, or it stages the reverse of this commit for the next bare \`git commit\`:\n  git reset -q -- ${changed.map(topLiteral).map(shellQuote).join(" ")}`,
		4,
	);
}

/** False on an unborn branch. */
function hasHeadCommit() {
	return git(["rev-parse", "--verify", "-q", "HEAD"]).status === 0;
}

/**
 * Names this run's own files in the per-worktree git directory, for its pid so
 * parallel runs never collide — the private index and each slow gate's
 * stamp — and starts the sweeper removing them however it ends, recording
 * them in `runFiles`.
 * @returns {RunFiles}
 */
function sweptRunFiles() {
	const r = git(["rev-parse", "--absolute-git-dir"]);
	if (r.status !== 0)
		fail(
			`git could not name the git directory (${r.stderr.trim()}). Nothing written.`,
			2,
		);
	const run = `${NAME}-${process.pid}`;
	/** @param {string} kind */
	const named = (kind) => path.join(r.stdout.trim(), `${run}.${kind}`);
	const index = named("index");
	const messageFile = named("message");
	const stamps = /** @type {Record<SlowGate, string>} */ (
		Object.fromEntries(
			SLOW_GATES.map((g) => [g, stampFile(g, r.stdout.trim(), run)]),
		)
	);
	const gates = named("gates");
	// An uncaught throw skips finish, and a signal kills this process where it
	// stands (#1680): a listener would wait for the spawnSync holding it to
	// return, and swallow a signal sent to it alone. So a detached shell removes
	// the files once its stdin — this process's end of a pipe, which no child
	// inherits — closes: ignoring the Ctrl-C or tree kill that ends this
	// process, and out of its process group, which a SIGKILL may be sent to
	// whole.
	const sweeper = spawn(
		"sh",
		[
			"-c",
			`trap '' HUP INT TERM; cat >/dev/null; rm -f -- "$@"`,
			"sh",
			index,
			messageFile,
			...Object.values(stamps),
			gates,
		],
		{ detached: true, stdio: ["pipe", "ignore", "ignore"] },
	);
	// A spawn that fails says so here, its pid unset: its `error` event waits
	// for an event loop this process never returns to. The run goes on, since a
	// file left behind opens nothing (#1639 story 20).
	if (sweeper.pid === undefined)
		err(
			`${NAME}: the shell that removes this run's files if it is killed did not start, so a kill may leave ${index} behind. Nothing honours it.\n`,
		);
	sweeper.on("error", () => {
		/* reported above; unhandled, it would throw in a test running this in process */
	});
	sweeper.unref();
	runFiles = { index, messageFile, stamps, gates, sweeper };
	return { index, messageFile, stamps, gates };
}

/** The mutation hold, the one gate script both its callers run (#1910). */
const MUTATION_HOLD = path.join(__dirname, "mutation-hold-gate.js");

/**
 * Whether the config on disk could fire the mutation hold, so a host where it
 * never can spawns nothing (#4306). A commit changing that, at HEAD alone or
 * staged alone, is left to the hook, which holds on both copies; an
 * unreadable config is too.
 */
function isHoldArmed() {
	try {
		const { modules, sensitivePaths } = readConfig();
		return isHoldArmable(modules, sensitivePaths);
	} catch {
		// Fails open to the hook, whose hold reads the config itself and says
		// so where it will not read (#1910).
		return false;
	}
}

/**
 * @param {string} root
 * @param {NodeJS.ProcessEnv} env naming the private index
 * @param {"--due"|"--pre-lock"} mode
 */
const runHold = (root, env, mode) =>
	spawnSync(process.execPath, [MUTATION_HOLD, mode], {
		cwd: root,
		env,
		stdio: ["ignore", "pipe", "pipe"],
		encoding: "utf8",
		maxBuffer: CHILD_MAX_BUFFER,
	});

/**
 * Run the slow gates due at commit before the commit takes the index lock,
 * after the hook's early gates (#1763): a commit-gated declared test (#1651),
 * then the mutation hold where it would run Stryker (#1910). Returns the
 * environment naming each green's stamp to the commit's own hook, which runs
 * in the lock whatever is not stamped — so nothing where none is due or none
 * can be had: the hook then acts, and refuses, alone. A red refuses here,
 * nothing written.
 * @param {() => RunFiles} runFilesNow the private index the runs see, where
 *   each green stamp goes and where the hook's gates are copied to run;
 *   called only once a run may be due, so a plain commit gated at push, the
 *   mutation hold unarmed, starts no sweeper (#1639 story 14)
 * @param {(index: string) => void} build (re)builds `index` as the commit will
 *   carry it, before each run and again after it; throws, saying why, where
 *   git refuses — or refuses outright, exiting, as the --patch build does
 * @returns {NodeJS.ProcessEnv|undefined}
 */
function preLockRun(runFilesNow, build) {
	let found;
	try {
		found = testGate();
	} catch {
		// Fails open to the hook, whose test gate reads the same config and
		// refuses on it: one refusal, from one place (spec #1639).
		err(
			`${NAME}: no pre-lock test run — the config could not be read, so the commit's hook judges it.\n`,
		);
		return;
	}
	const command = found.gate === "commit" ? found.command : null;
	const holdOn = isHoldArmed();
	if (command === null && !holdOn) return;
	const { index, stamps, gates } = runFilesNow();

	try {
		build(index);
	} catch (e) {
		err(
			`${NAME}: no pre-lock run — ${caught(e).message.trim()}. The commit's hook runs every gate in the lock instead.\n`,
		);
		return;
	}
	const root = readRoot();
	const common = git([
		"rev-parse",
		"--path-format=absolute",
		"--git-common-dir",
	]).stdout.trim();
	// As the hook runs its gates and suite: husky's PATH and the hook's own
	// main-checkout one.
	/** @type {NodeJS.ProcessEnv} */
	const runEnv = {
		...process.env,
		PATH: `${path.dirname(common)}/node_modules/.bin:node_modules/.bin:${process.env.PATH}`,
	};
	const holdEnv = { ...runEnv, GIT_INDEX_FILE: index };

	/** @type {DueGate[]} */
	const due = [];
	if (command !== null)
		due.push({
			gate: "test",
			label: `'${command}'`,
			run: () => preLockTest(root, index, command, runEnv),
		});
	if (holdOn && runHold(root, holdEnv, "--due").status === 0)
		due.push({
			gate: "mutation",
			label: "the mutation hold",
			run: () => preLockHold(root, holdEnv),
		});
	if (due.length === 0) return;

	preLockGates({
		root,
		index,
		gates,
		env: runEnv,
		slowLabel: due.map((d) => d.label).join(" and "),
	});
	const keyEnv = { ...process.env, GIT_INDEX_FILE: index };
	/** @type {NodeJS.ProcessEnv} */
	const stampEnv = {};
	for (const d of due) {
		const stamp = stampedRun(d, {
			stamp: stamps[d.gate],
			index,
			keyEnv,
			build,
		});
		if (stamp !== null) stampEnv[stampVariable(d.gate)] = stamp;
	}
	return stampEnv;
}

/**
 * One slow gate's pre-lock run, its green stamped where the commit's own
 * changes did not move while it ran (#1652); the stamp, or null, said, where
 * the hook runs the gate in the lock instead.
 * @param {DueGate} d
 * @param {{stamp: string, index: string, keyEnv: NodeJS.ProcessEnv, build: (index: string) => void}} at
 * @returns {string|null}
 */
function stampedRun({ gate, label, run }, { stamp, index, keyEnv, build }) {
	/** @type {(why: string) => null} */
	const deferToHook = (why) => {
		err(
			`${NAME}: no pre-lock green for ${label} — ${why}. The commit's hook runs it in the lock instead.\n`,
		);
		return null;
	};
	/** The key of the commit's own changes as they stand now; null, said, where git refuses (#1651). */
	const keyNow = () => {
		try {
			build(index);
			return commitKey(gate, { env: keyEnv });
		} catch (e) {
			return deferToHook(caught(e).message.trim());
		}
	};
	const keyBefore = keyNow();
	if (keyBefore === null) return null;
	const r = run();
	if ("why" in r) return deferToHook(r.why);

	// The hook's own key would void the stamp too; checking here names the
	// cause (#1652).
	const keyAfter = keyNow();
	if (keyAfter === null) return null;
	if (keyAfter !== keyBefore)
		return deferToHook(
			`it was green (${seconds(r.ms)}), but the commit's own changes moved while it ran`,
		);

	try {
		writeStamp(stamp, keyBefore);
	} catch (e) {
		return deferToHook(
			`it was green (${seconds(r.ms)}), but its stamp could not be written (${caught(e).code})`,
		);
	}
	err(
		`${NAME}: ${label} is green (${seconds(r.ms)}); the commit's hook stands its run down on that.\n`,
	);
	return stamp;
}

/**
 * The declared test over the commit's tree in a throwaway worktree (#1760).
 * @param {string} root
 * @param {string} index
 * @param {string} command
 * @param {NodeJS.ProcessEnv} env
 * @returns {SlowRun}
 */
function preLockTest(root, index, command, env) {
	const tree = git(["write-tree"], index);
	if (tree.status !== 0)
		return {
			why: `git could not write the commit's tree (${tree.stderr.trim()})`,
		};
	let start = Date.now();
	const r = runInTree(root, tree.stdout.trim(), command, {
		env,
		onStart: () => {
			err(
				`${NAME}: running '${command}' before the commit takes the index lock.\n`,
			);
			start = Date.now();
		},
	});
	if (r.error !== null) return { why: r.error.trim() };
	const ms = Date.now() - start;
	// Before the red refusal below, so the outcome log counts a red run too.
	countPreLockMs(ms);
	if (r.status !== 0) {
		err(r.output);
		if (r.spawnError) err(`${r.spawnError.message}\n`);
		// .husky/pre-commit's test gate prints these three lines too, worded for
		// its own run: change both together.
		fail(
			`the declared test command is RED — '${command}' — so this commit is refused. Nothing written.
  It ran on HEAD plus this commit's own paths, so no unsaved edit outside them reached it (#1760): the red is in HEAD, in this commit, or in a gitignored file the suite needs that its worktree lacks.
  Fix the failing test and commit again. Where the red is a gitignored file the worktree lacks, name it in \`worktreeLinks\` in .claude/workflow-core.json, and the worktree links it in (#1767).`,
			3,
		);
	}
	return { ms };
}

/**
 * The mutation hold on the private index, through the gate script the hook
 * runs, so the two give one verdict (#1910).
 * @param {string} root
 * @param {NodeJS.ProcessEnv} env naming the private index
 * @returns {SlowRun}
 */
function preLockHold(root, env) {
	err(
		`${NAME}: running the mutation hold before the commit takes the index lock.\n`,
	);
	const start = Date.now();
	const r = runHold(root, env, "--pre-lock");
	const ms = Date.now() - start;
	// Before the refusal below, as preLockTest's.
	countPreLockMs(ms);
	err(`${r.stdout ?? ""}${r.stderr ?? ""}`);
	// Its `--pre-lock` exits, in mutation-hold-gate.js's EXIT line: 0 green,
	// 1 refused, 3 left to the hook.
	if (r.status === 0) return { ms };
	if (r.status === 1)
		fail(
			"the mutation hold refused this commit before it took the index lock, as the commit's hook would. Nothing written.",
			3,
		);
	return {
		why:
			r.status === 3
				? "it judged nothing before the lock"
				: `it did not finish (${r.error?.message ?? (r.status === null ? `killed by ${r.signal}` : `exit ${r.status}`)})`,
	};
}

/**
 * The text of the pre-commit hook git runs, down to GATES_END, or why it
 * cannot be had (#1763). A hooks directory holding husky's `h` is read as
 * husky's shims, which run the hook of their own name one level up.
 * Residual: a husky whose shim is not named `h`, or a plain hooks directory
 * holding a file of that name, reads the wrong hook — one lacking the line,
 * so no gates run early and the hook runs them in the lock.
 * @param {string} root
 * @returns {{text: string, why: null}|{text: null, why: string}}
 */
function readHookGatesText(root) {
	const r = git([
		"-C",
		root,
		"rev-parse",
		"--path-format=absolute",
		"--git-path",
		"hooks",
	]);
	if (r.status !== 0)
		return {
			text: null,
			why: `git could not name the hooks directory (${r.stderr.trim()})`,
		};
	const hooks = r.stdout.trim();
	const hook = fs.existsSync(path.join(hooks, "h"))
		? path.join(path.dirname(hooks), "pre-commit")
		: path.join(hooks, "pre-commit");
	let lines;
	try {
		lines = fs.readFileSync(hook, "utf8").split("\n");
	} catch (e) {
		return { text: null, why: `${hook} could not be read (${caught(e).code})` };
	}
	const end = lines.indexOf(GATES_END);
	if (end === -1)
		return {
			text: null,
			why: `${hook} has no line marking where its gates end, an older hook than this script`,
		};
	return { text: `${lines.slice(0, end).join("\n")}\n`, why: null };
}

/**
 * Runs the hook's gates above its slow ones against `index`, as the hook runs
 * them in the lock, in this worktree, so this refuses only what the hook
 * would (#1763). A red refuses, nothing written; their output is held and shown on
 * a red alone, the hook printing it again in the lock. Gates that cannot be
 * read, or a run that does not finish, are said and left to the hook. The
 * hook's own stamp is written below
 * its slow gates, so never here.
 * @param {{root: string, index: string, gates: string, env: NodeJS.ProcessEnv, slowLabel: string}} a
 */
function preLockGates({ root, index, gates, env, slowLabel }) {
	/** @type {(why: string) => void} */
	const deferToHook = (why) => {
		err(
			`${NAME}: no early gate run — ${why}. The commit's hook runs its gates after ${slowLabel}, in the lock.\n`,
		);
	};
	const hook = readHookGatesText(root);
	if (hook.text === null) return deferToHook(hook.why);
	try {
		fs.writeFileSync(gates, hook.text);
	} catch (e) {
		return deferToHook(
			`the gates could not be copied out to run (${caught(e).code})`,
		);
	}
	err(
		`${NAME}: running the pre-commit hook's gates but its slow ones, before ${slowLabel}.\n`,
	);
	const r = spawnSync("sh", ["-c", 'sh -e "$1" </dev/null 2>&1', "sh", gates], {
		cwd: root,
		env: { ...env, GIT_INDEX_FILE: index },
		stdio: ["ignore", "pipe", "inherit"],
		encoding: "utf8",
		maxBuffer: CHILD_MAX_BUFFER,
	});
	fs.rmSync(gates, { force: true });
	if (r.status === 0) return;
	err(r.stdout ?? "");
	// A run that never finished is no gate's verdict.
	if (r.error || r.status === null)
		return deferToHook(
			`the run did not finish (${r.error?.message ?? `killed by ${r.signal}`})`,
		);
	fail(
		`a pre-commit gate refused this commit (exit ${r.status}), so ${slowLabel} never started. Nothing written.
  The gates ran on what the commit would carry, in this worktree, as the hook runs them in the lock, so it would refuse the same. A gate reading the working tree rather than the commit, as tsc and ESLint do, may be red on an unsaved edit this commit does not carry (mantahostels#273). Fix the finding above, or set that edit aside, and commit again.`,
		3,
	);
}

/**
 * Builds into `index`, without touching the worktree's, the index
 * `git commit -- <specs>` builds in the lock: HEAD (nothing on an unborn
 * branch) plus every path the specs reach in the index or HEAD, and
 * every untracked named file, each as the worktree has it — one gone from disk
 * as a deletion. Throws, saying why, where git refuses a step.
 * @param {{index: string, specs: string[], toAdd: string[]}} b
 */
function buildCommitIndex({ index, specs, toAdd }) {
	/** @type {(r: ReturnType<typeof git>, what: string) => string} */
	const ok = (r, what) => {
		if (r.status !== 0)
			throw new Error(`git could not ${what} (${r.stderr.trim()})`);
		return r.stdout;
	};
	fs.rmSync(index, { force: true });
	const hasHead = hasHeadCommit();
	const withTree = hasHead ? ["--with-tree=HEAD"] : [];
	let listed = ok(
		git(["ls-files", "-z", "--full-name", ...withTree, "--", ...specs]),
		"list the named paths",
	);
	if (toAdd.length > 0)
		listed += ok(
			git([
				"ls-files",
				"-z",
				"--full-name",
				"--others",
				"--",
				...toAdd.map(literal),
			]),
			"list the named new files",
		);
	if (hasHead)
		ok(git(["read-tree", "HEAD"], index), "read HEAD into a private index");
	ok(
		git(
			["-C", readRoot(), "update-index", "--add", "--remove", "-z", "--stdin"],
			index,
			listed,
		),
		"stage the named paths in a private index",
	);
}

/**
 * The named paths as git pathspecs, and the ones to intent-add; refuses where
 * any cannot be committed, or where every one matches HEAD and none is new.
 * An unborn branch has no HEAD to compare against; git decides there.
 * @param {string[]} paths
 */
function prepareWhole(paths) {
	const toAdd = classify(paths);
	const specs = paths.map(literal);
	if (
		toAdd.length === 0 &&
		hasHeadCommit() &&
		git(["diff", "--quiet", "HEAD", "--", ...specs]).status === 0
	)
		fail(
			"nothing to commit — every named path matches HEAD. Check the edit was saved and the path is the one you changed. Nothing written.",
			2,
		);
	return { toAdd, specs };
}

/**
 * --tree: print the tree the commit of `whole`, with `cut` applied where
 * given, would carry.
 * @param {string[]} whole
 * @param {string|null} cut
 * @returns {never}
 */
function printTree(whole, cut) {
	const { index } = sweptRunFiles();
	buildPrivateIndex(whole, cut, index);
	const r = git(["write-tree"], index);
	if (r.status !== 0)
		fail(`git could not write the tree (${r.stderr.trim()}).`, 2);
	out(r.stdout);
	return finish(0);
}

/**
 * --check: the verdict a commit of `whole`, with `cut` applied where given and
 * `message` where not "", would get — its pre-lock runs, then its hooks over
 * the private index — stopping before the commit object.
 * @param {string[]} whole
 * @param {string|null} cut
 * @param {string} message
 * @returns {never}
 */
function checkCommit(whole, cut, message) {
	const files = sweptRunFiles();
	const { base, build } = buildPrivateIndex(whole, cut, files.index);
	const stampEnv = preLockRun(() => files, build);
	armStampRemoval(files);
	runCommitHooks(files, base, stampEnv, message);
	if (message === "")
		err(
			`${NAME}: no message given, so the message checks — prepare-commit-msg and commit-msg — were skipped.\n`,
		);
	out(
		`${NAME}: every gate a commit of these paths would run passed. Nothing written.\n`,
	);
	return finish(0);
}

/**
 * The private index built as the commit's would be, refusing as it would; the
 * HEAD it is built on (null on an unborn branch), and its rebuild.
 * @param {string[]} whole
 * @param {string|null} cut
 * @param {string} index
 * @returns {{base: string|null, build: (index: string) => void}}
 */
function buildPrivateIndex(whole, cut, index) {
	if (cut !== null) {
		const { patch, root, sections } = preparePatch(cut, whole);
		const patchBuild = { index, whole, root, patch, sections };
		const base = buildOnHead(patchBuild);
		return {
			base,
			build: (i) => buildIndex({ ...patchBuild, index: i }, base),
		};
	}
	const { toAdd, specs } = prepareWhole(whole);
	const base = hasHeadCommit()
		? git(["rev-parse", "HEAD"]).stdout.trim()
		: null;
	/** @param {string} i */
	const build = (i) => buildCommitIndex({ index: i, specs, toAdd });
	try {
		build(index);
	} catch (e) {
		fail(`${caught(e).message}. Nothing written.`, 2);
	}
	return { base, build };
}

function main() {
	// Only this run's own stamps may reach its suite or its commit (#1639).
	for (const gate of SLOW_GATES) delete process.env[stampVariable(gate)];
	const { message, paths, patch, tree, check } = parseArgs(
		process.argv.slice(2),
	);

	if (git(["rev-parse", "--git-dir"]).status !== 0)
		fail("not inside a git repository. Nothing written.", 2);

	if (tree) printTree(paths, patch);
	if (check) checkCommit(paths, patch, message);
	if (patch !== null) commitPatch(message, patch, paths);

	const { toAdd, specs } = prepareWhole(paths);

	const stampEnv = preLockRun(sweptRunFiles, (index) =>
		buildCommitIndex({ index, specs, toAdd }),
	);

	const leftNote =
		toAdd.length > 0
			? `\nThe intent-add entries for ${toAdd.join(", ")} are left in the index — they commit nothing on their own — so re-running the same command after the fix just works.`
			: "";

	if (toAdd.length > 0) {
		const r = git(["add", "-N", "--", ...toAdd.map(literal)]);
		if (r.status !== 0) {
			err(r.stdout + r.stderr);
			fail(
				`git refused the intent-add (exit ${r.status}); git writes the index whole or not at all, so nothing was intent-added. Re-run once the cause above is gone.`,
				3,
			);
		}
		markTouched();
	}

	const r = git(
		["commit", "-m", message, "--", ...specs],
		undefined,
		undefined,
		stampEnv,
	);
	out(r.stdout);
	err(r.stderr);
	if (r.status !== 0)
		fail(
			`git or a hook refused the commit (exit ${r.status}); the output above is the work.${leftNote}`,
			3,
		);

	printCommitted("HEAD");
	finish(0);
}

main();
