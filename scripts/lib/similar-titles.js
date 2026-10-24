/*
 * similar-titles.js — the ranking file-issue.js lists similar open issues by
 * (workflow-core#536), as workflow-core#500's research measured it. The stopwords, the stem, the
 * threshold and the cut are that measurement's; changing any of them
 * invalidates it, and docs/data/issue-title-search-2026-09-27/ is the
 * dataset file-issue.test.ts re-checks it against.
 */

const STOPWORDS = new Set(
	"a an the and or but of to in on at by for from with without into onto over under is are was were be been being it its it's this that these those as not no so do does did done make makes making one each every any all when where which who what why how than then too very can cannot could would should will just only also more less most first own same other their them they there here via per our we you your i my me us up out off before after again once still yet across about spec".split(
		" ",
	),
);
const SIMILAR_MIN_SCORE = 6;
const SIMILAR_TOP = 3;

/** @param {string} title */
const titleWords = (title) =>
	title
		.toLowerCase()
		.replace(/[`'"“”‘’#:,.()[\]!?;]/g, " ")
		.split(/[\s\-_/]+/)
		.filter((w) => w && /[a-z]/.test(w));

/** @param {string} title */
const contentWords = (title) =>
	[...new Set(titleWords(title))].filter(
		(w) => !STOPWORDS.has(w) && w.length > 2,
	);

/** @param {string} w */
const stem = (w) => w.replace(/(ing|ed|es|s|al)$/, "");

/**
 * The open issues whose titles most resemble `query`: each scored by the
 * summed inverse document frequency of the query's words whose stem it
 * shares, frequencies over every title in `issues` plus the query's own;
 * at least SIMILAR_MIN_SCORE, best SIMILAR_TOP. Closed issues only weight
 * the frequencies.
 * @param {string} query
 * @param {{number: number, title: string, state: string}[]} issues
 */
function similarOpen(query, issues) {
	/** @type {Map<string, number>} */
	const df = new Map();
	const titles = [query, ...issues.map((i) => i.title)];
	for (const t of titles)
		for (const w of new Set(titleWords(t))) df.set(w, (df.get(w) || 0) + 1);
	const idf = (/** @type {string} */ w) =>
		Math.log(titles.length / (df.get(w) || 1));
	const words = contentWords(query);
	return issues
		.filter((i) => i.state.toUpperCase() === "OPEN")
		.map((i) => {
			const stems = new Set(contentWords(i.title).map(stem));
			let score = 0;
			for (const w of words) if (stems.has(stem(w))) score += idf(w);
			return { number: i.number, title: i.title, score };
		})
		.filter((c) => c.score >= SIMILAR_MIN_SCORE)
		.sort((a, b) => b.score - a.score)
		.slice(0, SIMILAR_TOP);
}

/*
 * The refusal's re-run hint, written by file-issue.js and read back by the
 * unattended filers that dedupe for themselves (check-orphaned-edits.js) —
 * one spelling, so a reword cannot strand them (workflow-core#1073).
 */
/** @param {number[]} numbers */
const distinctFromHint = (numbers) => `--distinct-from ${numbers.join(",")}.`;

/**
 * The numbers a refusal's hint names, comma-joined, or null.
 * @param {string} text
 */
const readDistinctFromHint = (text) =>
	/--distinct-from ([\d,]+)\.$/m.exec(text)?.[1] ?? null;

module.exports = { distinctFromHint, readDistinctFromHint, similarOpen };
