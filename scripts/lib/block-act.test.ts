// @vitest-environment node
/*
 * The cause→act table (#2699, #2705, #2707, #3621, spec #2695). The morning
 * cut-off is machine-local, so its cases build local dates.
 *
 * Loosen one and a normal-mode question or permission prompt is stopped before
 * the founder answers it in place, an away-mode park holds its slot until
 * morning, or an API-error session is resumed past its cap or never, or
 * stopped mid-retry, or a resumed-idle one is handed off before its one resume.
 */
import { describe, expect, it } from "vitest";
import { blockAct, nextTryAt, RESUME_CAP } from "./block-act.js";

const NOW = Date.parse("2026-10-24T03:00:00Z");
const MIN = 60 * 1000;

const block = (cause: import("./block-cause.js").Cause, minutes: number) => ({
	cause,
	since: NOW - minutes * MIN,
});

describe("the cause→act table", () => {
	it("QUESTION: away stops on the first tick; normal waits at any age", () => {
		expect(blockAct(block("QUESTION", 0), "away", NOW)).toBe("stop-and-park");
		for (const minutes of [0, 60, 10 * 24 * 60])
			expect(blockAct(block("QUESTION", minutes), "normal", NOW)).toBe("wait");
	});

	it("PERMISSION: away stops on the first tick; normal waits at any age", () => {
		expect(blockAct(block("PERMISSION", 0), "away", NOW)).toBe("stop-and-park");
		for (const minutes of [0, 60, 10 * 24 * 60])
			expect(blockAct(block("PERMISSION", minutes), "normal", NOW)).toBe(
				"wait",
			);
	});

	for (const cause of ["LIMIT", "OTHER_DIALOG", "UNKNOWN"] as const)
		it(`${cause}: none in either mode`, () => {
			expect(blockAct(block(cause, 600), "away", NOW)).toBe("none");
			expect(blockAct(block(cause, 600), "normal", NOW)).toBe("none");
		});
});

describe("the API_ERROR row (#2359)", () => {
	const transient = (over = {}) => ({
		cause: "API_ERROR" as const,
		sub: "transient" as const,
		since: NOW,
		...over,
	});

	it("auth and invalid_request park at once, in either mode", () => {
		for (const sub of ["auth", "invalid_request"] as const)
			for (const mode of ["away", "normal"] as const)
				expect(blockAct({ ...transient(), sub }, mode, NOW)).toBe(
					"stop-and-park",
				);
	});

	it("a transient stop resumes on the first tick that reads it", () => {
		expect(blockAct(transient(), "normal", NOW)).toBe("resume");
	});

	it("meets about 1, 5, 15 and 30 min from the stop, then every 30 min", () => {
		const first = NOW + MIN;
		const due = [1];
		let at = first;
		for (let tries = 1; tries < 7; tries++) {
			at = nextTryAt(tries, at);
			due.push((at - NOW) / MIN);
		}
		expect(due).toEqual([1, 5, 15, 30, 60, 90, 120]);
	});

	it("waits for the next due try, then resumes it", () => {
		const b = transient({ tries: 2, nextAt: NOW + 15 * MIN });
		expect(blockAct(b, "normal", NOW + 15 * MIN - 1)).toBe("wait");
		expect(blockAct(b, "normal", NOW + 15 * MIN)).toBe("resume");
	});

	it("holds one blocked again past the retry cycle until its next try, once", () => {
		const b = (over = {}) =>
			transient({ tries: 2, triedAt: NOW, nextAt: NOW + 10 * MIN, ...over });
		expect(blockAct(b(), "away", NOW + 4 * MIN - 1)).toBe("wait");
		expect(blockAct(b(), "away", NOW + 4 * MIN)).toBe("hold");
		expect(blockAct(b({ held: true }), "away", NOW + 4 * MIN)).toBe("wait");
		expect(blockAct(b({ typing: true }), "away", NOW + 4 * MIN)).toBe("wait");
		expect(blockAct(b(), "away", NOW + 10 * MIN)).toBe("resume");
	});

	it("makes no resume while a typed one awaits its check, but still parks", () => {
		const b = transient({ tries: 1, nextAt: NOW, typing: true });
		expect(blockAct(b, "normal", NOW)).toBe("wait");
		expect(blockAct({ ...b, tries: RESUME_CAP }, "normal", NOW)).toBe(
			"stop-and-park",
		);
	});

	it("parks when the try past the cap falls due, in either mode", () => {
		const at = (tries: number) => transient({ tries, nextAt: NOW + 2 * MIN });
		expect(blockAct(at(RESUME_CAP - 1), "normal", NOW + 2 * MIN)).toBe(
			"resume",
		);
		expect(blockAct(at(RESUME_CAP), "normal", NOW + MIN)).toBe("wait");
		for (const mode of ["away", "normal"] as const)
			expect(blockAct(at(RESUME_CAP), mode, NOW + 2 * MIN)).toBe(
				"stop-and-park",
			);
	});

	it("away, parks at the first 07:00 after the stop; normal resumes on", () => {
		const night = new Date(2026, 9, 24, 23, 0).getTime();
		const b = transient({ since: night, tries: 3, nextAt: night });
		const before = new Date(2026, 9, 25, 6, 59).getTime();
		const morning = new Date(2026, 9, 25, 7, 0).getTime();
		expect(blockAct(b, "away", before)).toBe("resume");
		expect(blockAct(b, "away", morning)).toBe("park-at-morning");
		expect(blockAct(b, "normal", morning)).toBe("resume");
	});

	it("a stop after 07:00 runs to the next day's 07:00", () => {
		const stop = new Date(2026, 9, 25, 7, 30).getTime();
		const b = transient({ since: stop, tries: 1, nextAt: stop });
		expect(blockAct(b, "away", new Date(2026, 9, 25, 8, 0).getTime())).toBe(
			"resume",
		);
	});
});

describe("the RESUMED_IDLE row (#2659, #2978)", () => {
	const idle = (minutes: number, tries?: number) => ({
		cause: "RESUMED_IDLE" as const,
		since: NOW - minutes * MIN,
		...(tries === undefined ? {} : { tries }),
	});

	it("waits 5 min from the restart row, then resumes, in either mode", () => {
		for (const mode of ["away", "normal"] as const) {
			expect(blockAct(idle(5), mode, NOW - 1)).toBe("wait");
			expect(blockAct(idle(5), mode, NOW)).toBe("resume");
		}
	});

	it("types once more into one still idle 5 min after its first typed resume", () => {
		expect(blockAct(idle(4, 1), "away", NOW)).toBe("wait");
		for (const mode of ["away", "normal"] as const)
			expect(blockAct(idle(5, 1), mode, NOW)).toBe("resume");
	});

	it("hands off one still idle 5 min after its second typed resume", () => {
		expect(blockAct(idle(4, 2), "away", NOW)).toBe("wait");
		for (const mode of ["away", "normal"] as const)
			expect(blockAct(idle(5, 2), mode, NOW)).toBe("handoff-relaunch");
	});
});
