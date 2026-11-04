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
 * the main checkout. Otherwise it lands the commits local `main` carries that `origin/landing`
 * lacks — a session worktree cut from `origin/landing`, `main` merged into
 * it, then lib/session-checkout.js's land — reports every edit left in the
 * main checkout, never discarding one, removes
 * the upstream, and runs one levelling pass. A merge that conflicts or is
 * refused leaves its worktree for a session to finish in, and the upstream
 * stays.
 */

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { execGit, gitReader, GIT_TIMEOUT_MS, SHORT_SHA } = require("./git.js");
const { scriptPath } = require("./script-path.js");

const BRANCH = "main";
const SHARED_MERGE = "refs/heads/landing";
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
 * Whether `cwd` is the main checkout or a directory in it outside every
 * linked worktree, each spelling resolved.
 * @param {string} cwd
 * @param {string} root
 * @param {string[]} worktrees
 */
function standsIn(cwd, root, worktrees) {
	const real = realOr(cwd);
	const inside = (/** @type {string} */ dir) =>
		real === dir || real.startsWith(dir + path.sep);
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
 */
function linkedWorktrees(root) {
	const home = realOr(root);
	return git(["worktree", "list", "--porcelain"], root)
		.split("\n")
		.filter((l) => l.startsWith("worktree "))
		.map((l) => realOr(l.slice("worktree ".length)))
		.filter((d) => d !== home);
}

/**
 * Whether the main checkout at `root` is cut over. A config git cannot read
 * answers not cut over.
 * @param {string} root
 */
const isCutOver = (root) =>
	readCutOver(gitReader(root, GIT_TIMEOUT_MS)) === true;

/**
 * @param {string[]} args
 * @param {string} cwd
 * @returns {{ status: number | null, out: string, err: string }}
 */
function execGitStatus(args, cwd) {
	try {
		const out = String(
			execGit(args, {
				cwd,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				timeout: GIT_TIMEOUT_MS,
			}),
		);
		return { status: 0, out, err: "" };
	} catch (err) {
		const e = caught(err);
		return {
			status: typeof e.status === "number" ? e.status : null,
			out: String(e.stdout ?? ""),
			err: String(e.stderr || e.message).trim(),
		};
	}
}

/**
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string}
 */
function git(args, cwd) {
	const r = execGitStatus(args, cwd);
	if (r.status !== 0)
		throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.err}`);
	return r.out.trim();
}

/**
 * @typedef {import("./level-main.js").Blocker} Blocker
 * @typedef {ReturnType<typeof import("./level-main.js").level>} LevelOutcome
 * @typedef {{
 *   moduleOn: () => boolean,
 *   listed: () => { agents: { name?: string, sessionId: string, cwd?: string }[] } | { why: string },
 *   cut: (root: string, name: string) => { dir: string },
 *   land: (dir: string) => { head: string, lander: string | null },
 *   dirt: (root: string) => Blocker[],
 *   level: (root: string) => LevelOutcome,
 * }} CutoverPorts
 * @typedef {(
 *   | { status: "module-off" }
 *   | { status: "unlisted", why: string }
 *   | { status: "occupied", sessions: string[] }
 *   | { status: "unmerged", dir: string, local: number, files: string[], why: string }
 *   | { status: "cut-over", already: boolean,
 *       landed: { count: number, head: string, lander: string | null } | null,
 *       dirt: Blocker[], level: LevelOutcome }
 * )} CutoverResult
 */

/**
 * Merge local `main` into the worktree at `dir`. Null where it committed,
 * else the conflicted files (none where git or a gate refused) and why.
 * @param {string} dir
 * @returns {{ files: string[], why: string } | null}
 */
function mergeMain(dir) {
	const r = execGitStatus(
		[
			"merge",
			"--no-ff",
			"-m",
			"Land the main checkout's local commits at cutover (#4248)",
			BRANCH,
		],
		dir,
	);
	if (r.status === 0) return null;
	const conflicted = execGitStatus(
		["diff", "--name-only", "--diff-filter=U"],
		dir,
	).out;
	return {
		files: conflicted.split("\n").filter(Boolean),
		why: (r.err || r.out).trim(),
	};
}

/**
 * @param {string} root the main checkout
 * @param {CutoverPorts} ports
 * @returns {CutoverResult}
 */
function cutover(root, ports) {
	if (!ports.moduleOn()) return { status: "module-off" };
	const already = isCutOver(root);
	/** @type {{ count: number, head: string, lander: string | null } | null} */
	let landed = null;
	if (!already) {
		const listing = ports.listed();
		if ("why" in listing) return { status: "unlisted", why: listing.why };
		const worktrees = linkedWorktrees(root);
		const sessions = listing.agents
			.filter((a) => a.cwd && standsIn(a.cwd, root, worktrees))
			.map((a) => a.name || a.sessionId);
		if (sessions.length > 0) return { status: "occupied", sessions };
		git(["fetch", "--quiet", "origin", "landing"], root);
		const local = git(
			[
				"rev-list",
				"--right-only",
				"--cherry-pick",
				`refs/remotes/origin/landing...${BRANCH}`,
			],
			root,
		)
			.split("\n")
			.filter(Boolean);
		if (local.length > 0) {
			const tip = git(["rev-parse", BRANCH], root).slice(0, SHORT_SHA);
			const { dir } = ports.cut(root, `cutover-main-${tip}`);
			const unmerged = mergeMain(dir);
			if (unmerged !== null)
				return { status: "unmerged", dir, local: local.length, ...unmerged };
			const { head, lander } = ports.land(dir);
			landed = { count: local.length, head, lander };
		}
		git(["branch", "--unset-upstream", BRANCH], root);
	}
	return {
		status: "cut-over",
		already,
		landed,
		dirt: ports.dirt(root),
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
					: "the main checkout is cut over: its main no longer tracks origin/landing, and edits and commits there are refused",
			];
			if (r.landed)
				lines.push(
					`landed main's ${r.landed.count} local commit(s) as ${r.landed.head.slice(0, SHORT_SHA)} on landing${r.landed.lander ? `; ${r.landed.lander}` : ""}`,
				);
			if (r.dirt.length > 0)
				lines.push(
					`${r.dirt.length} edit(s) remain in the main checkout, none discarded — judge each, moving it into a session worktree or discarding it by hand:`,
					...r.dirt.map(
						(b) =>
							`  ${b.path} — ${b.ageMs === null ? "deleted" : `${describeAge(b.ageMs)} old`}; last writer ${b.writer ? `session ${b.writer.sessionId}, ${describeAge(now - b.writer.at)} ago` : "unknown"}`,
					),
				);
			lines.push(...renderLevel(r.level));
			return lines;
		}
	}
}

module.exports = { cutover, isCutOver, readCutOver, renderCutover };
