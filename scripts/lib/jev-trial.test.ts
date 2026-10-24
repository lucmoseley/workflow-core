// @vitest-environment node
/*
 * The trial arithmetic, driven as a library (#253): the start line, and where
 * each of #175's two stop limbs — wrong flags and outages — stands.
 *
 * In-process against a temp markers dir, with timestamps built off the
 * committed TRIAL_START, so each case sits exactly either side of a boundary.
 *
 * check-jev-flags.js reports this standing at session start, and the trial
 * decides whether the plain-prose choice guard stays; a loosened case trips or
 * clears the trial on the wrong count.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const jevTrial = createRequire(__filename)("./jev-trial.js");

/** Where `recordVerdict` appends under `root`. */
const verdictsPath = (root: string) =>
	path.join(root, ".claude", "tmp", "markers", ".jev-verdicts.jsonl");

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-trial-"));
	fs.mkdirSync(path.join(dir, ".claude", "tmp", "markers"), {
		recursive: true,
	});
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/** The trial's and limb 2's start lines, and limb 2's voided stretch. */
const TRIAL_START_MS = Date.parse(jevTrial.TRIAL_START);
const OUTAGE_START_MS = Date.parse(jevTrial.OUTAGE_START);
const OUTAGE_VOID = jevTrial.stand({
	lines: [],
	verdicts: new Map(),
}).outageVoid;
const OUTAGE_VOID_FROM_MS = Date.parse(OUTAGE_VOID.from);
const OUTAGE_VOID_TO_MS = Date.parse(OUTAGE_VOID.to);

/** #175's limb 1 is measured over the trial's first 20 sessions. */
const LIMB1_SESSIONS = 20;

/** A timestamp `seconds` after the trial's start line. */
function sinceStart(seconds: number): string {
	return new Date(TRIAL_START_MS + seconds * 1000).toISOString();
}

/** A timestamp `seconds` before it. */
function beforeStart(seconds: number): string {
	return new Date(TRIAL_START_MS - seconds * 1000).toISOString();
}

interface Line {
	at: string;
	session: string;
	outcome: string;
	messageHash?: string;
}

/** `count` sessions, each holding one `clear` turn, starting after the line. */
/** A timestamp `seconds` after limb 2's own start line. */
function afterFix(seconds: number): string {
	return new Date(OUTAGE_START_MS + seconds * 1000).toISOString();
}

/** A timestamp `seconds` before it. */
function beforeFix(seconds: number): string {
	return new Date(OUTAGE_START_MS - seconds * 1000).toISOString();
}

/** A timestamp `seconds` after limb 2's billing-wall void opens (#670). */
function inVoid(seconds: number): string {
	return new Date(OUTAGE_VOID_FROM_MS + seconds * 1000).toISOString();
}

/** A timestamp `seconds` after it closes. */
function afterVoid(seconds: number): string {
	return new Date(OUTAGE_VOID_TO_MS + seconds * 1000).toISOString();
}

function quietSessions(count: number, from = 1): Line[] {
	return Array.from({ length: count }, (_, i) => ({
		at: sinceStart(from + i),
		session: `s${from + i}`,
		outcome: "clear",
	}));
}

function stand(lines: Line[]) {
	return jevTrial.stand({ lines, verdicts: jevTrial.readVerdicts(dir) });
}

describe("the start line", () => {
	it("excludes a session that began before it", () => {
		const s = stand([
			{
				at: beforeStart(10),
				session: "old",
				outcome: "flagged",
				messageHash: "a",
			},
			...quietSessions(1),
		]);

		expect(s.sessions).toBe(1);
		expect(s.flagged).toBe(0);
	});

	it("excludes a session straddling it, by its first line", () => {
		const s = stand([
			{ at: beforeStart(1), session: "straddle", outcome: "clear" },
			{
				at: sinceStart(60),
				session: "straddle",
				outcome: "flagged",
				messageHash: "a",
			},
		]);

		expect(s.sessions).toBe(0);
		expect(s.flagged).toBe(0);
	});

	it("does not take limb 2's sessions with it (#285)", () => {
		/* The trial's line moved once and limb 2's did not, so limb 2 counts
		 * from its own line whether or not the trial has begun. */
		const s = stand([
			{ at: beforeStart(60), session: "between", outcome: "outage" },
		]);

		expect(s.sessions).toBe(0);
		expect(s.limb2Sessions).toBe(1);
		expect(s.outageSessions).toBe(1);
	});

	it("excludes a line stamped at the start line itself", () => {
		const s = stand([
			{ at: jevTrial.TRIAL_START, session: "boundary", outcome: "outage" },
		]);

		expect(s.sessions).toBe(0);
	});
});

