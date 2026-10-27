/*
 * gh-recorder-host.js — the production ports record-acts.js,
 * record-issue-claim.js and release-issue-claim.js wire into their cores,
 * lib/gh-acts.js and lib/issue-claim-hook.js (#2799).
 *
 * The arbiter's stores are written in process. A claim or release that fails
 * is the store's own to log (arbiter-core.js's logError) and leaves the record
 * unwritten.
 */

const fs = require("node:fs");
const os = require("node:os");
const { gitOrNull, HOOK_GIT_TIMEOUT_MS } = require("./git.js");

/** @param {string} dir */
const readOriginUrl = (dir) =>
	gitOrNull(["-C", dir, "config", "--get", "remote.origin.url"], {
		timeout: HOOK_GIT_TIMEOUT_MS,
	})?.trim() ?? "";

/**
 * @param {import("./kit-context.js").PortEnv} env
 * @returns {import("./gh-acts.js").ActsPorts &
 *   import("./issue-claim-hook.js").ClaimPorts}
 */
function buildHostPorts({ root, payload }) {
	const issueClaims = require("./arbiter-issue-claims.js");
	const { recordAct } = require("./arbiter-ledger.js");
	return {
		payload,
		envSession: process.env.CLAUDE_CODE_SESSION_ID ?? "",
		root,
		home: os.homedir(),
		originUrl: readOriginUrl,
		readFile: (p) =>
			fs.existsSync(p) ? fs.readFileSync(p, "utf8") : undefined,
		claimIssue: (n, sessionId) => {
			issueClaims.claimIssue(n, { sessionId });
		},
		releaseIssue: (n, sessionId) => {
			issueClaims.releaseIssue(n, { sessionId });
		},
		recordAct: (act, sessionId) => {
			try {
				recordAct(act, sessionId);
			} catch (e) {
				/* Fails open, logged (mantahostels#103 §6). */
				require("./arbiter-core.js").logError("record act", e);
			}
		},
	};
}

module.exports = { buildHostPorts };
