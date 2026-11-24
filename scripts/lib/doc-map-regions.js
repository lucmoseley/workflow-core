const {
	FIGURE_ID: ENTRY_HEADING,
	idNumber,
	jsonStringEnd,
} = require("./doc-map.js");
const { requiredGroup } = require("./regex-group.js");
const { trimEndRun, trimRun } = require("./trim-run.js");

const SECTION_LETTER = /^Section ([A-Za-z])\b/;

const STAMP_LINE = /^v\d+\.\d+ · /;

const ROW_PREFIX = "A:";

const REGISTER_SECTION = "section-a";

const LEDGER_SECTION = "capture-and-placement-where-a-settled";
const LEDGER_HEADING = /^### 5\. /;
const LEDGER_ID = "capture-and-placement-shed-ledger";

const SIDECAR_PATH = "docs/doc-map-classes.json";

const MAP_PATH = "docs/doc-map.md";

const REGIONED = new Set([MAP_PATH, SIDECAR_PATH]);

/** @param {string} rel */
function isRegioned(rel) {
	return REGIONED.has(rel);
}

/**
 * @param {string} rel
 * @param {string} region
 */
function isGeneratorOnlyRegion(rel, region) {
	return (
		rel === MAP_PATH &&
		(region === REGISTER_SECTION || region.startsWith(ROW_PREFIX))
	);
}

