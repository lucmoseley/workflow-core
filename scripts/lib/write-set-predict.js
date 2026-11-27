const cache = require("./write-set-cache");
const { requiredGroup } = require("./regex-group.js");

/**
 * @typedef {{ok: true, files: string[]} | {ok: false, error: any}} Tracked
 * @typedef {{body?: string|null, labels?: string[], number?: number, title?: string|null}} Issue
 */

const DOC_MAP = "docs/doc-map.md";
const ROADMAP = "docs/reference-roadmap.html";
const DIGEST = "docs/roadmap-digest.md";

const DOC_MAP_HINT = /§B/;

const SKIP_LABEL = "wayfinder:map";

const SECTION_ANCHOR = /^#{1,6}\s/gm;
// lucmoseley/mantahostels#1289 measured 24 Aug 2026, 168 open issues: floors near p25/p75
const SMALL_MAX_PATHS = 2;
const SMALL_MAX_BODY_LENGTH = 2000;
const LARGE_MIN_PATHS = 7;
const LARGE_MIN_BODY_LENGTH = 12_000;
const LARGE_MIN_SECTIONS = 5;

/**
 * @param {{bodyLength: number, pathCount: number, sectionCount: number}} signals
 */
function predictedSizeOf({ bodyLength, pathCount, sectionCount }) {
	if (
		pathCount >= LARGE_MIN_PATHS ||
		bodyLength >= LARGE_MIN_BODY_LENGTH ||
		sectionCount >= LARGE_MIN_SECTIONS
	)
		return "large";
	if (
		pathCount <= SMALL_MAX_PATHS &&
		bodyLength < SMALL_MAX_BODY_LENGTH &&
		sectionCount === 0
	)
		return "small";
	return "medium";
}

/** @param {string} token @param {string[]} files */
const resolveToken = (token, files) => {
	if (files.includes(token)) return token;
	const hits = files.filter((f) => f.endsWith(`/${token}`));
	return hits.length === 1 ? hits[0] : null;
};

const BACKTICK_SPAN = /`([^`\n]+)`/g;

/** @param {string|null|undefined} body @param {string[]} files */
function pathsNamedIn(body, files) {
	const found = new Set();
	for (const span of String(body || "").matchAll(BACKTICK_SPAN))
		for (const token of requiredGroup(span, 1, BACKTICK_SPAN)
			.trim()
			.split(/\s+/)) {
			const hit = token && resolveToken(token, files);
			if (hit) found.add(hit);
		}
	return [...found].sort();
}

/** @param {Issue} issue @param {Tracked} tracked */
function predict(issue, tracked) {
	if (!tracked?.ok)
		return { ok: false, why: "git could not list the tree", writeSet: [] };
	if ((issue?.labels ?? []).includes(SKIP_LABEL))
		return {
			ok: false,
			why: `${SKIP_LABEL} — its substrate is its own issue body`,
			writeSet: [],
		};

	const set = new Set(pathsNamedIn(issue?.body, tracked.files));
	if (DOC_MAP_HINT.test(String(issue?.body ?? ""))) set.add(DOC_MAP);
	if (set.has(ROADMAP) || set.has(DIGEST)) {
		set.add(ROADMAP);
		set.add(DIGEST);
	}

	const writeSet = [...set].sort();
	return {
		ok: true,
		why: null,
		writeSet,
		predictedSize: predictedSizeOf({
			bodyLength: String(issue?.body ?? "").length,
			pathCount: writeSet.length,
			sectionCount: (String(issue?.body ?? "").match(SECTION_ANCHOR) || [])
				.length,
		}),
	};
}

/** @param {string} root @param {Issue} issue @param {Tracked} tracked */
function storeProvisional(root, issue, tracked) {
	if (typeof issue?.number !== "number")
		return { ok: false, why: "issue carries no number" };
	const p = predict(issue, tracked);
	if (!p.ok) return { ok: false, why: p.why };
	if (!tracked.ok) return { ok: false, why: "git could not list the tree" };

	let hash;
	try {
		hash = cache.bodyHash(issue?.body);
	} catch (e) {
		return { ok: false, why: e instanceof Error ? e.message : String(e) };
	}

	const r = cache.writeEntry(root, {
		issue: issue?.number,
		bodyHash: hash,
		writeSet: p.writeSet,
		trackedAtDerive: p.writeSet.filter((f) => tracked.files.includes(f)),
		sizeBand: null,
		predictedSize: p.predictedSize,
		gist: issue?.title ? String(issue.title) : null,
		provisional: true,
	});
	return r.ok ? { ok: true, entry: r.entry } : { ok: false, why: r.error };
}

module.exports = {
	DIGEST,
	DOC_MAP_HINT,
	pathsNamedIn,
	predict,
	storeProvisional,
};
