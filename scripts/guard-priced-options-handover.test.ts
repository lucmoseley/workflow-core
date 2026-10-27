// @vitest-environment node
/*
 * The no-round limb's one exemption (#926): a background job's `needs input:`
 * whose only pending item is a founder hand-over closes without a round.
 * Driven through the Stop hook in process, as a background job unless a case
 * says otherwise; the hand-over reading is reached through the turns it lets
 * close.
 *
 * The guard runs at every `Stop` (`self-plugin/hooks/hooks.json`,
 * `hooks/hooks.json`): narrow the exemption and a job handing the founder a
 * paste is refused for want of a round it does not need; widen it and a real
 * question leaves a background job with no round.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readStopGuardReason } from "./lib/stop-guard-testkit";

const GUARD = path.join(__dirname, "guard-priced-options.js");

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "handover-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/* A fresh session per turn, so no case spends another's block allowance. */
const stop = (message: string, { job = true } = {}) =>
	readStopGuardReason(GUARD, {
		dir,
		sid: `handover-${Math.random().toString(36).slice(2)}`,
		message,
		job,
	});

const PREAMBLE =
	"The classifier refused the three edits, so they go through a script you run.\n\n" +
	"Paste this at the prompt:\n\n";
const SEND_BACK_LINE =
	"Once it prints `applied: …`, I'll check the three diffs and close the ticket.";
const MARKER = "needs input: you running the apply script.";

const BARE = `${PREAMBLE}! node .claude/tmp/926/apply.js\n\n${SEND_BACK_LINE}\n\n${MARKER}`;
const FENCED = `${PREAMBLE}\`\`\`\n! node .claude/tmp/926/apply.js\n\`\`\`\n\n${SEND_BACK_LINE}\n\n${MARKER}`;
const NO_HANDOVER =
	"Both commits are in.\n\n" +
	"needs input: whether to fire the sweep now, or leave it to 01:00 UTC.";
const LETTERED =
	`${PREAMBLE}! node .claude/tmp/926/apply.js\n\n` +
	"(A) Run it now.\nConfidence: 85% (75% - 95%). One command.\n\n" +
	"(B) Hold it.\nConfidence: 15% (5% - 25%). Only if you want to read it.\n\n" +
	`${SEND_BACK_LINE}\n\n${MARKER}`;
const NO_SEND_BACK = `${PREAMBLE}! node .claude/tmp/926/apply.js\n\n${MARKER}`;

const REFUSED = "round above it";

describe("a `needs input:` ending in a founder hand-over (#926)", () => {
	it("allows a bare `!` line followed by a send-back line", () => {
		expect(stop(BARE)).toBe("");
	});

	it("allows the command inside a fenced block", () => {
		expect(stop(FENCED)).toBe("");
	});

	it("refuses one with no hand-over, naming the round it owes and the hand-over escape", () => {
		const reason = stop(NO_HANDOVER);
		expect(reason).toContain("with no `❓ **Qn**` round above it");
		expect(reason).toContain("a single founder act is not a decision");
	});

	it("refuses lettered options beside a `!` line that passes without them", () => {
		const unlettered = LETTERED.replace(
			/^\([AB]\)[^\n]*\nConfidence:[^\n]*\n\n/gm,
			"",
		);
		expect(unlettered).not.toMatch(/\([AB]\)/);
		expect(stop(unlettered)).toBe("");
		expect(stop(LETTERED)).toContain(REFUSED);
	});

	it("refuses letters put in prose or bullets beside a `!` line, for want of a round above it", () => {
		for (const options of [
			"Either run it now (A) or hold it (B).",
			"- (A) run it now\n- (B) hold it",
		]) {
			const text = `${PREAMBLE}! node apply.js\n\n${options}\n\n${SEND_BACK_LINE}\n\n${MARKER}`;
			expect(stop(text)).toContain(REFUSED);
		}
	});

	it("refuses a `!` line with no send-back line after it, asking for a round above it", () => {
		expect(stop(NO_SEND_BACK)).toContain(REFUSED);
	});

	it("refuses a send-back line that sits above the act rather than after it, saying no round sits above it", () => {
		const text = `${SEND_BACK_LINE}\n\n! node .claude/tmp/926/apply.js\n\n${MARKER}`;
		expect(stop(text)).toContain(REFUSED);
	});

	it("says nothing in a foreground session, for each named fixture", () => {
		for (const text of [BARE, FENCED, NO_HANDOVER, LETTERED, NO_SEND_BACK])
			expect(stop(text, { job: false })).toBe("");
	});
});

/* What counts as a hand-over, read off whether the job may close on it:
 * `closes` is the exemption granted, a refusal is the act or its send-back
 * not read. */
describe("the hand-over's shape", () => {
	const ending = (text: string) => stop(`${text}\n\n${MARKER}`);
	const closes = (text: string) => expect(ending(text)).toBe("");
	const refused = (text: string) => expect(ending(text)).toContain(REFUSED);

	it("reads a fenced block of literal text as an act", () => {
		closes(
			"Put this in the dashboard's redirect field:\n\n```\nhttps://example.com/cb\n```\n\nThen tell me what it shows.",
		);
	});

	it("never reads a send-back phrase inside the fence as the send-back", () => {
		refused("```\n! node apply.js\nI'll check the output\n```");
	});

	it("reads nothing inside a fence that never closes as an act", () => {
		refused("```\n! node apply.js\n\nLet me know.");
	});

	it("does not read a Markdown image as a `!` line", () => {
		refused("![diagram](d.png)\n\nLet me know.");
	});

	it("reads an inline-coded `!` line as an act", () => {
		closes("`! npm run status`\n\nLet me know.");
	});

	it("reads no send-back inside a fence opened after the act", () => {
		refused("! node apply.js\n\n```\nLet me know.");
	});

	/* One phrasing per `SEND_BACK` alternative, so dropping any one turns its
	 * own case red. */
	it.each([
		"Send the output back here.",
		"Let me know when it is done.",
		"Once it prints `applied`, carry on.",
		"I'll check the three diffs.",
	])("reads %j as a send-back", (sendBack) => {
		closes(`! node apply.js\n\n${sendBack}`);
	});
});
