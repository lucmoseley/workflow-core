const path = require("node:path");
const { gitReader, GIT_TIMEOUT_MS, SHORT_SHA } = require("./git.js");
const { REMOTE, VERIFIED_BRANCH, VERIFIED_REF } = require("./landing-refs.js");
const { scriptPath } = require("./script-path.js");
const { realKey } = require("./deref.js");
const { isUnder } = require("./is-under.js");
const { worktreePaths } = require("./worktree-paths.js");

const BRANCH = "main";
const LANDING_BRANCH = "landing";
const LANDING_REF = `${REMOTE}/${LANDING_BRANCH}`;
const SHARED_MERGE = `refs/heads/${LANDING_BRANCH}`;
const UPSTREAM_KEY = `branch.${BRANCH}.merge`;

/**
 * @param {import("./git.js").GitReader} gitRead
 * @returns {boolean | null}
 */
function readCutOver(gitRead) {
	const r = gitRead(["config", "--get", UPSTREAM_KEY], [1]);
	return r.ok ? r.out.trim() !== SHARED_MERGE : null;
}

/** @param {(name: string) => string} [at] */
const buildCutCommand = (at = scriptPath) =>
	`\`node ${at("session-checkout.js")} cut <session-name>\``;

/**
 * @param {string} cwd
 * @param {string} root
 * @param {string[]} worktrees
 */
function standsIn(cwd, root, worktrees) {
	const real = realKey(cwd);
	const inside = (/** @type {string} */ dir) => isUnder(real, [dir], path.sep);
	return inside(realKey(root)) && !worktrees.some(inside);
}

/**
 * @param {string} root
 * @param {(args: string[]) => string} git
 */
function linkedWorktrees(root, git) {
	const home = realKey(root);
	return worktreePaths(git)
		.map(realKey)
		.filter((d) => d !== home);
}

/** @param {import("./git.js").GitReader} gitRead */
const isCutOverAt = (gitRead) => readCutOver(gitRead) === true;

/** @param {string} root */
const isCutOver = (root) => isCutOverAt(gitReader(root, GIT_TIMEOUT_MS));

/**
 * @param {import("./git.js").GitReader} read
 * @param {string} dir
 * @returns {(args: string[]) => string}
 */
const throwingGit = (read, dir) => (args) => {
	const r = read(args, []);
	if (!r.ok)
		throw new Error(`git ${args.join(" ")} failed in ${dir}: ${r.why}`);
	return r.out.trim();
};

/**
 * @typedef {import("./level-main.js").Blocker} Blocker
 * @typedef {ReturnType<typeof import("./level-main.js").level>} LevelOutcome
 * @typedef {{
 * listed: () => { agents: { name?: string, sessionId: string, cwd?: string }[] } | { why: string },
 * cut: (root: string, name: string) => { dir: string },
 * land: (dir: string) => { queue: string, head: string, lander: string | null },
 * orphanedEdits: (root: string) => Blocker[],
 * level: (root: string) => LevelOutcome,
 * gitIn: (cwd: string) => import("./git.js").GitReader,
 * }} CutoverPorts
 * @typedef {(
 * | { status: "unlisted", why: string }
 * | { status: "occupied", sessions: string[] }
 * | { status: "unmerged", dir: string, local: number, files: string[], why: string }
 * | { status: "cut-over", already: boolean,
 * landed: { count: number, queue: string, head: string, lander: string | null } | null,
 * orphanedEdits: Blocker[], level: LevelOutcome }
 * )} CutoverResult
 */

/**
 * @param {import("./git.js").GitReader} read
 * @returns {{ files: string[], why: string } | null}
 */
function mergeMain(read) {
	const r = read(
		[
			"merge",
			"--no-ff",
			"-m",
			"Land the main checkout's local commits at cutover (workflow-core#4248)",
			BRANCH,
		],
		[],
	);
	if (r.ok) return null;
	const conflicted = read(["diff", "--name-only", "--diff-filter=U"], []);
	return {
		files: conflicted.ok ? conflicted.out.split("\n").filter(Boolean) : [],
		why: r.why,
	};
}

