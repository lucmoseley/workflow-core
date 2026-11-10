/*
 * commit-calls.js — the commit calls one Bash command made, read as the
 * guards read them (workflow-core#2383).
 *
 * COUNTED: a `git commit`, and a `commit-paths.js` call by any path that would
 * commit — never a `--tree` pin, nor one commit-paths.js refuses unread: one
 * with no message or two, or `--help`.
 *
 * LIMITS: a commit inside a heredoc body or a `bash -c` string is not seen.
 * Where the walk splits a command bash would not — a heredoc's terminator
 * followed by `)`, a quote never closed — the message word is cut short and
 * the caller reads it off the command itself, and a later commit in that
 * command is not seen.
 */

const {
	asWritten,
	parseCommand,
	walkCommands,
	TEXT_ONLY_PORTS,
} = require("./shell-parse.js");
const {
	commitPathsArgs,
	commitPathsParse,
	gitValueFlags,
	gitWords,
	literal,
	scanFlags,
} = require("./shell-words.js");

/**
 * @typedef {{ call: string, flag: "m" | "F" | "-", word: string }} CommitCall
 *   the call as written; `m` and the message word as written, `F` and the
 *   message file's path, or `-` and "" where neither was given or the path
 *   holds an expansion
 */

/**
 * @param {string} command
 * @returns {CommitCall[]}
 */
function commitCalls(command) {
	const parsed = parseCommand(command);
	const { spans } = parsed;
	/** @type {CommitCall[]} */
	const out = [];
	walkCommands(
		parsed,
		({ segment, words }) => {
			const call = asWritten(segment, spans).trim();
			for (const msg of commitMessages(words, spans))
				out.push(callOf(call, msg, spans));
		},
		TEXT_ONLY_PORTS,
	);
	return out;
}

/**
 * Each commit one command's words make, by its message flag and word: null
 * for a commit carrying neither `-m` nor `-F`.
 * @param {string[]} words
 * @param {string[]} spans
 * @returns {({ flag: string, word: string } | null)[]}
 */
function commitMessages(words, spans) {
	/** @type {({ flag: string, word: string } | null)[]} */
	const msgs = [];
	for (const cpArgs of commitPathsArgs(words, spans)) {
		const call = commitPathsParse(cpArgs, spans);
		if (call === null || call.tree || !call.messageFlag) continue;
		msgs.push({ flag: call.messageFlag.slice(1), word: call.message });
	}
	for (const git of gitWords(words, spans)) {
		if (git.sub !== "commit") continue;
		/** @type {{ flag: string, word: string } | null} */
		let msg = null;
		/* The first message flag wins. */
		scanFlags(gitValueFlags("commit"), git.args, (kind, name, value) => {
			if (msg !== null || kind !== "opt") return;
			if (name === "-m" || name === "--message")
				msg = { flag: "m", word: value };
			else if (name === "-F" || name === "--file")
				msg = { flag: "F", word: value };
		});
		msgs.push(msg);
	}
	return msgs;
}

/**
 * @param {string} call the segment as written
 * @param {{ flag: string, word: string } | null} msg
 * @param {string[]} spans
 * @returns {CommitCall}
 */
function callOf(call, msg, spans) {
	if (msg?.flag === "m")
		return { call, flag: "m", word: asWritten(msg.word, spans) };
	if (msg?.flag !== "F") return { call, flag: "-", word: "" };
	const path = literal(msg.word, spans);
	return path.known
		? { call, flag: "F", word: path.text }
		: { call, flag: "-", word: "" };
}

module.exports = { commitCalls };
