// @vitest-environment node
/*
 * Holds the refill loop's resumes of background sessions it did not launch
 * (lib/refill-outside.js, #4815) to their acts through the BlockIo double:
 * typed into on #2359's schedule, left alone once the founder types, held
 * back while the network is down with no try spent, fallen back to a stop and
 * --bg --resume only where no prompt reached them since the stop, and at the
 * cap left blocked with no park, label, comment or stop; one stopped whose
 * relaunch failed relaunched again within minutes on a bounded budget that
 * spends no try, and once more at the cap (#4871); a copy's original
 * that would not retire tried again on later ticks, its record kept until
 * then (#4829). Loosen it and the loop talks over the founder, burns its tries
 * offline, starts a second session beside one already resumed, leaves a
 * founder's session stopped for half an hour or for good, leaves an
 * original live as a second row beside its copy, or parks a ticket it does
 * not own.
 */
import { expect, it } from "vitest";
import { COPY_WHY } from "./bg-resume-fake";
import { nextTryAt, RESUME_CAP } from "./block-act.js";
import type { Reading } from "./block-cause.js";
import { API_PROMPT } from "./loop-prompts.js";
import { NET_PROBE_OFFLINE_LINE } from "./net-probe-fake";
import { logNetWaits } from "./refill-blocks.js";
import {
	type BlockIo,
	fakeIo,
	type Launch,
	logs,
	MIN,
	NO_HOLD,
	NOW,
	record,
} from "./refill-blocks-fixture";
import { actOnOutside } from "./refill-outside.js";

const SEAT = "/home/u/.claude";
const row = (state = "blocked") => ({
	sessionId: "sess-f1",
	id: "f1",
	name: "founder-session",
	kind: "background",
	state,
	seat: SEAT,
	cwd: "/home/u/work",
});
const TRANSIENT: Reading = { cause: "API_ERROR", sub: "transient" };
const NAME = "founder-session (f1, started outside the loop)";

/** One loop process: its records and call log kept across ticks. */
function loop(over: Partial<BlockIo> = {}) {
	const { io, calls } = fakeIo(over);
	return {
		io,
		calls,
		/** One tick at `now` over a registry of `rows`. */
		tick(
			now: number,
			{
				rows = [row()],
				reading = TRANSIENT,
				launches = [] as Launch[],
				barred = false,
			} = {},
		) {
			const seen = {
				agents: rows,
				now,
				io,
				swapHold: NO_HOLD,
				...(barred ? { barred } : {}),
			};
			actOnOutside(launches, rows, () => reading, seen);
			logNetWaits(seen);
		},
	};
}

const typed = (calls: string[]) => calls.filter((c) => c === "type f1").length;

it("reads the cause of a session it did not launch under that session's own name (#4825)", () => {
	const { io } = fakeIo();
	const names: string[] = [];
	actOnOutside(
		[],
		[row()],
		(_l, _row, name) => {
			names.push(name);
			return { cause: "QUESTION" };
		},
		{ agents: [row()], now: NOW, io, swapHold: NO_HOLD },
	);
	expect(names).toEqual([NAME]);
});

it("types a resume into a founder-started session blocked on a transient API error, on the schedule", () => {
	const l = loop();
	l.tick(NOW);
	expect(typed(l.calls)).toBe(1);
	expect(logs(l.calls)).toContain(
		`resume 1 of ${RESUME_CAP} after an API error, ${NAME}, by typing into the live session; next due ${new Date(NOW + 4 * MIN).toISOString()}`,
	);
	/* The typed line arrived; the session blocks again on the next drop. */
	l.io.readTimeline = () => [
		{ at: new Date(NOW + 1000).toISOString(), detail: API_PROMPT },
	];
	l.tick(NOW + 2 * MIN);
	expect(typed(l.calls)).toBe(1);
	l.tick(NOW + 4 * MIN);
	expect(typed(l.calls)).toBe(2);
	expect(l.calls).not.toContain("stop f1");
});

