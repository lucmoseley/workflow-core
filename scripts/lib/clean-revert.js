/*
 * clean-revert.js — whether a commit is the lander's clean revert of a
 * culprit (#3127), the one thing the two guard-registry gates exempt from
 * their staleness refusal.
 *
 * The lander names the culprit in WFC_LANDER_REVERT on its revert's commit and
 * on its push. The name only asks: a gate grants the exemption where the tree
 * it judges is what `git revert` of that culprit makes on the judged commit's
 * parent, conflict-free, recomputed here with `git merge-tree`, whose ort merge
 * is the one `git revert` runs. So the variable carries nothing past a gate
 * but a clean revert of a commit the repo holds.
 *
 * RESIDUAL: anyone may set it, an agent session included, and a clean revert
 * of any commit then lands with the rows it leaves stale. They stay stale
 * findings on every full run, and only staleness is exempt.
 */

const { spawnGitSync } = require("./git.js");

const LANDER_REVERT_ENV = "WFC_LANDER_REVERT";

/** @param {string} sha */
const buildRevertLine = (sha) => `This reverts commit ${sha}.`;

/** The culprit WFC_LANDER_REVERT names, or null where it is unset. */
const readLanderRevert = () => process.env[LANDER_REVERT_ENV] || null;

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string|null} stdout, or null on a non-zero exit
 */
function gitOut(cwd, args) {
	const r = spawnGitSync(["-C", cwd, ...args], { encoding: "utf8" });
	return r.status === 0 ? String(r.stdout) : null;
}

/**
 * Why `tree` is not a conflict-free revert of `culprit` made on `onto`, or
 * null where it is. A merge culprit may be reverted against any of its
 * parents, as the lander reverts against the one its bisect stepped from.
 * @param {string} cwd
 * @param {{culprit: string, onto: string, tree: string}} judged
 * @returns {string|null}
 */
function whyNotCleanRevert(cwd, { culprit, onto, tree }) {
	const parents = gitOut(cwd, ["rev-list", "--parents", "-n", "1", culprit]);
	if (parents === null) return `${culprit} is not a commit here`;
	const sides = parents.trim().split(" ").slice(1);
	if (sides.length === 0) return `${culprit} is a root commit`;
	const clean = sides.some(
		(side) =>
			gitOut(cwd, [
				"merge-tree",
				"--write-tree",
				`--merge-base=${culprit}`,
				onto,
				side,
			])?.split("\n")[0] === tree,
	);
	return clean
		? null
		: `its tree is not the conflict-free revert of ${culprit} on ${onto}`;
}

/**
 * Why the commit `sha`, pushed onto `tip`, is not the lander's revert of
 * `culprit`, or null where it is: its one parent is `tip`, its message carries
 * git's revert line for `culprit`, and its tree is the clean revert.
 * @param {string} cwd
 * @param {{culprit: string, sha: string, tip: string}} pushed
 * @returns {string|null}
 */
function whyNotLanderRevert(cwd, { culprit, sha, tip }) {
	const [full, head, base] = [culprit, sha, tip].map((rev) =>
		gitOut(cwd, ["rev-parse", "--verify", `${rev}^{commit}`])?.trim(),
	);
	if (!full) return `${culprit} is not a commit here`;
	if (!head || !base) return `${sha} or ${tip} is not a commit here`;
	const parents = gitOut(cwd, ["rev-list", "--parents", "-n", "1", head]);
	if (parents?.trim() !== `${head} ${base}`)
		return `${sha} is not one commit on ${tip}`;
	const line = buildRevertLine(full);
	const message = gitOut(cwd, ["log", "-1", "--format=%B", head]) ?? "";
	if (!message.includes(line))
		return `${sha}'s message does not carry "${line}"`;
	const tree = gitOut(cwd, ["rev-parse", `${head}^{tree}`]);
	if (tree === null) return `${sha}'s tree cannot be read`;
	return whyNotCleanRevert(cwd, {
		culprit: full,
		onto: base,
		tree: tree.trim(),
	});
}

module.exports = {
	LANDER_REVERT_ENV,
	buildRevertLine,
	readLanderRevert,
	whyNotCleanRevert,
	whyNotLanderRevert,
};
