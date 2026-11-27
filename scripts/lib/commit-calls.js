const {
	asWritten,
	commitPathsArgs,
	gitWords,
	parseCommand,
	walkCommands,
	TEXT_ONLY_PORTS,
} = require("./shell-parse.js");
const {
	commitPathsParse,
	gitValueFlags,
	literal,
	scanFlags,
} = require("./shell-words.js");

/** @typedef {{ call: string, flag: "m" | "F" | "-", word: string }} CommitCall */

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
 * @param {string} call
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