it("leaves one the founder typed into since its stop alone, and says why once", () => {
	const l = loop({ hasFounderTypedSinceStop: () => true });
	l.tick(NOW);
	l.tick(NOW + 60 * MIN);
	expect(typed(l.calls)).toBe(0);
	expect(
		logs(l.calls).filter((s) => s.startsWith(`leaving ${NAME} alone`)),
	).toEqual([
		`leaving ${NAME} alone: the founder typed into it since its API-error stop`,
	]);
});

it("leaves one alone while its transcript cannot tell whether the founder typed, then resumes it once it can", () => {
	let read: boolean | null = null;
	const l = loop({ hasFounderTypedSinceStop: () => read });
	l.tick(NOW);
	l.tick(NOW + 60 * MIN);
	expect(typed(l.calls)).toBe(0);
	expect(l.calls).not.toContain("stop f1");
	expect(
		logs(l.calls).filter((s) => s.startsWith(`leaving ${NAME} alone`)),
	).toEqual([
		`leaving ${NAME} alone while its transcript is unread or shows no API-error stop, so whether the founder typed since cannot be told`,
	]);
	read = false;
	l.tick(NOW + 61 * MIN);
	expect(typed(l.calls)).toBe(1);
});

it("holds a due resume back while the network is down, no try spent, then types once it is up", () => {
	let why: string | null = NET_PROBE_OFFLINE_LINE;
	const l = loop({ probeNetwork: () => why });
	l.tick(NOW);
	l.tick(NOW + 10 * MIN);
	expect(typed(l.calls)).toBe(0);
	expect(logs(l.calls)).toContain(
		`the API host is unreachable (${NET_PROBE_OFFLINE_LINE}), so these due resumes wait for the next tick, no try spent: ${NAME}`,
	);
	why = null;
	l.tick(NOW + 11 * MIN);
	expect(typed(l.calls)).toBe(1);
	expect(logs(l.calls).at(-1)).toMatch(/^resume 1 of /);
});

it("probes the network once a tick, and not at all where nothing is due", () => {
	const l = loop();
	l.tick(NOW, { rows: [row(), { ...row(), id: "f2", sessionId: "s2" }] });
	expect(l.calls.filter((c) => c === "probe")).toEqual(["probe"]);
	l.calls.length = 0;
	l.tick(NOW + MIN, { rows: [row("working")] });
	expect(l.calls).not.toContain("probe");
});

it("falls back to a stop and --bg --resume under its own id where the typed resume is unseen", () => {
	const l = loop({
		resumeTargetOf: () => ({ sessionId: "sess-f1-full", cwd: "/home/u/work" }),
		resumeStopped: (launch, prompt, target) => {
			resumes.push(
				`${launch.jobId} ${target.sessionId} ${prompt === API_PROMPT}`,
			);
			return { failed: null, jobId: "f1", sessionId: "s", copy: false };
		},
	});
	const resumes: string[] = [];
	l.tick(NOW);
	l.tick(NOW + 2 * MIN);
	expect(l.calls).toContain("stop f1");
	expect(resumes).toEqual(["f1 sess-f1-full true"]);
	expect(logs(l.calls)).toContain(
		`resumed ${NAME} by --bg --resume, woken in place`,
	);
});

it("neither stops nor copies one that took a prompt since its stop, and counts the resume arrived", () => {
	const l = loop({ isResumedSinceStop: () => true });
	l.tick(NOW);
	l.tick(NOW + 2 * MIN);
	expect(l.calls).not.toContain("stop f1");
	expect(l.calls.some((c) => c.startsWith("resume "))).toBe(false);
	expect(logs(l.calls)).toContain(
		`${NAME}'s session took a turn since its API-error stop, so it is neither stopped nor copied: its resume counts as arrived`,
	);
});

