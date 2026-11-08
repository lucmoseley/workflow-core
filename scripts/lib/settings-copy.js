/*
 * settings-copy.js — builds the pattern that finds one global file's versioned
 * copy in docs/claude-user-settings.md.
 *
 * The files under ~/.claude are versioned as BEGIN/END-marked fenced blocks in
 * that doc (workflow-core#2174). The drift check compares each block against the live file,
 * and both global hooks' tests run the doc's copy, so all three read a block
 * through this one pattern (workflow-core#2324).
 */
/**
 * The pattern matching the doc block holding one file's copy; its first group
 * is the file.
 * @param {string} name the file's name, as its BEGIN and END markers spell it
 * @param {string} fence the opening fence, info string included
 */
const copyBlockPattern = (name, fence) => {
	const n = name.replace(/\./g, "\\.");
	const open = fence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const close = fence.replace(/[^`]/g, "");
	return new RegExp(
		`<!-- BEGIN ${n} -->\\n${open}\\n([\\s\\S]*?)\\n${close}\\n<!-- END ${n} -->`,
	);
};

module.exports = { copyBlockPattern };
