const path = require("node:path");
const { isUnder } = require("./is-under.js");
const { requiredGroup } = require("./regex-group.js");

// guess: enough to recognise a worktree by, #5806
const NAMED_MAX = 5;

/** @param {string[]} paths */
const nameSome = (paths) =>
	`${paths.slice(0, NAMED_MAX).join(", ")}${paths.length > NAMED_MAX ? `, and ${String(paths.length - NAMED_MAX)} more` : ""}`;

/**
 * @typedef {{rel: string, head: string, index: string, gone: boolean}} Entry
 * @typedef {{tracked: Entry[], deleted: string[], untracked: string[],
 *   odd: string[]}} Status
 * @typedef {Entry & {blob: string}} File
 * @typedef {{sessionId: string, name: string|null, live: boolean}} Owner
 * @typedef {{why: string} | {ownedTrees: string[], unread: string[],
 *   owner: Owner|null}} Ownership
 * @typedef {{pid: string, cwd: string}[] | {error: string}} Processes
 * @typedef {{
 *   root: string,
 *   mainRoot: string,
 *   target: string,
 *   cwd: string,
 *   linked: string[]|null,
 * }} Registration
 * @typedef {{
 *   target: string,
 *   ref: string,
 *   commits: {unresolved: true} | {unlanded: number|null},
 *   status: Status|null,
 *   keptOnRef: string[],
 *   files: File[]|null,
 *   landed: boolean[],
 *   processes: Processes,
 *   selfPid: string,
 *   ownership: Ownership,
 * }} Contents
 */

// https://git-scm.com/docs/git-status#_porcelain_format_version_2
const CHANGED =
	/^[12] (\S\S) (\S{4}) \S+ \S+ \S+ ([0-9a-f]+) ([0-9a-f]+) (?:[RC]\d+ )?(.+)$/;

/**
 * @param {string} out
 * @returns {Status}
 */
function parseStatus(out) {
	/** @type {Status} */
	const acc = { tracked: [], deleted: [], untracked: [], odd: [] };
	const fields = out.split("\0").filter(Boolean);
	const it = fields[Symbol.iterator]();
	for (const f of it) {
		if (f.startsWith("? ")) {
			acc.untracked.push(f.slice(2));
			continue;
		}
		const m = CHANGED.exec(f);
		if (!m || requiredGroup(m, 2, CHANGED).startsWith("S")) {
			acc.odd.push(f);
			continue;
		}
		if (f.startsWith("2 ")) {
			const { value: from, done } = it.next();
			if (done) {
				acc.odd.push(f);
				continue;
			}
			acc.deleted.push(from);
		}
		acc.tracked.push({
			rel: requiredGroup(m, 5, CHANGED),
			head: requiredGroup(m, 3, CHANGED),
			index: requiredGroup(m, 4, CHANGED),
			gone: requiredGroup(m, 1, CHANGED).includes("D"),
		});
	}
	return acc;
}

/** @param {Status} status */
const deletedPaths = (status) => [
	...status.deleted,
	...status.tracked.filter((e) => e.gone).map((e) => e.rel),
];

/** @param {Status} status */
const presentEntries = (status) => status.tracked.filter((e) => !e.gone);

/**
 * @param {Entry[]} present
 * @param {string[]} blobs
 * @returns {File[]}
 */
const pairBlobs = (present, blobs) =>
	present.map((e, i) => ({ ...e, blob: blobs[i] ?? "" }));

/**
 * @param {File[]} files
 */
const judgedFiles = (files) => files.filter((f) => f.blob !== f.head);

/**
 * @param {Registration} f
 * @returns {string|null}
 */
function judgeRegistration({ root, mainRoot, target, cwd, linked }) {
	if (linked === null)
		return `git would not list the worktrees of ${root}, so ${target} cannot be confirmed as one`;
	if (target === mainRoot)
		return `${target} is the main checkout, not a linked worktree`;
	if (!linked.includes(target))
		return `${target} is not a registered worktree of ${root}`;
	if (isUnder(cwd, [target], path.sep))
		return `${target} holds this command's own working directory`;
	return null;
}

