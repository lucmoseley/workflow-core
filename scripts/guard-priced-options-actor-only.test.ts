// @vitest-environment node
/*
 * The eighteenth refusal (#598): a round offering one option the founder
 * performs and another the agent performs, naming no `Blocked:` line. Driven
 * through the guard's Stop entry in process, by `lib/stop-guard-testkit`, so
 * its block counters land in the temp directory rather than spending the real
 * repo's allowance. It runs at every `Stop` (`self-plugin/hooks/hooks.json`,
 * `hooks/hooks.json`). A break here lets "shall I do it
 * or will you?" reach the founder again, or refuses a round that named its
 * block.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readStopGuardReason } from "./lib/stop-guard-testkit";

const GUARD = path.join(__dirname, "guard-priced-options.js");

let dir: string;
let sid: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "actor-only-"));
	sid = `actor-only-${Math.random().toString(36).slice(2)}`;
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/** The refusal the guard writes for `message`, or "" where it allows the stop. */
const stop = (message: string, { job = false } = {}) =>
	readStopGuardReason(GUARD, { dir, sid, message, job });

/** A well-formed round of two rivals, with `extra` lines before the arrow. */
const round = (
	a: string,
	b: string,
	{ extra = "", relation = "rivals", n = 1 } = {},
) =>
	`❓ **Q${n}** — Who merges it?\n\nRelation: ${relation}\n\n` +
	`(A) ${a}\nConfidence: 80% (70% - 90%). It is cheap.\n\n` +
	`(B) ${b}\nConfidence: 20% (10% - 30%). It is slower.\n\n` +
	`${extra ? `${extra}\n\n` : ""}➡ (A).`;

const REFUSED = "asks the founder who performs an act";

describe("a round with a founder-led and an agent-led option", () => {
	it.each([
		["You", "I"],
		["You", "I'll"],
		["You", "I’ll"],
		["You", "I'd"],
		["You", "I'm"],
		["Founder", "Me"],
		["You", "Let me"],
		["You", "The agent"],
		["You", "This session"],
	])(
		"%s against %s, with no Blocked: line, is refused naming both",
		(theirs, ours) => {
			const reason = stop(
				round(`${ours} merge the branch.`, `${theirs} merge the branch.`),
			);
			expect(reason).toContain(REFUSED);
			expect(reason).toContain(
				`Q1: (B) “${theirs} merge the branch.” against (A) “${ours.replace("’", "'")} merge the branch.”`,
			);
		},
	);

	it("recognises the founder by the name the config declares, whole or first", () => {
		fs.mkdirSync(path.join(dir, ".claude"));
		fs.writeFileSync(
			path.join(dir, ".claude", "workflow-core.json"),
			JSON.stringify({ contract: 1, founder: "Ada Lovelace" }),
		);
		for (const name of ["Ada Lovelace", "Ada"])
			expect(stop(round("I merge it.", `${name} merges it.`), {})).toContain(
				REFUSED,
			);
		expect(stop(round("I merge it.", "Adam merges it."))).toBe("");
	});

	it.each([
		"Blocked: the guard denied `git merge` in the shared tree.",
		"**Blocked:** a login only you can do.",
		"**Blocked**: a click on a page I cannot reach.",
	])("passes with a non-empty Blocked: line: %s", (line) => {
		expect(stop(round("I merge it.", "You merge it.", { extra: line }))).toBe(
			"",
		);
	});

	it.each(["Blocked:", "**Blocked:**"])(
		"is still refused with an empty %s",
		(line) => {
			expect(
				stop(round("I merge it.", "You merge it.", { extra: line })),
			).toContain(REFUSED);
		},
	);
});

