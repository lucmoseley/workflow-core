// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readStopGuardReason } from "./lib/stop-guard-testkit";
import {
	buildBashCall,
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

const stop = (message: string, transcript?: string) =>
	readStopGuardReason(GUARD, { dir, sid, message, job: false, transcript });

const BLOCKED = "Blocked: the classifier refused `wrangler deploy`.";

const round = ({
	recurrence = "",
	pick = "(A)",
	blocked = BLOCKED,
	a = "I wrap the deploy in `npm run worker:deploy` and you grant it once.",
	b = "You run the deploy by hand.",
	figures = [80, 20],
} = {}) =>
	"❓ **Q1** — Who deploys the Worker?\n\nRelation: rivals\n\n" +
	`(A) ${a}\nConfidence: ${figures[0]}% (70% - 90%). It removes the hand-over.\n\n` +
	`(B) ${b}\nConfidence: ${figures[1]}% (10% - 30%). It is quicker today.\n\n` +
	[blocked, recurrence].filter(Boolean).join("\n") +
	(pick ? `\n\n➡ ${pick}.` : "");

const REFUSED = "has not settled whether the same act was handed to him before";

describe('a "you or me?" round with a Blocked: line', () => {
	it("is refused with no Recurrence: line, naming the line it wants", () => {
		const reason = stop(round());
		expect(reason).toContain(REFUSED);
		expect(reason).toContain("Q1: it carries no `Recurrence:` line.");
		expect(reason).toContain("`Recurrence: none — <the search you ran>`");
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
		["#258, #272 — each ended on a deploy", "#258, #272"],
		["acme/fitness#272 — a deploy", "acme/fitness#272"],
	])(
		"names a match (%s) and recommends the agent-led durable fix: passes",
		(found) => {
			expect(stop(round({ recurrence: `Recurrence: ${found}` }))).toBe("");
		},
	);

	it("names a match and recommends the founder doing it by hand again: refused", () => {
		const reason = stop(
			round({
				recurrence: "Recurrence: #258, #272 — each ended on a deploy",
				pick: "(B)",
				figures: [25, 75],
			}),
		);
		expect(reason).toContain(REFUSED);
		expect(reason).toContain(
			"names an earlier occurrence (#258, #272), yet it recommends (B)",
		);
		expect(reason).toContain("never the recommended one");
	});

	it("with no recommendation line, reads the highest-priced option as recommended", () => {
		const recurrence = "Recurrence: #272 — a deploy";
		expect(stop(round({ recurrence, pick: "", figures: [25, 75] }))).toContain(
			"yet it recommends (B)",
		);
		expect(stop(round({ recurrence, pick: "" }))).toBe("");
	});
});

describe("a round the limb leaves alone", () => {
	it("one with no Blocked: line, which the actor-only limb owns", () => {
		const reason = stop(round({ blocked: "" }));
		expect(reason).toContain("asks the founder who performs an act");
		expect(reason).not.toContain(REFUSED);
	});

	it("one that is not a you-or-me round", () => {
		expect(
			stop(round({ a: "Deploy now.", b: "Deploy after the migration." })),
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
});
