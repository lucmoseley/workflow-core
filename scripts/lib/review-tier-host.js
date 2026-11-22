const fs = require("node:fs");
const path = require("node:path");
const {
	gitAnswer,
	gitCommonDir,
	gitOrNull,
	gitReader,
	HOOK_GIT_TIMEOUT_MS,
} = require("./git.js");
const { markersDir } = require("./marker-root.js");
const { trimEndRun } = require("./trim-run.js");

/**
 * @param {string} dir
 * @param {string[]} args
 */
const git = (dir, args) =>
	gitOrNull(args, { cwd: dir, timeout: HOOK_GIT_TIMEOUT_MS });

/**
 * @param {string} dir
 * @param {string[]} args
 */
const lines = (dir, args) =>
	git(dir, ["-c", "core.quotePath=false", ...args])
		?.split("\n")
		.filter((l) => l !== "") ?? null;

/**
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
 * @param {{ root: string }} env
 * @returns {import("./review-tier.js").TierPorts}
 */
function buildHostPorts({ root }) {
	return {
		commonDir: (dir) => gitCommonDir(dir, { timeout: HOOK_GIT_TIMEOUT_MS }),
		staged: (tree) => lines(tree, ["diff", "--cached", "--name-only"]),
		sessionBase: (sid, tree) => {
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
				return null;
			}
			if (!base) return null;
			if (
				gitInTime(tree, "merge-base", ["--is-ancestor", base, "HEAD"]) !== null
			)
				return base;
			return gitInTime(tree, "merge-base", [base, "HEAD"])?.trim() || null;
		},
		changedSince: (tree, base) => {
			const tracked = lines(tree, ["diff", "--name-only", base]);
			const untracked = lines(tree, [
				"ls-files",
				"--others",
				"--exclude-standard",
			]);
			return tracked && untracked && [...tracked, ...untracked];
		},
		billed: (sid, tree) => {
			try {
				const store = require("./arbiter-store.js");
				return store.withGitTimeout(HOOK_GIT_TIMEOUT_MS, () =>
					store.readBilledPathsBy(sid, "review tier", tree),
				).value;
			} catch {
				return null;
			}
		},
		declared: (tree) =>
			require("./workflow-core-config.js").readConfig({
				root: tree,
				quiet: true,
			}).sensitivePaths,
		declaredAt: (tree, rev) => {
			const { readConfig } = require("./workflow-core-config.js");
			try {
				return readConfig({ root: tree, rev, quiet: true }).sensitivePaths;
			} catch (e) {
				const { readCommit } = require("./commit-sha.js");
				const named = readCommit(gitReader(tree, HOOK_GIT_TIMEOUT_MS), rev);
				if (named.ok && named.sha === null) return;
				throw e;
			}
		},
	};
}

module.exports = { buildHostPorts };
