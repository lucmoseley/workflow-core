/** @typedef {{repo: string|null, number: number}} IssueRef */

/**
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
 * @param {unknown} text
 * @returns {{repo: string, number: number} | null}
 */
function parseQualifiedRef(text) {
	const m =
		typeof text === "string" ? /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(text) : null;
	return m?.[1] && m[2] ? { repo: m[1], number: Number(m[2]) } : null;
}

/** @param {string|null|undefined} url */
function parseRepoOfUrl(url) {
	const m = url ? String(url).match(/\/repos\/([^/]+\/[^/]+)\/?$/) : null;
	return m?.[1] ?? null;
}

/** @param {string|null} a @param {string|null} b */
const isSameRepo = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * @param {IssueRef} ref
 * @param {string|null} childRepo
 */
const isInOtherRepo = (ref, childRepo) =>
	!!ref.repo && !isSameRepo(ref.repo, childRepo);

/**
 * @param {IssueRef} ref
 * @param {string|null} childRepo
 */
const refLabel = (ref, childRepo) =>
	isInOtherRepo(ref, childRepo)
		? `${ref.repo}#${ref.number}`
		: `#${ref.number}`;

/** @param {IssueRef} ref */
const refKey = (ref) => `${(ref.repo ?? "").toLowerCase()}#${ref.number}`;

/**
 * @typedef {{notAfter: RegExp|null, ownerName: boolean, bare: RegExp|null,
 *   wordEnd: boolean, skip?: RegExp}} RefForm
 */

/**
 * @typedef {{text: string, index: number, owner: string|null,
 *   name: string|null, number: number}} ScannedRef
 */

const SECTION = /§[A-Z]?\d+(?:\.\d+)*/g;

const REF_FORMS = {
	identifier: {
		notAfter: /[\w&/]/,
		ownerName: false,
		bare: /[\w.-]/,
		wordEnd: true,
		skip: SECTION,
	},
	citation: {
		notAfter: /[\w&{$]/,
		ownerName: true,
		bare: /[\w-]/,
		wordEnd: true,
	},
	blocker: { notAfter: null, ownerName: true, bare: null, wordEnd: false },
};

const WORD = /\w/;
const NAME = /[\w.-]/;

/**
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
 * @param {string} text
 * @param {RefForm} form
 * @returns {ScannedRef[]}
 */
function scanIssueRefs(text, form) {
	const names = runEnds(text, NAME);
	const bares = form.bare ? runEnds(text, form.bare) : names;
	const digits = runEnds(text, /\d/);
	const skip = form.skip && new RegExp(form.skip.source, "y");
	/** @param {number} at */
	const numberEnd = (at) => {
		if (text.charAt(at) !== "#") return null;
		const end = endAt(digits, at + 1);
		if (end === at + 1) return null;
		return form.wordEnd && WORD.test(text.charAt(end)) ? null : end;
	};
	/**
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
	parseQualifiedRef,
	parseRepoOfUrl,
	refKey,
	REF_FORMS,
	SECTION,
	refLabel,
	scanIssueRefs,
};
