/*
 * clean-revert.js — whether a commit is the lander's clean revert of a
 * culprit (workflow-core#3127), the one thing the two guard-registry gates exempt from
 * their staleness refusal.
 *
 * The lander names the culprit in WFC_LANDER_REVERT on its revert's commit and
 * on its push. The name only asks: a gate grants the exemption where the tree
 * it judges is what `git revert` of that culprit makes on the judged commit's
 * parent, recomputed here with `git merge-tree`, whose ort merge is the one
 * `git revert` runs. So the variable carries nothing past a gate but a clean
 * revert of a commit the repo holds.
 *
 * A CONFLICT ONLY IN ANCHOR FILES STILL COUNTS AS CLEAN (workflow-core#3935). `git merge-file
 * --ours` settles the file for the side the revert is made on. Regenerating it
 * instead would write a read nobody made (workflow-core#3127). A kept digest can only read
 * stale: the fix ticket owes a guard-registry row's re-read, and a census row
 * reports on the full run.
 *
 * RESIDUAL: anyone may set it, an agent session included, and a clean revert
 * of any commit then lands with the rows it leaves stale. They stay stale
 * findings on every full run, and only staleness is exempt.
 */

const { commitSha } = require("./commit-sha.js");
const { spawnGitSync } = require("./git.js");

const LANDER_REVERT_ENV = "WFC_LANDER_REVERT";

const ANCHOR_FILES = new Set([
	".claude/guard-registry-anchors.json",
	"scripts/code-standards-anchors.json",
	"scripts/code-standards-base-anchors.json",
	"scripts/instruction-surface-anchors.json",
]);

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
 * The revert's bytes for each path in `conflicted`, its conflicted hunks keeping
 * `onto`'s side, or null where a path is no anchor file, a path's three versions
 * do not all exist, or a result is not JSON. An empty `conflicted` is null.
 * @param {string} cwd
 * @param {{culprit: string, onto: string, side: string}} revert `side` the
 *   parent of `culprit` the revert restores
 * @param {string[]} conflicted
 * @returns {Map<string, string>|null}
 */
function readKeptAnchors(cwd, { culprit, onto, side }, conflicted) {
	if (conflicted.length === 0) return null;
	/** @type {Map<string, string>} */
	const kept = new Map();
	for (const file of conflicted) {
		if (!ANCHOR_FILES.has(file)) return null;
		const merged = gitOut(cwd, [
			"merge-file",
			"-p",
			"--ours",
			"--object-id",
			`${onto}:${file}`,
			`${culprit}:${file}`,
			`${side}:${file}`,
		]);
		if (merged === null || !isJson(merged)) return null;
		kept.set(file, merged);
	}
	return kept;
}

/** @param {string} text */
function isJson(text) {
	try {
		JSON.parse(text);
		return true;
	} catch {
		return false;
	}
}

/**
 * Whether `tree` is the revert of `culprit` against `side` on `onto`: the
 * merge's own tree, or that tree with its anchor conflicts kept.
 * @param {string} cwd
 * @param {{culprit: string, onto: string, side: string, tree: string}} judged
 */
function isRevertTree(cwd, { culprit, onto, side, tree }) {
	const merged = spawnGitSync(
		[
			"-C",
			cwd,
			"merge-tree",
			"--write-tree",
			"--name-only",
			`--merge-base=${culprit}`,
			onto,
			side,
		],
		{ encoding: "utf8" },
	);
	/* Prints the tree, then on a conflict the conflicted paths up to a blank line. */
	const [made, ...rest] = String(merged.stdout).split("\n");
	if (merged.status === 0) return made === tree;
	if (merged.status !== 1 || !made) return false;
	const kept = readKeptAnchors(
		cwd,
		{ culprit, onto, side },
		rest.slice(0, rest.indexOf("")),
	);
	if (kept === null) return false;
	const differing = gitOut(cwd, ["diff-tree", "-r", "--name-only", made, tree]);
	return (
		differing
			?.split("\n")
			.filter(Boolean)
			.every((file) => kept.has(file)) &&
		[...kept].every(
			([file, bytes]) =>
				gitOut(cwd, ["cat-file", "blob", `${tree}:${file}`]) === bytes,
		)
	);
}

/**
 * Why `tree` is not a clean revert of `culprit` made on `onto`, or null where it
 * is. A merge culprit may be reverted against any of its parents, as the lander
 * reverts against the one its bisect stepped from.
 * @param {string} cwd
 * @param {{culprit: string, onto: string, tree: string}} judged
 * @returns {string|null}
 */
function whyNotCleanRevert(cwd, { culprit, onto, tree }) {
	const parents = gitOut(cwd, ["rev-list", "--parents", "-n", "1", culprit]);
	if (parents === null) return `${culprit} is not a commit here`;
	const sides = parents.trim().split(" ").slice(1);
	if (sides.length === 0) return `${culprit} is a root commit`;
	return sides.some((side) => isRevertTree(cwd, { culprit, onto, side, tree }))
		? null
		: `its tree is not the clean revert of ${culprit} on ${onto}`;
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
		commitSha(cwd, rev),
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
	readKeptAnchors,
	readLanderRevert,
	whyNotCleanRevert,
	whyNotLanderRevert,
};
