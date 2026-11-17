/*
 * core-docs.js — the two core documents every adopter reads but never edits,
 * rendered from the core's own sources (#5294): its glossary, which the
 * shipped rules cite for a core term, and the method sections of its doc map.
 *
 * The core commits both renders (scripts/generate-core-docs.js, `--check`
 * in .husky/pre-commit), the release ships them, and core-owned-files.js
 * copies them into an adopter on every bump. Neither is imported at session
 * start: a session opens one where a rule cites it.
 *
 * THE DOC-MAP RENDER IS THE METHOD, NEVER THE CONTENT: §Authority classes,
 * §A's preamble before its first register table, §B's before its first
 * entry, §The propagation pass, and §Capture and placement's §1–4. The
 * register, the figure entries, the routes and the shed ledger stay in each
 * repo's own docs/doc-map.md.
 */

const GLOSSARY_FILE = ".claude/workflow-core.glossary.md";
const DOC_MAP_METHOD_FILE = ".claude/workflow-core.doc-map.md";
const GLOSSARY_SOURCE = "GLOSSARY.md";
const DOC_MAP_SOURCE = "docs/doc-map.md";

const CORE_DOCS = [GLOSSARY_FILE, DOC_MAP_METHOD_FILE];

/** @param {string} source */
const buildHeader = (source) =>
	`<!-- CORE-OWNED. Rendered from workflow-core's ${source} by scripts/generate-core-docs.js, and REWRITTEN in an adopter on every bump. Never imported at session start. Do not edit. -->\n\n`;

/**
 * @param {string} glossary the core's GLOSSARY.md
 * @returns {string}
 */
const renderGlossary = (glossary) => buildHeader(GLOSSARY_SOURCE) + glossary;

/**
 * The top-level sections of a markdown text, by heading line.
 * @param {string} text
 * @returns {Map<string, string>} heading line to its whole section, heading
 *   included
 */
function sectionsOf(text) {
	/** @type {Map<string, string>} */
	const out = new Map();
	const parts = text.split(/\n(?=## )/);
	for (const part of parts.slice(1)) {
		const heading = part.slice(0, part.indexOf("\n"));
		out.set(heading, part.trimEnd());
	}
	return out;
}

/**
 * `section` up to the first line `stop` matches, trailing blanks dropped.
 * @param {string} section
 * @param {RegExp} stop
 */
function cut(section, stop) {
	const lines = section.split("\n");
	const at = lines.findIndex((line, i) => i > 0 && stop.test(line));
	return (at < 0 ? lines : lines.slice(0, at)).join("\n").trimEnd();
}

/* Each method section, by its heading in the core's doc map, and where it
 * stops: never, or at the first line that opens the repo's own content. */
/** @type {Array<[string, RegExp | null]>} */
const METHOD = [
	["## Authority classes", null],
	["## Section A — document register", /^### /],
	[
		"## Section B — load-bearing figure registry",
		/^### B\d|^None registered\.$/,
	],
	["## The propagation pass", null],
	["## Capture and placement — where a settled fact goes", /^### 5\. /],
];

/**
 * @param {string} docMap the core's docs/doc-map.md
 * @returns {string}
 * @throws {Error} naming a method section the doc map no longer carries
 */
function renderDocMapMethod(docMap) {
	const sections = sectionsOf(docMap);
	const body = METHOD.map(([heading, stop]) => {
		const section = sections.get(heading);
		if (section === undefined)
			throw new Error(`${DOC_MAP_SOURCE} has no \`${heading}\` section`);
		return stop ? cut(section, stop) : section;
	});
	return `${buildHeader(DOC_MAP_SOURCE)}# Workflow core — the document-map method

The method every repo's \`docs/doc-map.md\` is run by: its authority classes, the rules for §A's register and §B's figure entries, the propagation pass, and where a settled fact goes. The register, the entries, the routes and the shed ledger are each repo's own, in its \`docs/doc-map.md\`. A \`scripts/\` path here is relative to the workflow-core root: the installed plugin in an adopter.

${body.join("\n\n")}
`;
}

module.exports = {
	CORE_DOCS,
	DOC_MAP_METHOD_FILE,
	DOC_MAP_SOURCE,
	GLOSSARY_FILE,
	GLOSSARY_SOURCE,
	renderDocMapMethod,
	renderGlossary,
};
