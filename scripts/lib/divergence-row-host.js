const fs = require("node:fs");
const { ignoreFailure } = require("./caught.js");

/** @param {string[]} args */
const git = (args) => {
	const { gitOrNull, HOOK_GIT_TIMEOUT_MS } = require("./git.js");
	const out = gitOrNull(args, { timeout: HOOK_GIT_TIMEOUT_MS });
	return out === null ? null : require("./trim-run.js").trimEndRun(out, "\n");
};

/**
 * @param {string} ps
 * @returns {number | null}
 */
function sessionsOff(ps) {
	const { spawnSync } = require("node:child_process");
	const { CHILD_MAX_BUFFER } = require("./child-buffer.js");
	const { countSessions, readProcCwd } = require("./claude-sessions.js");
	const { HOOK_GIT_TIMEOUT_MS } = require("./git.js");
	const r = spawnSync(ps, ["-eo", "pid=,ppid=,args="], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		timeout: HOOK_GIT_TIMEOUT_MS,
		maxBuffer: CHILD_MAX_BUFFER,
	});
	if (r.error || r.status !== 0) return null;
	return countSessions(r.stdout, (pid) => readProcCwd(pid));
}

/** @returns {Date} */
const clock = () => {
	const { now } = require("./check.js");
	try {
		return new Date(now());
	} catch {
		return new Date();
	}
};

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {import("./divergence-row.js").DivergencePorts}
 */
function buildHostPorts(env) {
	return {
		disabled: env.WFC_NO_DIVERGENCE_LOG === "1",
		sessionDir: (payload) => require("./host-root.js").sessionDir(payload),
		isDir: (p) => {
			try {
				return fs.statSync(p).isDirectory();
			} catch {
				return false;
			}
		},
		toplevel: (dir) => require("./git-tree.js").readTopLevel(dir),
		commonDir: (dir) => {
			const { gitCommonDir, HOOK_GIT_TIMEOUT_MS } = require("./git.js");
			return gitCommonDir(dir, { timeout: HOOK_GIT_TIMEOUT_MS });
		},
		pushedRef: (top) => require("./landing-refs.js").pushedRef({ tree: top }),
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
		now: clock,
		projectDir: (top) => require("./arbiter-core.js").stateDirFor(top),
	};
}

/** @param {import("./divergence-row.js").Row | null} row */
function appendRow(row) {
	if (!row) return;
	const { dir, file, line } = row;
	ignoreFailure(() => {
		fs.mkdirSync(dir, { recursive: true });
		fs.appendFileSync(file, line);
	});
}

module.exports = { appendRow, buildHostPorts };
