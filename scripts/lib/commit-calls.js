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

const { asWritten, parseCommand, walkCommands } = require("./shell-parse.js");
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
			/** @type {{ flag: string, word: string } | null} */
			let msg = null;
			const cpArgs = commitPathsArgs(words, spans);
			if (cpArgs === null) {
				const git = gitWords(words, spans);
				if (git?.sub !== "commit") return;
				/* The first message flag wins. */
				scanFlags(gitValueFlags("commit"), git.args, (kind, name, value) => {
					if (msg !== null || kind !== "opt") return;
					if (name === "-m" || name === "--message")
						msg = { flag: "m", word: value };
					else if (name === "-F" || name === "--file")
						msg = { flag: "F", word: value };
				});
			} else {
				const call = commitPathsParse(cpArgs, spans);
				if (call === null || call.tree || !call.messageFlag) return;
				msg = { flag: call.messageFlag.slice(1), word: call.message };
			}
			const call = asWritten(segment, spans).trim();
			if (msg?.flag === "m")
				out.push({ call, flag: "m", word: asWritten(msg.word, spans) });
			else if (msg?.flag === "F") {
				const path = literal(msg.word, spans);
				out.push(
					path.known
						? { call, flag: "F", word: path.text }
						: { call, flag: "-", word: "" },
				);
			} else out.push({ call, flag: "-", word: "" });
		},
		{ cwd: undefined, fallbackCwd: "/", vars: {}, isDir: () => false },
	);
	return out;
}

module.exports = { commitCalls };
