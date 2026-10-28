/*
 * review-tier-host.js — the production ports lib/review-tier.js reads through
 * the dispatcher (#2792): git's view of the trees a review covers, this
 * session's start point and the paths it wrote or committed, and the host's
 * declared sensitive paths. Every git read carries the hook's git timeout, and
 * answers as an erroring one where it overruns.
 */

const fs = require("node:fs");
const path = require("node:path");
const { gitCommonDir, gitOrNull, HOOK_GIT_TIMEOUT_MS } = require("./git.js");
const { gitTopLevel } = require("./host-root.js");
const { markersDir } = require("./marker-root.js");

/**
 * git's stdout in `dir`, or null where git could not answer.
 * @param {string} dir
 * @param {string[]} args
 */
const git = (dir, args) =>
	gitOrNull(args, { cwd: dir, timeout: HOOK_GIT_TIMEOUT_MS });

/**
 * git's stdout as lines, none where git errors. core.quotePath=false, so a
 * non-ASCII path comes out raw, as the ledger holds it.
 * @param {string} dir
 * @param {string[]} args
 */
const lines = (dir, args) =>
	(git(dir, ["-c", "core.quotePath=false", ...args]) ?? "")
		.split("\n")
		.filter((l) => l !== "");

/**
 * @param {string} root
 * @returns {import("./review-tier.js").TierPorts}
 */
function buildHostPorts(root) {
	return {
		topLevel: (dir) => {
			try {
				return gitTopLevel(dir, HOOK_GIT_TIMEOUT_MS);
			} catch {
				/* Not a git tree, or git overran: no worktree to read. */
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
				base = fs
					.readFileSync(
						path.join(markersDir(root), `.concision-base-${sid}`),
						"utf8",
					)
					.replace(/\n+$/, "");
			} catch {
				/* No recorded base: the session bills nothing since one. */
				return null;
			}
			if (!base) return null;
			if (git(root, ["merge-base", "--is-ancestor", base, "HEAD"]) !== null)
				return base;
			return git(root, ["merge-base", base, "HEAD"])?.trim() || null;
		},
		/* lib/code-signal.sh's written_paths before attribution, its twin
		 * (#2971): what changed since `base` in the working tree,
		 * untracked files included. */
		changedSince: (tree, base) => [
			...lines(tree, ["diff", "--name-only", base]),
			...lines(tree, ["ls-files", "--others", "--exclude-standard"]),
		],
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
