/*
 * clean-revert.js — whether a commit is the lander's clean revert of a
 * culprit (#3127), the one thing the two guard-registry gates exempt from
 * their staleness refusal.
 *
 * The lander names the culprit in WFC_LANDER_REVERT on its revert's commit and
 * on its push. The name only asks: a gate grants the exemption where the tree
 * it judges is what `git revert` of that culprit makes on the judged commit's
 * parent, recomputed here with `git merge-tree`, whose ort merge is the one
 * `git revert` runs. A culprit reverted with its conflicting
 * dependents (#4453) is pushed as one line of reverts, so the variable may name
 * several commits, space-separated, in the order their reverts were committed;
 * a commit names one.
 *
 * A CONFLICT ONLY IN ANCHOR FILES STILL COUNTS AS CLEAN (#3935). `git merge-file
 * --ours` settles the file for the side the revert is made on. Regenerating it
 * instead would write a read nobody made (#3127). A kept digest can only read
 * stale: the fix ticket owes a guard-registry row's re-read, and a census row
 * reports on the full run.
 *
 * The guard registry's file is settled by its merge driver's own per-row merge
 * (#4171), so a revert and its recomputation agree whether or not the git they
 * run under defines the driver: where it does, the file never conflicts and
 * `merge-tree` writes those bytes itself.
 *
 * RESIDUAL: anyone may set it, an agent session included, and a clean revert
 * of any commit then lands with the rows it leaves stale. They stay stale
 * findings on every full run, and only staleness is exempt.
 */

const { commitSha } = require("./commit-sha.js");
const { spawnGitSync } = require("./git.js");
const {
	REGISTRY_ANCHORS,
	buildMergedAnchors,
} = require("./registry-anchors-merge.js");

const LANDER_REVERT_ENV = "WFC_LANDER_REVERT";

const ANCHOR_FILES = new Set([
	REGISTRY_ANCHORS,
	"scripts/code-standards-anchors.json",
	"scripts/code-standards-base-anchors.json",
	"scripts/instruction-surface-anchors.json",
]);

/** @param {string} sha */
const buildRevertLine = (sha) => `This reverts commit ${sha}.`;

/**
 * The commit `message`'s revert line names, or null where it carries none.
 * @param {string} message
 * @returns {string|null}
 */
const parseRevertLine = (message) =>
	/This reverts commit ([0-9a-f]{40})\./.exec(message)?.[1] ?? null;

/**
 * The commits WFC_LANDER_REVERT names, or null where it names none.
 * @returns {string[]|null}
 */
const readLanderRevert = () => {
	const named = (process.env[LANDER_REVERT_ENV] ?? "")
		.split(" ")
		.filter(Boolean);
	return named.length > 0 ? named : null;
};

/**
 * The environment a revert of `reverted` is committed or pushed in.
 * @param {string[]} reverted
 */
const buildRevertEnv = (reverted) => ({
	...process.env,
	[LANDER_REVERT_ENV]: reverted.join(" "),
});

/** @param {string} file whether readKeptAnchors settles a conflict in it */
const isAnchorFile = (file) => ANCHOR_FILES.has(file);

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
		const merged =
			file === REGISTRY_ANCHORS
				? readRegistryMerge(cwd, { culprit, onto, side })
				: gitOut(cwd, [
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

/**
 * The registry file's per-row revert, its moved-on-both rows keeping `onto`'s
 * digest, or null where a version is missing or not JSON digests.
 * @param {string} cwd
 * @param {{culprit: string, onto: string, side: string}} revert
 * @returns {string|null}
 */
function readRegistryMerge(cwd, { culprit, onto, side }) {
	/** @param {string} rev */
	const readBlobAt = (rev) =>
		gitOut(cwd, ["cat-file", "blob", `${rev}:${REGISTRY_ANCHORS}`]);
	const base = readBlobAt(culprit);
	const ours = readBlobAt(onto);
	const theirs = readBlobAt(side);
	if (base === null || ours === null || theirs === null) return null;
	return buildMergedAnchors(base, ours, theirs);
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
 * Why the commits `sha` pushes onto `tip` are not the lander's reverts of
 * `culprits`, in that order, or null where they are: one line of commits on
 * `tip`, one per culprit, each with a single parent, git's revert line for its
 * culprit in its message, and the clean revert of it on that parent as its tree.
 * @param {string} cwd
 * @param {{culprits: string[], sha: string, tip: string}} pushed
 * @returns {string|null}
 */
function whyNotLanderRevert(cwd, { culprits, sha, tip }) {
	/** @type {string[]} */
	const full = [];
	for (const c of culprits) {
		const resolved = commitSha(cwd, c);
		if (!resolved) return `${c} is not a commit here`;
		full.push(resolved);
	}
	const [head, base] = [sha, tip].map((rev) => commitSha(cwd, rev));
	if (!head || !base) return `${sha} or ${tip} is not a commit here`;
	const chain = readCommitChain(cwd, base, head, full);
	if (chain === null)
		return `${sha} is not ${culprits.length === 1 ? "one commit" : `a line of ${culprits.length} commits`} on ${tip}`;
	for (const step of chain) {
		const why = whyNotOneRevert(cwd, step);
		if (why !== null) return why;
	}
	return null;
}

/**
 * The commits `base..head`, oldest first, each paired with its one parent and
 * the culprit at its place in `culprits`, where they form a single line on
 * `base` one commit per culprit; else null.
 * @param {string} cwd
 * @param {string} base
 * @param {string} head
 * @param {string[]} culprits
 * @returns {{culprit: string, commit: string, onto: string}[]|null}
 */
function readCommitChain(cwd, base, head, culprits) {
	const listed = gitOut(cwd, [
		"rev-list",
		"--reverse",
		"--parents",
		`${base}..${head}`,
	]);
	const rows = (listed ?? "").split("\n").filter(Boolean);
	if (rows.length !== culprits.length) return null;
	/** @type {{culprit: string, commit: string, onto: string}[]} */
	const chain = [];
	let onto = base;
	for (const [i, row] of rows.entries()) {
		const [commit, ...parents] = row.split(" ");
		const culprit = culprits[i];
		if (
			commit === undefined ||
			culprit === undefined ||
			parents.length !== 1 ||
			parents[0] !== onto
		)
			return null;
		chain.push({ culprit, commit, onto });
		onto = commit;
	}
	return chain;
}

/**
 * Why `commit` is not the clean revert of `culprit` on its parent `onto`,
 * carrying git's revert line, or null where it is.
 * @param {string} cwd
 * @param {{culprit: string, commit: string, onto: string}} judged
 * @returns {string|null}
 */
function whyNotOneRevert(cwd, { culprit, commit, onto }) {
	const line = buildRevertLine(culprit);
	const message = gitOut(cwd, ["log", "-1", "--format=%B", commit]) ?? "";
	if (!message.includes(line))
		return `${commit}'s message does not carry "${line}"`;
	const tree = gitOut(cwd, ["rev-parse", `${commit}^{tree}`]);
	if (tree === null) return `${commit}'s tree cannot be read`;
	return whyNotCleanRevert(cwd, { culprit, onto, tree: tree.trim() });
}

module.exports = {
	LANDER_REVERT_ENV,
	buildRevertEnv,
	buildRevertLine,
	isAnchorFile,
	parseRevertLine,
	readKeptAnchors,
	readLanderRevert,
	whyNotCleanRevert,
	whyNotLanderRevert,
};
