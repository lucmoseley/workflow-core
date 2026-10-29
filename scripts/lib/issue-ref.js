/*
 * issue-ref.js — an issue named across repos: read off an API URL or out of
 * prose (#3477), keyed, labelled for a reader, and told apart from another
 * repo's (#3256). Its own module so the blocker readers that need only these do not
 * load the claim store parent-claims.js reads. A word of a `gh issue` command is
 * gh-issue-ref.js's to read, not this file's.
 *
 * A CORE: it reads nothing but its arguments.
 */

/** @typedef {{repo: string|null, number: number}} IssueRef */

/**
 * The issue an API issue URL names. `repo` is null where the URL carries no
 * `/repos/<owner>/<name>/` part, read as the candidate's own repo.
 * @param {string|null|undefined} url
 * @returns {IssueRef|null}
 */
function parseIssueRef(url) {
	if (!url) return null;
	const m = String(url).match(/\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/?$/);
	if (m) return { repo: m[1] ?? null, number: Number(m[2]) };
	const n = Number(String(url).split("/").pop());
	return Number.isInteger(n) && n > 0 ? { repo: null, number: n } : null;
}

/**
 * `owner/name` from a `repository_url`, or null.
 * @param {string|null|undefined} url
 */
function parseRepoOfUrl(url) {
	const m = url ? String(url).match(/\/repos\/([^/]+\/[^/]+)\/?$/) : null;
	return m?.[1] ?? null;
}

/** @param {string|null} a @param {string|null} b */
const isSameRepo = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * Whether `ref` lives in a repo other than `childRepo`. A ref naming no repo
 * is the child's own.
 * @param {IssueRef} ref
 * @param {string|null} childRepo
 */
const isInOtherRepo = (ref, childRepo) =>
	!!ref.repo && !isSameRepo(ref.repo, childRepo);

/**
 * How a reader sees `ref` from an issue in `childRepo`: `#n` in the same repo,
 * `owner/name#n` in another.
 * @param {IssueRef} ref
 * @param {string|null} childRepo
 */
const refLabel = (ref, childRepo) =>
	isInOtherRepo(ref, childRepo)
		? `${ref.repo}#${ref.number}`
		: `#${ref.number}`;

/**
 * One key per issue across repos, case-folded as GitHub folds a repo name; a
 * ref naming no repo keys as `#n`.
 * @param {IssueRef} ref
 */
const refKey = (ref) => `${(ref.repo ?? "").toLowerCase()}#${ref.number}`;

/**
 * How a scan reads a reference. `notAfter` is the characters a reference may
 * not start straight after; `ownerName` admits an `owner/name#n` prefix;
 * `bare` is the character class of a lone `name#n` prefix, or null for none;
 * `wordEnd` refuses a number running on into a word character; `skip` is a
 * span no reference starts inside.
 * @typedef {{notAfter: RegExp|null, ownerName: boolean, bare: RegExp|null,
 *   wordEnd: boolean, skip?: RegExp}} RefForm
 */

/**
 * @typedef {{text: string, index: number, owner: string|null,
 *   name: string|null, number: number}} ScannedRef
 */

/** A section identifier: `§N2`, `§6`. */
const SECTION = /§[A-Z]?\d+(?:\.\d+)*/g;

