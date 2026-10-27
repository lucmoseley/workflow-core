#!/usr/bin/env node
/**
 * mark-pass.js — step 6's marker: the session base and the cut count.
 *
 *   node .claude/skills/concision-pass/scripts/mark-pass.js <cuts> [--base <rev>]
 *
 * Writes `.concision-pass-<session-id>` under the markers directory:
 *
 *   base=<the session's start sha>
 *   findings=<cuts>
 *   route=in-session
 *
 * The markers directory is the Stop backstop's: CLAUDE_PROJECT_DIR, else the
 * directory holding the git common dir, so a pass marked from a throwaway
 * worktree lands where the backstop reads.
 *
 * `base=` is `.concision-base-<session-id>`, written at SessionStart; `--base`
 * is the fallback where none was recorded, never an override (SKILL.md §6).
 *
 * Exit 0 written · 1 usage, a non-numeric count, no base, or a start-point
 * file it cannot read.
 */

const fs = require("node:fs");
const path = require("node:path");
const { writeFileAtomic } = require("../../../../scripts/lib/atomic-write.js");
const { markersDir } = require("../../../../scripts/lib/marker-root.js");
const { writeFd } = require("../../../../scripts/lib/write-fd.js");
const {
	execGit,
	gitCommonDirOrThrow,
} = require("../../../../scripts/lib/git.js");

const USAGE =
	"usage: node .claude/skills/concision-pass/scripts/mark-pass.js <cuts> [--base <rev>]";

/**
 * writeFd, not process.stderr: node drops what is still buffered on a pipe at
 * process.exit (docs/code-standards-base.md §N6).
 *
 * @param {string} msg
 * @returns {never}
 */
function die(msg) {
	writeFd(2, `mark-pass: ${msg}\n`);
	process.exit(1);
}

/** @param {unknown} err */
function parseErrorFirstLine(err) {
	return String(err instanceof Error ? err.message : err).split("\n")[0];
}

/** @param {string[]} args */
function git(args) {
	return execGit(args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

/**
 * The file's text, or "" where it does not exist. Any other fault dies: a
 * start point read as empty would fall back to --base unannounced.
 *
 * @param {string} file
 */
function readIfPresent(file) {
	try {
		return fs.readFileSync(file, "utf8");
	} catch (err) {
		if (/** @type {NodeJS.ErrnoException} */ (err)?.code === "ENOENT")
			return "";
		return die(`cannot read ${file}: ${parseErrorFirstLine(err)}`);
	}
}

/**
 * @param {string[]} argv
 * @returns {{ cuts: string, fallback: string }}
 */
function parseArgs(argv) {
	let cuts = "";
	let fallback = "";
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--base") fallback = argv[++i] ?? "";
		else if (cuts) die(USAGE);
		else cuts = argv[i] ?? "";
	}
	if (!/^[0-9]+$/.test(cuts))
		die(`<cuts> must be digits only, got '${cuts}'.\n${USAGE}`);
	return { cuts, fallback };
}

function markersRoot() {
	if (process.env.CLAUDE_PROJECT_DIR) return markersDir();
	try {
		return markersDir(path.dirname(gitCommonDirOrThrow(process.cwd())));
	} catch (err) {
		return die(`cannot find the git common dir: ${parseErrorFirstLine(err)}`);
	}
}

/**
 * @param {string} dir
 * @param {string} sid
 * @param {string} fallback
 */
function readSessionBase(dir, sid, fallback) {
	const base = readIfPresent(path.join(dir, `.concision-base-${sid}`)).trim();
	if (base) return base;
	if (!fallback)
		die(
			"no .concision-base for this session — pass --base <the step-1 fixed point>.",
		);
	try {
		return git(["rev-parse", "--verify", "--quiet", `${fallback}^{commit}`]);
	} catch {
		return die(`--base '${fallback}' is not a commit git can resolve.`);
	}
}

function main() {
	const { cuts, fallback } = parseArgs(process.argv.slice(2));
	const sid = process.env.CLAUDE_CODE_SESSION_ID;
	if (!sid)
		die("no CLAUDE_CODE_SESSION_ID, so there is no session marker to write.");
	const dir = markersRoot();
	const base = readSessionBase(dir, sid, fallback);

	const marker = path.join(dir, `.concision-pass-${sid}`);
	const body = `base=${base}\nfindings=${cuts}\nroute=in-session\n`;
	writeFileAtomic(marker, body);
	writeFd(1, `${marker}\n${body}`);
}

module.exports = { main };
if (require.main === module) main();
