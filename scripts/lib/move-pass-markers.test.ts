// @vitest-environment node
/*
 * Pins whose pass markers a refill-loop copy takes at its resume (#4105). Too
 * loose and a session passes its gates on another live session's review; too tight
 * and a resume re-runs a pass it finished. That a real tick calls this is in
 * refill-loop-run.test.ts, and that a gate reads the result in
 * concision-backstop.test.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAgentsBranch, buildJobRow, type Row } from "./agents-stop-fake";
import { writeClaudeStub } from "./claude-stub";
import { mkScratchDir } from "./git-fixture";
import { MARKERS_REL } from "./marker-root.js";
import { movePassMarkers } from "./move-pass-markers.js";

const FROM = "past-session";
const TO = "copy-session";
const CONCISION = ".concision-pass-";
const REVIEW = ".codereview-pass-";

let root = "";
const buildMarkerPath = (prefix: string, id: string) =>
	path.join(root, MARKERS_REL, `${prefix}${id}`);
const leave = (prefix: string, id: string) =>
	fs.writeFileSync(buildMarkerPath(prefix, id), `by ${id}\n`);
const read = (prefix: string, id: string) =>
	fs.readFileSync(buildMarkerPath(prefix, id), "utf8");

/** The liveness oracle, listing `rows` beside the copy, or failing, given null. */
const oracle = (rows: Row[] | null) => {
	const bin = path.join(root, "claude");
	const copy = buildJobRow("copy", "working", { sessionId: TO });
	writeClaudeStub(bin, [buildAgentsBranch(rows && [copy, ...rows])]);
	vi.stubEnv("WFC_CLAUDE_BIN", bin);
};
const buildFromRow = (state: string) =>
	buildJobRow("past", state, { sessionId: FROM });

beforeEach(() => {
	root = mkScratchDir("move-pass-");
	fs.mkdirSync(path.join(root, MARKERS_REL), { recursive: true });
	vi.stubEnv("CLAUDE_CODE_SESSION_ID", "");
});

afterEach(() => {
	vi.unstubAllEnvs();
	fs.rmSync(root, { recursive: true, force: true });
});

describe("a session that has ended", () => {
	it.each([
		["the oracle lists as done", [buildFromRow("done")]],
		["the oracle no longer lists", []],
	])("moves both kinds of marker from one %s", (_what, rows) => {
		oracle(rows);
		leave(CONCISION, FROM);
		leave(REVIEW, FROM);
		expect(movePassMarkers(root, FROM, TO)).toBeNull();
		expect(read(CONCISION, TO)).toBe(`by ${FROM}\n`);
		expect(read(REVIEW, TO)).toBe(`by ${FROM}\n`);
		expect(fs.existsSync(buildMarkerPath(CONCISION, FROM))).toBe(false);
		expect(fs.existsSync(buildMarkerPath(REVIEW, FROM))).toBe(false);
	});

	it("keeps a marker the copy already wrote, moving only what it lacks", () => {
		oracle([]);
		leave(CONCISION, TO);
		leave(CONCISION, FROM);
		leave(REVIEW, FROM);
		expect(movePassMarkers(root, FROM, TO)).toBeNull();
		expect(read(CONCISION, TO)).toBe(`by ${TO}\n`);
		expect(read(REVIEW, TO)).toBe(`by ${FROM}\n`);
		expect(fs.existsSync(buildMarkerPath(CONCISION, FROM))).toBe(false);
	});
});

describe("a marker the copy may not take", () => {
	const expectLeft = () => {
		expect(fs.existsSync(buildMarkerPath(CONCISION, TO))).toBe(false);
		expect(fs.existsSync(buildMarkerPath(CONCISION, FROM))).toBe(true);
	};

	it("leaves one a live session holds, saying so", () => {
		oracle([buildFromRow("working")]);
		leave(CONCISION, FROM);
		expect(movePassMarkers(root, FROM, TO)).toBe(`${FROM} is still live`);
		expectLeft();
	});

	it("leaves one where the listing omits the copy, as it says nothing of the past id", () => {
		const bin = path.join(root, "claude");
		writeClaudeStub(bin, [buildAgentsBranch([buildJobRow("x", "working")])]);
		vi.stubEnv("WFC_CLAUDE_BIN", bin);
		leave(CONCISION, FROM);
		expect(movePassMarkers(root, FROM, TO)).toContain("omits the copy");
		expectLeft();
	});

	it("leaves one where the oracle cannot be read, naming why", () => {
		oracle(null);
		leave(CONCISION, FROM);
		expect(movePassMarkers(root, FROM, TO)).toContain("would not run");
		expectLeft();
	});
});

it("reads no oracle where the session holds no marker", () => {
	oracle(null);
	expect(movePassMarkers(root, FROM, TO)).toBeNull();
});
