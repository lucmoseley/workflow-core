/*
 * suite-output.js — what a suite run prints, read back: the failing files
 * and tests a vitest or pytest run names, and the two lines
 * scripts/retry-failed-files.js ends on. A leaf, so the local tester, the
 * Actions tester and the retry program read one run's output one way and
 * none loads another. Performs no I/O.
 */

const crypto = require("node:crypto");
const {
	firstLineTerminator,
	hasLineTerminator,
	LINE_TERMINATORS,
	lastLineTerminator,
} = require("./line-terminators.js");
const { requiredGroup } = require("./regex-group.js");

/* The retry program's last two lines: the files its one retry cleared, a
 * green batch's flakes (#4558), and those still failing, a red batch's
 * failing files (#4545). */
const CLEARED = "retry-failed-files: cleared by one retry:";
const STILL_FAILING = "retry-failed-files: still failing after one retry:";

const VITEST_FAIL = /^\s*FAIL\s+(\S+)/;
const PYTEST_FAIL = /^(?:FAILED|ERROR)\s+([^\s:]+)/;
/* The heads of a failing test's line; the name after each is read by index,
 * as a regex ending `(.+?)\s*$` retries its tail from every character (#4647). */
const VITEST_TEST = /^\s*FAIL\s+(\S+)(\s+)/;
const PYTEST_TEST = /^(?:FAILED|ERROR)\s+([^\s:]+)::/;
const VITEST_ARROW = /^>(\s+)/;
const VITEST_END = /^[✓×❯⎯↓]/;
const DIFF_LINE = /^[-+]\s/;
const DIFF_HEADER = /^(?:- Expected|\+ Received)\b/;
/* Untraced: room for an assertion's first lines, kept short for the heartbeat
 * and the tickets that carry it. */
const MESSAGE_CHARS = 300;
/* Untraced: 64 bits, as a signature only compares one test's few failures. */
const SIGNATURE_HEX = 16;

/**
 * A run's output as lines, its ANSI colour stripped.
 * @param {string} out
 * @returns {string[]}
 */
const parsePlainLines = (out) =>
	// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour
	out.replace(/\u001b\[[0-9;]*m/g, "").split("\n");

/**
 * The failing test files a vitest or pytest run names, in the order first
 * named: vitest's `FAIL  <file> > <test>` lines and pytest's
 * `FAILED <file>::<test>` and `ERROR <file>` ones.
 * @param {string} out
 * @returns {string[]}
 */
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

/**
 * What tells one failure from another, read off its whole error before any cut
 * for display. Less what differs between two runs of one failure: an absolute
 * path's directories, as the tip's run is CI's and a bisect's local; shas, from
 * 7 hex digits, git's shortest default abbreviation; and numbers, as a line
 * number moves with any edit above it. Residual (#3937): one file's two
 * offenders on different lines read as one failure, a message otherwise moved
 * by a commit reads as a new failure there, naming that commit in place of the
 * one that broke the test, one differing run to run holds on the culprit's
 * second run, and a list of offenders compares whole, so a merged side red on
 * only some of the tip's reads as not red and the merge is reverted.
 * @param {string} text
 */
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

/**
 * The failing tests a vitest or pytest run names, each with its error: on
 * pytest's `FAILED <file>::<test> - <message>` line, or after vitest's
 * `FAIL  <file> > <test>` lines, one error printing under every test it failed.
 * Vitest's error is its first line and its diff's `+` and `-` lines, as a
 * `toEqual([])` on a list of offenders prints one first line for any offender.
 * @param {string} out
 * @returns {import("./queue-lander.js").Failure[]}
 */
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

/**
 * @typedef {{file: string, test: string, message?: string}} FailingTest
 *   `message` pytest's, after ` - ` on the test's line
 */

const isSpace = (/** @type {string | undefined} */ c) =>
	c !== undefined && c.trim() === "";

/**
 * A test name read from `after`, the line past its head's whitespace `gap`:
 * `after` less its trailing whitespace, holding no line terminator. Where
 * nothing follows the gap, the name is the gap's last character other than a
 * line terminator, past its first.
 * @param {string} gap
 * @param {string} after
 * @returns {string | null}
 */
function nameAfter(gap, after) {
	if (after === "")
		return (
			[...gap.slice(1)].findLast((c) => !LINE_TERMINATORS.includes(c)) ?? null
		);
	const name = after.trimEnd();
	return hasLineTerminator(name) ? null : name;
}

/**
 * The test a vitest `FAIL  <file> > <test>` line names, the `> ` optional;
 * where a lone `>` is all that follows, that `>` is the name.
 * @param {string} line
 * @returns {FailingTest | null}
 */
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

/**
 * The test a pytest `FAILED <file>::<test> - <message>` line names, the
 * message optional; without one, the test runs to the line's trailing
 * whitespace and holds no line terminator.
 * @param {string} line
 * @returns {FailingTest | null}
 */
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
 * Where pytest's ` - ` splits `rest`, the line past `<file>::`, whose text
 * ends at `end`: the first one whose test before it, of at least one
 * character, and whose message after it, trimmed, hold no line terminator.
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
 * @typedef {{unread: import("./queue-lander.js").Failure[], lines: string[]}}
 *   OpenError the tests awaiting an error, and that error's lines so far
 */

/** @param {OpenError} open accumulator: emptied, its tests given its error */
function closeError(open) {
	if (open.lines.length > 0)
		for (const failure of open.unread)
			withError(failure, open.lines.join(" / "));
	open.unread = [];
	open.lines = [];
}

/**
 * @param {OpenError} open accumulator
 * @param {string} line
 */
function readErrorLine(open, line) {
	const text = line.trim();
	if (text === "" || open.unread.length === 0) return;
	/* A bare `ERROR <file>` line names a file, and is no test's error. */
	if (VITEST_END.test(text) || PYTEST_FAIL.test(line)) closeError(open);
	else if (
		open.lines.length === 0 ||
		(DIFF_LINE.test(text) && !DIFF_HEADER.test(text))
	)
		open.lines.push(text);
}

/**
 * @param {import("./queue-lander.js").Failure} failure accumulator
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
