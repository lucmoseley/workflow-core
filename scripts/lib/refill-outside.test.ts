// @vitest-environment node
/*
 * Holds the refill loop's resumes of background sessions it did not launch
 * (lib/refill-outside.js, #4815) to their acts through the BlockIo double:
 * typed into on #2359's schedule, left alone once the founder types, held
 * back while the network is down with no try spent, fallen back to a stop and
 * --bg --resume only where no prompt reached them since the stop, and at the
 * cap left blocked with no park, label, comment or stop. Loosen it and the
 * loop talks over the founder, burns its tries offline, starts a second
 * session beside one already resumed, or parks a ticket it does not own.
 */
import { expect, it } from "vitest";
import { RESUME_CAP } from "./block-act.js";
import type { Reading } from "./block-cause.js";
import { API_PROMPT } from "./loop-prompts.js";
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
	name: "his-session",
	kind: "background",
	state,
	seat: SEAT,
	cwd: "/home/u/work",
});
const TRANSIENT: Reading = { cause: "API_ERROR", sub: "transient" };
const NAME = "his-session (f1, started outside the loop)";

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

it("holds a due resume back while the network is down, no try spent, then types once it is up", () => {
	let why: string | null = "api.anthropic.com did not resolve: EAI_AGAIN";
	const l = loop({ probeNetwork: () => why });
	l.tick(NOW);
	l.tick(NOW + 10 * MIN);
	expect(typed(l.calls)).toBe(0);
	expect(logs(l.calls)).toContain(
		`the API host is unreachable (api.anthropic.com did not resolve: EAI_AGAIN), so these due resumes wait for the next tick, no try spent: ${NAME}`,
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
		`resumed ${NAME} by stop and --bg --resume, the typed one unseen, as job f1`,
	);
});

it("neither stops nor copies one that took a prompt since its stop, and counts the resume arrived", () => {
	const l = loop({ isResumedSinceStop: () => true });
	l.tick(NOW);
	l.tick(NOW + 2 * MIN);
	expect(l.calls).not.toContain("stop f1");
	expect(l.calls.some((c) => c.startsWith("resume "))).toBe(false);
	expect(logs(l.calls)).toContain(
		`${NAME} took a prompt since its API-error stop, so it is neither stopped nor copied: its resume counts as arrived`,
	);
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
