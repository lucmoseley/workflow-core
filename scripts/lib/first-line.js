/*
 * first-line.js — the first line of a tool's output (#2404) or of a thrown
 * error's message (#2728), and the message line of a failed process's stderr,
 * for a one-line reason.
 */

const { caught } = require("./caught.js");

/** `text`'s first line, trimmed; empty where `text` is blank.
 *  @param {string} text */
function parseFirstLine(text) {
	const trimmed = text.trim();
	const end = trimmed.indexOf("\n");
	return end === -1 ? trimmed : trimmed.slice(0, end);
}

/* A source location, as Node prints ahead of an uncaught throw's source
 * line and message: `<path or node: id>:<line>`. */
const LOCATION = /^\S+:\d+$/;
const THROWN = /^(?:Uncaught )?[A-Za-z]*(?:Error|Exception)\b[^:]*: \S/;

/**
 * The line naming why a process failed, off its stderr: where that opens on
 * a source location, as an uncaught throw's does, the thrown error's message
 * line below it, so a module that would not load reads `Error: Cannot find
 * module …`; else the first line (#4950).
 * @param {string} text
 */
function parseMessageLine(text) {
	const first = parseFirstLine(text);
	if (!LOCATION.test(first)) return first;
	const thrown = text
		.split("\n")
		.map((l) => l.trim())
		.find((l) => THROWN.test(l));
	return thrown ?? first;
}

/** The first line of `e`'s message, whatever was thrown.
 *  @param {unknown} e */
const parseErrorFirstLine = (e) => parseFirstLine(caught(e).message);

module.exports = { parseErrorFirstLine, parseFirstLine, parseMessageLine };
