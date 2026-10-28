/*
 * review-tier-host.js — the production ports lib/review-tier.js reads through
 * the dispatcher (#2792): git's view of the trees a review covers, this
 * session's start point and the paths it wrote or committed, and the host's
 * declared sensitive paths. Every git read carries the hook's git timeout; a
 * path listing that overruns answers as an erroring one, null, and the top
 * level and session base throw, so the core logs each fail-open (#3446).
 */

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const {
	gitAnswer,
	gitCommonDir,
	gitOrNull,
	HOOK_GIT_TIMEOUT_MS,
} = require("./git.js");
const { gitTopLevel } = require("./host-root.js");
const { markersDir } = require("./marker-root.js");
const { trimEndRun } = require("./trim-run.js");

/**
 * git's stdout in `dir`, or null where git could not answer.
 * @param {string} dir
 * @param {string[]} args
 */
const git = (dir, args) =>
	gitOrNull(args, { cwd: dir, timeout: HOOK_GIT_TIMEOUT_MS });

/**
 * git's stdout as lines, null where git errors. core.quotePath=false, so a
 * non-ASCII path comes out raw, as the ledger holds it.
 * @param {string} dir
 * @param {string[]} args
 */
const lines = (dir, args) =>
	git(dir, ["-c", "core.quotePath=false", ...args])
		?.split("\n")
		.filter((l) => l !== "") ?? null;

/**
 * `git <command> <args>`'s stdout in `dir`, null where git errors; throws
 * where it overran its timeout.
 * @param {string} dir
 * @param {string} command
 * @param {string[]} args
 */
const gitInTime = (dir, command, args) => {
	const { out, timedOut } = gitAnswer([command, ...args], {
		cwd: dir,
		timeout: HOOK_GIT_TIMEOUT_MS,
	});
	if (timedOut) throw new Error(`git ${command} overran its timeout`);
	return out;
};

/**
 * @param {string} root
 * @returns {import("./review-tier.js").TierPorts}
 */
function buildHostPorts(root) {
	return {
		topLevel: (dir) => {
			try {
				return gitTopLevel(dir, HOOK_GIT_TIMEOUT_MS);
			} catch (e) {
				if (caught(e).code === "ETIMEDOUT") throw e;
				/* Not a git tree, or no git to ask: no worktree to read. */
				return null;
			}
		},
		commonDir: (dir) => gitCommonDir(dir, { timeout: HOOK_GIT_TIMEOUT_MS }),
		staged: (tree) => lines(tree, ["diff", "--cached", "--name-only"]),
		/* lib/concision-marker.sh's concision_session_base, its twin
		 * (#2971). Existence is not
		 * validity (mantahostels#114): a parallel session's rebase leaves the
		 * recorded commit off HEAD's line, so the merge base stands in. */
		sessionBase: (sid) => {
			let base;
			try {
				base = trimEndRun(
					fs.readFileSync(
						path.join(markersDir(root), `.concision-base-${sid}`),
						"utf8",
					),
					"\n",
				);
			} catch {
				/* No recorded base: the session bills nothing since one. */
				return null;
			}
			if (!base) return null;
			if (
				gitInTime(root, "merge-base", ["--is-ancestor", base, "HEAD"]) !== null
			)
				return base;
			return gitInTime(root, "merge-base", [base, "HEAD"])?.trim() || null;
		},
		/* lib/code-signal.sh's written_paths before attribution, its twin
		 * (#2971): what changed since `base` in the working tree,
		 * untracked files included. */
		changedSince: (tree, base) => {
			const tracked = lines(tree, ["diff", "--name-only", base]);
			const untracked = lines(tree, [
				"ls-files",
				"--others",
				"--exclude-standard",
			]);
			return tracked && untracked && [...tracked, ...untracked];
		},
		/* In process, not a session-arbiter.js spawn: the store's own read, the
		 * ledger the bash nags read through `writes --committed`. A store that
		 * will not load is an unreadable ledger. */
		billed: (sid) => {
			try {
				const store = require("./arbiter-store.js");
				return store.withGitTimeout(HOOK_GIT_TIMEOUT_MS, () =>
					store.readBilledPathsBy(sid, "review tier"),
				).value;
			} catch {
				return null;
			}
		},
		declared: () =>
			require("./workflow-core-config.js").readConfig({ root, quiet: true })
				.sensitivePaths,
	};
}

module.exports = { buildHostPorts };