/* Each caller's form keeps the quirks of the regex it replaced (#3383). */
const REF_FORMS = {
	/** `#12`, `mantahostels#12`. */
	identifier: {
		notAfter: /[\w&/]/,
		ownerName: false,
		bare: /[\w.-]/,
		wordEnd: true,
		skip: SECTION,
	},
	/** `#12`, `name#12`, `acme/core#12` in option lines. */
	citation: {
		notAfter: /[\w&{$]/,
		ownerName: true,
		bare: /[\w-]/,
		wordEnd: true,
	},
	/** `#12` or `owner/name#12` in a `**Blocked on**` list. */
	blocker: { notAfter: null, ownerName: true, bare: null, wordEnd: false },
};

const WORD = /\w/;
const NAME = /[\w.-]/;

/**
 * Where the run of `cls` characters starting at each index ends, the text's
 * length past its last.
 * @param {string} text
 * @param {RegExp} cls
 */
function runEnds(text, cls) {
	const ends = new Int32Array(text.length + 1);
	let end = text.length;
	ends[end] = end;
	for (let i = text.length - 1; i >= 0; i--) {
		if (!cls.test(text.charAt(i))) end = i;
		ends[i] = end;
	}
	return ends;
}

/**
 * @param {Int32Array} ends
 * @param {number} i
 */
function endAt(ends, i) {
	const end = ends[i];
	if (end === undefined) throw new RangeError(`no run end at ${i}`);
	return end;
}

/**
 * Every issue reference in `text` that `form` admits, leftmost first. Each
 * index is tried once against run ends worked out up front, so the scan is
 * linear however long a run of name characters.
 * @param {string} text
 * @param {RefForm} form
 * @returns {ScannedRef[]}
 */
function scanIssueRefs(text, form) {
	const names = runEnds(text, NAME);
	const bares = form.bare ? runEnds(text, form.bare) : names;
	const digits = runEnds(text, /\d/);
	const skip = form.skip && new RegExp(form.skip.source, "y");
	/** @param {number} at the end of the number a `#` at `at` opens, or null */
	const numberEnd = (at) => {
		if (text.charAt(at) !== "#") return null;
		const end = endAt(digits, at + 1);
		if (end === at + 1) return null;
		return form.wordEnd && WORD.test(text.charAt(end)) ? null : end;
	};
	/**
	 * The prefixes the form admits at `at`, in the order they are tried.
	 * @param {number} at
	 * @returns {{prefixEnd: number, ownerEnd: number|null}[]}
	 */
	const prefixesAt = (at) => {
		const out = [];
		const ownerEnd = endAt(names, at);
		if (form.ownerName && ownerEnd > at && text.charAt(ownerEnd) === "/") {
			const nameEnd = endAt(names, ownerEnd + 1);
			if (nameEnd > ownerEnd + 1) out.push({ prefixEnd: nameEnd, ownerEnd });
		}
		const bareEnd = endAt(bares, at);
		if (form.bare && bareEnd > at)
			out.push({ prefixEnd: bareEnd, ownerEnd: null });
		out.push({ prefixEnd: at, ownerEnd: null });
		return out;
	};
	/** @param {number} at */
	const admitted = (at) =>
		!form.notAfter || at === 0 || !form.notAfter.test(text.charAt(at - 1));
	/**
	 * @param {number} at
	 * @param {{prefixEnd: number, ownerEnd: number|null}} prefix
	 * @param {number} end
	 * @returns {ScannedRef}
	 */
	const refOf = (at, { prefixEnd, ownerEnd }, end) => ({
		text: text.slice(at, end),
		index: at,
		owner: ownerEnd === null ? null : text.slice(at, ownerEnd),
		name:
			prefixEnd === at
				? null
				: text.slice(ownerEnd === null ? at : ownerEnd + 1, prefixEnd),
		number: Number(text.slice(prefixEnd + 1, end)),
	});
	/** @param {number} at @returns {ScannedRef|null} */
	const refAt = (at) => {
		if (!admitted(at)) return null;
		for (const prefix of prefixesAt(at)) {
			const end = numberEnd(prefix.prefixEnd);
			if (end !== null) return refOf(at, prefix, end);
		}
		return null;
	};
	/** @type {ScannedRef[]} */
	const refs = [];
	for (let at = 0; at < text.length; ) {
		const ref = refAt(at);
		if (ref) refs.push(ref);
		if (skip) skip.lastIndex = at;
		const skipped = ref ? null : skip?.exec(text);
		at = ref ? at + ref.text.length : at + (skipped?.[0].length || 1);
	}
	return refs;
}

module.exports = {
	isInOtherRepo,
	isSameRepo,
	parseIssueRef,
	parseRepoOfUrl,
	refKey,
	REF_FORMS,
	SECTION,
	refLabel,
	scanIssueRefs,
};