it("neither stops nor copies one where whether it took a turn since its stop cannot be told, and types again when next due (#4873)", () => {
	const l = loop({ isResumedSinceStop: () => null });
	l.tick(NOW);
	l.tick(NOW + 2 * MIN);
	expect(l.calls).not.toContain("stop f1");
	expect(l.calls.some((c) => c.startsWith("resume "))).toBe(false);
	expect(logs(l.calls)).toContain(
		`${NAME}'s transcript shows no API-error stop, and its timeline is unread or the loop holds no time for the stop, so whether its session took a turn since cannot be told: it is neither stopped nor copied this try`,
	);
	l.tick(NOW + 4 * MIN);
	expect(typed(l.calls)).toBe(2);
});

it("at the cap stops trying, says so, and neither parks, labels, comments on nor stops it", () => {
	const labelled: string[] = [];
	const l = loop({
		labelParked: () => {
			labelled.push("label");
			return [];
		},
		/* Every typed resume arrives, and every resumed turn drops again. */
		readTimeline: () => [
			{
				at: new Date(NOW + 365 * 24 * 60 * MIN).toISOString(),
				detail: API_PROMPT,
			},
		],
	});
	let now = NOW;
	for (let i = 0; i < 40; i++) {
		l.tick(now);
		now += 30 * MIN;
	}
	expect(typed(l.calls)).toBe(RESUME_CAP);
	expect(logs(l.calls)).toContain(
		`stopped trying to resume ${NAME} after ${RESUME_CAP} resumes: it stays blocked on its last error`,
	);
	expect(labelled).toEqual([]);
	expect(
		l.calls.filter(
			(c) =>
				c.startsWith("comment") ||
				c.startsWith("record") ||
				c.startsWith("stop"),
		),
	).toEqual([]);
});

it("takes up no loop launch, no print-mode run and none blocked on anything but a transient API error", () => {
	const l = loop();
	l.tick(NOW, { launches: [record({ jobId: "f1" })] });
	l.tick(NOW, { rows: [{ ...row(), kind: "headless" }] });
	l.tick(NOW, { reading: { cause: "API_ERROR", sub: "auth" } });
	l.tick(NOW, { reading: { cause: "QUESTION" } as Reading });
	expect(typed(l.calls)).toBe(0);
});

it("types nothing on a barred tick, nor off an unread listing", () => {
	const l = loop();
	l.tick(NOW, { barred: true });
	const { io, calls } = fakeIo();
	actOnOutside([], [row()], () => TRANSIENT, {
		agents: null,
		now: NOW,
		io,
		swapHold: NO_HOLD,
	});
	expect(typed(l.calls) + typed(calls)).toBe(0);
});

it("names a copy its fallback started, and follows the session onto it", () => {
	const l = loop();
	l.tick(NOW);
	l.tick(NOW + 2 * MIN);
	expect(logs(l.calls)).toContain(
		`resumed ${NAME} by --bg --resume, as its copy f1-copy (${COPY_WHY})`,
	);
	expect(l.io.readOutside()).toMatchObject([{ jobId: "f1-copy", tries: 1 }]);
});

const WHY = "the launcher named no job";
const at = (ms: number) => new Date(ms).toISOString();

/**
 * A loop whose first typed resume goes unseen, so its second tick stops the
 * session, and whose every --bg --resume fails while `fails()`: `resumedAt`,
 * the minutes past NOW of each one.
 */
function stoppedLoop(fails: () => boolean, over: Partial<BlockIo> = {}) {
	const resumedAt: number[] = [];
	let clock = NOW;
	const l = loop({
		resumeStopped: (launch) => {
			l.calls.push(`resume ${launch.jobId}`);
			resumedAt.push((clock - NOW) / MIN);
			return fails()
				? { failed: WHY }
				: { failed: null, jobId: "f1", sessionId: "s", copy: false };
		},
		...over,
	});
	const tick = (now: number, opts: Parameters<typeof l.tick>[1] = {}) => {
		clock = now;
		l.tick(now, { rows: [], ...opts });
	};
	tick(NOW, { rows: [row()] });
	tick(NOW + 2 * MIN, { rows: [row()] });
	return { ...l, tick, resumedAt };
}

