#!/usr/bin/env node
/*
 * repair-main.js — restore a shared `main` that cannot be read, the one sanctioned
 * route to write it (#3198, spec #3597). Run by a session; the refill loop never
 * runs it. A `node` script because the founder's ruling chose one: `Bash(node *)`
 * is allowed, where the auto-mode classifier refused a session's direct ref write.
 *
 * Joins no §N3 family: it writes a ref, and exits 1 on a refusal its caller reads.
 *
 * Its proofs sit here with no core, as each is a question only real git answers,
 * which a port would only relay.
 *
 * Any failed proof refuses before the write:
 *  1. The ref file exists and `git rev-parse --verify` fails on it. A readable
 *     `main`, at whatever commit, is never touched.
 *  2. The shared tree has `main` checked out, as `git read-tree HEAD` would
 *     otherwise load another branch into its index.
 *  3. The target is the newest reflog entry whose new sha is an ancestor of
 *     `origin/landing` or `origin/main`.
 *  4. The ref file and `.git/index` are copied under `.claude/tmp/` first.
 *
 * THE REF IS WRITTEN BY HAND, as git itself refuses to lock a broken ref: `git
 * update-ref` answers "reference broken" (measured on git 2.43.0). It keeps git's
 * own protocol, a `.lock` file renamed over the ref, and proof 1 is re-read under
 * that lock, so of two sessions repairing at once the second refuses a `main` the
 * first has restored.
 *
 * Exit codes: 0; 1 on a refusal, or where the index would not rebuild after the
 * write, which the output says; 2 on a command line it refuses.
 */

const fs = require("node:fs");
const path = require("node:path");
const { buildErrorText, caught } = require("./lib/caught.js");
const { parseOrCode } = require("./lib/cli-args.js");
const { readCommit } = require("./lib/commit-sha.js");
const {
	gitCommonDir,
	gitOutcome,
	gitReader,
	spawnGitSync,
	GIT_TIMEOUT_MS,
} = require("./lib/git.js");
const { hostRoot } = require("./lib/host-root.js");
const { MAIN_REF, readMainState } = require("./lib/main-ref.js");
const { scriptPath } = require("./lib/script-path.js");
const { fromEnv } = require("./lib/session-id.js");
const { writeFd } = require("./lib/write-fd.js");

const USAGE = `usage: node ${scriptPath("repair-main.js")}
  restore a shared main that cannot be read, from a session, proofs first`;

const ORIGIN_REFS = ["origin/landing", "origin/main"];

const ASK_FOUNDER = `Leave it for the founder, on this checkout's probe hold: \`node ${scriptPath("repo-hold.js")} list\`.`;

const RERUN = `Re-run in a minute. ${ASK_FOUNDER}`;

const NOT_BROKEN = {
	readable:
		"`main` reads, so it is moved at most, not broken; nothing here may rewrite it. To move it forward, `git merge --ff-only <commit>`.",
	"no-ref-file": `.git/${MAIN_REF} does not exist, so \`main\` is not the empty or corrupt file this repairs. ${ASK_FOUNDER}`,
	unknown: `git did not answer on \`main\`, which proves nothing. ${RERUN}`,
};

/* `<old sha> <new sha> <who> <when>\t<message>`, the message optional. */
const REFLOG_LINE =
	/^[0-9a-f]+ (?<sha>[0-9a-f]{40}|[0-9a-f]{64}) [^\t]+(?:\t(?<message>.*))?$/;

/** Refused; its message says what failed. */
class Refusal extends Error {}

/**
 * @typedef {{sha: string|null, shown: string}} ReflogEntry  a torn line names no
 *   sha, and is shown whole, as it may be all that is left of a commit
 */

/** @param {string} line */
const say = (line) => writeFd(1, `${line}\n`);

/** @param {string} commonDir */
function requireBroken(commonDir) {
	const state = readMainState(commonDir);
	if (state !== "unreadable") throw new Refusal(NOT_BROKEN[state]);
}

/**
 * `main`'s reflog, oldest first, read as a file: a reflog command resolves the
 * broken ref first.
 * @param {string} commonDir
 * @returns {ReflogEntry[]}
 */
function readReflog(commonDir) {
	let text;
	try {
		text = fs.readFileSync(path.join(commonDir, "logs", MAIN_REF), "utf8");
	} catch (err) {
		throw new Refusal(
			`no reflog to take a target from: ${caught(err).message}. ${ASK_FOUNDER}`,
			{ cause: err },
		);
	}
	return text
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const fields = REFLOG_LINE.exec(line)?.groups;
			return fields
				? {
						sha: fields.sha ?? null,
						shown: `${fields.sha} ${fields.message ?? "(no message)"}`,
					}
				: { sha: null, shown: line };
		});
}

/**
 * What the origin refs name.
 * @param {string} commonDir
 * @returns {string[]}
 */
function readOriginShas(commonDir) {
	const read = gitReader(commonDir);
	const shas = ORIGIN_REFS.flatMap((ref) => {
		const r = readCommit(read, `refs/remotes/${ref}`);
		if (!r.ok) throw new Refusal(`could not read ${ref}: ${r.why}. ${RERUN}`);
		return r.sha ? [r.sha] : [];
	});
	if (shas.length === 0)
		throw new Refusal(
			`neither ${ORIGIN_REFS.join(" nor ")} resolves. ${ASK_FOUNDER}`,
		);
	return shas;
}

/**
 * Whether `sha` is an ancestor of an origin ref. Any exit but 0 is no proof: 1 is
 * not an ancestor, and past that git has lost the sha or it is a deletion's zeros
 * (#3198). A git cut off refuses, as it says nothing of the sha.
 * @param {string} commonDir
 * @param {string} sha
 * @param {string[]} origins
 */
