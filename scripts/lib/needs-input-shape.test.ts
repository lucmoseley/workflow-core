// @vitest-environment node
/*
 * needs-input-shape.test.ts — the checklist of every piece a `needs input:`
 * ending owes (#4206), and the once-a-turn claim the two Stop guards share.
 *
 * Run in-process on plain strings. Each case points `WFC_REPO_ROOT` and
 * `CLAUDE_PROJECT_DIR` at a temp directory, so the claim markers land there
 * and never in the shared tree; a lapsed claim is seeded by ageing its file's
 * mtime rather than by waiting out the window. A fresh session id per case
 * keeps each first call the claimant.
 *
 * WHAT BREAKING IT COSTS: a session refused at `needs input:` goes back to
 * finding the shape one refusal at a time, a turn and a post per piece, or
 * reads the checklist twice, or neither guard prints it.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Kind = "round" | "handover" | "pointer" | "hold" | "prose";
const shape = createRequire(__filename)("./needs-input-shape.js") as {
	parkKind: (message: string, payload: string, transcript?: string) => Kind;
	shareChecklist: (turn: {
		sessionId: string;
		message: string;
		payload: string;
		transcript?: string;
		judged?: Record<string, "met" | "missing">;
	}) => string;
};

const ROUND =
	"❓ **Q1** Which parser?\n\nRelation: rivals.\n\n(A) Line.\nConfidence: 70% (60% - 80%). Readers.\n\n(B) Block.\nConfidence: 30% (20% - 40%). One.\n\n➡ (A).";
const PARKED = `${ROUND}\n\nwaits on you:\n- #31 (answer Q1, round posted on the issue)\n\nneeds input: which parser — waits on you: #31`;
const BARE = "Done.\n\nneeds input: which parser";
const HANDOVER =
	"Run this:\n\n! gh auth login\n\nSend back what it prints.\n\nneeds input: the login";
const HEAD = "EVERY PIECE THIS `needs input:` ENDING OWES";
const CLAIM_PREFIX = ".needs-input-checklist-";

let dir: string;
let n = 0;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "needs-input-shape-"));
	vi.stubEnv("WFC_REPO_ROOT", dir);
	vi.stubEnv("CLAUDE_PROJECT_DIR", dir);
});
afterEach(() => {
	vi.unstubAllEnvs();
	fs.rmSync(dir, { recursive: true, force: true });
});

/** The checklist a first claimant prints for `message`. */
const checklist = (
	message: string,
	judged?: Record<string, "met" | "missing">,
) =>
	shape.shareChecklist({
		sessionId: `s${String(++n)}`,
		message,
		payload: message.slice(message.lastIndexOf("needs input:") + 12),
		judged,
	});

/** Each piece's state as the checklist prints it, in its order. */
const states = (text: string) =>
	Object.fromEntries(
		[
			...text.matchAll(
				/^\d+\. \*\*([a-z-]+)\*\* — (met|MISSING|not yet judged)/gm,
			),
		].map((m) => [m[1], m[2]]),
	);

describe("parkKind", () => {
	it("reads a round, a hand-over and prose apart", () => {
		expect(shape.parkKind(PARKED, "which parser")).toBe("round");
		expect(shape.parkKind(HANDOVER, "the login")).toBe("handover");
		expect(shape.parkKind(BARE, "which parser")).toBe("prose");
	});

	it("voids the hand-over on a letter", () => {
		expect(shape.parkKind(`(A) or (B)?\n\n${HANDOVER}`, "the login")).toBe(
			"prose",
		);
	});
});

describe("the checklist", () => {
	it("shows a bare prose ending every piece missing or not yet judged, none met, in writing order", () => {
		const text = checklist(BARE);
		expect(text).toContain(HEAD);
		expect(Object.entries(states(text))).toEqual([
			["research", "not yet judged"],
			["round", "MISSING"],
			["posted", "not yet judged"],
			["claimed", "not yet judged"],
			["hand-off", "not yet judged"],
			["block", "MISSING"],
			["status", "MISSING"],
			["practice", "not yet judged"],
		]);
		expect(text).toContain(
			"**research** — not yet judged (once the round is written)",
		);
	});

	it("names what each unjudged piece waits on, the guard that judges it where nothing gates it", () => {
		const text = checklist(PARKED, { block: "met" });
		expect(text).toMatch(
			/\*\*posted\*\* — not yet judged \(guard-inventory\.js/,
		);
		expect(text).toContain(
			"**claimed** — not yet judged (once the round is posted on that issue)",
		);
		expect(text).toMatch(
			/\*\*practice\*\* — not yet judged \(the practice Stop hook outside this repo/,
		);
	});

	it("lets the message's own gap beat a guard's met", () => {
		expect(states(checklist(BARE, { block: "met" })).block).toBe("MISSING");
	});

	it("owes a hand-over no round and no research", () => {
		const shown = states(checklist(HANDOVER));
		expect(Object.keys(shown)).toEqual([
			"act",
			"hand-off",
			"block",
			"status",
			"practice",
		]);
		expect(shown.act).toBe("met");
	});
});

describe("once a turn", () => {
	const turn = { sessionId: "s0", message: BARE, payload: " which parser" };

	it("prints the checklist to the first guard and a pointer to the second", () => {
		expect(shape.shareChecklist(turn)).toContain(HEAD);
		const second = shape.shareChecklist(turn);
		expect(second).toContain("in the other Stop refusal this turn");
		expect(second).not.toContain(HEAD);
	});

	it("prints it afresh for another message, and for the same one re-sent after the claim lapses", () => {
		shape.shareChecklist(turn);
		expect(
			shape.shareChecklist({ ...turn, message: `${BARE} again` }),
		).toContain(HEAD);
		const markers = path.join(dir, ".claude", "tmp", "markers");
		const claims = fs
			.readdirSync(markers)
			.filter((f) => f.startsWith(`${CLAIM_PREFIX}s0-`));
		expect(claims).toHaveLength(2);
		expect(shape.shareChecklist(turn)).not.toContain(HEAD);
		const old = new Date(Date.now() - 60_000);
		for (const claim of claims)
			fs.utimesSync(path.join(markers, claim), old, old);
		expect(shape.shareChecklist(turn)).toContain(HEAD);
		expect(shape.shareChecklist(turn)).not.toContain(HEAD);
	});
});