/**
 * @param {string} root
 * @param {CutoverPorts} ports
 * @returns {CutoverResult}
 */
function cutover(root, ports) {
	const read = ports.gitIn(root);
	const already = readCutOver(read) === true;
	/** @type {{ count: number, queue: string, head: string, lander: string | null } | null} */
	let landed = null;
	if (!already) {
		const listing = ports.listed();
		if ("why" in listing) return { status: "unlisted", why: listing.why };
		const git = throwingGit(read, root);
		const worktrees = linkedWorktrees(root, git);
		const sessions = listing.agents
			.filter((a) => a.cwd && standsIn(a.cwd, root, worktrees))
			.map((a) => a.name || a.sessionId);
		if (sessions.length > 0) return { status: "occupied", sessions };
		git(["fetch", "--quiet", REMOTE, VERIFIED_BRANCH]);
		const local = git([
			"rev-list",
			"--right-only",
			"--cherry-pick",
			`refs/remotes/${VERIFIED_REF}...${BRANCH}`,
		])
			.split("\n")
			.filter(Boolean);
		if (local.length > 0) {
			const tip = git(["rev-parse", BRANCH]).slice(0, SHORT_SHA);
			const { dir } = ports.cut(root, `cutover-main-${tip}`);
			const unmerged = mergeMain(ports.gitIn(dir));
			if (unmerged !== null)
				return { status: "unmerged", dir, local: local.length, ...unmerged };
			const { queue, head, lander } = ports.land(dir);
			landed = { count: local.length, queue, head, lander };
		}
		git(["branch", "--unset-upstream", BRANCH]);
	}
	return {
		status: "cut-over",
		already,
		landed,
		orphanedEdits: ports.orphanedEdits(root),
		level: ports.level(root),
	};
}

/**
 * @param {CutoverResult} r
 * @param {{ renderBlocker: (b: Blocker) => string,
 * renderLevel: (o: LevelOutcome) => string[] }} how
 * @returns {string[]}
 */
function renderCutover(r, { renderBlocker, renderLevel }) {
	switch (r.status) {
		case "unlisted":
			return [
				`refused: no session listing, so no session can be shown to be out of the main checkout — nothing was cut over: ${r.why}`,
			];
		case "occupied":
			return [
				`refused: ${r.sessions.length} session(s) still stand in the main checkout, and nothing was cut over — end or reap each, then run this again:`,
				...r.sessions.map((s) => `  ${s}`),
			];
		case "unmerged":
			return [
				r.files.length > 0
					? `refused: merging main's ${r.local} local commit(s) into ${r.dir} conflicts, so nothing was cut over — resolve there and \`git commit\`, run \`node ${scriptPath("session-checkout.js")} land\` from it, then run this again:`
					: `refused: the merge of main's ${r.local} local commit(s) into ${r.dir} was refused, so nothing was cut over — fix what it names and \`git commit\` there, run \`node ${scriptPath("session-checkout.js")} land\` from it, then run this again: ${r.why}`,
				...r.files.map((f) => `  ${f}`),
			];
		case "cut-over": {
			/** @type {string[]} */
			const lines = [
				r.already
					? "the main checkout was already cut over"
					: `the main checkout is cut over: its main no longer tracks ${LANDING_REF}, and edits and commits there are refused`,
			];
			if (r.landed)
				lines.push(
					`pushed main's ${r.landed.count} local commit(s) as ${r.landed.head.slice(0, SHORT_SHA)} to ${r.landed.queue}, for the queue lander to land${r.landed.lander ? `; ${r.landed.lander}` : ""}`,
				);
			if (r.orphanedEdits.length > 0)
				lines.push(
					`${r.orphanedEdits.length} edit(s) remain in the main checkout, none discarded — judge each, moving it into a session worktree or discarding it by hand:`,
					...r.orphanedEdits.map(renderBlocker),
				);
			lines.push(...renderLevel(r.level));
			return lines;
		}
	}
}

module.exports = {
	buildCutCommand,
	cutover,
	isCutOver,
	LANDING_REF,
	readCutOver,
	isCutOverAt,
	renderCutover,
};
