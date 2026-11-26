// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readStopGuardReason } from "./lib/stop-guard-testkit";
import {
	buildBashCall,
	failOpenLog,
	researchCalls,
	transcriptRecords,
	writeTranscript,
} from "./lib/transcript-testkit";

const GUARD = path.join(__dirname, "guard-priced-options.js");
const { reset, founder } = transcriptRecords("2026-11-26T10:00:00Z");

let dir: string;
let sid: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "recurrence-"));
	sid = `recurrence-${Math.random().toString(36).slice(2)}`;
	reset();
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const unread = () => path.join(dir, "absent.jsonl");

const stop = (message: string, transcript = unread()) =>
	readStopGuardReason(GUARD, { dir, sid, message, job: false, transcript });

const BLOCKED = "Blocked: the classifier refused `wrangler deploy`.";
const DURABLE =
	"You grant `Bash(npm run worker:*)` once; I script the deploy behind it.";
const MANUAL = "You run the deploy by hand.";

const round = ({
	recurrence = "",
	pick = "➡ (A).",
	blocked = BLOCKED,
	a = DURABLE,
	b = MANUAL,
	figures = [80, 20],
} = {}) =>
	"❓ **Q1** — Who deploys the Worker?\n\nRelation: rivals\n\n" +
	`(A) ${a}\nConfidence: ${figures[0]}% (${figures[0] - 10}% - ${figures[0] + 10}%). It removes the hand-over.\n\n` +
	`(B) ${b}\nConfidence: ${figures[1]}% (${figures[1] - 10}% - ${figures[1] + 10}%). It is quicker today.\n\n` +
	[blocked, recurrence].filter(Boolean).join("\n") +
	(pick ? `\n\n${pick}` : "");

const REFUSED = "has not settled whether the same act was handed to him before";
const MATCH = "Recurrence: #258, #272 — (B) repeats it";

describe("a round carrying a Blocked: line", () => {
	it("is refused with no Recurrence: line, printing the rule", () => {
		const reason = stop(round());
		expect(reason).toContain(REFUSED);
		expect(reason).toContain("Q1: it carries no `Recurrence:` line.");
		expect(reason).toContain("A RECURRING HAND-OVER IS FIXED, NOT REPEATED");
	});

	it.each([
		"Recurrence: none — searched closed issues for `wrangler deploy`.",
		"**Recurrence:** none found",
	])("passes on a Recurrence: line that found nothing: %s", (recurrence) => {
		expect(stop(round({ recurrence }))).toBe("");
	});

	it("is refused on a Recurrence: line that neither says none nor names an issue", () => {
		expect(stop(round({ recurrence: "Recurrence: checked." }))).toContain(
			"neither opens `none` nor names an earlier issue",
		);
	});

	it.each([
		["#258, #272 — (B) repeats it", "#258, #272"],
		["acme/fitness#272 — (B) repeats it", "acme/fitness#272"],
		["health-and-fitness#272 — (B) repeats it", "health-and-fitness#272"],
		["#272's deploy — (B) repeats it", "#272"],
	])("passes where it names %s and recommends the durable fix", (found) => {
		expect(stop(round({ recurrence: `Recurrence: ${found}` }))).toBe("");
	});

	it("is refused where it names an earlier issue but no repeating option", () => {
		expect(
			stop(round({ recurrence: "Recurrence: #272 — a deploy" })),
		).toContain(
			"names an earlier occurrence (#272) but not the option that repeats the hand-over",
		);
	});

	it("is refused where it recommends the option it names as repeating the hand-over", () => {
		const reason = stop(
			round({ recurrence: MATCH, pick: "➡ (B).", figures: [25, 75] }),
		);
		expect(reason).toContain(
			"names an earlier occurrence (#258, #272), yet it recommends (B), the option that repeats the hand-over",
		);
	});

	it("reads a prose recommendation naming both options as the higher-priced one", () => {
		expect(
			stop(round({ recurrence: MATCH, pick: "I recommend (A) over (B)." })),
		).toBe("");
	});

	it("with no recommendation line, reads the highest-priced option as recommended", () => {
		expect(
			stop(round({ recurrence: MATCH, pick: "", figures: [25, 75] })),
		).toContain("yet it recommends (B)");
		expect(stop(round({ recurrence: MATCH, pick: "" }))).toBe("");
	});

	it.each([
		["an agent-led manual route", DURABLE, "I hand you the commands to paste."],
		["founder-led options only", DURABLE, MANUAL],
	])("checks %s too", (_case, a, b) => {
		expect(
			stop(
				round({ recurrence: MATCH, a, b, pick: "➡ (B).", figures: [25, 75] }),
			),
		).toContain("yet it recommends (B)");
	});
});

describe("a round with no Blocked: line", () => {
	it("is left to the actor-only limb, which refuses it", () => {
		const reason = stop(round({ blocked: "", a: "I script the deploy." }));
		expect(reason).toContain("asks the founder who performs an act");
		expect(reason).not.toContain(REFUSED);
	});

	it("passes when it is not a you-or-me round", () => {
		expect(
			stop(round({ blocked: "", a: "Deploy now.", b: "Deploy later." })),
		).toBe("");
	});
});

describe("the closed-issue search it stands on", () => {
	const recurrence = "Recurrence: none — searched closed issues for deploys.";
	const transcriptWith = (...commands: string[]) => {
		const file = path.join(dir, "transcript.jsonl");
		writeTranscript(
			file,
			founder(),
			...researchCalls().map((c) => JSON.stringify(c)),
			...commands.map((c, i) =>
				JSON.stringify(
					buildBashCall(c, `s${i}`, { timestamp: "2026-11-26T11:00:00Z" }),
				),
			),
		);
		return file;
	};

	it("is refused where the session ran no closed-issue search", () => {
		expect(stop(round({ recurrence }), transcriptWith())).toContain(
			"stands on no search of closed issues this session",
		);
	});

	it.each([
		"gh search issues --state closed 'wrangler deploy'",
		"gh issue list --state closed --search 'migration'",
	])("passes once the session ran %s", (command) => {
		expect(stop(round({ recurrence }), transcriptWith(command))).toBe("");
	});

	it("does not count a search of open issues", () => {
		expect(
			stop(
				round({ recurrence }),
				transcriptWith("gh search issues --state open deploy"),
			),
		).toContain("stands on no search of closed issues");
	});

	it("takes the line on its word where the transcript cannot be read, and logs it", () => {
		const config = path.join(dir, "config");
		const unreadable = path.join(dir, "a-directory.jsonl");
		fs.mkdirSync(unreadable);
		expect(stop(round({ recurrence }), unreadable)).toBe("");
		expect(failOpenLog(config)).toContain("Recurrence: taken on its word");
	});
});

describe("its budget", () => {
	it("stops at its own cap of 3", () => {
		const bad = round();
		for (let i = 0; i < 3; i++) expect(stop(bad)).toContain(REFUSED);
		expect(stop(bad)).toBe("");
	});
});
