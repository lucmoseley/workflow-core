/**
 * @typedef {"write" | "move" | "command"} RemedyKind
 */

/**
 * @param {string | undefined} tool
 * @returns {RemedyKind}
 */
function remedyKind(tool) {
	if (tool === "Write") return "write";
	if (tool === "Edit" || tool === "NotebookEdit") return "move";
	return "command";
}

module.exports = { remedyKind };
