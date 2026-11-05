/*
 * The one fake of lib/refill-resume.js's ResumeIo port, for its module cases
 * (#4386). Each port serves the answer a test picks by name from ANSWERS, or
 * throws the fault it picks from FAULTS, every port defaulting to its first
 * answer, and records what it was handed. Held to lib/resume-io.js by
 * resume-io.contract.test.ts (§G7).
 */

import {
	buildRekeyedResponse,
	FAKE_COPY,
	type ResumeKind,
} from "./bg-resume-fake";

type ResumeIo = import("./refill-resume.js").ResumeIo;
type ChildRun = ReturnType<ResumeIo["runClaude"]>;
type OverflowLaunch = NonNullable<
	ReturnType<ReturnType<ResumeIo["overflowLookup"]>>
>;

/** The stopped session every answer is about, and its short job id, which
 * `claude stop` and the job store key on. */
export const SESSION = "5e55101d-job7";
export const JOB = SESSION.slice(0, 8);
/** The session id a copy's job record names. */
export const COPY_SESSION = "s-copy";
export const KEY_VAR = "K2";
export const ALLOWANCE_USD = 50;

const ran = (stdout: string, stderr = ""): ChildRun => ({
	status: 0,
	stdout,
	stderr,
	error: undefined,
	failed: null,
	out: `${stdout}${stderr}`.trim(),
});

/** The launcher's run, answering `kind` for job JOB. */
const launched = (kind: ResumeKind): ChildRun => {
	const r = buildRekeyedResponse(kind, JOB, FAKE_COPY);
	return ran(r.stdout, r.stderr);
};

/** The key's first launch of SESSION, as the dispatch ledger reads it back. */
const FIRST_LAUNCH: OverflowLaunch = {
	ts: "2026-11-05T00:00:00.000Z",
	issues: [7],
	model: "opus",
	prompt: "/implement 7",
	session: null,
	jobId: JOB,
	kind: "overflow",
	keyVar: KEY_VAR,
	allowanceUsd: ALLOWANCE_USD,
	sessionId: SESSION,
};

export const ANSWERS = {
	keySettings: {
		settings: { settings: `{"apiKeyHelper":"${KEY_VAR}"}` },
		unreadable: { why: `${KEY_VAR} is not set in /home/u/secrets.env` },
	},
	authRefusal: {
		admitted: null,
		refused: "an apiKeyHelper setting is in force (#2236)",
	},
	runClaude: {
		copy: launched("copy"),
		woke: launched("woke"),
		continued: launched("continued"),
		/* A launcher line naming no job. */
		noJob: ran("no job named"),
	},
	readJobRecord: {
		copyWorking: { state: "working", sessionId: COPY_SESSION },
		working: { state: "working", sessionId: SESSION },
		stopped: { state: "stopped", sessionId: SESSION },
		otherSession: { state: "working", sessionId: "s-other" },
		/* No record yet: the resume is not confirmed. */
		unread: null,
	},
	findResumed: { none: null },
	copyTranscript: {
		copied: null,
		uncopied:
			"copying its transcript /a to /b: EISDIR: illegal operation on a directory",
	},
	hasJobRecord: { none: false, present: true },
	stop: {
		stopped: { ok: true, said: "stopped" },
		/* A job that never started, or has gone. */
		noJob: {
			ok: false,
			why: `exit 1: No job matching ${JOB}`,
			said: `No job matching ${JOB}`,
			timedOut: false,
			noJob: true,
		},
	},
	overflowLookup: {
		none: () => null,
		/* The key's first launch of SESSION, and nothing else. */
		launched: (q: { jobId?: string | null; sessionId?: string | null }) =>
			q.sessionId === SESSION ? FIRST_LAUNCH : null,
	},
	recordLaunch: { written: true, unwritable: false },
	copySpendUsd: { none: 0 },
	sessionSpendUsd: { none: 0 },
	runArbiter: { released: ran("Released the claim on #7.") },
	movePassMarkers: {
		moved: null,
		live: `${SESSION} is still live`,
	},
	moveParkedBy: { moved: undefined },
} satisfies {
	[P in keyof ResumeIo]?: Record<string, ReturnType<ResumeIo[P]>>;
};

/** What a port throws, by the fault a test picks. */
export const FAULTS = {
	/* A dispatch ledger that will not read. */
	overflowLookup: { unreadable: "dispatched.jsonl would not read: EISDIR" },
};

type Answers = typeof ANSWERS;
type Faults = typeof FAULTS;
export type Picks = {
	[P in keyof Answers]?:
		| keyof Answers[P]
		| (P extends keyof Faults ? keyof Faults[P] : never);
};

/**
 * A ResumeIo serving the picked answers over `env`, what each port was
 * handed, and what it logged.
 */
export function fakeResumeIo(
	picks: Picks = {},
	env: NodeJS.ProcessEnv = { PATH: "/bin" },
) {
	const calls: { port: string; args: unknown[] }[] = [];
	const lines: string[] = [];
	const served = <P extends keyof typeof ANSWERS>(name: P) =>
		((...args: unknown[]) => {
			calls.push({ port: name, args });
			const named: Record<string, unknown> = ANSWERS[name];
			const pick = String(picks[name] ?? Object.keys(named)[0]);
			const fault = (FAULTS as Record<string, Record<string, string>>)[name]?.[
				pick
			];
			if (fault) throw new Error(fault);
			return named[pick];
		}) as ResumeIo[P];
	const io: ResumeIo = {
		log: (line) => lines.push(line),
		env: () => env,
		keySettings: served("keySettings"),
		authRefusal: served("authRefusal"),
		runClaude: served("runClaude"),
		readJobRecord: served("readJobRecord"),
		findResumed: served("findResumed"),
		copyTranscript: served("copyTranscript"),
		hasJobRecord: served("hasJobRecord"),
		stop: served("stop"),
		overflowLookup: served("overflowLookup"),
		recordLaunch: served("recordLaunch"),
		copySpendUsd: served("copySpendUsd"),
		sessionSpendUsd: served("sessionSpendUsd"),
		runArbiter: served("runArbiter"),
		movePassMarkers: served("movePassMarkers"),
		moveParkedBy: served("moveParkedBy"),
	};
	const callsTo = (name: string) =>
		calls.filter((c) => c.port === name).map((c) => c.args);
	return { io, lines, callsTo };
}
