#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { writeFileAtomic } = require("../../../../scripts/lib/atomic-write.js");
const { markersDir } = require("../../../../scripts/lib/marker-root.js");
const { writeFd } = require("../../../../scripts/lib/write-fd.js");
const { readCommit } = require("../../../../scripts/lib/commit-sha.js");
const {
	gitCommonDirOrThrow,
	gitReader,
} = require("../../../../scripts/lib/git.js");

const USAGE =
	"usage: node .claude/skills/concision-pass/scripts/mark-pass.js <cuts> [--base <rev>]";

/**
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

/**
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
	const r = readCommit(gitReader(), fallback);
	if (!r.ok) return die(`git would not resolve --base '${fallback}': ${r.why}`);
	return r.sha ?? die(`--base '${fallback}' is not a commit git can resolve.`);
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