describe("limb 1 — wrong flags", () => {
	/** `count` flagged turns, each in its own session, each hash `f<n>`. */
	function flags(count: number): Line[] {
		return Array.from({ length: count }, (_, i) => ({
			at: sinceStart(i + 1),
			session: `f${i}`,
			outcome: "flagged",
			messageHash: `f${i}`,
		}));
	}

	function judge(hash: string, verdict: string) {
		jevTrial.recordVerdict({ root: dir, messageHash: hash, verdict });
	}

	it("holds where every flag was judged right", () => {
		for (let i = 0; i < 10; i++) judge(`f${i}`, "right");

		const s = stand(flags(10));

		expect(s).toMatchObject({ right: 10, wrong: 0, unjudged: 0 });
		expect(s.limb1).toBe("holding");
	});

	it("holds at exactly one wrong in ten — the threshold is 'more than'", () => {
		judge("f0", "wrong");
		for (let i = 1; i < 10; i++) judge(`f${i}`, "right");

		expect(stand(flags(10)).limb1).toBe("holding");
	});

	it("trips at two wrong in ten", () => {
		judge("f0", "wrong");
		judge("f1", "wrong");
		for (let i = 2; i < 10; i++) judge(`f${i}`, "right");

		expect(stand(flags(10)).limb1).toBe("tripped");
	});

	it("is pending while the unjudged flags could carry it over", () => {
		for (let i = 0; i < 8; i++) judge(`f${i}`, "right");

		const s = stand(flags(10));

		expect(s.unjudged).toBe(2);
		expect(s.limb1).toBe("pending");
	});

	it("holds where no verdict the unjudged flags could take would trip it", () => {
		for (let i = 0; i < 9; i++) judge(`f${i}`, "right");

		const s = stand(flags(10));

		expect(s.unjudged).toBe(1);
		expect(s.limb1).toBe("holding");
	});

	it("counts no flag after the first 20 sessions", () => {
		const lines = [
			...quietSessions(20),
			...flags(1).map((l) => ({
				...l,
				at: sinceStart(500),
			})),
		];

		const s = stand(lines);

		expect(s.sessions).toBe(21);
		expect(s.limb1Sessions).toBe(LIMB1_SESSIONS);
		expect(s.flagged).toBe(0);
	});
});

describe("limb 2 — outages", () => {
	/* Limb 2 counts only sessions after `OUTAGE_START`, so every fixture here
	 * is stamped past it (#164). */
	function withOutages(sessions: number, outages: number): Line[] {
		const lines = Array.from({ length: sessions }, (_, i) => ({
			at: afterFix(1 + i),
			session: `s${1 + i}`,
			outcome: "clear",
		}));
		for (let i = 0; i < outages; i++)
			lines.push({
				at: afterFix(1000 + i),
				session: `s${1 + i}`,
				outcome: "outage",
			});
		return lines;
	}

	it("holds at exactly one session in ten", () => {
		expect(stand(withOutages(10, 1)).limb2).toBe("holding");
	});

	it("trips above one session in ten", () => {
		expect(stand(withOutages(10, 2)).limb2).toBe("tripped");
	});

	it("counts a session once however many outages it logged", () => {
		const lines = withOutages(10, 0);
		lines.push(
			{ at: afterFix(1000), session: "s1", outcome: "outage" },
			{ at: afterFix(1001), session: "s1", outcome: "outage" },
			{ at: afterFix(1002), session: "s1", outcome: "outage" },
		);

		const s = stand(lines);

		expect(s.outageSessions).toBe(1);
		expect(s.limb2).toBe("holding");
	});

	it("counts an outage before its own start line toward neither side", () => {
		/* The four #255 diagnosed: struck from the numerator AND from the
		 * denominator, so they neither trip limb 2 nor dilute it (#164). */
		const lines: Line[] = [];
		for (let i = 0; i < 4; i++)
			lines.push({
				at: beforeFix(100 + i),
				session: `s${1 + i}`,
				outcome: "outage",
			});

		const s = stand(lines);

		expect(s.limb2Sessions).toBe(0);
		expect(s.outageSessions).toBe(0);
		expect(s.limb2).toBe("holding");
	});

	it("excludes a session straddling its start line, by its first line", () => {
		const lines: Line[] = [
			{ at: afterFix(-5), session: "s1", outcome: "clear" },
			{ at: afterFix(5), session: "s1", outcome: "outage" },
		];

		const s = stand(lines);

		expect(s.limb2Sessions).toBe(0);
		expect(s.outageSessions).toBe(0);
	});

	describe("the billing-wall void (#670)", () => {
		it("counts a session logged wholly inside it toward neither side", () => {
			const lines: Line[] = [
				{ at: afterFix(1), session: "s1", outcome: "clear" },
				{ at: inVoid(10), session: "s2", outcome: "outage" },
				{ at: inVoid(20), session: "s3", outcome: "outage" },
			];

			const s = stand(lines);

			expect(s.limb2Sessions).toBe(1);
			expect(s.outageSessions).toBe(0);
			expect(s.limb2).toBe("holding");
		});

		it("drops an earlier session's outage logged inside it", () => {
			const lines: Line[] = [
				{ at: inVoid(-60), session: "s1", outcome: "clear" },
				{ at: inVoid(60), session: "s1", outcome: "outage" },
			];

			const s = stand(lines);

			expect(s.limb2Sessions).toBe(1);
			expect(s.outageSessions).toBe(0);
		});

		it("counts again from its end, which is exclusive", () => {
			const lines: Line[] = [
				{ at: afterVoid(0), session: "s1", outcome: "outage" },
			];

			const s = stand(lines);

			expect(s.limb2Sessions).toBe(1);
			expect(s.outageSessions).toBe(1);
		});

		it("counts an outage just before its start, which is inclusive", () => {
			const lines: Line[] = [
				{ at: inVoid(-0.001), session: "s1", outcome: "outage" },
			];

			expect(stand(lines).outageSessions).toBe(1);
		});

		it("counts a session started inside it by its outage after it", () => {
			const lines: Line[] = [
				{ at: inVoid(10), session: "s1", outcome: "outage" },
				{ at: afterVoid(10), session: "s1", outcome: "outage" },
			];

			const s = stand(lines);

			expect(s.limb2Sessions).toBe(1);
			expect(s.outageSessions).toBe(1);
		});

		it("counts a session running through it by its outage after it", () => {
			const lines: Line[] = [
				{ at: inVoid(-60), session: "s1", outcome: "clear" },
				{ at: inVoid(60), session: "s1", outcome: "outage" },
				{ at: afterVoid(60), session: "s1", outcome: "outage" },
			];

			const s = stand(lines);

			expect(s.limb2Sessions).toBe(1);
			expect(s.outageSessions).toBe(1);
		});
	});

	it("counts a malformed reply toward neither limb (#226)", () => {
		const lines = quietSessions(10);
		for (let i = 0; i < 5; i++)
			lines.push({
				at: sinceStart(1000 + i),
				session: `s${1 + i}`,
				outcome: "malformed",
			});

		expect(stand(lines).outageSessions).toBe(0);
		expect(stand(lines).limb2).toBe("holding");
	});
});

