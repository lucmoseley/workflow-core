/*
 * divergence-row-host.js — the production ports record-divergence.js wires
 * into its core, lib/divergence-row.js (#2797), and the append that files the
 * row it returns.
 *
 * A PRODUCTION ADAPTER (base §T7): it touches git through lib/git.js and
 * lib/git-tree.js, the workflow-core config through lib/landing-refs.js in
 * process, `ps` at WFC_PS, /proc through lib/claude-sessions.js, the
 * filesystem, and
 * `process.env` for WFC_NO_DIVERGENCE_LOG, WFC_PS and WFC_NOW.
 *
 * Every module past node:fs loads where a refusal first needs it,
 * landing-refs.js and arbiter-core.js the heaviest: a load at the top is paid
 * on every git call (#2899).
 */

const fs = require("node:fs");

/**
 * Git's stdout less trailing newlines, as a shell `$(…)` reads it; null where
 * git would not answer in the hook's ceiling.
 * @param {string[]} args
 */
const git = (args) => {
	const { gitOrNull, HOOK_GIT_TIMEOUT_MS } = require("./git.js");
	return (
		gitOrNull(args, { timeout: HOOK_GIT_TIMEOUT_MS })?.replace(/\n+$/, "") ??
		null
	);
};

/**
 * The session count off `ps` at WFC_PS, null where it will not run or exits
 * non-zero. Bounded as a hook's git read is, the same reason holding: a hook
 * that blocks costs every git call on the machine.
 * @param {string} ps
 * @returns {number | null}
 */
function sessionsOff(ps) {
	const { spawnSync } = require("node:child_process");
	const { CHILD_MAX_BUFFER } = require("./child-buffer.js");
	const { countSessions, isProcCwd } = require("./claude-sessions.js");
	const { HOOK_GIT_TIMEOUT_MS } = require("./git.js");
	const r = spawnSync(ps, ["-eo", "pid=,ppid=,args="], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		timeout: HOOK_GIT_TIMEOUT_MS,
		maxBuffer: CHILD_MAX_BUFFER,
	});
	if (r.error || r.status !== 0) return null;
	return countSessions(r.stdout, isProcCwd);
}

/**
 * The clock, pinned by WFC_NOW where it reads as a date (lib/check.js's
 * convention). RESIDUAL: the stamp is durable, so a session exporting WFC_NOW
 * stamps its rows at that time (mantahostels#2161); one that will not parse
 * is the wall clock, since dropping the row loses the observation.
 * @param {string | undefined} pinned
 * @returns {() => Date}
 */
const clock = (pinned) => () => {
	const t = pinned ? Date.parse(pinned) : Number.NaN;
	return new Date(Number.isNaN(t) ? Date.now() : t);
};

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {import("./divergence-row.js").DivergencePorts}
 */
function buildHostPorts(env) {
	return {
		disabled: env.WFC_NO_DIVERGENCE_LOG === "1",
		pwd: process.cwd(),
		isDir: (p) => {
			try {
				return fs.statSync(p).isDirectory();
			} catch {
				/* Absent or unreadable alike drop the row: the lower bound
				 * record-divergence.js's LIMITS name (#2797). */
				return false;
			}
		},
		toplevel: (dir) => require("./git-tree.js").readTopLevel(dir),
		commonDir: (dir) => {
			const { gitCommonDir, HOOK_GIT_TIMEOUT_MS } = require("./git.js");
			return gitCommonDir(dir, { timeout: HOOK_GIT_TIMEOUT_MS });
		},
		pushedRef: (top) => require("./landing-refs.js").pushedRef({ root: top }),
		refExists: (top, ref) =>
			git(["-C", top, "rev-parse", "--verify", "--quiet", ref]) !== null,
		upstream: (top) =>
			git([
				"-C",
				top,
				"rev-parse",
				"--abbrev-ref",
				"--symbolic-full-name",
				"@{u}",
			]),
		counts: (top, ref) =>
			git(["-C", top, "rev-list", "--left-right", "--count", `HEAD...${ref}`]),
		sessions: () => sessionsOff(env.WFC_PS || "ps"),
		now: clock(env.WFC_NOW),
		projectDir: (top) => require("./arbiter-core.js").stateDirFor(top),
	};
}

/**
 * Append the row, creating its directory; the core's null writes nothing. A
 * write that fails is silent: an unwritable log directory shows in the row
 * count against the other repo's.
 * @param {import("./divergence-row.js").Row | null} row
 */
function appendRow(row) {
	if (!row) return;
	const { dir, file, line } = row;
	try {
		fs.mkdirSync(dir, { recursive: true });
		fs.appendFileSync(file, line);
	} catch {
		/* Silent by design (#289): a refused pull that costs a second failure
		 * is worse than one observation lost. */
	}
}

module.exports = { appendRow, buildHostPorts };
