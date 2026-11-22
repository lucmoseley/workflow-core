/**
 * @typedef {import("./cutover.js").CutoverResult | { status: "busy" }} RunResult
 * @typedef {{ cutOver: () => boolean | null,
 *   runCutover?: () => { result: RunResult, lines: string[] } }} Reading
 * @typedef {(
 *   | { outcome: "broken", line: string }
 *   | { outcome: "skip", line: string }
 *   | { outcome: "ok", line: string, lines: string[] }
 *   | { outcome: "fail", tag: "OCCUPIED" | "NOT-CUT-OVER", line: string }
 * )} Judgement
 */

/**
 * @param {Reading} r
 * @returns {Judgement}
 */
function judgeCutover(r) {
	const cutOver = r.cutOver();
	if (cutOver === null)
		return {
			outcome: "broken",
			line: "git could not read whether the main checkout is cut over.",
		};
	if (cutOver)
		return {
			outcome: "ok",
			line: "the main checkout is cut over, so each session works its own worktree.",
			lines: [],
		};
	if (!r.runCutover)
		return {
			outcome: "fail",
			tag: "NOT-CUT-OVER",
			line: "the main checkout is not cut over, so every session there shares one unguarded tree; the next session to start with none standing in it cuts it over.",
		};
	const { result, lines } = r.runCutover();
	switch (result.status) {
		case "busy":
			return {
				outcome: "skip",
				line: "another session is cutting the main checkout over now.",
			};
		case "cut-over":
			return {
				outcome: "ok",
				line: "cut the main checkout over, so each session works its own worktree.",
				lines,
			};
		case "occupied":
			return {
				outcome: "fail",
				tag: "OCCUPIED",
				line: `the main checkout is not cut over, so every session there shares one unguarded tree, and ${result.sessions.length} session(s) stand in it: ${result.sessions.join(", ")}. End each, or move it to its own worktree; the next session to start with none there cuts it over.`,
			};
		default:
			return {
				outcome: "fail",
				tag: "NOT-CUT-OVER",
				line: `the main checkout is not cut over, so every session there shares one unguarded tree, and its cutover refused: ${lines.join(" ")}`,
			};
	}
}

module.exports = { judgeCutover };
