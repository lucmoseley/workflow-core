const crypto = require("node:crypto");
const { stripVTControlCharacters } = require("node:util");
const {
	firstLineTerminator,
	hasLineTerminator,
	LINE_TERMINATORS,
	lastLineTerminator,
} = require("./line-terminators.js");
const { requiredGroup } = require("./regex-group.js");

const CLEARED = "retry-failed-files: cleared by one retry:";
const STILL_FAILING = "retry-failed-files: still failing after one retry:";

const VITEST_FAIL = /^\s*FAIL\s+(\S+)/;
const PYTEST_FAIL = /^(?:FAILED|ERROR)\s+([^\s:]+)/;
const VITEST_TEST = /^\s*FAIL\s+(\S+)(\s+)/;
const PYTEST_TEST = /^(?:FAILED|ERROR)\s+([^\s:]+)::/;
const VITEST_ARROW = /^>(\s+)/;
const VITEST_END = /^[✓×❯⎯↓]/;
const DIFF_LINE = /^[-+]\s/;
const DIFF_HEADER = /^(?:- Expected|\+ Received)\b/;
// guess: room for an assertion's first lines, workflow-core#4860
const MESSAGE_CHARS = 300;
// guess, workflow-core#4860
const SIGNATURE_HEX = 16;

/** @param {string} out @returns {string[]} */
const parsePlainLines = (out) => stripVTControlCharacters(out).split("\n");

/** @param {string} out @returns {string[]} */
function parseFailingFiles(out) {
	/** @type {Set<string>} */
	const files = new Set();
	for (const line of parsePlainLines(out))
		for (const re of [VITEST_FAIL, PYTEST_FAIL]) {
			const m = line.match(re);
			if (m) {
				files.add(requiredGroup(m, 1, re));
				break;
			}
		}
	return [...files];
}

/** @param {string} text */
const buildSignature = (text) =>
	crypto
		.createHash("sha256")
		.update(
			text
				.replace(/(?<![\w.])(?:\/[^\s/:'"`]+)+\//g, "")
				.replace(/\b[0-9a-f]{7,40}\b/g, "#")
				.replace(/\d+/g, "#"),
		)
		.digest("hex")
		.slice(0, SIGNATURE_HEX);

/** @param {string} out @returns {import("./queue-lander.js").Failure[]} */
function parseFailingTests(out) {
	/** @type {Map<string, import("./queue-lander.js").Failure>} */
	const tests = new Map();
	/** @param {FailingTest} t */
	const named = ({ file, test }) => {
		const key = `${file}\0${test}`;
		const failure = tests.get(key) ?? { file, test };
		tests.set(key, failure);
		return failure;
	};
	/** @type {OpenError} */
	const open = { unread: [], lines: [] };
	for (const line of parsePlainLines(out)) {
		const v = parseVitestTest(line);
		const p = v ? null : parsePytestTest(line);
		if (v) {
			if (open.lines.length > 0) closeError(open);
			open.unread.push(named(v));
		} else if (p) {
			closeError(open);
			if (p.message) withError(named(p), p.message);
			else named(p);
		} else readErrorLine(open, line);
	}
	closeError(open);
	return [...tests.values()];
}

/** @typedef {{file: string, test: string, message?: string}} FailingTest */

const isSpace = (/** @type {string | undefined} */ c) =>
	c !== undefined && c.trim() === "";

/** @param {string} gap @param {string} after @returns {string | null} */
function nameAfter(gap, after) {
	if (after === "")
		return (
			[...gap.slice(1)].findLast((c) => !LINE_TERMINATORS.includes(c)) ?? null
		);
	const name = after.trimEnd();
	return hasLineTerminator(name) ? null : name;
}

/** @param {string} line @returns {FailingTest | null} */
function parseVitestTest(line) {
	const head = VITEST_TEST.exec(line);
	if (!head) return null;
	const rest = line.slice(head[0].length);
	const arrow = VITEST_ARROW.exec(rest);
	const test =
		(arrow &&
			nameAfter(
				requiredGroup(arrow, 1, VITEST_ARROW),
				rest.slice(arrow[0].length),
			)) ??
		nameAfter(requiredGroup(head, 2, VITEST_TEST), rest);
	return test === null
		? null
		: { file: requiredGroup(head, 1, VITEST_TEST), test };
}

/** @param {string} line @returns {FailingTest | null} */
function parsePytestTest(line) {
	const head = PYTEST_TEST.exec(line);
	if (!head) return null;
	const file = requiredGroup(head, 1, PYTEST_TEST);
	const rest = line.slice(head[0].length);
	const end = rest.trimEnd().length;
	const split = messageSplit(rest, end);
	if (split)
		return {
			file,
			test: rest.slice(0, split.testEnd),
			message: rest.slice(split.messageStart, end),
		};
	const test = rest.slice(0, Math.max(end, 1));
	return test === "" || hasLineTerminator(test)
		? null
		: { file, test, message: "" };
}

/**
 * @param {string} rest
 * @param {number} end
 * @returns {{testEnd: number, messageStart: number} | null}
 */
function messageSplit(rest, end) {
	const firstBreak = firstLineTerminator(rest);
	const lastBreak = lastLineTerminator(rest.slice(0, end));
	for (
		let dash = rest.indexOf("-", 2);
		dash !== -1;
		dash = rest.indexOf("-", dash + 1)
	) {
		if (!isSpace(rest[dash - 1]) || !isSpace(rest[dash + 1])) continue;
		let testEnd = dash - 1;
		while (testEnd > 1 && isSpace(rest[testEnd - 1])) testEnd--;
		if (testEnd > firstBreak) return null;
		let messageStart = dash + 1;
		while (isSpace(rest[messageStart])) messageStart++;
		if (lastBreak < messageStart) return { testEnd, messageStart };
	}
	return null;
}

/**
 * @typedef {{unread: import("./queue-lander.js").Failure[], lines: string[]}} OpenError
 */

/** @param {OpenError} open */
function closeError(open) {
	if (open.lines.length > 0)
		for (const failure of open.unread)
			withError(failure, open.lines.join(" / "));
	open.unread = [];
	open.lines = [];
}

/** @param {OpenError} open @param {string} line */
function readErrorLine(open, line) {
	const text = line.trim();
	if (text === "" || open.unread.length === 0) return;
	if (VITEST_END.test(text) || PYTEST_FAIL.test(line)) closeError(open);
	else if (
		open.lines.length === 0 ||
		(DIFF_LINE.test(text) && !DIFF_HEADER.test(text))
	)
		open.lines.push(text);
}

/**
 * @param {import("./queue-lander.js").Failure} failure
 * @param {string} text
 */
function withError(failure, text) {
	failure.message = text.slice(0, MESSAGE_CHARS);
	failure.signature = buildSignature(text);
}

module.exports = {
	CLEARED,
	parseFailingFiles,
	parseFailingTests,
	parsePlainLines,
	STILL_FAILING,
};
