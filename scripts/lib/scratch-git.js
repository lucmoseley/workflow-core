/*
 * scratch-git.js — the dispatcher core that refuses running an untracked
 * shell script which writes git state but does not fail closed (#3162). Its
 * production ports, the script's text and whether a repository tracks it,
 * are lib/scratch-git-host.js.
 *
 * Why: on 27 Oct a review subagent's probe scripts sourced a helper a hook had
 * refused to write, so their `cd` into a scratch repository never ran and
 * every git command ran in the shared repository's root — two junk commits on
 * `main`, an emptied `.git/refs/heads/main` and a deleted `.git/index` (the
 * incident comment on #3098). The command guards parse a direct Bash call and
 * saw nothing: the git acts were in the script's file.
 *
 * WHAT IT REFUSES: a Bash call running a shell script that no repository
 * tracks, whose text writes git state — a git subcommand that changes a
 * repository, or any `.git` path — and which has not turned on BOTH errexit
 * and nounset before its first `cd`, `pushd`, `source`, `.` or git write.
 * Errexit stops a failed `cd` or `source`; nounset stops `cd "$SCRATCH"` on an
 * unset variable, which `cd ""` would otherwise leave in the start directory.
 * A later `set +e` or `set +u` turns the guard back off, and is read so. The
 * flags count from the interpreter's own words (`bash -eu x.sh`), the
 * shebang, or a `set` line.
 *
 * The routes it reads are lib/script-runs.js's, under bash/sh/zsh/dash/ksh; a
 * script run as the command itself counts where the file's shebang names a
 * shell or, with none, its name ends `.sh`.
 *
 * `set -e` DEPARTS FROM docs/practice/shell-scripting-and-hooks.md, whose
 * sources advise explicit checks over it: every surprise it carries ends a
 * probe early, which is the direction a script writing git state should fail.
 *
 * A TRACKED SCRIPT IS NEVER READ: a repository's own scripts are reviewed
 * code, and its git hooks write git state by design.
 *
 * DENY, NOT WARN (mantahostels#103): the file's text is a structured fact, and
 * the remedy — one `set -eu` line — is always open, so a false refusal costs
 * a line. No latch: each run is judged.
 *
 * LIMITS
 *  - The script's text is read LEXICALLY, line by line: a heredoc or a string
 *    mentioning `git commit` or `.git/` counts as a write, and a git act
 *    spelled through a variable, an alias or a script the script runs is not
 *    seen.
 *  - A heredoc into `bash` is not read, nor is any route lib/script-runs.js's
 *    LIMITS name.
 *  - A `cd` that SUCCEEDS into a scratch directory under the shared tree that
 *    is not a repository still lets git walk up into the shared `.git/`. The
 *    refusal says to build scratch under `mktemp -d`; nothing enforces it.
 *  - A script over the host's read cap, or unreadable, is allowed, logged; so
 *    is one git cannot say is tracked (mantahostels#103 §6).
 *  - `set -e` does not stop a failure inside an `if`, a `&&`/`||` list or a
 *    function called from one, so `cd x && …; git commit` still escapes it.
 *  - A command run outside Claude Code sees no hook.
 */

const { requiredGroup } = require("./regex-group.js");
const { scriptRuns, SHELL_NAMES, SHELLS } = require("./script-runs.js");

/**
 * @typedef {import("./guard-dispatch.js").CoreContext & {
 *   readScript: (abs: string) => string | null,
 *   isTracked: (abs: string) => boolean | null,
 * }} ScratchGitContext the script's text, null where it is absent, unreadable
 *   or over the host's cap; and whether the repository holding it tracks it,
 *   null where git cannot say
 * @typedef {import("./script-runs.js").Run & { flags: Set<string> }} Run
 *   with the letters its interpreter's own option words turn on
 */

/* `#!/bin/bash`, `#!/usr/bin/env bash`, `#!/usr/bin/env -S bash -eu`. */
const SHELL_SHEBANG = new RegExp(
	String.raw`^#!\s*\S*?\/(?:env\s+(?:-\S+\s+)*)?(?:${SHELL_NAMES.join("|")})(?:\s|$)`,
);

/* The git subcommands that change a repository, its objects, refs, index or
 * config. */
const GIT_WRITE = new RegExp(
	String.raw`(?:^|[\s;&|(])git(?:\s+(?:-[Cc]\s+\S+|--(?:git-dir|work-tree|namespace)\s+\S+|--[\w-]+(?:=\S+)?))*\s+` +
		`(?:${[
			"init",
			"clone",
			"add",
			"commit",
			"rm",
			"mv",
			"reset",
			"restore",
			"checkout",
			"switch",
			"branch",
			"tag",
			"merge",
			"rebase",
			"cherry-pick",
			"revert",
			"stash",
			"update-ref",
			"symbolic-ref",
			"update-index",
			"read-tree",
			"write-tree",
			"commit-tree",
			"hash-object",
			"mktree",
			"mktag",
			"reflog",
			"worktree",
			"submodule",
			"sparse-checkout",
			"clean",
			"apply",
			"am",
			"pull",
			"push",
			"fetch",
			"config",
			"notes",
			"replace",
			"filter-branch",
			"gc",
			"prune",
		].join("|")})(?![\\w-])`,
);
/* `.git/…` and `.git` itself, after a start, space, quote, `=`, `/` or a
 * redirect — never `.github/` or `.gitignore`. */
