const EXEMPT_MARKERS = /** @type {const} */ ([
	"arbiter-literal",
	"bare-citation",
	"citation",
	"claude-route",
	"cli-args",
	"env-write",
	"gh-route",
	"git-identity",
	"isolation",
	"jsonl-read",
]);

/** @typedef {typeof EXEMPT_MARKERS[number]} ExemptMarker */

const POINTER_START = String.raw`(?:[\w.-]+\/[\w.-]+)?#\d|ADR-\d{4}`;

/** @param {ExemptMarker} name */
function exemptMarker(name) {
	if (!EXEMPT_MARKERS.includes(name))
		throw new Error(`${name}-exempt: is no registered marker`);
	return new RegExp(
		String.raw`(?<![\w-])${name}-exempt:[ \t]*(?=${POINTER_START})`,
	);
}

module.exports = { EXEMPT_MARKERS, exemptMarker };
