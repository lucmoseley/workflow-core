/*
 * own-acts.js — this session's own acts ledger, for a script whose gh call no
 * hook sees: recordOwnAct writes what record-acts.js would have (workflow-core#2308). A
 * leaf (workflow-core#5399).
 */

const ledger = require("./arbiter-ledger.js");
const { buildAct } = require("./act-line.js");
const { logError, repoRoot } = require("./arbiter-core.js");
const { fromEnv } = require("./session-id.js");

/** The store recordOwnAct writes to and readOwnFilings reads. */
const actRoot = () => ledger.ledgerRoot() ?? repoRoot();

/**
 * Add a `kind` act on issue `n` of `repo` to this session's acts ledger
 * (workflow-core#2308). Silent with no session id, and on a failed write, which is logged:
 * the act itself has landed, and a missed line costs the refill loop one launch
 * read as unproven.
 * @param {import("./act-line.js").BareActKind} kind
 * @param {string} repo `owner/name`
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
 * The issues of `repo` this session filed, by its acts ledger; none with no
 * session id. `unreadable` where the ledger would not read, which is not
 * "filed nothing".
 * @param {string} repo `owner/name`
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