describe("a round the limb leaves alone", () => {
	it.each([
		["only the agent leads", "I merge it.", "I leave it for a later session."],
		["only the founder leads", "You merge it.", "You leave it."],
		["neither leads", "Merge it now.", "Leave it."],
		["the lead is another word", "It merges cleanly.", "Your call on timing."],
		[
			"the agent option drops the act",
			"You commit it.",
			"I revert both edits.",
		],
		["the agent option drops it as I'd", "You commit it.", "I'd leave it."],
		[
			"the agent option drops it as Let me",
			"You commit it.",
			"Let me revert it.",
		],
		["the agent option drops it as I’ll", "You commit it.", "I’ll revert it."],
	])("passes where %s", (_case, a, b) => {
		expect(stop(round(a, b))).toBe("");
	});

	it("passes where its options are declared combinable", () => {
		expect(
			stop(
				round("You decide on the cards.", "I close the container.", {
					relation: "independent, so take any combination",
				}),
			),
		).toBe("");
	});
});

describe("the refusal", () => {
	const reason = () => stop(round("I merge it.", "You merge it."));

	it("says to act and report, gives the Blocked: escape and asks for the question alone", () => {
		const text = reason();
		expect(text).toMatch(/^A Stop guard refused this turn/);
		expect(text).toContain("act, then report what you did");
		expect(text).toContain("`Blocked: <the refusal you hit");
		expect(text).toContain("A preference to ask first is not a block.");
		expect(text.match(/Blocked: <the refusal you hit/g)).toHaveLength(1);
		expect(text).toContain("A FOUNDER HAND-OVER");
		expect(text).toMatch(
			/RE-SEND ONLY THE CORRECTED QUESTION, not the whole round\.$/,
		);
	});

	it("names every flagged round", () => {
		const text = stop(
			`${round("I merge it.", "You merge it.")}\n\n` +
				round("Let me push it.", "You push it.", { n: 2 }),
		);
		expect(text).toContain("Q1: (B)");
		expect(text).toContain("Q2: (B)");
	});
});

describe("beside the founder-act refusal (#597)", () => {
	const both = round("I merge it.", "You paste `! git merge <branch>`.");

	it("still reads the founder option's literal text, printing the hand-over once", () => {
		const text = stop(both);
		expect(text).toContain(REFUSED);
		expect(text).toContain("Q1 (B): placeholder");
		expect(text.match(/A FOUNDER HAND-OVER/g)).toHaveLength(1);
		expect(text.match(/A Stop guard refused this turn/g)).toHaveLength(1);
	});

	it("still refuses the placeholder where a Blocked: line clears this limb, naming the question and option", () => {
		const text = stop(
			round("I merge it.", "You paste `! git merge <branch>`.", {
				extra: "Blocked: the guard denied `git merge` in the shared tree.",
			}),
		);
		expect(text).not.toContain(REFUSED);
		expect(text).toContain("Q1 (B): placeholder");
	});
});

describe("its budget", () => {
	const bad = round("I merge it.", "You merge it.");

	it("stops at its own cap of 3", () => {
		for (let i = 0; i < 3; i++) expect(stop(bad)).toContain(REFUSED);
		expect(stop(bad)).toBe("");
	});

	it("reports beside another shape defect in one block", () => {
		const text = stop(bad.replace(" (70% - 90%)", ""));
		expect(text).toContain(REFUSED);
		expect(text).toContain("bare percentage");
		expect(text.match(/A Stop guard refused this turn/g)).toHaveLength(1);
	});

	it("counts towards the session ceiling and never spends its reserved last block", () => {
		const marked = `${bad}\n\nneeds input: who merges it`;
		const unpriced =
			"❓ **Q2** — Which?\n\nRelation: rivals\n\n(A) x\n\n(B) y\n\n➡ (A).\n\nneeds input: which";
		expect(stop(unpriced, { job: true })).toContain("no Confidence line");
		expect(stop(unpriced, { job: true })).toContain("no Confidence line");
		expect(stop(marked, { job: true })).toContain(REFUSED);
		expect(stop(marked, { job: true })).toContain(REFUSED);
		/* Four blocks spent: the fifth is the filing checks'. */
		expect(stop(marked, { job: true })).toBe("");
		expect(stop("Done.", { job: true })).toContain(
			"carrying neither status marker",
		);
	});
});
