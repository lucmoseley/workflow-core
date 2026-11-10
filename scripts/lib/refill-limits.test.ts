// @vitest-environment node
/*
 * The refill loop's acts on limit-blocked launches (#3735), through
 * actOnLimits with a fake BlockIo that records each call.
 * refill-loop-run.test.ts drives the program's own BlockIo end to end.
 *
 * Loosen one and the loop holds, resumes, moves or parks a limit-blocked
 * session when it should not, fails to when it should, takes the wrong seat
 * or slot, keeps the wrong ledger hold, or misreports what it did.
 */
import { describe, expect, it } from "vitest";
import { COPY_WHY } from "./bg-resume-fake";
import { RESUME_CAP } from "./block-act.js";
import { LIMIT_PROMPT } from "./loop-prompts.js";
import { isHeld } from "./refill-block-core.js";
import { actOnIdle, markParked } from "./refill-blocks.js";
import {
	type Agents,
	agent,
	type BlockIo,
	blocks,
	fakeIo,
	type Launch,
	logs,
	MIN,
	NO_HOLD,
	NOW,
	record,
} from "./refill-blocks-fixture";
import { buildLimitCapText, unprovenRoom } from "./refill-decide.js";
import {
	actOnLimits,
	buildHeldStopText,
	releaseEndedHolds,
} from "./refill-limits.js";
import { judgedLaunches } from "./refill-loop.js";
import { buildSeatName } from "./refill-seats.js";

const DAY = 24 * 60 * MIN;
const LIMIT_HOLD_BOUND_DAYS = 8;
/** The cap refill-decide.js keeps to itself, pinned here. */
const LIMIT_PARK_CAP = 2;

