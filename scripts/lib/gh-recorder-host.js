const { readBodyFile } = require("./body-file.js");
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
		readFile: readBodyFile,
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
				require("./arbiter-core.js").logError("record act", e);
			}
		},
	};
}

module.exports = { buildHostPorts };
