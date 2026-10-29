// @vitest-environment node
/*
 * The refill loop's overflow seats (#2611, spec #2570): each seat's budget
 * read for the decision core only once every plan seat is weekly-full, a key
 * spent for its cycle told from one held by running sessions, the dry run's
 * line naming the headless launch, and a headless launch judged finished by
 * its absence from the listing, its acts read by the session id it carried
 * from launch.
 *
 * The readings and the line are module cases with the budget gate injected,
 * since its settling is overflow-budget.test.ts's; the finish reads the real
 * headless store under the setup's WFC_REFILL_DIR.
 *
 * Loosen one and the loop spends credits while plan allowance remains, stops
 * while a key's running sessions are about to reopen it, or never counts an
 * overflow launch toward the no-progress stop.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { headlessStore, writeHeadlessRun } from "./headless-runs-testkit";
import { readLiveAgents } from "./headless-sessions.js";
import { buildWouldRunLine, dispatchCall } from "./refill-batch.js";
import { decideTick, FULL } from "./refill-decide.js";
import { actsOf, judgedLaunches, overflowReadings } from "./refill-loop.js";

const NOW = Date.parse("2026-10-18T12:00:00Z");
const MIN = 60 * 1000;

const planSeat = (seat: string, weekFull: boolean) => ({
	seat,
	week: weekFull ? FULL : 50,
	session: 10,
	weekFull,
	sessionFull: false,
	sessionResets: null,
});

const overflowSeat = (dir: string) => ({
	dir,
	kind: "overflow" as const,
	keyVar: `KEY_${path.basename(dir)}`,
	grantUsd: 200,
	cycleDay: 20,
});

const budget = (over: Record<string, unknown> = {}) => ({
	fit: 5,
	headroomUsd: 20,
	settledUsd: 100,
	reservedUsd: 80,
	grantUsd: 200,
	qUsd: 4,
	running: 2,
	cycleStart: new Date(2026, 9, 20).getTime(),
	nextCycleStart: new Date(2026, 10, 20).getTime(),
	exhausted: false,
	...over,
});

describe("each overflow seat's reading", () => {
	const list = (...overflow: ReturnType<typeof overflowSeat>[]) => ({
		seats: [{ dir: "/s/plan", kind: "plan" as const }, ...overflow],
		errors: [],
	});
	const both = list(overflowSeat("/s/x"), overflowSeat("/s/y"));
	const first = list(overflowSeat("/s/x"));

	it("reads no budget while a plan seat is not weekly-full", () => {
		const read: string[] = [];
		const out = overflowReadings(
			both,
			[planSeat("a", true), planSeat("b", false)],
			(s) => {
				read.push(s.dir);
				return budget();
			},
		);
		expect(read).toEqual([]);
		expect(out.map((o) => o.fits)).toEqual([null, null]);
	});

	it("gives each seat's fit once every plan seat is weekly-full", () => {
		const fits = [3, 0];
		const out = overflowReadings(both, [planSeat("a", true)], () =>
			budget({ fit: fits.shift() }),
		);
		expect(out).toEqual([
			{ seat: "/s/x", fits: 3, spentUntil: null, why: null },
			{ seat: "/s/y", fits: 0, spentUntil: null, why: null },
		]);
	});

	it("marks a key spent until its cycle ends where refused for credit or settled past one reservation", () => {
		const until = "2026-11-20";
		for (const b of [
			budget({ fit: 0, exhausted: true }),
			budget({ fit: 0, settledUsd: 197, reservedUsd: 0, headroomUsd: 3 }),
		])
			expect(
				overflowReadings(first, [planSeat("a", true)], () => b)[0],
			).toMatchObject({ fits: 0, spentUntil: until });
	});

	it("passes an unread budget's reason on", () => {
		expect(
			overflowReadings(first, [planSeat("a", true)], () => ({
				why: "the session cost table is unreadable",
			})),
		).toEqual([
			{
				seat: "/s/x",
				fits: null,
				spentUntil: null,
				why: "the session cost table is unreadable",
			},
		]);
	});

	it("reads a seat file that refuses as one unread seat, so the tick waits on it", () => {
		const out = overflowReadings(
			{ seats: [], errors: ["refill-seats:2: missing cycle-day="] },
			[planSeat("a", true)],
			() => budget(),
		);
		expect(out).toEqual([
			{
				seat: "the seat file",
				fits: null,
				spentUntil: null,
				why: "it refuses: refill-seats:2: missing cycle-day=",
			},
		]);
	});
});

describe("the dry run's dispatch line", () => {
	const call = dispatchCall(
		[
			{
				root: "/home/u/wfc",
				issues: [7],
				prompt: "/implement 7",
				model: "opus",
				seat: "/home/u/.claude2-api",
			},
		],
		"/core/dispatch-sessions.sh",
		{ PATH: "/usr/bin" },
	);

	it("names the headless launch on an overflow seat, and only there", () => {
		expect(buildWouldRunLine(call, new Set(["/home/u/.claude2-api"]))).toBe(
			"would run in /home/u/wfc on overflow seat /home/u/.claude2-api, each member a headless `claude -p` (lib/headless-sessions.js): bash /core/dispatch-sessions.sh opus /implement 7",
		);
		expect(buildWouldRunLine(call, new Set())).toBe(
			"would run in /home/u/wfc on /home/u/.claude2-api: bash /core/dispatch-sessions.sh opus /implement 7",
		);
	});
});

describe("a headless launch's finish (#2611)", () => {
	const refill = String(process.env.WFC_REFILL_DIR);
	afterEach(() =>
		fs.rmSync(headlessStore(refill), { recursive: true, force: true }),
	);

	const launch = (jobId: string, launchedAt = NOW - 10 * MIN) => ({
		root: "/home/u/wfc",
		issues: [Number.parseInt(jobId, 16) % 1000],
		prompt: `/implement ${jobId}`,
		seat: "/home/u/.claude2-api",
		jobId,
		sessionId: `session-${jobId}`,
		launchedAt,
		finishedAt: null,
	});
	const judge = (launches: ReturnType<typeof launch>[]) =>
		judgedLaunches(launches, readLiveAgents(), NOW, {
			progressOf: (l) =>
				actsOf(l, ["/home/u/wfc"], (sessionId) => ({
					acts: sessionId === "session-0000000a" ? ["claim #10"] : [],
					unreadable: [],
				})),
			causeOf: () => ({ cause: "QUESTION" }) as never,
		});

	it("is judged by its absence from the listing, its acts read by its launch-time session id", () => {
		writeHeadlessRun(refill, "0000000b", "session-0000000b");
		writeHeadlessRun(refill, "0000000a", "session-0000000a", { live: false });
		const [ended, live] = judge([launch("0000000a"), launch("0000000b")]);
		expect(ended).toMatchObject({ finishedAt: NOW, acts: { claim: 1 } });
		expect(live).toMatchObject({ finishedAt: null });
	});

	it("counts toward the no-progress stop", () => {
		const history = judge(
			["0000000c", "0000000d", "0000000e"].map((id) => launch(id)),
		);
		expect(history.map((l) => l.acts)).toEqual([{}, {}, {}]);
		expect(
			decideTick({
				now: NOW,
				mode: "normal" as const,
				startedAt: NOW - 60 * MIN,
				stopRequested: false,
				frontier: [],
				retroBundles: [],
				running: [],
				freeSlots: 2,
				lastPromptAt: null,
				seats: [{ ...planSeat("a", true), fits: null }],
				overflow: [
					{
						seat: "/home/u/.claude2-api",
						fits: 5,
						spentUntil: null,
						why: null,
					},
				],
				history,
			}),
		).toMatchObject({ stop: "no-progress" });
	});
});
