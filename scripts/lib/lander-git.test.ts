// @vitest-environment node
/*
 * lib/lander-git.js's reading of what the gates refusing a merge said
 * (#4800).
 *
 * Loosen it and a fix ticket shows a gate's remedy with its reason cut off:
 * the session taking the ticket replays the merge to learn which row went
 * stale and why (#4793).
 */
import { expect, it } from "vitest";
import { parseGateRefusal } from "./lander-git.js";

const rules = (n: number) =>
	Array.from({ length: n }, (_, i) => `  rule:  docs/x.md:${i}  **Rule ${i}**`);

it("keeps a refusal shorter than its tail whole, colour stripped and blank lines dropped", () => {
	expect(
		parseGateRefusal(
			"OK: a linked worktree\n\n\u001b[31mSTALE-PROSE\u001b[0m gated.txt  \nrun: re-anchor\n",
		),
	).toBe("OK: a linked worktree\nSTALE-PROSE gated.txt\nrun: re-anchor");
});

it("keeps every row a merge did not carry and its reason, however far from the end, marking each run of lines left out", () => {
	const said = parseGateRefusal(
		[
			"OK: a linked worktree",
			"STALE-PROSE  scripts/a.js",
			...rules(30),
			"no row carried across this merge: the anchors file conflicts.",
			"not carried scripts/a.js — both sides changed scripts/lib/x.js.",
			"not carried scripts/b.js — it is not fresh on HEAD.",
			"carried scripts/c.js across the merge, anchored 0123: each side changed different files of its closure (#4514).",
			...rules(50),
			"FAIL: 2 fault(s) this commit adds",
		].join("\n"),
	).split("\n");

	expect(said.slice(0, 6)).toEqual([
		"[…]",
		"no row carried across this merge: the anchors file conflicts.",
		"not carried scripts/a.js — both sides changed scripts/lib/x.js.",
		"not carried scripts/b.js — it is not fresh on HEAD.",
		"[…]",
		"  rule:  docs/x.md:11  **Rule 11**",
	]);
	expect(said).toHaveLength(5 + 40);
	expect(said.at(-1)).toBe("FAIL: 2 fault(s) this commit adds");
});

it("keeps each fault a commit adds, under the line that opens their list, and an earlier gate's FAIL", () => {
	const said = parseGateRefusal(
		[
			"FAIL: an earlier gate's verdict",
			"The fault(s) below are NOT in HEAD — this commit adds them:",
			"  findings: scripts/a.js — the guard changed since the last review",
			"  HEAD had 3, so this commit adds 1.",
			"This commit leaves the guard-registry anchor(s) above expired (#2617).",
			...rules(45),
		].join("\n"),
	).split("\n");

	expect(said.slice(0, 5)).toEqual([
		"FAIL: an earlier gate's verdict",
		"The fault(s) below are NOT in HEAD — this commit adds them:",
		"  findings: scripts/a.js — the guard changed since the last review",
		"  HEAD had 3, so this commit adds 1.",
		"[…]",
	]);
});

it("cuts a verdict line ahead of the tail to 300 characters, and leaves the tail's lines whole", () => {
	const long = `not carried scripts/a.js — ${"x".repeat(400)}`;
	const said = parseGateRefusal([long, ...rules(40), long].join("\n")).split(
		"\n",
	);

	expect(said[0]).toBe(`${long.slice(0, 299)}…`);
	expect(said.at(-1)).toBe(long);
});
