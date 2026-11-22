const ledger = require("./arbiter-ledger.js");
const { buildAct } = require("./act-line.js");
const { logError, repoRoot } = require("./arbiter-core.js");
const { fromEnv } = require("./session-id.js");

const actRoot = () => ledger.ledgerRoot() ?? repoRoot();

/**
 * @param {import("./act-line.js").BareActKind} kind
 * @param {string} repo
 * @param {number|string} n
 */
function recordOwnAct(kind, repo, n) {
	const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
	if (!sessionId) return;
	try {
		ledger.recordAct(buildAct(kind, repo, n), sessionId, actRoot());
	} catch (e) {
		logError("record act", e);
	}
}

/**
 * @param {string} repo
 * @returns {{numbers: number[], unreadable: boolean}}
 */
function readOwnFilings(repo) {
	const sessionId = fromEnv();
	if (!sessionId) return { numbers: [], unreadable: false };
	const { acts, unreadable } = ledger.readActsBy(sessionId, [actRoot()]);
	const prefix = buildAct("file", repo, "");
	const numbers = acts
		.filter((a) => a.startsWith(prefix))
		.map((a) => Number(a.slice(prefix.length)));
	return { numbers: [...new Set(numbers)], unreadable: unreadable.length > 0 };
}

module.exports = { readOwnFilings, recordOwnAct };