it("relaunches a session it stopped whose --bg --resume failed a minute later, no try spent", () => {
	let fail = true;
	const l = stoppedLoop(() => fail);
	expect(l.resumedAt).toEqual([2]);
	expect(logs(l.calls)).toContain(
		`could not resume ${NAME} by --bg --resume: ${WHY}; it stays stopped until the next attempt, due ${at(NOW + 3 * MIN)}`,
	);
	l.tick(NOW + 3 * MIN - 1);
	expect(l.resumedAt).toEqual([2]);
	fail = false;
	l.tick(NOW + 3 * MIN);
	expect(l.resumedAt).toEqual([2, 3]);
	expect(l.calls.filter((c) => c === "stop f1")).toHaveLength(1);
	expect(logs(l.calls).at(-1)).toBe(
		`resumed ${NAME} by --bg --resume, woken in place`,
	);
	l.tick(nextTryAt(1, NOW), { rows: [row()] });
	expect(logs(l.calls).at(-1)).toMatch(
		new RegExp(`^resume 2 of ${RESUME_CAP} after an API error`),
	);
});

it("re-attempts a relaunch that keeps failing 3 times at doubling gaps, then waits for its scheduled try, which earns 3 more", () => {
	const l = stoppedLoop(() => true);
	for (let m = 3; m <= 15; m++) l.tick(NOW + m * MIN);
	/* Try 2, due at 4 min, replaces the re-attempt due at 5; try 3 is due at
	 * 14, after the three that follow try 2 at 5, 7 and 11. */
	expect(l.resumedAt).toEqual([2, 3, 4, 5, 7, 11, 14, 15]);
	const lines = logs(l.calls);
	expect(lines).toContain(
		`re-attempt 1 of 3 to resume ${NAME} by --bg --resume failed: ${WHY}; it stays stopped until the next attempt, due ${at(NOW + 4 * MIN)}`,
	);
	expect(lines).toContain(
		`re-attempt 2 of 3 to resume ${NAME} by --bg --resume failed: ${WHY}; it stays stopped until the next attempt, due ${at(NOW + 11 * MIN)}`,
	);
	expect(lines).toContain(
		`re-attempt 3 of 3 to resume ${NAME} by --bg --resume failed: ${WHY}; it stays stopped until the next attempt, due ${at(NOW + 14 * MIN)}`,
	);
	expect(typed(l.calls)).toBe(1);
	expect(l.calls.filter((c) => c === "stop f1")).toHaveLength(1);
});

it("makes no re-attempt, and spends none, on a tick with the network down or launching barred", () => {
	let why: string | null = null;
	const l = stoppedLoop(() => true, { probeNetwork: () => why });
	why = NET_PROBE_OFFLINE_LINE;
	l.tick(NOW + 3 * MIN);
	expect(logs(l.calls).at(-1)).toBe(
		`the API host is unreachable (${NET_PROBE_OFFLINE_LINE}), so these due resumes wait for the next tick, no try spent: ${NAME}`,
	);
	why = null;
	l.tick(NOW + 3 * MIN + 1, { barred: true });
	expect(l.resumedAt).toEqual([2]);
	l.tick(NOW + 3 * MIN + 2);
	expect(l.resumedAt).toHaveLength(2);
	expect(logs(l.calls).at(-1)).toMatch(/^re-attempt 1 of 3 /);
});

/**
 * Tick `l` each minute until its scheduled tries and the re-attempts of the
 * last are spent: the minute after.
 */
function tickToSpent(l: ReturnType<typeof stoppedLoop>) {
	const isSpent = () => {
		const lines = logs(l.calls);
		return (
			lines.filter((s) => s.startsWith("could not resume")).length ===
				RESUME_CAP && /^re-attempt 3 of 3 /.test(lines.at(-1) ?? "")
		);
	};
	let m = 3;
	for (; !isSpent(); m++) l.tick(NOW + m * MIN);
	return m;
}

