const { requiredGroup } = require("./regex-group.js");

/** @type {Readonly<Record<number, { name: string, tags: readonly string[] }>>} */
const DOC_MAP_ASSERTIONS = Object.freeze({
	1: { name: "Coverage", tags: ["UNCOVERED", "UNCOVERED-GRACE"] },
	2: {
		name: "No dead entries",
		tags: ["DEAD-ENTRY", "DEAD-ENTRY-GRACE", "UNTRACKED-ENTRY"],
	},
	4: { name: "Live routes", tags: ["DEAD-ROUTE", "UNTRACKED-ROUTE"] },
	5: { name: "Live restatements", tags: ["DEAD-RESTATEMENT"] },
	6: { name: "Distinct entry ids", tags: ["DUPLICATE-ENTRY-ID"] },
	7: { name: "Dense route ids", tags: ["ROUTE-ID-GAP"] },
	8: { name: "Distinct register keys", tags: ["DUPLICATE-REGISTER-KEY"] },
	9: { name: "No stray entries", tags: ["STRAY-ENTRY"] },
	10: { name: "Settled at on every entry", tags: ["SETTLED-AT-MISSING"] },
	11: { name: "Pointer-shape agreement", tags: ["POINTER-SHAPE"] },
	12: { name: "New ids above the mark", tags: ["REUSED-ENTRY-ID"] },
	13: { name: "The mark holds", tags: ["HIGH-WATER-MARK"] },
	14: { name: "New-entry prose cap", tags: ["NEW-ENTRY-OVER-CAP"] },
	15: { name: "Shed-ledger entry cap", tags: ["LEDGER-ENTRY-OVER-CAP"] },
	16: {
		name: "Trigger verdict on a pool-byte tranche",
		tags: ["LEDGER-TRIGGER-VERDICT"],
	},
	17: { name: "§A render agreement", tags: ["SECTION-A-DRIFT"] },
	18: { name: "Role prose cap", tags: ["ROLE-OVER-CAP"] },
	19: { name: "Class vocabulary", tags: ["UNKNOWN-CLASS"] },
	20: { name: "Compaction verdict", tags: ["LEDGER-COMPACTION-VERDICT"] },
	21: { name: "Stale over-cap marker", tags: ["STALE-OVER-CAP-MARKER"] },
	22: { name: "Over-cap entry growth", tags: ["OVER-CAP-ENTRY-GREW"] },
	23: {
		name: "Malformed over-cap marker",
		tags: ["MALFORMED-OVER-CAP-MARKER"],
	},
	24: { name: "Dropped over-cap marker", tags: ["OVER-CAP-MARKER-DROPPED"] },
	25: {
		name: "Live Consumes references",
		tags: ["MALFORMED-CONSUMES", "DEAD-CONSUMES", "UNTRACKED-CONSUMES"],
	},
	26: { name: "Pair-scope prefixes", tags: ["PAIR-SCOPE"] },
	27: { name: "No line-number locators", tags: ["LINE-LOCATOR"] },
	28: { name: "Live anchors", tags: ["DEAD-ANCHOR"] },
	29: { name: "Admission record", tags: ["UNRECORDED-ADMISSION"] },
	30: {
		name: "Sidecar canonical serialisation",
		tags: ["SIDECAR-NOT-CANONICAL"],
	},
	31: {
		name: "Reader vocabulary",
		tags: ["UNKNOWN-READER", "MISSING-READER", "READER-ON-NON-PROSE"],
	},
	32: { name: "Page source", tags: ["PAGE-SOURCE"] },
	33: { name: "Live section references", tags: ["DEAD-SECTION-REF"] },
});

const ASSERTION_OF_TAG = new Map(
	Object.entries(DOC_MAP_ASSERTIONS).flatMap(([n, { tags }]) =>
		tags.map((tag) => [tag, Number(n)]),
	),
);

/**
 * @param {string} tag
 * @returns {number}
 */
function assertionOf(tag) {
	const n = ASSERTION_OF_TAG.get(tag);
	if (n === undefined) {
		throw new Error(`doc-map finding tag ${tag} names no assertion`);
	}
	return n;
}

const ASSERTION_CITATION = /\bassertions? (\d+(?:(?:,? and |, )\d+)*)/gi;

/**
 * @param {string} text
 * @returns {number[]}
 */
function citedAssertions(text) {
	return [...text.matchAll(ASSERTION_CITATION)].flatMap((m) =>
		requiredGroup(m, 1, ASSERTION_CITATION)
			.split(/,? and |, /)
			.map(Number),
	);
}

/**
 * @param {Record<string, string>} files
 * @returns {string[]}
 */
function unresolvedCitations(files) {
	return Object.entries(files).flatMap(([file, text]) =>
		citedAssertions(text)
			.filter((n) => !(n in DOC_MAP_ASSERTIONS))
			.map((n) => `${file}: assertion ${n}`),
	);
}

module.exports = {
	DOC_MAP_ASSERTIONS,
	assertionOf,
	citedAssertions,
	unresolvedCitations,
};
