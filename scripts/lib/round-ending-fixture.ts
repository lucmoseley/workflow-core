/*
 * The `needs input:` ending guard-inventory.js passes, and the round comment
 * it parks on (#2843). The hand-off stays a literal, never
 * `buildHandOffComment`'s output, so the guard's test checks the block apart
 * from the code that writes it.
 */

export const ROUND =
	"❓ **Q1** Which parser ships first?\n\n" +
	"(A) The line parser.\nConfidence: 70% (60% - 80%). It has every reader waiting.\n\n" +
	"(B) The block parser.\nConfidence: 30% (20% - 40%). One reader only.\n\n" +
	"Relation: rivals, one release slot.\n\n➡ (A).";
export const NEEDS_INPUT = `${ROUND}\n\nwaits on you:\n- #31 (answer Q1, round posted on the issue)\n\nneeds input: which parser ships first — waits on you: #31`;
export const HAND_OFF =
	"**Hand-off:**\n- Base: abc1234\n- Done: def5678 (the line parser)\n- Left: ship the block parser\n- Blocked on: Q1\n- Uncommitted: none";
/** The round posted on #31 with its hand-off, as the GraphQL comment node. */
export const POSTED = {
	author: { login: "a" },
	body: `${ROUND}\n\n${HAND_OFF}`,
	createdAt: "2026-10-09T00:00:00Z",
	url: "u",
};
