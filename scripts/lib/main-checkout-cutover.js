/*
 * main-checkout-cutover.js — the session-start step that moves a main checkout
 * still on the shared-tree model to the worktree model (workflow-core#4688, workflow-core#5276).
 *
 * A main checkout not cut over (lib/cutover.js's mark) is one tree every
 * session there shares, with no shared-tree guard and no file-claim refusal
 * (workflow-core#4251, workflow-core#4249). The first session to start while no session stands in it
 * runs the cutover; while one does, the step fails naming each (workflow-core#5247 Q1 (A)).
 * A reading with no `runCutover` reports and never cuts: `npm run status` only
 * reads.
 */

/**
 * @typedef {import("./cutover.js").CutoverResult | { status: "busy" }} RunResult
 *   `busy` where another run holds the cutover
 * @typedef {{ cutOver: () => boolean | null,
 *   runCutover?: () => { result: RunResult, lines: string[] } }} Reading
 *   `cutOver` reads the main checkout's mark, null where git could not
 * @typedef {(
 *   | { outcome: "broken", line: string }
 *   | { outcome: "skip", line: string }
 *   | { outcome: "ok", line: string, lines: string[] }
 *   | { outcome: "fail", tag: "OCCUPIED" | "NOT-CUT-OVER", line: string }
 * )} Judgement `lines` is the cutover's report where this run made it
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