const DOT_GIT = /(?:^|[\s"'=/<>])\.git(?![\w.-])/;
const MOVES = /^\s*(?:cd|pushd|source|\.)(?:\s|$)/;
const OPTION_WORD = /^([-+])([a-zA-Z]+)$/;
const SET_LINE = /^\s*set\s+(.*)$/;

/* The long `-o` names this core reads, as the letter each shortens to. */
const LONG_OPTS = new Map([
	["errexit", "e"],
	["nounset", "u"],
]);

/* Each line kind that moves the script or writes git state. */
const RISKY = [MOVES, GIT_WRITE, DOT_GIT];

/**
 * Applies a run of option words to `on`: `-x` letters turn on and `+x` ones
 * off, long `-o`/`+o` names folded to their letter.
 * @param {string[]} words
 * @param {Set<string>} on accumulator: the letters on so far, changed in place
 */
function applyOptions(words, on) {
	words.forEach((w, i) => {
		const m = OPTION_WORD.exec(w);
		if (!m) return;
		const turnOn = requiredGroup(m, 1, OPTION_WORD) === "-";
		/** @param {string} ch */
		const flip = (ch) => (turnOn ? on.add(ch) : on.delete(ch));
		const letters = requiredGroup(m, 2, OPTION_WORD);
		for (const ch of letters) flip(ch);
		/* `-o errexit`, and `-euo pipefail`'s trailing `o` taking the next word. */
		const long = letters.endsWith("o")
			? LONG_OPTS.get(words[i + 1] ?? "")
			: null;
		if (long) flip(long);
	});
	return on;
}

/**
 * Where the script's text writes git state before turning on both flags, the
 * first line it reaches unguarded; null where it writes none or fails closed
 * first.
 * @param {string} text
 * @param {Run} run
 */
function unguardedWrite(text, { flags, direct }) {
	if (!GIT_WRITE.test(text) && !DOT_GIT.test(text)) return null;
	const lines = text.split("\n");
	const on = new Set(flags);
	/* An interpreter named on the command line ignores the shebang. */
	const shebang = direct && lines[0]?.startsWith("#!") ? lines[0] : "";
	if (shebang) applyOptions(shebang.slice(2).trim().split(/\s+/), on);
	return firstUnguarded(lines, on);
}

/**
 * @param {string[]} lines
 * @param {Set<string>} on accumulator: the letters on so far, which each
 *   `set` line changes in place
 */
function firstUnguarded(lines, on) {
	for (const line of lines) {
		const set = SET_LINE.exec(line);
		if (set) applyOptions(requiredGroup(set, 1, SET_LINE).split(/[\s;]+/), on);
		else if (
			!line.trimStart().startsWith("#") &&
			RISKY.some((r) => r.test(line)) &&
			!(on.has("e") && on.has("u"))
		)
			return line.trim();
	}
	return null;
}

/**
 * @param {string} command
 * @param {ScratchGitContext} ctx
 * @returns {import("./guard-dispatch.js").CoreDecision}
 */
function decide(command, ctx) {
	const runs = scriptRuns(command, ctx, { interpreters: SHELLS }).map(
		(run) => ({ ...run, flags: applyOptions(run.opts, new Set()) }),
	);
	/* The overwhelming majority of Bash calls leave here. */
	if (runs.length === 0) return null;
	for (const run of runs) {
		const line = refusedLine(run, ctx);
		if (line !== null) return { deny: ctx.corePaths(refusal(run.shown, line)) };
	}
	return null;
}

/**
 * The line an untracked shell script reaches unguarded; null where the run
 * is allowed, logged where that is for want of an answer.
 * @param {Run} run
 * @param {ScratchGitContext} ctx
 */
function refusedLine(run, ctx) {
	const text = ctx.readScript(run.abs);
	if (text === null) {
		ctx.log(`${run.abs} could not be read — script run allowed unchecked`);
		return null;
	}
	/* A file run as the command is a shell script only by its shebang or,
	 * with none, its name: a `node` or `python` one is not this core's. */
	const shell = text.startsWith("#!")
		? SHELL_SHEBANG.test(text)
		: run.abs.endsWith(".sh");
	if (run.direct && !shell) return null;
	const found = unguardedWrite(text, run);
	if (!found) return null;
	const tracked = ctx.isTracked(run.abs);
	if (tracked === null)
		ctx.log(`git ls-files could not answer for ${run.abs} — run allowed`);
	return tracked === false ? found : null;
}

/**
 * @param {string} shown the script as the command named it
 * @param {string} line the first line it reaches unguarded
 */
function refusal(shown, line) {
	return `Refused: \`${shown}\` writes git state but does not fail closed — it reaches \`${line}\` before turning on both errexit and nounset. If a \`cd\` or \`source\` fails, the rest runs in the directory you started in, which is the shared repository: on 27 Oct a probe like this one committed on \`main\`, emptied \`.git/refs/heads/main\` and deleted \`.git/index\` for every session (#3162). Put this as the script's first command, keep it on, then run it again:

    set -eu

And build any scratch repository under \`"$(mktemp -d)"\`, never under this repository, so a git command run in a scratch directory that is not a repository cannot walk up into the shared \`.git/\`.`;
}

module.exports = {
	field: "command",
	noun: "script run",
	decide,
};
