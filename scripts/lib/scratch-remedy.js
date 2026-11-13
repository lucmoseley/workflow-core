/*
 * scratch-remedy.js — which remedy a scratch-path refusal hands the tool it
 * refused (workflow-core#2789). The job-dir and root-scratch cores each word it their own
 * way; the tool set is this file's.
 */

/**
 * @typedef {"write" | "move" | "command"} RemedyKind
 */

/**
 * `write` for a Write, re-aimed as it stands; `move` for an Edit or
 * NotebookEdit, which needs the file to exist where it is aimed, so it moves
 * first; `command` for anything else, a Bash call that may write by any
 * spelling, so it is handed the target alone.
 * @param {string | undefined} tool
 * @returns {RemedyKind}
 */
function remedyKind(tool) {
	if (tool === "Write") return "write";
	if (tool === "Edit" || tool === "NotebookEdit") return "move";
	return "command";
}

module.exports = { remedyKind };