it("at the cap makes one last relaunch of a session it holds stopped before it logs and drops it", () => {
	const l = stoppedLoop(() => true);
	for (let m = 3; m <= 9 * 60; m++) l.tick(NOW + m * MIN);
	const drop = l.calls.indexOf(
		`log stopped trying to resume ${NAME} after ${RESUME_CAP} resumes, its last --bg --resume failing too (${WHY}): it stays stopped on its last error`,
	);
	expect(l.calls[drop - 1]).toBe("resume f1");
	expect(l.calls.slice(drop + 1)).toEqual([]);
	/* 3 re-attempts a scheduled try and the last one bound it at 65; the two
	 * tries whose gaps are shorter than 7 min spend fewer. */
	expect(l.resumedAt.length).toBeGreaterThan(RESUME_CAP);
	expect(l.resumedAt.length).toBeLessThanOrEqual(65);
	expect(typed(l.calls)).toBe(1);
});

it("holds the last relaunch, unspent, while the network is down", () => {
	let why: string | null = null;
	const l = stoppedLoop(() => true, { probeNetwork: () => why });
	let m = tickToSpent(l);
	why = NET_PROBE_OFFLINE_LINE;
	const made = l.resumedAt.length;
	for (const end = m + 60; m < end; m++) l.tick(NOW + m * MIN);
	expect(l.resumedAt).toHaveLength(made);
	why = null;
	l.tick(NOW + m * MIN);
	expect(l.resumedAt).toHaveLength(made + 1);
	expect(logs(l.calls).at(-1)).toMatch(/it stays stopped on its last error$/);
});

it("leaves a session its last relaunch set live alone where it blocks again, saying it stays blocked", () => {
	let fail = true;
	const l = stoppedLoop(() => fail);
	let m = tickToSpent(l);
	fail = false;
	for (; logs(l.calls).at(-1)?.startsWith("re-attempt"); m++)
		l.tick(NOW + m * MIN);
	expect(logs(l.calls).at(-1)).toBe(
		`resumed ${NAME} by --bg --resume, woken in place`,
	);
	const made = l.resumedAt.length;
	for (const end = m + 120; m < end; m++)
		l.tick(NOW + m * MIN, { rows: [row()] });
	expect(logs(l.calls).at(-1)).toBe(
		`stopped trying to resume ${NAME} after ${RESUME_CAP} resumes: it stays blocked on its last error`,
	);
	expect(l.resumedAt).toHaveLength(made);
	expect(typed(l.calls)).toBe(1);
	expect(l.calls.filter((c) => c === "stop f1")).toHaveLength(1);
});

it("starts afresh on a later stop once a capped session took a turn", () => {
	const l = loop({
		readTimeline: () => [
			{
				at: new Date(NOW + 365 * 24 * 60 * MIN).toISOString(),
				detail: API_PROMPT,
			},
		],
	});
	let now = NOW;
	for (let i = 0; i < 40; i++, now += 30 * MIN) l.tick(now);
	expect(typed(l.calls)).toBe(RESUME_CAP);
	l.tick(now, { rows: [row("working")] });
	expect(l.io.readOutside()).toEqual([]);
	l.tick(now + MIN);
	expect(typed(l.calls)).toBe(RESUME_CAP + 1);
});

