const { requiredGroup } = require("./regex-group.js");
const { scriptRuns, SHELL_NAMES, SHELLS } = require("./script-runs.js");

/**
 * @typedef {import("./core-contract.js").CoreContext & {
 *   readScript: (abs: string) => string | null,
 *   isTracked: (abs: string) => boolean | null,
 * }} ScratchGitContext
 * @typedef {import("./script-runs.js").Run & { flags: Set<string> }} Run
 */

const SHELL_SHEBANG = new RegExp(
	String.raw`^#!\s*\S*?\/(?:env\s+(?:-\S+\s+)*)?(?:${SHELL_NAMES.join("|")})(?:\s|$)`,
);

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
const DOT_GIT = /(?:^|[\s"'=/<>])\.git(?![\w.-])/;
const MOVES = /^\s*(?:cd|pushd|source|\.)(?:\s|$)/;
const OPTION_WORD = /^([-+])([a-zA-Z]+)$/;
const SET_LINE = /^\s*set\s+(?!\s)(.*)$/;

const LONG_OPTS = new Map([
	["errexit", "e"],
	["nounset", "u"],
]);

const RISKY = [MOVES, GIT_WRITE, DOT_GIT];

/**
 * @param {string[]} words
 * @param {Set<string>} on
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
		const long = letters.endsWith("o")
			? LONG_OPTS.get(words[i + 1] ?? "")
			: null;
		if (long) flip(long);
	});
	return on;
}

/**
 * @param {string} text
 * @param {Run} run
 */
function unguardedWrite(text, { flags, direct }) {
	if (!GIT_WRITE.test(text) && !DOT_GIT.test(text)) return null;
	const lines = text.split("\n");
	const on = new Set(flags);
	const shebang = direct && lines[0]?.startsWith("#!") ? lines[0] : "";
	if (shebang) applyOptions(shebang.slice(2).trim().split(/\s+/), on);
	return firstUnguarded(lines, on);
}

/**
 * @param {string[]} lines
 * @param {Set<string>} on
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
 * @returns {import("./core-contract.js").CoreDecision}
 */
function decide(command, ctx) {
	const runs = scriptRuns(command, ctx, { interpreters: SHELLS }).map(
		(run) => ({ ...run, flags: applyOptions(run.opts, new Set()) }),
	);
	if (runs.length === 0) return null;
	for (const run of runs) {
		const line = refusedLine(run, ctx);
		if (line !== null) return { deny: ctx.corePaths(refusal(run.shown, line)) };
	}
	return null;
}

/**
 * @param {Run} run
 * @param {ScratchGitContext} ctx
 */
function refusedLine(run, ctx) {
	const text = ctx.readScript(run.abs);
	if (text === null) {
		ctx.log(`${run.abs} could not be read — script run allowed unchecked`);
		return null;
	}
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
 * @param {string} shown
 * @param {string} line
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
