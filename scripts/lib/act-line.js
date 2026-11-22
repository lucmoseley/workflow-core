const ACT_KINDS = /** @type {const} */ ([
	"block",
	"close",
	"file",
	"gate",
	"relabel",
	"round",
]);

/** @typedef {typeof ACT_KINDS[number]} ActKind */

const TAKES_KIND = /** @type {const} */ ("relabel");

/** @typedef {Exclude<ActKind, typeof TAKES_KIND>} BareActKind */

const REF_SOURCE = String.raw`[\w.-]+\/[\w.-]+#\d+`;
const ACT_LINE = new RegExp(
	ACT_KINDS.map(
		(k) =>
			`^${k} ${REF_SOURCE}${k === TAKES_KIND ? String.raw` takes:\S+` : ""}$`,
	).join("|"),
);

/**
 * @typedef {{kind: string, ref: string, takes?: string}} Act
 */

/**
 * @param {ActKind} kind
 * @param {string} repo
 * @param {number|string} n
 * @param {string} [takes]
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

module.exports = { ACT_LINE, buildAct, buildCommitAct, parseAct };