describe("the acts on a limit-blocked launch (#3735)", () => {
	const Seat = "/home/u/.claude3";
	const Since = NOW - 5 * MIN;
	type Sized = import("./refill-decide.js").SizedSeat;
	const planSeat = (over: Partial<Sized> = {}): Sized => ({
		seat: Seat,
		week: 50,
		session: 10,
		weekFull: false,
		sessionFull: false,
		sessionResets: null,
		weekResets: null,
		readAt: NOW,
		weekRead: { percent: 50, atMs: NOW },
		fits: 1,
		...over,
	});
	const fiveHourFull = planSeat({
		session: 100,
		sessionFull: true,
		sessionResets: "2026-10-18T15:00:00Z",
		fits: null,
	});
	const LimitHeld = {
		at: Since,
		sessionId: "s-job42",
		cwd: "/home/u/design-vault",
		limit: { bar: "5-hour", resets: "2026-10-18T15:00:00Z" },
	};
	const blocked = (over: Record<string, unknown> = {}) =>
		record({
			sessionId: "s-job42",
			parked: true,
			block: { cause: "LIMIT", since: Since },
			...over,
		});
	const held = (over: Record<string, unknown> = {}) =>
		blocked({ limitHeld: LimitHeld, ...over });

	function limits(
		launches: Launch[],
		agents: Agents,
		{
			seats = [planSeat()],
			overflow = [],
			slots = 1,
			mode = "away",
			seatListRead = true,
			now = NOW,
			io: over = {},
		}: {
			seats?: Sized[];
			overflow?: import("./refill-decide.js").OverflowReading[];
			seatListRead?: boolean;
			slots?: number;
			now?: number;
			mode?: "away" | "normal";
			io?: Partial<BlockIo>;
		} = {},
	) {
		const { io, calls } = fakeIo({
			resumeStopped: (l, prompt, target) => {
				calls.push(`confirmed ${l.seat} ${target.sessionId} ${prompt}`);
				return {
					failed: null,
					jobId: l.jobId,
					sessionId: target.sessionId,
					copy: false,
				};
			},
			...over,
		});
		const out = actOnLimits(launches, mode, {
			agents,
			now,
			io,
			swapHold: NO_HOLD,
			typedSeat: null,
			readMoveSeats: () => ({ seats, overflow }),
			seatListRead,
			slots,
		});
		return { ...out, calls };
	}
	const comments = (calls: string[]) =>
		calls.filter((c) => c.startsWith("comment "));

	describe.each(["away", "normal"] as const)("in %s mode", (mode) => {
		const weekFull = planSeat({
			week: 100,
			weekFull: true,
			weekResets: NOW + DAY,
			fits: null,
		});
		it.each([
			["5-hour", fiveHourFull, "2026-10-18T15:00:00Z"],
			["weekly", weekFull, new Date(NOW + DAY).toISOString()],
		] as const)(
			"holds on a spent %s bar: stops the job, logs session, seat and limit, labels and comments nothing",
			(bar, seat, reset) => {
				const labelled: string[] = [];
				const { launches, calls } = limits(
					[blocked()],
					[agent("job42", "blocked")],
					{
						seats: [seat],
						mode,
						io: {
							labelParked: (l) => {
								labelled.push(l.jobId ?? "");
								return [];
							},
						},
					},
				);
				expect(calls[0]).toBe("stop job42");
				expect(comments(calls)).toEqual([]);
				expect(labelled).toEqual([]);
				expect(logs(calls)).toEqual([
					`held job42 design-vault /implement 42 on ${Seat}, at its ${bar} limit (reset ${reset}): stopped until a seat has room`,
				]);
				expect(launches[0]).toMatchObject({
					finishedAt: null,
					block: { cause: "LIMIT" },
					limitHeld: { at: NOW, sessionId: "s", cwd: "/", limit: { bar } },
				});
				expect(isHeld(launches[0] as Launch)).toBe(true);
			},
		);

		it("resumes a live one: stops, resumes under its seat, comments once", () => {
			const { launches, calls } = limits(
				[blocked()],
				[agent("job42", "blocked")],
				{ mode },
			);
			expect(calls.slice(0, 2)).toEqual([
				"stop job42",
				`confirmed ${Seat} s ${LIMIT_PROMPT}`,
			]);
			expect(comments(calls)).toHaveLength(1);
			expect(launches[0]).toMatchObject({
				jobId: "job42",
				relaunchedAt: NOW,
				limitHeld: { resumedAt: NOW },
			});
		});
	});

	it("names the limit its block text names, the bars only where it names none (#3730)", () => {
		const seats = [planSeat({ sessionResets: "2026-10-18T15:00:00Z" })];
		const named = (bar: object) =>
			comments(
				limits(
					[blocked({ block: { cause: "LIMIT", since: Since, ...bar } })],
					[agent("job42", "blocked")],
					{ seats },
				).calls,
			)[0];
		expect(named({ bar: "5-hour" })).toContain(
			"5-hour limit (reset 2026-10-18T15:00:00Z)",
		);
		expect(named({})).toContain("weekly limit (reset unread)");
	});

	it("resumes a held one without a second stop, and its comment says what was lost", () => {
		const { launches, calls, slots } = limits([held()], []);
		expect(calls).not.toContain("stop job42");
		expect(calls).toContain(`confirmed ${Seat} s-job42 ${LIMIT_PROMPT}`);
		const [comment] = comments(calls);
		expect(comment).toContain("5-hour limit (reset 2026-10-18T15:00:00Z)");
		expect(comment).toContain(`same seat, ${Seat}`);
		expect(comment).toContain(
			"in-flight subagents, background tasks and monitors, and the warm prompt cache",
		);
		expect(launches[0]).toMatchObject({ limitHeld: { resumedAt: NOW } });
		expect(slots).toBe(0);
	});

	it("takes a slot per held resume, and a live one's stop and resume takes none", () => {
		const two = [held(), held({ jobId: "job43", issues: [43] })];
		const out = limits(two, [], { slots: 1 });
		expect(out.launches[0]).toMatchObject({ limitHeld: { resumedAt: NOW } });
		expect(out.launches[1]?.limitHeld).not.toHaveProperty("resumedAt");
		expect(out.slots).toBe(0);
		const live = limits([blocked()], [agent("job42", "blocked")], { slots: 0 });
		expect(live.calls).toContain("stop job42");
		expect(live.slots).toBe(0);
		expect(live.launches[0]).toMatchObject({ limitHeld: { resumedAt: NOW } });
	});

	it("resumes one held session in place a tick on a reset seat, sized for one (#3730)", () => {
		const two = [held(), held({ jobId: "job43", issues: [43] })];
		const out = limits(two, [], { slots: 2 });
		expect(out.launches[0]).toMatchObject({ limitHeld: { resumedAt: NOW } });
		expect(out.launches[1]?.limitHeld).not.toHaveProperty("resumedAt");
		expect(out.slots).toBe(1);
	});

	it("a failed resume stays held and names the failure in log and comment", () => {
		const { launches, calls, slots } = limits([held()], [], {
			io: {
				resumeStopped: () => ({ failed: "not confirmed: job42 reads x" }),
			},
		});
		expect(launches[0]).toMatchObject({
			limitHeld: LimitHeld,
			limitResumes: {
				tries: 1,
				triedAt: NOW,
				nextAt: NOW + 4 * MIN,
				failed: "not confirmed: job42 reads x",
			},
		});
		expect(isHeld(launches[0] as Launch)).toBe(true);
		expect(slots).toBe(1);
		expect(logs(calls).join("\n")).toContain("not confirmed: job42 reads x");
		expect(comments(calls)[0]).toContain("not confirmed: job42 reads x");
	});

	it("comments a failure once, and again only when it changes", () => {
		const io = { resumeStopped: () => ({ failed: "same" }) };
		const tried = {
			tries: 1,
			triedAt: NOW - 30 * MIN,
			nextAt: NOW - MIN,
			failed: "same",
		};
		const again = limits([held({ limitResumes: tried })], [], { io });
		expect(comments(again.calls)).toEqual([]);
		expect(logs(again.calls).join("\n")).toContain("same");
		const changed = limits(
			[held({ limitResumes: { ...tried, failed: "other" } })],
			[],
			{ io },
		);
		expect(comments(changed.calls)).toHaveLength(1);
	});

	describe("a held one whose resume can never take (#3790)", () => {
		const failedTo = (failedTries: number) =>
			held({ limitHeld: { ...LimitHeld, failedTries } });
		const otherSeat = [planSeat({ seat: "/home/u/.claude2" })];

		function expectParked(
			{ launches, calls, slots }: ReturnType<typeof limits>,
			why: string,
		) {
			const parked = launches[0] as Launch;
			expect(parked).toMatchObject({ parkStopped: NOW, finishedAt: null });
			expect(parked).not.toHaveProperty("limitHeld");
			expect(isHeld(parked)).toBe(false);
			const [judged] = judgedLaunches([parked], [], NOW, {
				progressOf: () => ({}),
				causeOf: () => ({ cause: "LIMIT" }),
			});
			expect(judged?.finishedAt).toBe(NOW);
			expect(comments(calls)[0]).toContain("labelled parked: #42");
			expect(comments(calls)[0]).toContain(why);
			expect(calls.some((c) => c.startsWith("confirmed"))).toBe(false);
			expect(calls).toContain("stop job42");
			expect(slots).toBe(1);
		}

		it("parks at the cap of failed resumes, and it finishes", () => {
			expectParked(
				limits([failedTo(RESUME_CAP)], []),
				`${RESUME_CAP} failed resumes or moves`,
			);
		});

		describe("held on a seat that never reads open (#3793)", () => {
			const heldFor = (ms: number) =>
				held({ limitHeld: { ...LimitHeld, at: NOW - ms } });
			const weekFull = planSeat({
				week: 100,
				weekFull: true,
				weekResets: NOW + DAY,
				fits: null,
			});

			it("parks past the bound with no resume tried, and it finishes", () => {
				expectParked(
					limits([heldFor(LIMIT_HOLD_BOUND_DAYS * DAY)], [], {
						seats: [{ ...weekFull, readAt: NOW - LIMIT_HOLD_BOUND_DAYS * DAY }],
					}),
					`past the ${LIMIT_HOLD_BOUND_DAYS}-day bound`,
				);
			});

			it("parks past the bound on a stand-in seat list, and not within it", () => {
				const standIn = { seats: [], seatListRead: false };
				expectParked(
					limits([heldFor(LIMIT_HOLD_BOUND_DAYS * DAY)], [], standIn),
					`past the ${LIMIT_HOLD_BOUND_DAYS}-day bound`,
				);
				const within = limits([heldFor(7 * DAY)], [], standIn);
				expect(within.launches[0]).toHaveProperty("limitHeld");
			});

			it("parks one at the failed-resume cap on a stand-in seat list (#3800)", () => {
				expectParked(
					limits([failedTo(RESUME_CAP)], [], {
						seats: [],
						seatListRead: false,
					}),
					`${RESUME_CAP} failed resumes or moves`,
				);
			});

			it("stays held within the bound, waiting on a weekly reset", () => {
				const { launches, calls } = limits([heldFor(7 * DAY)], [], {
					seats: [weekFull],
				});
				expect(launches[0]).toMatchObject({ finishedAt: null });
				expect(launches[0]).toHaveProperty("limitHeld");
				expect(launches[0]).not.toHaveProperty("parkStopped");
				expect(calls).not.toContain("stop job42");
			});
		});

		it("parks where its seat has gone from the seats read, and it finishes", () => {
			expectParked(
				limits([held()], [], { seats: otherSeat }),
				`its seat ${Seat} off the loop's seats`,
			);
		});

		it("parks though its stop fails, and logs why", () => {
			const { launches, calls } = limits([failedTo(RESUME_CAP)], [], {
				io: {
					stop: () => ({
						ok: false,
						why: "seat gone",
						said: null,
						timedOut: false,
						noJob: false,
					}),
				},
			});
			expect(launches[0]).toMatchObject({ parkStopped: NOW });
			expect(logs(calls).join("\n")).toContain("seat gone");
		});

		it("marks its park under the hold's session id, where the launch has none", () => {
			const { launches, calls } = limits([held({ sessionId: undefined })], [], {
				seats: otherSeat,
			});
			expect(calls).toContain("record s-job42 42");
			expect(launches[0]).toMatchObject({ sessionId: "s-job42" });
		});

		it("stays held off a damaged or empty control's stand-in seats", () => {
			const { launches, calls } = limits([held()], [], {
				seats: otherSeat,
				seatListRead: false,
			});
			expect(isHeld(launches[0] as Launch)).toBe(true);
			expect(comments(calls)).toEqual([]);
		});

		it("parks on the tick after the failure that reaches the cap", () => {
			const io = { resumeStopped: () => ({ failed: "still failing" }) };
			const failed = limits([failedTo(RESUME_CAP - 1)], [], { io });
			expect(isHeld(failed.launches[0] as Launch)).toBe(true);
			expect(failed.launches[0]?.limitHeld).toMatchObject({
				failedTries: RESUME_CAP,
			});
			const next = limits(failed.launches as Launch[], [], { io });
			expect(next.launches[0]).toMatchObject({ parkStopped: NOW });
		});

		it("resumes a try short of the cap", () => {
			const { launches, calls } = limits([failedTo(RESUME_CAP - 1)], []);
			expect(calls).toContain(`confirmed ${Seat} s-job42 ${LIMIT_PROMPT}`);
			expect(launches[0]).toMatchObject({ limitHeld: { resumedAt: NOW } });
			expect(launches[0]).not.toHaveProperty("parkStopped");
		});

		it("counts a resume its record later shows failed", () => {
			const { launches } = limits(
				[held({ limitHeld: { ...LimitHeld, resumedAt: NOW - MIN } })],
				[],
				{ io: { jobStateOf: () => null } },
			);
			expect(launches[0]?.limitHeld).toMatchObject({ failedTries: 1 });
		});

		it("counts no resume that took, however many the launch has made", () => {
			const { launches } = limits(
				[
					held({
						limitResumes: {
							tries: RESUME_CAP + 5,
							triedAt: NOW - 60 * MIN,
							nextAt: NOW - MIN,
						},
					}),
				],
				[],
			);
			expect(launches[0]).toMatchObject({ limitHeld: { resumedAt: NOW } });
			expect(launches[0]?.limitHeld).not.toHaveProperty("failedTries");
		});

		it("counts a new hold's failures from none, a resume having taken", () => {
			const { launches: settled } = limits(
				[
					held({
						limitHeld: { ...LimitHeld, resumedAt: NOW - MIN, failedTries: 3 },
					}),
				],
				[],
			);
			const reheld = limits(
				[{ ...settled[0], block: blocked().block } as Launch],
				[agent("job42", "blocked")],
				{ seats: [fiveHourFull] },
			);
			expect(isHeld(reheld.launches[0] as Launch)).toBe(true);
			expect(reheld.launches[0]?.limitHeld).not.toHaveProperty("failedTries");
		});

		it("leaves a live one alone off a seat the loop does not read", () => {
			const { launches, calls } = limits(
				[blocked()],
				[agent("job42", "blocked")],
				{ seats: otherSeat },
			);
			expect(launches[0]).toEqual(blocked());
			expect(comments(calls)).toEqual([]);
		});
	});

	describe("a resume that takes and re-blocks (#3792)", () => {
		const live = [agent("job42", "blocked")];
		const buildDryResumes = (
			dryResumes: number,
			over: Record<string, unknown> = {},
		) => ({
			tries: dryResumes + 1,
			triedAt: NOW - 60 * MIN,
			nextAt: NOW - MIN,
			takenAt: NOW - 60 * MIN,
			dryResumes,
			...over,
		});

		/** Each tick's act, then the next listing showing it blocked again, each
		 * tick at its next try, until it parks or `ticks` run out. */
		function reblocking(ticks: number, io: Partial<BlockIo>) {
			let launch = blocked();
			let now = NOW;
			let resumes = 0;
			for (let i = 0; i < ticks; i += 1) {
				const out = limits([launch], live, { now, io });
				launch = out.launches[0] as Launch;
				resumes += out.calls.filter((c) => c.startsWith("confirmed")).length;
				if (launch.parkStopped !== undefined) break;
				[launch] = markParked(
					[launch],
					live,
					() => ({ cause: "LIMIT" }),
					now + MIN,
				) as [Launch];
				now = launch.limitResumes?.nextAt ?? now;
			}
			return { launch, resumes };
		}

		it("parks past the bound of resumes with no reply, and it finishes", () => {
			const { launch, resumes } = reblocking(RESUME_CAP * 2, {
				hasRepliedSince: () => false,
			});
			expect(resumes).toBe(RESUME_CAP);
			expect(launch.parkStopped).toBeDefined();
			const at = launch.parkStopped as number;
			const [judged] = judgedLaunches([launch], [], at, {
				progressOf: () => ({}),
				causeOf: () => ({ cause: "LIMIT" }),
			});
			expect(judged?.finishedAt).toBe(at);
		});

		it("resumes one that replies between its blocks however many it has met", () => {
			const { launch, resumes } = reblocking(RESUME_CAP * 3, {
				hasRepliedSince: () => true,
			});
			expect(resumes).toBe(RESUME_CAP * 3);
			expect(launch.parkStopped).toBeUndefined();
			expect(launch.limitResumes?.tries).toBe(RESUME_CAP * 3);
		});

		it("clears the count on a reply, so the bound is on resumes in a row", () => {
			const { launches, calls } = limits(
				[blocked({ limitResumes: buildDryResumes(RESUME_CAP - 1) })],
				live,
				{ io: { hasRepliedSince: () => true } },
			);
			expect(calls).toContain(`confirmed ${Seat} s ${LIMIT_PROMPT}`);
			expect(launches[0]?.limitResumes).not.toHaveProperty("dryResumes");
		});

		it("counts the block once, however many ticks it then waits", () => {
			const replied: number[] = [];
			const io = {
				hasRepliedSince: (_: unknown, at: number) => {
					replied.push(at);
					return false;
				},
			};
			const first = limits(
				[blocked({ limitResumes: buildDryResumes(2) })],
				live,
				{
					seats: [fiveHourFull],
					io,
				},
			);
			expect(first.launches[0]?.limitResumes).toMatchObject({ dryResumes: 3 });
			const next = limits(first.launches as Launch[], [], {
				seats: [fiveHourFull],
				io,
			});
			expect(next.launches[0]?.limitResumes).toMatchObject({ dryResumes: 3 });
			expect(replied).toHaveLength(1);
		});

		it("parks one held on a full seat once its count reaches the bound", () => {
			const { launches, calls } = limits(
				[held({ limitResumes: buildDryResumes(RESUME_CAP - 1) })],
				[],
				{ seats: [fiveHourFull] },
			);
			expect(launches[0]).toMatchObject({ parkStopped: NOW });
			expect(comments(calls)[0]).toContain(
				`${RESUME_CAP} resumes or moves in a row with no reply`,
			);
		});

		it("names the cap the table parked on, for one held at both (#3800)", () => {
			const { calls } = limits(
				[
					held({
						limitHeld: { ...LimitHeld, failedTries: RESUME_CAP },
						limitResumes: buildDryResumes(RESUME_CAP),
					}),
				],
				[],
				{ seats: [fiveHourFull] },
			);
			expect(comments(calls)[0]).toContain(
				`${RESUME_CAP} failed resumes or moves`,
			);
			expect(comments(calls)[0]).not.toContain("with no reply");
		});

		it("judges nothing off an unread transcript", () => {
			const { launches, calls } = limits(
				[blocked({ limitResumes: buildDryResumes(RESUME_CAP - 1) })],
				live,
				{ seats: [fiveHourFull], io: { hasRepliedSince: () => null } },
			);
			expect(launches[0]?.limitResumes).toMatchObject({
				dryResumes: RESUME_CAP - 1,
				takenAt: NOW - 60 * MIN,
			});
			expect(launches[0]).not.toHaveProperty("parkStopped");
			expect(calls).toContain("stop job42");
		});

		describe("the park's count of limit-cap parks in a row (#3804)", () => {
			const buildLaunchAtResumeCap = (over: Record<string, unknown> = {}) =>
				blocked({ limitResumes: buildDryResumes(RESUME_CAP), ...over });
			const parkOf = (launch: Launch, io: Partial<BlockIo> = {}) => {
				const counts: (number | undefined)[] = [];
				const { calls } = limits([launch], live, {
					io: {
						hasRepliedSince: () => false,
						recordParked: (_, __, { limitParks }) => {
							counts.push(limitParks);
							return null;
						},
						...io,
					},
				});
				return { counts, calls };
			};
			const comment = (calls: string[]) =>
				calls.find((c) => c.startsWith("comment ")) ?? "";

			it("counts a first park as one, and leaves the ticket to relaunch", () => {
				const { counts, calls } = parkOf(buildLaunchAtResumeCap());
				expect(counts).toEqual([1]);
				expect(comment(calls)).not.toContain("will not relaunch");
			});

			it("counts on from the parks its launch came back from, and says at the cap that relaunches end", () => {
				const { counts, calls } = parkOf(
					buildLaunchAtResumeCap({ limitParks: LIMIT_PARK_CAP - 1 }),
				);
				expect(counts).toEqual([LIMIT_PARK_CAP]);
				expect(comment(calls)).toContain(buildLimitCapText(LIMIT_PARK_CAP));
			});

			it("promises no end to relaunches where the marker holding the count went unwritten", () => {
				const { calls } = parkOf(
					buildLaunchAtResumeCap({ limitParks: LIMIT_PARK_CAP - 1 }),
					{
						recordParked: () => "EACCES",
					},
				);
				expect(comment(calls)).not.toContain("will not relaunch");
			});

			it("starts again where the launch replied since it began", () => {
				const seen: number[] = [];
				const launchedAt = NOW - 3 * 60 * MIN;
				const { counts } = parkOf(
					buildLaunchAtResumeCap({
						limitParks: LIMIT_PARK_CAP - 1,
						launchedAt,
					}),
					{
						hasRepliedSince: (_, at) => {
							seen.push(at);
							return at === launchedAt;
						},
					},
				);
				expect(counts).toEqual([1]);
				expect(seen).toContain(launchedAt);
			});

			it("counts on over an unread transcript, which cannot lift the bound", () => {
				const { counts } = parkOf(buildLaunchAtResumeCap({ limitParks: 1 }), {
					hasRepliedSince: () => null,
				});
				expect(counts).toEqual([2]);
			});

			it("counts no park off a dropped seat, which routes afresh", () => {
				const counts: (number | undefined)[] = [];
				limits(
					[
						blocked({
							limitParks: 1,
							limitHeld: { at: NOW - MIN, sessionId: "s1", cwd: "/r" },
						}),
					],
					[],
					{
						seats: [planSeat({ seat: "/other" })],
						io: {
							recordParked: (_, __, { limitParks }) => {
								counts.push(limitParks);
								return null;
							},
						},
					},
				);
				expect(counts).toEqual([undefined]);
			});
		});

		it("keeps the count through a resume that runs as a copy", () => {
			const { launches } = limits(
				[blocked({ limitResumes: buildDryResumes(3) })],
				live,
				{
					io: {
						resumeStopped: () => ({
							failed: null,
							jobId: "job99",
							sessionId: "s2",
							copy: true,
							why: COPY_WHY,
						}),
					},
				},
			);
			expect(launches[0]).toMatchObject({
				jobId: "job99",
				limitResumes: { dryResumes: 4, takenAt: NOW },
			});
		});

		it("keeps the count through a resume that fails", () => {
			const { launches } = limits(
				[held({ limitResumes: buildDryResumes(3) })],
				[],
				{
					io: { resumeStopped: () => ({ failed: "no" }) },
				},
			);
			expect(launches[0]?.limitResumes).toMatchObject({
				dryResumes: 4,
				failed: "no",
			});
			expect(launches[0]?.limitResumes).not.toHaveProperty("takenAt");
		});

		it("stays blocked and logs why where a live one's stop fails, and parks once it holds", () => {
			const stuck = [blocked({ limitResumes: buildDryResumes(RESUME_CAP) })];
			const { launches, calls } = limits(stuck, live, {
				io: {
					stop: () => ({
						ok: false,
						why: "seat busy",
						said: null,
						timedOut: false,
						noJob: false,
					}),
				},
			});
			expect(launches[0]).not.toHaveProperty("parkStopped");
			expect(comments(calls)).toEqual([]);
			expect(logs(calls).join("\n")).toContain("seat busy");
			const parked = limits(launches as Launch[], live);
			expect(parked.launches[0]).toMatchObject({ parkStopped: NOW });
			expect(parked.workingChange).toBe(-1);
		});
	});

	describe("a resume judged a tick on", () => {
		const resumed = () =>
			held({ limitHeld: { ...LimitHeld, resumedAt: NOW - MIN } });

		it("goes back to held, named, where its record reads failed (#2159)", () => {
			const { launches, calls, slots } = limits([resumed()], [], {
				io: {
					jobStateOf: () => ({ state: "failed", detail: "source not found" }),
				},
			});
			expect(launches[0]?.limitHeld).not.toHaveProperty("resumedAt");
			expect(isHeld(launches[0] as Launch)).toBe(true);
			expect(comments(calls)[0]).toContain(
				"state failed after its resume: source not found",
			);
			expect(calls.some((c) => c.startsWith("confirmed"))).toBe(false);
			expect(slots).toBe(1);
		});

		it("goes back to held where its record is unread", () => {
			const { launches } = limits([resumed()], [], {
				io: { jobStateOf: () => null },
			});
			expect(isHeld(launches[0] as Launch)).toBe(true);
		});

		it("is let go on any other reading, for the listing to judge", () => {
			const { launches, calls } = limits([resumed()], [], {
				io: { jobStateOf: () => ({ state: "done" }) },
			});
			expect(launches[0]).not.toHaveProperty("limitHeld");
			expect(launches[0]).not.toHaveProperty("block");
			expect(comments(calls)).toEqual([]);
		});
	});

	describe("the dispatch-ledger hold", () => {
		const seats = [fiveHourFull];

		it("is written on the tick a session is held", () => {
			const { launches, calls } = limits(
				[blocked()],
				[agent("job42", "blocked")],
				{ seats },
			);
			const until = NOW + LIMIT_HOLD_BOUND_DAYS * DAY;
			expect(calls).toContain(`ledger job42 ${until}`);
			expect(launches[0]?.limitHeld).toMatchObject({ ledgerHeldUntil: until });
		});

		it("is written once, as it outlasts the run", () => {
			const written = held({
				limitHeld: { ...LimitHeld, ledgerHeldUntil: NOW + DAY },
			});
			expect(limits([written], [], { seats }).calls).toEqual([]);
		});

		it("is logged where the write fails, and tried again next tick", () => {
			const { launches, calls } = limits([held()], [], {
				seats,
				io: { writeLedgerHold: () => false },
			});
			expect(logs(calls).join("\n")).toContain("dispatch-ledger hold");
			expect(launches[0]?.limitHeld).not.toHaveProperty("ledgerHeldUntil");
		});

		describe("once the hold ends", () => {
			const holding = held({
				limitHeld: { ...LimitHeld, ledgerHeldUntil: NOW + DAY },
			});
			const released = (
				after: Launch[],
				before: Launch[] = [holding],
				ok = true,
			) => {
				const calls: string[] = [];
				releaseEndedHolds(before, after, {
					release: (l) => {
						calls.push(`release ${l.jobId}`);
						return ok;
					},
					writeLedgerHold: (l, until) => {
						calls.push(`row ${l.jobId} ${until}`);
						return true;
					},
					log: (line) => calls.push(`log ${line}`),
				});
				return calls;
			};

			it("is released on a launch gone off the hold, its running session taking an ordinary row", () => {
				const { limitHeld: _, ...ended } = holding;
				expect(released([ended])).toEqual([
					"release job42",
					"row job42 undefined",
				]);
			});

			it("takes no row where the launch parked or finished", () => {
				const { limitHeld: _, ...ended } = holding;
				for (const over of [{ parkStopped: NOW }, { finishedAt: NOW }])
					expect(released([{ ...ended, ...over }])).toEqual(["release job42"]);
			});

			it("comes back where a resume that gave it up fails", () => {
				const unjudged = { ...LimitHeld, resumedAt: NOW - MIN };
				const failed = limits([held({ limitHeld: unjudged })], [], {
					io: { jobStateOf: () => ({ state: "failed", detail: "no" }) },
				});
				expect(failed.calls).toContain(
					`ledger job42 ${Since + LIMIT_HOLD_BOUND_DAYS * DAY}`,
				);
				expect(failed.launches[0]?.limitHeld).toMatchObject({
					ledgerHeldUntil: Since + LIMIT_HOLD_BOUND_DAYS * DAY,
				});
			});

			it("is kept on one still held, a copy included", () => {
				expect(released([holding])).toEqual([]);
				const copy = { ...holding, jobId: "job99", copiedFrom: "job42" };
				expect(released([copy])).toEqual([]);
			});

			it("is left alone on one whose hold was never written", () => {
				const { limitHeld: _, ...ended } = held();
				expect(released([ended], [held()])).toEqual([]);
			});

			it("names how long its issues wait where the release fails", () => {
				const { limitHeld: _, ...ended } = holding;
				expect(released([ended], [holding], false).join("\n")).toContain(
					new Date(NOW + DAY).toISOString(),
				);
			});
		});
	});

	describe("a stop's line for a held launch", () => {
		const text = (limitHeld: object) =>
			buildHeldStopText(
				held({ limitHeld: { ...LimitHeld, ...limitHeld } }) as never,
			);

		it("names the session, its seat, and how long its ticket is held", () => {
			const line = text({ ledgerHeldUntil: NOW + DAY });
			expect(line).toContain("job42");
			expect(line).toContain(buildSeatName(held().seat));
			expect(line).toContain(
				`held from dispatch until ${new Date(NOW + DAY).toISOString()}`,
			);
		});

		it("says a session resumed and unjudged is that, not stopped", () => {
			const line = text({ resumedAt: NOW });
			expect(line).toContain(`resumed at ${new Date(NOW).toISOString()}`);
			expect(line).not.toContain("stopped at");
		});

		it("says a direct dispatch may take the ticket where no hold was written", () => {
			expect(text({})).toContain("a direct dispatch may take its ticket");
		});
	});

	/** held, its dispatch-ledger hold already written. */
	const ledgerHeld = () =>
		held({ limitHeld: { ...LimitHeld, ledgerHeldUntil: NOW + DAY } });

	it("logs a held one whose seat reads open, waiting on a slot, and acts on nothing", () => {
		const { launches, calls } = limits([ledgerHeld()], [], {
			slots: 0,
			mode: "normal",
		});
		expect(calls).toEqual([
			`log design-vault /implement 42 on ${Seat} reads open, and waits on a free slot`,
		]);
		expect(launches[0]).toMatchObject({
			finishedAt: null,
			limitHeld: { sessionId: "s-job42" },
		});
	});

	it("leaves a held one held, unstopped and unresumed, while its seat is spent", () => {
		const { launches, calls, slots } = limits([ledgerHeld()], [], {
			seats: [fiveHourFull],
			mode: "normal",
		});
		expect(calls).toEqual([]);
		expect(launches[0]).toMatchObject({
			finishedAt: null,
			limitHeld: { sessionId: "s-job42" },
		});
		expect(launches[0]?.limitHeld).not.toHaveProperty("resumedAt");
		expect(slots).toBe(1);
	});

	it("reads no seat with none limit-blocked", () => {
		const { io } = fakeIo();
		const out = actOnLimits([record()], "away", {
			agents: [],
			now: NOW,
			io,
			swapHold: NO_HOLD,
			typedSeat: null,
			readMoveSeats: () => {
				throw new Error("read");
			},
			seatListRead: true,
			slots: 2,
		});
		expect(out).toMatchObject({ slots: 2, workingChange: 0 });
	});

	describe("the tick's working figure (#3778)", () => {
		const Open = { seats: [planSeat()] };
		const FailedResume = { resumeStopped: () => ({ failed: "no" }) };
		const live = [agent("job42", "blocked")];
		it.each<[string, () => { workingChange: number }, number]>([
			["a held one resumed adds one", () => limits([held()], [], Open), 1],
			[
				"a live one stopped for its limit takes one off",
				() => limits([blocked()], live, { seats: [fiveHourFull] }),
				-1,
			],
			[
				"a live one resumed in place moves nothing",
				() => limits([blocked()], live, Open),
				0,
			],
			[
				"a held one staying held moves nothing",
				() => limits([held()], [], { seats: [fiveHourFull] }),
				0,
			],
			[
				"a held one whose resume failed moves nothing",
				() =>
					limits([held()], [], {
						...Open,
						io: FailedResume,
					}),
				0,
			],
			[
				"a live one whose resume failed after its stop takes one off",
				() =>
					limits([blocked()], live, {
						...Open,
						io: FailedResume,
					}),
				-1,
			],
			[
				"a live one whose stop failed moves nothing",
				() =>
					limits([blocked()], live, {
						seats: [fiveHourFull],
						io: {
							stop: () => ({
								ok: false,
								why: "no",
								said: null,
								timedOut: false,
								noJob: false,
							}),
						},
					}),
				0,
			],
			[
				"last tick's resume, judged now, moves nothing",
				() =>
					limits(
						[held({ limitHeld: { ...LimitHeld, resumedAt: NOW - MIN } })],
						[],
						Open,
					),
				0,
			],
		])("%s", (_, run, change) => {
			expect(run().workingChange).toBe(change);
		});
	});

	it("a live one whose resume failed after its stop is held, its target kept", () => {
		const { launches } = limits([blocked()], [agent("job42", "blocked")], {
			io: { resumeStopped: () => ({ failed: "no" }) },
		});
		expect(launches[0]).toMatchObject({
			limitHeld: { sessionId: "s", cwd: "/" },
		});
	});

	it("a failed stop leaves it live, named, and never resumes", () => {
		const { launches, calls } = limits(
			[blocked()],
			[agent("job42", "blocked")],
			{
				io: {
					stop: () => ({
						ok: false,
						why: "exit 1",
						said: null,
						timedOut: false,
						noJob: false,
					}),
				},
			},
		);
		expect(calls.some((c) => c.startsWith("confirmed"))).toBe(false);
		expect(launches[0]).not.toHaveProperty("limitHeld");
		expect(comments(calls)[0]).toContain("stop: exit 1");
	});

	it("tracks a resume the launcher ran as a copy as the same launch", () => {
		const { launches, calls } = limits([held()], [], {
			io: {
				resumeStopped: () => ({
					failed: null,
					jobId: "copy1",
					sessionId: "s-copy",
					copy: true,
					why: COPY_WHY,
				}),
			},
		});
		expect(launches[0]).toMatchObject({
			jobId: "copy1",
			copiedFrom: "job42",
			sessionId: "s-copy",
			pastSessionIds: ["s-job42"],
		});
		expect(comments(calls)[0]).toContain("as its copy copy1");
	});

	it("reads no plan seat's bars for an overflow session on its dir, a marker's launch or the loop's own (#4147)", () => {
		const { launches, calls } = limits(
			[blocked({ keyVar: "K2", reason: "parked session's seat" })],
			[agent("job42", "blocked")],
			{ seats: [fiveHourFull, planSeat({ seat: "/other" })] },
		);
		expect(calls).toEqual([]);
		expect(launches[0]).toMatchObject({ keyVar: "K2", seat: Seat });
		expect(launches[0]).not.toHaveProperty("limitHeld");
	});

	it("an adopter's one seat, no overflow: hold, then resume in place at reset", () => {
		const first = limits([blocked()], [agent("job42", "blocked")], {
			seats: [fiveHourFull],
		});
		expect(isHeld(first.launches[0] as Launch)).toBe(true);
		const waiting = limits(first.launches as Launch[], [], {
			seats: [fiveHourFull],
		});
		expect(waiting.calls).toEqual([]);
		const reset = limits(first.launches as Launch[], []);
		expect(reset.calls).toContain(`confirmed ${Seat} s ${LIMIT_PROMPT}`);
		expect(reset.launches[0]).toMatchObject({ limitHeld: { resumedAt: NOW } });
	});

	describe("a move onto an overflow seat (#3736)", () => {
		const weekFull = (seat: string) =>
			planSeat({
				seat,
				week: 100,
				weekFull: true,
				weekRead: { percent: 100, atMs: NOW },
				fits: null,
			});
		const key = (fits: number) => ({
			seat: Seat,
			keyVar: "K3",
			fits,
			headroomUsd: 42.5,
			spentUntil: null,
			why: null,
		});
		const weekly = (over: Record<string, unknown> = {}) =>
			blocked({
				limitHeld: { ...LimitHeld, limit: { bar: "weekly", resets: null } },
				...over,
			});

		it.each(["away", "normal"] as const)(
			"%s: moves a weekly-blocked session onto the key once every plan seat is weekly-full, charged the headroom",
			(mode) => {
				const { launches, calls } = limits(
					[weekly()],
					[agent("job42", "blocked")],
					{
						seats: [weekFull(Seat), weekFull("/other")],
						overflow: [key(1)],
						mode,
					},
				);
				expect(calls).toContain(`move job42 ${Seat} ${Seat} key=K3 s-job42`);
				expect(launches[0]).toMatchObject({
					seat: Seat,
					keyVar: "K3",
					reason: `moved from ${Seat}`,
					limitHeld: {
						resumedAt: NOW,
						movedFrom: { seat: Seat, jobId: "job42" },
					},
				});
				expect(comments(calls)).toHaveLength(1);
				expect(comments(calls)[0]).toContain(
					`from ${Seat} to ${Seat} on overflow key K3`,
				);
				expect(comments(calls)[0]).toContain("its allowance there $42.50");
			},
		);

		it("hands the move the key and its headroom as the allowance", () => {
			const targets: unknown[] = [];
			limits([weekly()], [agent("job42", "blocked")], {
				seats: [weekFull(Seat), weekFull("/other")],
				overflow: [key(1)],
				io: {
					moveSession: (_l, target) => {
						targets.push(target);
						return {
							failed: null,
							jobId: "copy1",
							sessionId: "s-copy",
							copy: true,
							why: COPY_WHY,
						};
					},
				},
			});
			expect(targets).toEqual([
				{ seat: Seat, keyVar: "K3", allowanceUsd: 42.5 },
			]);
		});

		it("moves nothing onto a key whose headroom is unread (#3730)", () => {
			const { calls } = limits([weekly()], [agent("job42", "blocked")], {
				seats: [weekFull(Seat), weekFull("/other")],
				overflow: [{ ...key(1), headroomUsd: undefined }],
			});
			expect(calls.filter((c) => c.startsWith("move "))).toEqual([]);
		});

		it("holds a 5-hour block while another plan seat is not weekly-full, whatever the key fits", () => {
			const { launches, calls } = limits(
				[blocked()],
				[agent("job42", "blocked")],
				{
					seats: [fiveHourFull, { ...fiveHourFull, seat: "/other" }],
					overflow: [key(3)],
				},
			);
			expect(calls.filter((c) => c.startsWith("move "))).toEqual([]);
			expect(launches[0]).not.toHaveProperty("keyVar");
			expect(launches[0]).toHaveProperty("limitHeld");
			const one = limits([ledgerHeld()], [], {
				seats: [fiveHourFull],
				overflow: [key(3)],
				mode: "normal",
			});
			expect(one.calls).toEqual([]);
			expect(one.launches[0]).not.toHaveProperty("keyVar");
			expect(one.launches[0]).toMatchObject({ seat: Seat, limitHeld: {} });
		});

		it("holds where every plan seat is weekly-full and the key fits none", () => {
			const { launches, calls } = limits(
				[weekly()],
				[agent("job42", "blocked")],
				{ seats: [weekFull(Seat)], overflow: [key(0)] },
			);
			expect(calls.filter((c) => c.startsWith("move "))).toEqual([]);
			expect(launches[0]).toMatchObject({ seat: Seat, limitHeld: {} });
		});

		it("moves one session a tick onto a key, the next waiting on a fresh sizing", () => {
			const other = weekly({ jobId: "job43", sessionId: "s-job43" });
			const { calls } = limits(
				[weekly(), other],
				[agent("job42", "blocked"), agent("job43", "blocked")],
				{ seats: [weekFull(Seat)], overflow: [key(5)], slots: 2 },
			);
			expect(calls.filter((c) => c.startsWith("move "))).toHaveLength(1);
		});

		it("puts a failed copy back on the plan seat it left, its job, session and no key", () => {
			const moved = limits([weekly()], [agent("job42", "blocked")], {
				seats: [weekFull(Seat)],
				overflow: [key(1)],
				io: {
					moveSession: () => ({
						failed: null,
						jobId: "copy1",
						sessionId: "s-copy",
						copy: true,
						why: COPY_WHY,
					}),
				},
			}).launches as Launch[];
			expect(moved[0]).toMatchObject({ jobId: "copy1", keyVar: "K3" });
			const { launches, calls } = limits(moved, [], {
				seats: [weekFull(Seat)],
				io: { jobStateOf: () => ({ state: "failed", detail: "nope" }) },
			});
			expect(launches[0]).toMatchObject({
				seat: Seat,
				jobId: "job42",
				sessionId: "s-job42",
			});
			expect(launches[0]).not.toHaveProperty("keyVar");
			expect(launches[0]).not.toHaveProperty("copiedFrom");
			expect(calls).toContain("stop copy1");
			expect(comments(calls)[0]).toContain("could not move");
		});

		it("removes the job it left once a copy on the same dir took, never the copy's", () => {
			const moved = limits([weekly()], [agent("job42", "blocked")], {
				seats: [weekFull(Seat)],
				overflow: [key(1)],
				io: {
					moveSession: () => ({
						failed: null,
						jobId: "copy1",
						sessionId: "s-copy",
						copy: true,
						why: COPY_WHY,
					}),
				},
			}).launches as Launch[];
			const removed: string[] = [];
			const { launches } = limits(moved, [], {
				seats: [weekFull(Seat)],
				io: {
					removeJobRecord: (seat, sessionId) => {
						removed.push(`${seat} ${sessionId}`);
						return null;
					},
				},
			});
			expect(removed).toEqual([`${Seat} s-job42`]);
			expect(launches[0]).toMatchObject({ jobId: "copy1", keyVar: "K3" });
		});
	});

	describe("a move to another seat (#3734)", () => {
		const other = () => planSeat({ seat: "/other" });
		const moveLine = (from: string, to: string) => `move job42 ${from} ${to} s`;

		it.each(["away", "normal"] as const)(
			"%s: stops it, moves it, rewrites seat and reason, comments once",
			(mode) => {
				const { launches, calls } = limits(
					[blocked()],
					[agent("job42", "blocked")],
					{ seats: [fiveHourFull, other()], mode },
				);
				expect(calls.indexOf("stop job42")).toBeLessThan(
					calls.indexOf(moveLine(Seat, "/other")),
				);
				expect(launches[0]).toMatchObject({
					seat: "/other",
					reason: `moved from ${Seat}`,
					jobId: "job42",
					relaunchedAt: NOW,
					limitHeld: { resumedAt: NOW, movedFrom: { seat: Seat } },
				});
				expect(comments(calls)).toHaveLength(1);
				expect(comments(calls)[0]).toContain(`from ${Seat} to /other`);
				expect(comments(calls)[0]).toContain("5-hour limit");
				expect(comments(calls)[0]).toContain("Lost: its in-flight subagents");
			},
		);

		it("moves a held one as another seat opens, unstopped, taking a slot", () => {
			const { launches, calls, slots, workingChange } = limits([held()], [], {
				seats: [fiveHourFull, other()],
				slots: 1,
			});
			expect(calls).not.toContain("stop job42");
			expect(calls).toContain(`move job42 ${Seat} /other s-job42`);
			expect(launches[0]).toMatchObject({ seat: "/other" });
			expect(slots).toBe(0);
			expect(workingChange).toBe(1);
		});

		it("leaves a failed move held on its old seat, naming why in the log and a comment", () => {
			const { launches, calls } = limits(
				[blocked()],
				[agent("job42", "blocked")],
				{
					seats: [fiveHourFull, other()],
					io: { moveSession: () => ({ failed: "state failed: nope" }) },
				},
			);
			expect(launches[0]).toMatchObject({
				seat: Seat,
				limitHeld: { failedTries: 1, sessionId: "s" },
			});
			expect(launches[0].limitHeld).not.toHaveProperty("resumedAt");
			expect(launches[0]).not.toHaveProperty("relaunchedAt");
			expect(logs(calls).join("\n")).toContain("state failed: nope");
			expect(comments(calls)[0]).toContain("could not move");
			expect(comments(calls)[0]).toContain("state failed: nope");
		});

		it("takes a failed move's resume back to the old seat a tick on", () => {
			const moved = limits(
				[blocked({ reason: "last typed on" })],
				[agent("job42", "blocked")],
				{ seats: [fiveHourFull, other()] },
			).launches as Launch[];
			const { launches, calls } = limits(moved, [], {
				seats: [fiveHourFull, other()],
				io: { jobStateOf: () => ({ state: "failed", detail: "nope" }) },
			});
			expect(launches[0]).toMatchObject({
				seat: Seat,
				reason: "last typed on",
			});
			expect(launches[0].limitHeld).not.toHaveProperty("movedFrom");
			expect(comments(calls)[0]).toContain("could not move");
		});

		it("settles a move that took, and stops address its new seat", () => {
			const moved = limits([blocked()], [agent("job42", "blocked")], {
				seats: [fiveHourFull, other()],
			}).launches as Launch[];
			const { launches, calls } = limits(moved, [], {
				seats: [fiveHourFull, other()],
			});
			expect(calls).toContain(`rm on ${Seat}`);
			expect(launches[0]).toMatchObject({ seat: "/other", finishedAt: null });
			expect(launches[0]).not.toHaveProperty("limitHeld");
			const stops: string[] = [];
			const again = limits(
				[{ ...launches[0], parked: true, block: blocked().block } as Launch],
				[agent("job42", "blocked")],
				{
					seats: [fiveHourFull, { ...fiveHourFull, seat: "/other" }],
					io: {
						stop: (seat, id) => {
							stops.push(`${seat} ${id}`);
							return { ok: true, said: "" };
						},
					},
				},
			);
			expect(again.launches[0]).toHaveProperty("limitHeld");
			expect(stops).toEqual(["/other job42"]);
		});

		it("dates a moved session's block at the move, keeps the seat it left, and spaces no next move", () => {
			const { launches } = limits([blocked()], [agent("job42", "blocked")], {
				seats: [fiveHourFull, other()],
			});
			expect(launches[0]).toMatchObject({
				block: { since: NOW },
				limitLeft: [{ seat: Seat, since: Since }],
				limitResumes: { nextAt: NOW },
			});
		});

		it("stops a resume that reads failed a tick on, before going back", () => {
			const moved = limits([blocked()], [agent("job42", "blocked")], {
				seats: [fiveHourFull, other()],
			}).launches as Launch[];
			const stops: string[] = [];
			limits(moved, [], {
				seats: [fiveHourFull, other()],
				io: {
					jobStateOf: () => null,
					stop: (seat) => {
						stops.push(seat);
						return { ok: true, said: "" };
					},
				},
			});
			expect(stops).toEqual(["/other"]);
		});

		it("takes one move per seat a tick, the seat being sized for one", () => {
			const twin = blocked({ jobId: "job43" });
			const { launches, calls } = limits(
				[blocked(), twin],
				[agent("job42", "blocked"), agent("job43", "blocked")],
				{ seats: [fiveHourFull, other()] },
			);
			expect(calls.filter((c) => c.startsWith("move "))).toHaveLength(1);
			expect(launches[1]).toMatchObject({
				seat: Seat,
				limitHeld: { sessionId: "s" },
			});
		});
	});

	it("acts on nothing off an unread listing, nor a launch on no plan seat", () => {
		expect(limits([blocked()], null).calls).toEqual([]);
		expect(
			limits([blocked({ seat: "/api" })], [agent("job42", "blocked")]).calls,
		).toEqual([]);
	});

	it("keeps a held launch through a listing that drops it or shows it ended", () => {
		const causeOf = () => ({ cause: "LIMIT" as const });
		for (const agents of [[], [agent("job42", "stopped")]]) {
			const [l] = markParked([held()], agents, causeOf, NOW);
			expect(l).toMatchObject({ limitHeld: LimitHeld, finishedAt: null });
		}
	});

	it("lets go of one the listing shows live again", () => {
		const causeOf = () => ({ cause: "LIMIT" as const });
		const [l] = markParked([held()], [agent("job42", "working")], causeOf, NOW);
		expect(l).not.toHaveProperty("limitHeld");
	});

	it("leaves the other acts' pass alone: actOnBlocks takes no limit block", () => {
		const { calls } = blocks([blocked()], [agent("job42", "blocked")], "away");
		expect(calls).toEqual([]);
	});

	describe("the unproven cap across a limit restart (#4684)", () => {
		const Act = NOW - 30 * MIN;
		const unproven = [0, 1, 2].map((i) =>
			record({ jobId: `u${i}`, launchedAt: Act + 1 + i }),
		);
		const room = (launches: Launch[]) =>
			unprovenRoom({
				/* One unproven launch finishes: its room comes back. */
				history: launches.map((l) =>
					l.jobId === "u0" ? { ...l, finishedAt: NOW } : l,
				),
				lastActAt: Act,
			});

		it("leaves a live one resumed in place, with three unproven running, dated by its launch", () => {
			const { launches, workingChange } = limits(
				[...unproven, blocked({ launchedAt: Act - 60 * MIN })],
				[agent("job42", "blocked")],
				{ slots: 0 },
			);
			expect(launches[3]).toMatchObject({
				relaunchedAt: NOW,
				limitHeld: { resumedAt: NOW },
			});
			expect(launches[3]).not.toHaveProperty("slotTakenAt");
			expect(workingChange).toBe(0);
			expect(room(launches)).toBe(1);
		});

		it("counts a held one resumed into a slot from its resume", () => {
			const { launches } = limits(
				[...unproven.slice(1), held({ launchedAt: Act - 60 * MIN })],
				[],
				{ slots: 1 },
			);
			expect(launches[2]).toMatchObject({ slotTakenAt: NOW });
			expect(room(launches)).toBe(0);
		});
	});

	it("reads a held one neither resumed-idle nor owed anything by actOnIdle", () => {
		const { io, calls } = fakeIo({ idleSince: () => NOW - 60 * MIN });
		actOnIdle([held()], "away", {
			agents: [],
			now: NOW,
			io,
			swapHold: NO_HOLD,
		});
		expect(calls).toEqual([]);
	});
});
