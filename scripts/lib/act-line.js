/*
 * act-line.js — the acts ledger's one line format (#3264): every
 * writer builds its line through buildAct, lib/arbiter-ledger.js checks it
 * against ACT_LINE, and every reader splits it through parseAct.
 *
 * A pure module, so lib/gh-acts.js stays a core and lib/refill-loop.js free of
 * store reads.
 */

/* What a session did beside committing, as `<kind> <owner/name>#<n>`, a
 * relabel adding ` takes:<x>`; a block is a blocked-by edge added (#2464), a
 * gate an issue's first live gate line (#3301). A commit is no line here: the
 * commit ledger already holds it. */
const ACT_KINDS = /** @type {const} */ ([
	"block",
	"close",
	"file",
	"gate",
	"relabel",
	"round",
]);

/** @typedef {typeof ACT_KINDS[number]} ActKind */

/** The one kind whose line carries a ` takes:<x>` suffix. */
const TAKES_KIND = /** @type {const} */ ("relabel");

/** @typedef {Exclude<ActKind, typeof TAKES_KIND>} BareActKind */

const REF_SOURCE = String.raw`[\w.-]+\/[\w.-]+#\d+`;
const ACT_LINE = new RegExp(
	`^(?:${ACT_KINDS.filter((k) => k !== TAKES_KIND).join("|")}) ${REF_SOURCE}$|^${TAKES_KIND} ${REF_SOURCE} takes:\\S+$`,
);

/**
 * @typedef {{kind: string, ref: string, takes?: string}} Act
 */

/**
 * @param {ActKind} kind
 * @param {string} repo `owner/name`
 * @param {number|string} n
 * @param {string} [takes] a relabel's `takes:<x>`
 */
function buildAct(kind, repo, n, takes) {
	const line = `${kind} ${repo}#${n}`;
	return takes === undefined ? line : `${line} ${takes}`;
}

/**
 * @param {string} sha
 */
const buildCommitAct = (sha) => `commit ${sha}`;

/**
 * @param {string} line
 * @returns {Act}
 */
function parseAct(line) {
	const [kind = "", ref = "", takes] = line.split(" ");
	return takes === undefined ? { kind, ref } : { kind, ref, takes };
}

module.exports = { ACT_KINDS, ACT_LINE, buildAct, buildCommitAct, parseAct };
