/*
 * canary-remark-host.js — the production ports lib/canary-remark.js reads
 * (#4744): git at a revision and the worktree list, the live session
 * listing, each canary or writer run as a session's hook would run it, and
 * the scratch tree a revision's canary is taken into. Kept apart so the
 * core's choices of whom to vouch for and whom the move strands are tested
 * without a bash canary or a real repository; level-main.test.ts crosses
 * these adapters for real.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { readAgentsForLevelling } = require("./agent-liveness.js");
const { deref } = require("./deref.js");
const { gitRead } = require("./dirty-tree.js");
const { selfPluginRoot } = require("./hook-env.js");
const { worktreePaths } = require("./worktree-paths.js");

/**
 * @typedef {import("./canary-remark.js").LiveSession} LiveSession
 * @typedef {import("./canary-remark.js").ListSessions} ListSessions
 * @typedef {import("./canary-remark.js").RemarkPorts} RemarkPorts
 */

/* Untraced: a canary or writer is a few file reads and one jq. */
const HOOK_TIMEOUT_MS = 10_000;

/**
 * Every session `claude agents --json` lists, with the directory it started
 * in. The self-test is waived: a levelling pass runs detached from whichever
 * session started it, and acts only on the sessions listed.
 * @type {ListSessions}
 */
function listLiveSessions() {
	const listed = readAgentsForLevelling();
	if (listed.why !== undefined) return { why: listed.why };
	const blind = listed.agents.find((a) => !a.cwd);
	if (blind)
		return {
			why: `session ${blind.sessionId} is listed with no directory, so it cannot be re-marked`,
		};
	return {
		sessions: listed.agents.map((a) => ({
			sessionId: a.sessionId,
			cwd: a.cwd ?? "",
		})),
	};
}

/**
 * Run a canary or writer for one session, as its hook would.
 * @param {string} script
 * @param {LiveSession} s
 * @param {NodeJS.ProcessEnv} [env] added to the hook's environment
 * @returns {{ ok: boolean, said: string }}
 */
function runHook(script, s, env = {}) {
	const r = spawnSync("bash", [script], {
		cwd: s.cwd,
		input: JSON.stringify({ session_id: s.sessionId }),
		env: { ...process.env, CLAUDE_PROJECT_DIR: s.cwd, ...env },
		encoding: "utf8",
		timeout: HOOK_TIMEOUT_MS,
	});
	const said =
		(r.stderr ?? "").split("\n").find((l) => l.trim() !== "") ??
		r.error?.message ??
		`exit ${r.status}`;
	return { ok: r.status === 0, said: said.trim() };
}

/**
 * @param {string} root the main checkout
 * @param {string} rev
 * @param {string} file
 * @returns {import("./canary-remark.js").ReadAt}
 */
function readAt(root, rev, file) {
	const text = gitRead(["show", `${rev}:${file}`], root);
	if (text !== null) return { text };
	/* Absent at `rev` lists nothing; a git fault answers null. */
	if (gitRead(["ls-tree", "--name-only", rev, "--", file], root) === "")
		return { absent: true };
	return { why: `git could not read ${file} at ${rev}` };
}

/**
 * @param {string} root the main checkout
 * @param {string} scratch a directory the re-mark may fill and remove
 * @param {ListSessions} [listSessions]
 * @returns {RemarkPorts}
 */
function buildHostPorts(root, scratch, listSessions = listLiveSessions) {
	return {
		root,
		readAt: (rev, file) => readAt(root, rev, file),
		listSessions,
		worktrees: () => {
			const out = gitRead(["worktree", "list", "--porcelain", "-z"], root);
			return out === null ? null : worktreePaths(() => out).map(deref);
		},
		deref,
		exists: (p) => fs.existsSync(p),
		hook: (script, s) => runHook(script, s),
		mark: (writer, s) => {
			runHook(writer, s, { CLAUDE_PLUGIN_ROOT: selfPluginRoot(root) });
		},
		inScratch: (files, run) => {
			fs.rmSync(scratch, { recursive: true, force: true });
			try {
				for (const [file, text] of files) {
					fs.mkdirSync(path.join(scratch, path.dirname(file)), {
						recursive: true,
					});
					fs.writeFileSync(path.join(scratch, file), text);
				}
				return run(scratch);
			} finally {
				fs.rmSync(scratch, { recursive: true, force: true });
			}
		},
	};
}

module.exports = { buildHostPorts };