describe("the verdict store", () => {
	it("is an empty map before anything has been judged", () => {
		expect(jevTrial.readVerdicts(dir).size).toBe(0);
	});

	it("reads back the last verdict recorded for a hash", () => {
		jevTrial.recordVerdict({ root: dir, messageHash: "abc", verdict: "right" });
		jevTrial.recordVerdict({
			root: dir,
			messageHash: "abc",
			verdict: "wrong",
			note: "on reflection",
		});

		const line = jevTrial.readVerdicts(dir).get("abc");

		expect(line.verdict).toBe("wrong");
		expect(line.note).toBe("on reflection");
	});

	it("keeps the superseded verdict on disk as an audit trail", () => {
		jevTrial.recordVerdict({ root: dir, messageHash: "abc", verdict: "right" });
		jevTrial.recordVerdict({ root: dir, messageHash: "abc", verdict: "wrong" });

		const raw = fs.readFileSync(verdictsPath(dir), "utf8");

		expect(raw.trim().split("\n")).toHaveLength(2);
	});

	it("refuses a verdict outside the vocabulary, listing the verdicts it accepts", () => {
		expect(() =>
			jevTrial.recordVerdict({
				root: dir,
				messageHash: "abc",
				verdict: "maybe",
			}),
		).toThrow(/right, wrong/);
	});

	it("does not let a torn line hide the verdicts around it", () => {
		jevTrial.recordVerdict({ root: dir, messageHash: "abc", verdict: "right" });
		fs.appendFileSync(verdictsPath(dir), '{"messageHash":"tor\n');
		jevTrial.recordVerdict({ root: dir, messageHash: "def", verdict: "wrong" });

		const all = jevTrial.readVerdicts(dir);

		expect(all.get("abc").verdict).toBe("right");
		expect(all.get("def").verdict).toBe("wrong");
	});
});

describe("the limb 1 window", () => {
	it("is open while the trial has fewer than 20 sessions", () => {
		expect(stand(quietSessions(19)).limb1Closed).toBe(false);
	});

	it("closes once 20 sessions have logged, and stays closed", () => {
		expect(stand(quietSessions(20)).limb1Closed).toBe(true);
		expect(stand(quietSessions(25)).limb1Closed).toBe(true);
	});
});
