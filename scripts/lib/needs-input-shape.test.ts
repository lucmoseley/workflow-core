// @vitest-environment node
/*
 * needs-input-shape.test.ts — the checklist of every piece a `needs input:`
 * ending owes (#4206), and the once-a-turn claim the two Stop guards share.
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

interface Piece {
	id: string;
	state: "met" | "missing" | "unjudged";
	waitsOn?: string;
	how: string;
}
type Kind = "round" | "handover" | "pointer" | "hold" | "prose";
const shape = createRequire(__filename)("./needs-input-shape.js") as {
	CLAIM_PREFIX: string;
	owedPieces: (
		message: string,
		kind: Kind,
		judged?: Record<string, "met" | "missing">,
	) => Piece[];
	parkKind: (message: string, payload: string, transcript?: string) => Kind;
	shareChecklist: (turn: {
		sessionId: string;
		message: string;
		kind: Kind;
		judged?: Record<string, "met" | "missing">;
	}) => string;
};

const ROUND =
	"❓ **Q1** Which parser?\n\nRelation: rivals.\n\n(A) Line.\nConfidence: 70% (60% - 80%). Readers.\n\n(B) Block.\nConfidence: 30% (20% - 40%). One.\n\n➡ (A).";
const PARKED = `${ROUND}\n\nwaits on you:\n- #31 (answer Q1, round posted on the issue)\n\nneeds input: which parser — waits on you: #31`;
const BARE = "Done.\n\nneeds input: which parser";

const states = (pieces: Piece[]) =>
	Object.fromEntries(pieces.map((p) => [p.id, p.state]));

describe("parkKind", () => {
	it("reads a round, a hand-over and prose apart", () => {
		expect(shape.parkKind(PARKED, "which parser")).toBe("round");
		expect(
			shape.parkKind(
				"Run this:\n\n! gh auth login\n\nSend back what it prints.\n\nneeds input: the login",
				"the login",
			),
		).toBe("handover");
		expect(shape.parkKind(BARE, "which parser")).toBe("prose");
	});

	it("voids the hand-over on a letter", () => {
		expect(
			shape.parkKind(
				"(A) or (B)?\n\n! gh auth login\n\nSend back what it prints.\n\nneeds input: x",
				"x",
			),
		).toBe("prose");
	});
});

describe("owedPieces", () => {
	it("shows a bare prose ending every piece missing or not yet judged, none met", () => {
		const pieces = shape.owedPieces(BARE, "prose");
		expect(pieces.map((p) => p.id)).toEqual([
			"research",
			"round",
			"posted",
			"claimed",
			"hand-off",
			"block",
			"status",
			"practice",
		]);
		expect(states(pieces)).toEqual({
			research: "unjudged",
			round: "missing",
			posted: "unjudged",
			claimed: "unjudged",
			"hand-off": "unjudged",
			block: "missing",
			status: "missing",
			practice: "unjudged",
		});
		const research = pieces.find((p) => p.id === "research");
		expect(research?.waitsOn).toBe("once the round is written");
	});

	it("names what each unjudged piece waits on, the guard that judges it where nothing gates it", () => {
		const pieces = shape.owedPieces(PARKED, "round", { block: "met" });
		const waits = Object.fromEntries(pieces.map((p) => [p.id, p.waitsOn]));
		expect(waits.posted).toContain("guard-inventory.js");
		expect(waits.claimed).toBe("once the round is posted on that issue");
		expect(waits.practice).toContain("outside this repo");
	});

	it("lets the message's own gap beat a guard's met", () => {
		expect(
			states(shape.owedPieces(BARE, "prose", { block: "met" })).block,
		).toBe("missing");
	});

	it("owes a pointer park no round and no research", () => {
		const ids = shape.owedPieces(PARKED, "pointer").map((p) => p.id);
		expect(ids).toEqual(["pointer", "hand-off", "block", "status", "practice"]);
		expect(states(shape.owedPieces(PARKED, "pointer")).pointer).toBe("met");
	});
});

describe("shareChecklist, once a turn", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "needs-input-shape-"));
		vi.stubEnv("WFC_REPO_ROOT", dir);
		vi.stubEnv("CLAUDE_PROJECT_DIR", dir);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	const turn = { sessionId: "s1", message: BARE, kind: "prose" as Kind };

	it("prints the checklist to the first guard and a pointer to the second", () => {
		expect(shape.shareChecklist(turn)).toContain(
			"EVERY PIECE THIS `needs input:` ENDING OWES",
		);
		const second = shape.shareChecklist(turn);
		expect(second).toContain("in the other Stop refusal this turn");
		expect(second).not.toContain("EVERY PIECE");
	});

	it("prints it afresh for another message, and for the same one re-sent after the claim lapses", () => {
		shape.shareChecklist(turn);
		expect(
			shape.shareChecklist({ ...turn, message: `${BARE} again` }),
		).toContain("EVERY PIECE");
		const markers = path.join(dir, ".claude", "tmp", "markers");
		const claims = fs
			.readdirSync(markers)
			.filter((f) => f.startsWith(`${shape.CLAIM_PREFIX}s1-`));
		expect(claims).toHaveLength(2);
		expect(shape.shareChecklist(turn)).not.toContain("EVERY PIECE");
		const old = new Date(Date.now() - 60_000);
		for (const claim of claims)
			fs.utimesSync(path.join(markers, claim), old, old);
		expect(shape.shareChecklist(turn)).toContain("EVERY PIECE");
		expect(shape.shareChecklist(turn)).not.toContain("EVERY PIECE");
	});
});
