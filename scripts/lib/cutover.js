/*
 * cutover.js — the main checkout's move to the worktree model (#4248, spec
 * #4229): whether it has moved, and the one pass that moves it.
 *
 * THE MARK IS THE UPSTREAM. Under the shared-tree model the main checkout's
 * `main` tracks `origin/landing`, where sessions pushed from it; under the
 * worktree model it follows `origin/main` by the levelling step alone and
 * tracks nothing. So a `main` whose upstream is `landing` is a main checkout
 * not yet cut over, and every other is cut over: a fresh clone, whose `main`
 * tracks `origin/main`, included. The write refusal, the pre-commit limb and
 * the levelling step all read this one mark, and turn on when the pass below
 * removes that upstream.
 *
 * THE PASS refuses while any session `claude agents --json` lists stands in
 * the main checkout. Otherwise it lands the commits local `main` carries that
 * `origin/main` lacks — a session worktree cut from `origin/main`, `main`
 * merged into it, then lib/session-checkout.js's land, a push of that
 * worktree's queue ref — reports every edit left in the
 * main checkout, never discarding one, removes
 * the upstream, and runs one levelling pass. A merge that conflicts or is
 * refused leaves its worktree for a session to finish in, and the upstream
 * stays.
 */

const fs = require("node:fs");
const path = require("node:path");
const { gitReader, GIT_TIMEOUT_MS, SHORT_SHA } = require("./git.js");
const {
	LANDING_BRANCH,
	LANDING_REF,
	REMOTE,
	VERIFIED_BRANCH,
	VERIFIED_REF,
} = require("./landing-refs.js");
const { scriptPath } = require("./script-path.js");
const { isUnder } = require("./is-under.js");
const { worktreePaths } = require("./worktree-paths.js");

const BRANCH = "main";
const SHARED_MERGE = `refs/heads/${LANDING_BRANCH}`;
const UPSTREAM_KEY = `branch.${BRANCH}.merge`;

/**
 * Whether the main checkout `git` reads is cut over, or null where git could
 * not answer.
 * @param {import("./git.js").GitReader} gitRead run in the main checkout
 * @returns {boolean | null}
 */
function readCutOver(gitRead) {
	const r = gitRead(["config", "--get", UPSTREAM_KEY], [1]);
	return r.ok ? r.out.trim() !== SHARED_MERGE : null;
}

/**
 * The command that cuts a session its own worktree and prints its path.
 * @param {(name: string) => string} [at] where scripts live: a dispatcher
 *   core passes its `ctx.scriptPath`
 */
const buildCutCommand = (at = scriptPath) =>
	`\`node ${at("session-checkout.js")} cut <session-name>\``;

/**
 * Whether `cwd` is the main checkout or a directory in it outside every
 * linked worktree, each spelling resolved.
 * @param {string} cwd
 * @param {string} root
 * @param {string[]} worktrees
 */
function standsIn(cwd, root, worktrees) {
	const real = realOr(cwd);
	const inside = (/** @type {string} */ dir) => isUnder(real, [dir], path.sep);
	return inside(realOr(root)) && !worktrees.some(inside);
}

/** @param {string} p */
function realOr(p) {
	try {
		return fs.realpathSync(p);
	} catch {
		return path.resolve(p);
	}
}

/**
 * The linked worktrees' directories, each resolved.
 * @param {string} root
 * @param {(args: string[]) => string} git run in `root`
 */
function linkedWorktrees(root, git) {
	const home = realOr(root);
	return worktreePaths(git)
		.map(realOr)
		.filter((d) => d !== home);
}

/**
 * Whether the write refusal binds: the `landing` module on and the main
 * checkout `gitRead` reads cut over. A git that cannot answer reads as not.
 * @param {(module: "landing") => boolean} moduleOn
 * @param {import("./git.js").GitReader} gitRead
 */
const landingCutOver = (moduleOn, gitRead) =>
	moduleOn("landing") && readCutOver(gitRead) === true;

/**
 * Whether the main checkout at `root` is cut over. A config git cannot read
 * answers not cut over.
 * @param {string} root
 */
const isCutOver = (root) =>
	readCutOver(gitReader(root, GIT_TIMEOUT_MS)) === true;

/**
 * git run in `dir` through `read`, its output trimmed; a git that fails or
 * cannot answer throws, naming `dir`.
 * @param {import("./git.js").GitReader} read run in `dir`
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
 *   moduleOn: () => boolean,
 *   listed: () => { agents: { name?: string, sessionId: string, cwd?: string }[] } | { why: string },
 *   cut: (root: string, name: string) => { dir: string },
 *   land: (dir: string) => { queue: string, head: string, lander: string | null },
 *   orphanedEdits: (root: string) => Blocker[],
 *   level: (root: string) => LevelOutcome,
 *   gitIn: (cwd: string) => import("./git.js").GitReader,
 * }} CutoverPorts `gitIn` runs git in a directory: the main checkout, or the
 *   worktree `cut` made
 * @typedef {(
 *   | { status: "module-off" }
 *   | { status: "unlisted", why: string }
 *   | { status: "occupied", sessions: string[] }
 *   | { status: "unmerged", dir: string, local: number, files: string[], why: string }
 *   | { status: "cut-over", already: boolean,
 *       landed: { count: number, queue: string, head: string, lander: string | null } | null,
 *       orphanedEdits: Blocker[], level: LevelOutcome }
 * )} CutoverResult
 */

/**
 * Merge local `main` into the worktree `read` runs in. Null where it
 * committed, else the conflicted files (none where git or a gate refused)
 * and why.
 * @param {import("./git.js").GitReader} read
 * @returns {{ files: string[], why: string } | null}
 */
function mergeMain(read) {
	const r = read(
		[
			"merge",
			"--no-ff",
			"-m",
			"Land the main checkout's local commits at cutover (#4248)",
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
 * @param {string} root the main checkout
 * @param {CutoverPorts} ports
 * @returns {CutoverResult}
 */
function cutover(root, ports) {
	if (!ports.moduleOn()) return { status: "module-off" };
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
 * The result as report lines.
 * @param {CutoverResult} r
 * @param {{ describeAge: (ms: number) => string,
 *   renderLevel: (o: LevelOutcome) => string[], now: number }} how
 * @returns {string[]}
 */
function renderCutover(r, { describeAge, renderLevel, now }) {
	switch (r.status) {
		case "module-off":
			return [
				"refused: the `landing` module is off, so the main checkout stays the shared tree and nothing was cut over",
			];
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
					...r.orphanedEdits.map(
						(b) =>
							`  ${b.path} — ${b.ageMs === null ? "deleted" : `${describeAge(b.ageMs)} old`}; last writer ${b.writer ? `session ${b.writer.sessionId}, ${describeAge(now - b.writer.at)} ago` : "unknown"}`,
					),
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
	landingCutOver,
	readCutOver,
	renderCutover,
};
