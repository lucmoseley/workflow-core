const { escapeRe } = require("./regex-group.js");

const EXEMPT_MARKERS = /** @type {const} */ ([
	"arbiter-literal",
	"bare-citation",
	"citation",
	"claude-route",
	"cli-args",
	"gh-route",
	"git-identity",
	"isolation",
	"jsonl-read",
]);

/** @typedef {typeof EXEMPT_MARKERS[number]} ExemptMarker */

const CITATION_REPO = "workflow-core";

const ISSUE_REF = String.raw`(?:[\w.-]+\/[\w.-]+|${escapeRe(CITATION_REPO)})?#\d+`;

const POINTER_BODY = String.raw`${ISSUE_REF}|ADR-\d{4}|RFC\d+(?:§[\d.]+)?|https?:\/\/(?:www\.rfc-editor\.org\/rfc\/|datatracker\.ietf\.org\/doc\/(?:html\/)?|tools\.ietf\.org\/html\/)rfc\d+(?:[#/?.]\S*)?`;

const POINTER = new RegExp(`^(?:${POINTER_BODY})$`);

/** @param {ExemptMarker} name */
function exemptMarker(name) {
	if (!EXEMPT_MARKERS.includes(name))
		throw new Error(`${name}-exempt: is no registered marker`);
	return new RegExp(
		String.raw`(?<![\w-])${escapeRe(name)}-exempt:[ \t]*(?=(?:${POINTER_BODY})(?![\w-]))`,
	);
}

/** @param {ExemptMarker} name */
const exemptHint = (name) => `\`${name}-exempt: #N\``;

module.exports = {
	CITATION_REPO,
	EXEMPT_MARKERS,
	ISSUE_REF,
	POINTER,
	exemptHint,
	exemptMarker,
};