it("retries, on later ticks, the retirement of a copy's original that would not retire, keeping the record until it is retired", () => {
	const unretired = {
		seat: SEAT,
		sessionId: "sess-f1-full",
		cwd: "/home/u/work",
		copyJobId: "f1-copy",
		tries: 1,
	};
	const answers: (string | null)[] = ["the daemon is busy", null];
	const retires: string[] = [];
	const l = loop({
		resumeStopped: () => ({
			failed: null,
			jobId: "f1-copy",
			sessionId: "s",
			copy: true,
			why: COPY_WHY,
			unretired,
		}),
		retireJob: (_seat, sessionId) => {
			retires.push(sessionId);
			return answers.shift() ?? null;
		},
	});
	l.tick(NOW);
	l.tick(NOW + 2 * MIN);
	expect(l.io.readOutside()).toMatchObject([
		{ jobId: "f1-copy", unretired: [unretired] },
	]);
	expect(retires).toEqual([]);
	/* The copy is not listed, yet its record stays for the retirement. */
	l.tick(NOW + 3 * MIN, { rows: [] });
	expect(retires).toEqual(["sess-f1-full"]);
	expect(l.io.readOutside()).toMatchObject([
		{ jobId: "f1-copy", unretired: [{ ...unretired, tries: 2 }] },
	]);
	l.tick(NOW + 4 * MIN, { rows: [] });
	expect(retires).toEqual(["sess-f1-full", "sess-f1-full"]);
	expect(logs(l.calls)).toContain(
		"retired original sess-f1- of founder-session (f1-copy, started outside the loop)'s copy f1-copy",
	);
	expect(l.io.readOutside()).toEqual([]);
	l.tick(NOW + 5 * MIN, { rows: [] });
	expect(retires).toHaveLength(2);
});

const UNRETIRED = {
	seat: SEAT,
	sessionId: "sess-f1-full",
	cwd: "/home/u/work",
	copyJobId: "f1-copy",
	tries: 1,
};
const COPY_NAME = "founder-session (f1-copy, started outside the loop)";
const copyRow = (state = "blocked") => ({
	...row(state),
	id: "f1-copy",
	sessionId: "s",
});

it("gives up on an original out of tries with a log, no comment, and drops the record", () => {
	const l = loop({ retireJob: () => "the daemon is busy" });
	l.io.writeOutside([
		{
			seat: SEAT,
			jobId: "f1-copy",
			name: "founder-session",
			cwd: "/home/u/work",
			sessionId: "s",
			tries: 1,
			unretired: [UNRETIRED],
		},
	]);
	l.tick(NOW, { rows: [] });
	expect(l.io.readOutside()).toHaveLength(1);
	l.tick(NOW + MIN, { rows: [] });
	expect(l.io.readOutside()).toEqual([]);
	expect(logs(l.calls)).toContain(
		`${COPY_NAME}: two rows of this session are live in \`claude agents\` on ${SEAT}: original job sess-f1- and its copy f1-copy. The original would not retire after 3 tries (the daemon is busy); stop and remove it by hand (\`claude stop sess-f1-\`, then \`claude rm sess-f1-\`) so only the copy is revived.`,
	);
	expect(l.calls.filter((c) => c.startsWith("comment"))).toEqual([]);
});

it("keeps a capped copy's record for its unretired original, yet resumes the copy's next stop afresh", () => {
	const l = loop({ retireJob: () => "the daemon is busy" });
	l.io.writeOutside([
		{
			seat: SEAT,
			jobId: "f1-copy",
			name: "founder-session",
			cwd: "/home/u/work",
			sessionId: "s",
			since: NOW - 60 * MIN,
			tries: RESUME_CAP,
			capped: true,
			unretired: [{ ...UNRETIRED, tries: 0 }],
		},
	]);
	l.tick(NOW, { rows: [copyRow("working")] });
	expect(l.io.readOutside()).toEqual([
		expect.objectContaining({ jobId: "f1-copy", tries: 0 }),
	]);
	expect(l.io.readOutside()[0]).not.toHaveProperty("capped");
	l.tick(NOW + MIN, { rows: [copyRow()] });
	expect(l.calls).toContain("type f1-copy");
});

it("takes up no copy's unretired original as a session of its own", () => {
	const l = loop({ retireJob: () => "the daemon is busy" });
	l.io.writeOutside([
		{
			seat: SEAT,
			jobId: "f1-copy",
			name: "founder-session",
			cwd: "/home/u/work",
			sessionId: "s",
			tries: 1,
			unretired: [{ ...UNRETIRED, tries: 0 }],
		},
	]);
	l.tick(NOW, { rows: [{ ...row(), id: "sess-f1-" }] });
	expect(l.calls.filter((c) => c.startsWith("type"))).toEqual([]);
});
