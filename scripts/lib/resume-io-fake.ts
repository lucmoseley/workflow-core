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
/** The job a headless resume of SESSION runs under. */
export const HEADLESS_JOB = "0e0e0e0e";
export const ALLOWANCE_USD = 50;
/** The launch flags a job's record saves, which its resume under its own id
 * passes again. */
export const SAVED_FLAGS = [
	"--model",
	"opus",
	"--name",
	"Implement 7: a title",
];

const ran = (stdout: string, stderr = ""): ChildRun => ({
	status: 0,
	stdout,
	stderr,
	error: undefined,
	failed: null,
	out: `${stdout}${stderr}`.trim(),
});

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
	authRefusal: {
		admitted: null,
		refused: "an apiKeyHelper setting is in force (#2236)",
	},
	settingsLockout: {
		admitted: null,
		lockedOut:
			"/r/.claude/settings.json's PreToolUse line `x` would refuse or stall every tool call of a session started there, as it exited 127 — restore it with `git -C /r checkout origin/main -- .claude/settings.json`, or mend that line by hand, then start the session again",
	},
	launchHeadless: {
		launched: {
			record: {
				jobId: HEADLESS_JOB,
				sessionId: SESSION,
				pid: 4242,
				procStart: "1",
				bootId: "b",
				pgid: 4242,
				seat: "/home/u/.claude3",
				keyVar: KEY_VAR,
				cwd: "/home/u/repo",
				prompt: "/implement 7",
				log: "/r/.headless-runs/0e0e0e0e/out.jsonl",
				stderr: "/r/.headless-runs/0e0e0e0e/stderr.log",
				launchedAt: 1000,
			},
		},
		unreadable: { why: `${KEY_VAR} is not set in /home/u/secrets.env` },
	},
	findHeadlessRun: {
		none: null,
		found: { jobId: HEADLESS_JOB, sessionId: SESSION },
	},
	readRunAsJob: {
		none: null,
		working: {
			state: "working",
			sessionId: SESSION,
			cwd: "/home/u/repo/.claude/worktrees/implement-7",
		},
	},
	runClaude: {
		copy: launched("copy"),
		woke: launched("woke"),
		continued: launched("continued"),
		ownId: launched("ownId"),
		/* `claude rm`'s answer. */
		removed: ran(`removed ${JOB}\n`),
		noJob: ran("no job named"),
	},
	readJobRecord: {
		copyWorking: { state: "working", sessionId: COPY_SESSION },
		working: { state: "working", sessionId: SESSION },
		/* A job a restart killed, its launch flags saved. */
		saved: {
			state: "working",
			sessionId: SESSION,
			respawnFlags: SAVED_FLAGS,
		},
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
	writeJobName: {
		written: null,
		unwritable:
			"writing /a/state.json: ENOENT: no such file or directory, open '/a/state.json'",
	},
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
		busy: {
			ok: false,
			why: "exit 1: daemon socket is busy",
			said: "daemon socket is busy",
			timedOut: false,
			noJob: false,
		},
	},
	overflowLookup: {
		none: () => null,
		launched: (q: { jobId?: string | null; sessionId?: string | null }) =>
			q.sessionId === SESSION ? FIRST_LAUNCH : null,
	},
	recordLaunch: { written: true, unwritable: false },
	copySpendUsd: { none: 0 },
	sessionSpendUsd: { none: 0 },
	sessionName: {
		unnamed: { name: null },
		named: { name: "Implement 7: a title" },
		unreadable: {
			why: "reading /a: EISDIR: illegal operation on a directory, read",
		},
	},
	moveIssueClaim: {
		moved: ran(`Moved the claim on #7 to session ${COPY_SESSION}.`),
	},
	movePassMarkers: {
		moved: null,
		live: `${SESSION} is still live`,
	},
	moveParkedBy: { moved: undefined },
} satisfies {
	[P in keyof ResumeIo]?: Record<string, ReturnType<ResumeIo[P]>>;
};

export const FAULTS = {
	overflowLookup: { unreadable: "dispatched.jsonl would not read: EISDIR" },
	readRunAsJob: {
		unreadable: "EISDIR: illegal operation on a directory, read",
		logUnreadable:
			"its log /r/.headless-runs/0e0e0e0e/out.jsonl: EISDIR: illegal operation on a directory, read",
	},
};

type Answers = typeof ANSWERS;
type Faults = typeof FAULTS;
type AnswerPick<P extends keyof Answers> =
	| keyof Answers[P]
	| (P extends keyof Faults ? keyof Faults[P] : never);
/** Each port's answer, or its answers call by call, the last repeating. */
export type Picks = {
	[P in keyof Answers]?: AnswerPick<P> | AnswerPick<P>[];
};

export function fakeResumeIo(picks: Picks = {}, env?: NodeJS.ProcessEnv) {
	const processEnv = env ?? { PATH: "/bin" };
	const calls: { port: string; args: unknown[] }[] = [];
	const lines: string[] = [];
	const served = <P extends keyof typeof ANSWERS>(name: P) =>
		((...args: unknown[]) => {
			const nth = calls.filter((c) => c.port === name).length;
			calls.push({ port: name, args });
			const named: Record<string, unknown> = ANSWERS[name];
			const picked = picks[name] ?? Object.keys(named)[0];
			const pick = String(
				Array.isArray(picked)
					? picked[Math.min(nth, picked.length - 1)]
					: picked,
			);
			const fault = (FAULTS as Record<string, Record<string, string>>)[name]?.[
				pick
			];
			if (fault) throw new Error(fault);
			return named[pick];
		}) as ResumeIo[P];
	const io: ResumeIo = {
		log: (line) => lines.push(line),
		env: () => processEnv,
		authRefusal: served("authRefusal"),
		settingsLockout: served("settingsLockout"),
		launchHeadless: served("launchHeadless"),
		findHeadlessRun: served("findHeadlessRun"),
		readRunAsJob: served("readRunAsJob"),
		runClaude: served("runClaude"),
		readJobRecord: served("readJobRecord"),
		findResumed: served("findResumed"),
		copyTranscript: served("copyTranscript"),
		hasJobRecord: served("hasJobRecord"),
		writeJobName: served("writeJobName"),
		stop: served("stop"),
		overflowLookup: served("overflowLookup"),
		recordLaunch: served("recordLaunch"),
		copySpendUsd: served("copySpendUsd"),
		sessionSpendUsd: served("sessionSpendUsd"),
		sessionName: served("sessionName"),
		moveIssueClaim: served("moveIssueClaim"),
		movePassMarkers: served("movePassMarkers"),
		moveParkedBy: served("moveParkedBy"),
	};
	const callsTo = (name: string) =>
		calls.filter((c) => c.port === name).map((c) => c.args);
	return { io, lines, callsTo };
}
