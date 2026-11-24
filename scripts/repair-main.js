#!/usr/bin/env node

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
const { VERIFIED_REF } = require("./lib/landing-refs.js");
const { checkoutOfCommonDir } = require("./lib/main-checkout.js");
const { MAIN_REF, readMainState } = require("./lib/main-ref.js");
const { scriptPath } = require("./lib/script-path.js");
const { fromEnv } = require("./lib/session-id.js");
const { writeFd } = require("./lib/write-fd.js");

const USAGE = `usage: node ${scriptPath("repair-main.js")}
  restore a shared main that cannot be read, from a session, proofs first`;

const ASK_FOUNDER = `Leave it for the founder, on this checkout's probe hold: \`node ${scriptPath("repo-hold.js")} list\`.`;

const RERUN = `Re-run in a minute. ${ASK_FOUNDER}`;

const NOT_BROKEN = {
	readable:
		"`main` reads, so it is moved at most, not broken; nothing here may rewrite it. To move it forward, `git merge --ff-only <commit>`.",
	"no-ref-file": `.git/${MAIN_REF} does not exist, so \`main\` is not the empty or corrupt file this repairs. ${ASK_FOUNDER}`,
	unknown: `git did not answer on \`main\`, which proves nothing. ${RERUN}`,
};

const REFLOG_LINE =
	/^[0-9a-f]+ (?<sha>[0-9a-f]{40}|[0-9a-f]{64}) [^\t]+(?:\t(?<message>.*))?$/;

class Refusal extends Error {}

/** @typedef {{sha: string|null, shown: string}} ReflogEntry */

/** @param {string} line */
const say = (line) => writeFd(1, `${line}\n`);

/** @param {string} commonDir */
function requireBroken(commonDir) {
	const state = readMainState(commonDir, GIT_TIMEOUT_MS);
	if (state !== "unreadable") throw new Refusal(NOT_BROKEN[state]);
}

/**
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
 * @param {string} commonDir
 * @returns {string[]}
 */
function readOriginShas(commonDir) {
	const r = readCommit(gitReader(commonDir), `refs/remotes/${VERIFIED_REF}`);
	if (!r.ok)
		throw new Refusal(`could not read ${VERIFIED_REF}: ${r.why}. ${RERUN}`);
	if (!r.sha)
		throw new Refusal(`${VERIFIED_REF} resolves to no commit. ${ASK_FOUNDER}`);
	return [r.sha];
}

// workflow-core#3198
/**
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
		`no reflog entry of ${entries.length} is an ancestor of ${VERIFIED_REF}. ${ASK_FOUNDER}`,
	);
}

/**
 * @param {string} commonDir
 * @param {string} root
 * @param {string} session
 * @returns {string}
 */
function writeBackup(commonDir, root, session) {
	const sessionDir = path.join(root, ".claude", "tmp", `git-repair-${session}`);
	fs.mkdirSync(sessionDir, { recursive: true });
	const dir = fs.mkdtempSync(path.join(sessionDir, "run-"));
	fs.copyFileSync(path.join(commonDir, MAIN_REF), path.join(dir, "main"));
	const index = path.join(commonDir, "index");
	if (fs.existsSync(index)) fs.copyFileSync(index, path.join(dir, "index"));
	return dir;
}

/**
 * @param {string} commonDir
 * @param {string} root
 * @param {string} session
 * @param {string} sha
 * @returns {string}
 */
function replaceBrokenRef(commonDir, root, session, sha) {
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
		const backup = writeBackup(commonDir, root, session);
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

/** @param {ReflogEntry[]} newer */
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
 * @param {string} session
 * @returns {0|1}
 */
function repair(session) {
	const commonDir = gitCommonDir(hostRoot());
	if (!commonDir)
		throw new Refusal(`git names no shared .git here. ${ASK_FOUNDER}`);
	const root = checkoutOfCommonDir(commonDir);
	if (!root)
		throw new Refusal(
			`the shared .git, ${commonDir}, names no checkout to restore. ${ASK_FOUNDER}`,
		);
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

	const backup = replaceBrokenRef(commonDir, root, session, sha);
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