/** @param {string} heading */
function sectionId(heading) {
	const title = heading.replace(/^#+\s+/, "").trim();
	const section = title.match(SECTION_LETTER);
	if (section)
		return `section-${requiredGroup(section, 1, SECTION_LETTER).toLowerCase()}`;
	const dashed = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
	const slug = trimRun(dashed, "-");
	if (slug.length <= 40) return slug || "section";
	return (
		trimEndRun(slug.slice(0, 40).replace(/-[^-]*$/, ""), "-") ||
		slug.slice(0, 40)
	);
}

/**
 * @param {string} text
 * @returns {{id: string, start: number, end: number}[]}
 */
function parseJsonKeyRegions(text) {
	/** @type {JsonKeyScan} */
	const scan = {
		found: [],
		depth: 0,
		awaitingKey: true,
		keyStart: -1,
		key: null,
		entryStart: -1,
	};

	let i = 0;
	while (i < text.length) i = scanJsonToken(scan, text, i);
	return scan.found;
}

/**
 * @typedef {object} JsonKeyScan
 * @property {{id: string, start: number, end: number}[]} found
 * @property {number} depth
 * @property {boolean} awaitingKey
 * @property {number} keyStart
 * @property {string|null} key
 * @property {number} entryStart
 */

/**
 * @param {JsonKeyScan} scan
 * @param {string} text
 * @param {number} i
 */
function scanJsonToken(scan, text, i) {
	const ch = text[i];
	if (ch === '"') {
		const end = jsonStringEnd(text, i);
		if (scan.depth === 1 && scan.awaitingKey && scan.key === null) {
			scan.keyStart = i + 1;
			scan.key = text.slice(i + 1, end);
			scan.awaitingKey = false;
		}
		return end + 1;
	}
	if (ch === "{" || ch === "[") {
		if (scan.depth === 1 && scan.key !== null && scan.entryStart === -1)
			scan.entryStart = scan.keyStart - 1;
		scan.depth++;
		return i + 1;
	}
	if (ch === "}" || ch === "]") {
		closeJsonContainer(scan, i);
		return i + 1;
	}
	if (ch === "," && scan.depth === 1) {
		awaitNextKey(scan);
	}
	return i + 1;
}

/**
 * @param {JsonKeyScan} scan
 * @param {number} i
 */
function closeJsonContainer(scan, i) {
	scan.depth--;
	if (scan.depth === 1 && scan.key !== null && scan.entryStart !== -1) {
		scan.found.push({
			id: ROW_PREFIX + scan.key,
			start: scan.entryStart,
			end: i + 1,
		});
		awaitNextKey(scan);
	}
}

/** @param {JsonKeyScan} scan */
function awaitNextKey(scan) {
	scan.key = null;
	scan.entryStart = -1;
	scan.awaitingKey = true;
}

/**
 * @param {string} text
 * @param {string} [rel]
 * @returns {{id: string, start: number, end: number}[]}
 */
function parseRegions(text, rel) {
	if (rel === SIDECAR_PATH) return parseJsonKeyRegions(text);
	const regions = [];
	const end = text.length;
	let offset = 0;
	let current = { id: "head", start: 0, end: 0 };
	let fenced = false;
	let awaitingLedger = false;

	/** @param {number} at */
	const close = (at) => {
		current.end = Math.min(at, end);
		if (current.end > current.start) regions.push(current);
	};

	for (const line of text.split("\n")) {
		const lineStart = offset;
		offset += line.length + 1;

		if (/^\s*(```|~~~)/.test(line)) {
			fenced = !fenced;
			continue;
		}
		if (fenced) continue;

		if (STAMP_LINE.test(line)) {
			close(lineStart);
			regions.push({
				id: "stamp",
				start: lineStart,
				end: Math.min(offset, end),
			});
			current = { id: "head", start: Math.min(offset, end), end: 0 };
			continue;
		}

		const entry = line.match(ENTRY_HEADING);
		if (entry) {
			close(lineStart);
			current = {
				id: requiredGroup(entry, 1, ENTRY_HEADING),
				start: lineStart,
				end: offset,
			};
			continue;
		}

		if (awaitingLedger && LEDGER_HEADING.test(line)) {
			close(lineStart);
			awaitingLedger = false;
			current = { id: LEDGER_ID, start: lineStart, end: offset };
			continue;
		}

		if (/^## /.test(line)) {
			close(lineStart);
			const id = sectionId(line);
			awaitingLedger = id === LEDGER_SECTION;
			current = { id: sectionRegionId(id), start: lineStart, end: offset };
		}
	}
	close(end);
	return regions;
}

/** @param {string} id */
function sectionRegionId(id) {
	return id === "section-b" ? "section-b-preamble" : id;
}

/**
 * @param {string} haystack
 * @param {string} needle
 * @returns {number[]}
 */
function occurrences(haystack, needle) {
	const found = [];
	let from = 0;
	for (;;) {
		const at = haystack.indexOf(needle, from);
		if (at === -1) return found;
		found.push(at);
		from = at + 1;
		if (found.length > 8) return found;
	}
}

/**
 * @param {string} text
 * @param {unknown} anchor
 * @param {number} [anchorLength]
 * @param {string} [rel]
 * @returns {{region: string|null, why: string|null, regions?: string[]}}
 */
function resolveRegion(text, anchor, anchorLength, rel) {
	if (typeof anchor !== "string" || anchor === "")
		return { region: null, why: "no anchor" };
	if (
		typeof anchorLength === "number" &&
		Number.isFinite(anchorLength) &&
		anchorLength > anchor.length
	)
		return {
			region: null,
			why: `anchor was truncated at ${anchor.length} of ${anchorLength} characters, so where it ends is unknown`,
		};
	const found = parseRegions(text, rel);
	const at = occurrences(text, anchor);
	if (at.length === 0)
		return { region: null, why: "anchor not found in the file" };
	if (at.length > 8)
		return { region: null, why: "anchor occurs too many times to place" };

	const hit = [];
	for (const start of at) {
		const last = Math.max(start + anchor.length - 1, start);
		const touched = found.filter((r) => start < r.end && last >= r.start);
		const [first] = touched;
		if (first === undefined)
			return { region: null, why: "anchor could not be placed" };
		if (touched.length > 1) return spansRegions(touched, at.length === 1);
		hit.push(first.id);
	}
	const distinct = [...new Set(hit)];
	if (distinct.length > 1)
		return {
			region: null,
			why: `anchor occurs in ${distinct.length} regions (${distinct.join(", ")})`,
		};
	const [region] = distinct;
	if (region === undefined)
		throw new Error(`anchor's ${at.length} occurrences placed no region`);
	return { region, why: null };
}

/**
 * @param {{id: string}[]} touched
 * @param {boolean} single
 * @returns {{region: null, why: string, regions?: string[]}}
 */
function spansRegions(touched, single) {
	const ids = [...new Set(touched.map((r) => r.id))];
	return {
		region: null,
		why: `anchor spans ${touched.map((r) => r.id).join(", ")}`,
		...(single && ids.length > 1 ? { regions: ids } : {}),
	};
}

/**
 * @param {string} text
 * @param {string} region
 * @param {string} [rel]
 * @returns {string|null}
 */
function parseRegionText(text, region, rel) {
	const found = parseRegions(text, rel).filter((r) => r.id === region);
	if (found.length === 0) return null;
	return found.map((r) => text.slice(r.start, r.end)).join("");
}

/**
 * @param {string} text
 * @param {number} mark
 */
function nextEntryNumber(text, mark) {
	return (
		entryIds(text).reduce((max, id) => Math.max(max, idNumber(id)), mark) + 1
	);
}

/** @param {string} text */
function entryIds(text) {
	return parseRegions(text)
		.map((r) => r.id)
		.filter((id) => /^B\d+$/.test(id));
}

module.exports = {
	REGISTER_SECTION,
	ROW_PREFIX,
	SIDECAR_PATH,
	entryIds,
	isGeneratorOnlyRegion,
	isRegioned,
	nextEntryNumber,
	parseRegions,
	parseRegionText,
	resolveRegion,
};
