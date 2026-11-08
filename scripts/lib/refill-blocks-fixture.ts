/*
 * The fixtures lib/refill-blocks.js's and lib/refill-limits.js's module tests
 * share (#4295). Its BlockIo double, every act succeeding and recording its
 * call, has no contract test (§G7): tsc holds it to the port's shape,
 * refill-loop-run.test.ts drives the real BlockIo end to end, and the ports it
 * is built on (agents-stop, bg-resume, resume-io) carry their own contracts.
 */
import { COPY_WHY } from "./bg-resume-fake";
import { actOnBlocks } from "./refill-blocks.js";

export const MIN = 60 * 1000;
export const NOW = Date.parse("2026-10-18T12:00:00Z");

export type Launch = import("./refill-loop.js").LoopLaunch;
export type BlockIo = import("./refill-blocks.js").BlockIo;
export type Agents = import("./refill-blocks.js").Tick["agents"];

export const NO_HOLD: import("./admission.js").SwapHold = { held: false };

export function record(over: Record<string, unknown> = {}): Launch {
	return {
		root: "/home/u/design-vault",
		issues: [42],
		prompt: "/implement 42",
		seat: "/home/u/.claude3",
		jobId: "job42",
		launchedAt: NOW - 10 * MIN,
		finishedAt: null,
		...over,
	} as Launch;
}

export const agent = (id: string, state: string) => ({
	sessionId: `s-${id}`,
	id,
	kind: "background",
	state,
});

/** A BlockIo whose every act succeeds unless `over` says otherwise, and its
 * `calls`. */
export function fakeIo(over: Partial<BlockIo> = {}) {
	const calls: string[] = [];
	/* Each launch writeLaunch wrote, its resume on record (#4180). */
	const started: Launch[] = [];
	const io: BlockIo = {
		stop: (_, id) => {
			calls.push(`stop ${id}`);
			return { ok: true, said: "" };
		},
		type: (l) => {
			calls.push(`type ${l.jobId}`);
			return null;
		},
		resumeTargetOf: () => ({ sessionId: "s", cwd: "/" }),
		adoptResumed: () => null,
		resumeStopped: (l) => {
			calls.push(`resume ${l.jobId}`);
			return {
				failed: null,
				jobId: `${l.jobId}-copy`,
				sessionId: "s",
				copy: true,
				why: COPY_WHY,
			};
		},
		moveSession: (l, target, _prompt, moved) => {
			const key = target.keyVar ? ` key=${target.keyVar}` : "";
			calls.push(
				`move ${l.jobId} ${l.seat} ${target.seat}${key} ${moved.sessionId}`,
			);
			return {
				failed: null,
				jobId: l.jobId,
				sessionId: moved.sessionId,
				copy: false,
			};
		},
		removeJobRecord: (seat) => {
			calls.push(`rm on ${seat}`);
			return null;
		},
		findParkTranscript: () => null,
		readMainChain: () => null,
		jobStateOf: () => ({ state: "working" }),
		writeLedgerHold: (l, until) => {
			calls.push(`ledger ${l.jobId} ${until}`);
			return true;
		},
		holdLockedOut: (l, { refusal }) => {
			calls.push(`hold ${l.jobId} ${refusal}`);
			return { hold: { id: "probe", issue: 77 } };
		},
		readTimeline: () => [],
		idleSince: () => null,
		hasTurnedSince: () => false,
		hasRepliedSince: () => false,
		labelParked: () => [],
		recordParked: (sid, ns) => {
			calls.push(`record ${sid} ${ns.join(",")}`);
			return null;
		},
		readJobCwd: () => null,
		readParkMarkers: () => [],
		unparkSession: () => null,
		comment: (_, body) => calls.push(`comment ${body}`),
		postHandOff: (_root, args) => {
			calls.push(`hand-off ${args[args.indexOf("--job") + 1]}`);
			return { failed: null, out: "" };
		},
		release: () => true,
		readActsBefore: () => ({}),
		progressOf: () => ({}),
		log: (line) => calls.push(`log ${line}`),
		admitResume: () => {
			calls.push("re-read");
			return null;
		},
		stagger: () => calls.push("stagger"),
		writeLaunch: (l) => {
			started.push(l);
		},
		resumeOwnId: (l, prompt, target) => io.resumeStopped(l, prompt, target),
		...over,
	};
	return { io, calls, started };
}

export const logs = (calls: string[]) =>
	calls.filter((c) => c.startsWith("log ")).map((c) => c.slice(4));

export function blocks(
	launches: Launch[],
	agents: Agents,
	mode: "away" | "normal",
	{
		now = NOW,
		io: over = {},
		barred,
	}: { now?: number; io?: Partial<BlockIo>; barred?: boolean } = {},
) {
	const { io, calls } = fakeIo(over);
	return {
		out: actOnBlocks(launches, mode, {
			agents,
			now,
			io,
			swapHold: NO_HOLD,
			...(barred ? { barred } : {}),
		}),
		calls,
	};
}