/** @param {Contents} f */
function whyCommitsOff({ ref, commits }) {
	if ("unresolved" in commits)
		return `${ref} does not resolve, so whether its HEAD has landed is unknown`;
	if (commits.unlanded === null)
		return `git would not count its commits off ${ref}`;
	return commits.unlanded > 0
		? `its HEAD has ${String(commits.unlanded)} commit(s) not on ${ref}`
		: null;
}

/**
 * @param {Contents} f
 * @param {Status} status
 * @returns {string[]}
 */
function whyDirtUnlanded({ ref, keptOnRef, files, landed }, status) {
	/** @type {string[]} */
	const why = [];
	if (status.odd.length > 0)
		why.push(
			`unmerged or submodule path(s) it cannot judge: ${nameSome(status.odd)}`,
		);
	if (keptOnRef.length > 0)
		why.push(
			`deleted here but still on ${ref}: ${nameSome([...keptOnRef].sort())}`,
		);
	if (files === null) return [...why, "git would not hash its working files"];
	const staged = files.filter((f) => f.index !== f.head && f.index !== f.blob);
	if (staged.length > 0)
		why.push(
			`staged content that is neither HEAD's nor the working copy's: ${nameSome(staged.map((f) => f.rel))}`,
		);
	const unlanded = judgedFiles(files)
		.filter((_, i) => !landed[i])
		.map((f) => f.rel);
	if (unlanded.length > 0)
		why.push(`changed and not on ${ref}'s history: ${nameSome(unlanded)}`);
	if (status.untracked.length > 0)
		why.push(`untracked file(s) not gitignored: ${nameSome(status.untracked)}`);
	return why;
}

/** @param {Contents} f */
function whyProcessInside({ target, processes, selfPid }) {
	if ("error" in processes)
		return `the process table would not read (${processes.error}), so a process inside it cannot be ruled out`;
	const inside = processes
		.filter((p) => p.pid !== selfPid && isUnder(p.cwd, [target], path.sep))
		.map((p) => p.pid);
	return inside.length > 0
		? `process(es) ${nameSome(inside)} have their working directory inside it`
		: null;
}

/** @param {Contents} f */
function whyLiveOwner({ target, ownership }) {
	if ("why" in ownership)
		return `${ownership.why}, so whether a live session owns it is unknown`;
	const held = ownership.ownedTrees.filter((tree) => tree === target);
	if (held.length > 0)
		return `a live session claims, observed or wrote ${String(held.length)} path(s) in it`;
	if (ownership.unread.length > 0)
		return `job state ${nameSome(ownership.unread)} would not read, so its owner is unknown`;
	const { owner } = ownership;
	if (owner?.live)
		return `live session ${owner.sessionId}${owner.name ? ` (${owner.name})` : ""} owns it`;
	return null;
}

/**
 * @param {Contents} f
 * @returns {string[]}
 */
function judgeContents(f) {
	const why = [
		whyCommitsOff(f),
		...(f.status === null
			? ["git status would not list its paths"]
			: whyDirtUnlanded(f, f.status)),
		whyProcessInside(f),
		whyLiveOwner(f),
	];
	return why.filter((w) => w !== null);
}

/**
 * @param {string} target
 * @param {string[]} refusals
 * @param {{status: string, land: string}} commands
 */
const buildRefusedMessage = (target, refusals, commands) =>
	`refused, nothing removed — ${target}:\n${refusals.map((r) => `  - ${r}`).join("\n")}\n` +
	`Clear each, or read what it holds (${commands.status}) and land it: ${commands.land}`;

module.exports = {
	deletedPaths,
	judgeContents,
	judgeRegistration,
	judgedFiles,
	pairBlobs,
	parseStatus,
	presentEntries,
	buildRefusedMessage,
};