function isPushed(commonDir, sha, origins) {
	return origins.some((origin) => {
		const r = spawnGitSync(["merge-base", "--is-ancestor", sha, origin], {
			cwd: commonDir,
			stdio: "ignore",
			timeout: GIT_TIMEOUT_MS,
		});
		if (r.error || r.status === null)
			throw new Refusal(
				`git did not answer whether ${sha} is an ancestor of ${origin}. ${RERUN}`,
			);
		return r.status === 0;
	});
}

/**
 * The newest entry an origin ref holds, and the entries newer than it.
 * @param {string} commonDir
 * @param {ReflogEntry[]} entries
 * @param {string[]} origins
 * @returns {{sha: string, newer: ReflogEntry[]}}
 */
function findTarget(commonDir, entries, origins) {
	for (let at = entries.length - 1; at >= 0; at--) {
		const sha = entries[at]?.sha;
		if (sha && isPushed(commonDir, sha, origins))
			return { sha, newer: entries.slice(at + 1) };
	}
	throw new Refusal(
		`no reflog entry of ${entries.length} is an ancestor of ${ORIGIN_REFS.join(" or ")}. ${ASK_FOUNDER}`,
	);
}

/**
 * Copy the damaged ref and the index into a directory of this run's own, so a
 * second repair in one session keeps the first's.
 * @param {string} commonDir
 * @param {string} session
 * @returns {string} the directory
 */
function writeBackup(commonDir, session) {
	const sessionDir = path.join(
		path.dirname(commonDir),
		".claude",
		"tmp",
		`git-repair-${session}`,
	);
	fs.mkdirSync(sessionDir, { recursive: true });
	const dir = fs.mkdtempSync(path.join(sessionDir, "run-"));
	fs.copyFileSync(path.join(commonDir, MAIN_REF), path.join(dir, "main"));
	const index = path.join(commonDir, "index");
	if (fs.existsSync(index)) fs.copyFileSync(index, path.join(dir, "index"));
	return dir;
}

/**
 * Take git's lock on the ref, prove it still broken under that lock, back up, and
 * rename the target into place.
 * @param {string} commonDir
 * @param {string} session
 * @param {string} sha
 * @returns {string} the backup directory
 */
function replaceBrokenRef(commonDir, session, sha) {
	const ref = path.join(commonDir, MAIN_REF);
	const lock = `${ref}.lock`;
	try {
		fs.writeFileSync(lock, `${sha}\n`, { flag: "wx" });
	} catch (err) {
		throw new Refusal(
			`could not take ${lock}, as git or another repair may be writing the ref: ${caught(err).message}. ${RERUN}`,
			{ cause: err },
		);
	}
	try {
		requireBroken(commonDir);
		const backup = writeBackup(commonDir, session);
		fs.renameSync(lock, ref);
		return backup;
	} catch (err) {
		fs.rmSync(lock, { force: true });
		throw err instanceof Refusal
			? err
			: new Refusal(
					`no backup, so no write: ${caught(err).message}. ${ASK_FOUNDER}`,
					{ cause: err },
				);
	}
}

/**
 * The entries the repair stepped over, for the caller to file.
 * @param {ReflogEntry[]} newer
 */
function sayNewer(newer) {
	if (newer.length === 0) {
		say("No reflog entry is newer than the target.");
		return;
	}
	say(
		`${newer.length} reflog entries newer than the target, none of them an ancestor of origin. File these on a ticket:`,
	);
	for (const { shown } of newer) say(shown);
}

/**
 * Prove it all, write, and rebuild the index.
 * @param {string} session
 * @returns {0|1}
 */
function repair(session) {
	const commonDir = gitCommonDir(hostRoot());
	if (!commonDir)
		throw new Refusal(`git names no shared .git here. ${ASK_FOUNDER}`);
	const root = path.dirname(commonDir);
	requireBroken(commonDir);
	const head = fs.readFileSync(path.join(commonDir, "HEAD"), "utf8").trim();
	if (head !== `ref: ${MAIN_REF}`)
		throw new Refusal(
			`the shared tree's HEAD is \`${head}\`, not on \`main\`. ${ASK_FOUNDER}`,
		);
	const { sha, newer } = findTarget(
		commonDir,
		readReflog(commonDir),
		readOriginShas(commonDir),
	);

	const backup = replaceBrokenRef(commonDir, session, sha);
	say(`Restored main to ${sha}. Backup of the ref and the index: ${backup}`);
	const rebuilt = gitOutcome(["read-tree", "HEAD"], [], root);
	if (rebuilt.ok) {
		const tip = gitOutcome(["log", "--oneline", "-1"], [], root);
		say(tip.ok ? tip.out.trimEnd() : `git log failed: ${tip.why}`);
	} else {
		writeFd(
			2,
			`The index did not rebuild, so run \`git read-tree HEAD\` in ${root}: ${rebuilt.why}\n`,
		);
	}
	sayNewer(newer);
	return rebuilt.ok ? 0 : 1;
}

function main(argv = process.argv.slice(2)) {
	const parsed = parseOrCode(argv, { usage: USAGE, max: 0 });
	if (typeof parsed === "number") return parsed;
	const session = fromEnv(process.env);
	try {
		if (!session) throw new Refusal("no session id. Run it from a session.");
		return repair(session);
	} catch (err) {
		if (!(err instanceof Refusal)) throw err;
		writeFd(2, `repair-main: refused, main not written: ${err.message}\n`);
		return 1;
	}
}

if (require.main === module) {
	try {
		process.exitCode = main();
	} catch (err) {
		writeFd(2, `${buildErrorText(err)}\n`);
		process.exitCode = 1;
	}
}
