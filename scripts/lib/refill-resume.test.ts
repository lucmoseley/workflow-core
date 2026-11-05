// @vitest-environment node
/*
 * The refill loop's resume of a stopped session (lib/refill-resume.js) against
 * a fake ResumeIo: what the resume launches and with which key, how it judges
 * the job the launcher named, what a copy is handed, and what a move to
 * another seat or onto a key stops where it fails. The fake answers in the ports' shapes but no contract test pins it to
 * the adapter: scripts/refill-loop-run.test.ts crosses the real one.
 *
 * Loosen one and a resume can bill the plan for a key's session, count a job
 * still stopped or another session's as resumed, leave a failed move's resume
 * starting, or run a move's job on a key unrecorded.
 */
import { describe, expect, it } from "vitest";
import {
	buildRekeyedResponse,
	FAKE_COPY,
	type ResumeKind,
} from "./bg-resume-fake";
import { resumeSteps } from "./refill-resume.js";

type ResumeIo = import("./refill-resume.js").ResumeIo;
type ChildRun = ReturnType<ResumeIo["runClaude"]>;

const SEAT = "/home/u/.claude3";
const TARGET = "/home/u/.claude4";
const ROOT = "/home/u/repo";
const PROMPT = "carry on";
const LAUNCH = { root: ROOT, issues: [7], seat: SEAT };
const IDS = { sessionId: "s-job7", cwd: ROOT };

/** The launcher's run, answering `kind` for job `resumed`. */
const launched = (kind: ResumeKind, resumed = "job7"): ChildRun => {
	const r = buildRekeyedResponse(kind, resumed, FAKE_COPY);
	return {
		status: 0,
		stdout: r.stdout,
		stderr: r.stderr,
		error: undefined,
		failed: null,
		out: `${r.stdout}${r.stderr}`.trim(),
	};
};

const ran = (out: string): ChildRun => ({
	status: 0,
	stdout: out,
	stderr: "",
	error: undefined,
	failed: null,
	out,
});

function fakeIo(over: Partial<ResumeIo> = {}) {
	const calls: { port: string; args: unknown[] }[] = [];
	const lines: string[] = [];
	const recorded =
		<A extends unknown[], R>(port: string, f: (...args: A) => R) =>
		(...args: A) => {
			calls.push({ port, args });
			return f(...args);
		};
	const io: ResumeIo = {
		log: (line) => lines.push(line),
		env: () => ({ PATH: "/bin" }),
		keySettings: (keyVar) => ({ settings: `{"apiKeyHelper":"${keyVar}"}` }),
		authRefusal: recorded("authRefusal", () => null),
		runClaude: recorded("runClaude", () => launched("copy")),
		readJobRecord: () => ({ state: "working", sessionId: "s-copy" }),
		findResumed: recorded("findResumed", () => null),
		copyTranscript: recorded("copyTranscript", () => null),
		hasJobRecord: () => false,
		stop: recorded("stop", () => ({ ok: true, said: "stopped" })),
		overflowLookup: () => () => null,
		recordLaunch: recorded("recordLaunch", () => true),
		copySpendUsd: () => 0,
		sessionSpendUsd: () => 0,
		sessionName: () => null,
		runArbiter: recorded("runArbiter", () => ran("Released #7")),
		movePassMarkers: recorded("movePassMarkers", () => null),
		moveParkedBy: recorded("moveParkedBy", () => undefined),
		...over,
	};
	const callsTo = (port: string) =>
		calls.filter((c) => c.port === port).map((c) => c.args);
	return { io, calls, lines, callsTo, steps: resumeSteps(io) };
}

describe("resumeStopped", () => {
	it("refuses the --bg --resume where its auth would not bill the subscription, launching nothing (#2236)", () => {
		const { steps, callsTo } = fakeIo({
			authRefusal: () => "an apiKeyHelper setting is in force (#2236)",
		});
		expect(steps.resumeStopped(LAUNCH, PROMPT, IDS)).toEqual({
			failed: "an apiKeyHelper setting is in force (#2236)",
		});
		expect(callsTo("runClaude")).toEqual([]);
	});

	it("reads a launcher line naming no job as a failed resume (#2963)", () => {
		const { steps } = fakeIo({ runClaude: () => ran("no job named") });
		expect(steps.resumeStopped(LAUNCH, PROMPT, IDS)).toEqual({
			failed: "the launcher never said what it started: no job named",
		});
	});

	it("counts a job woken in place whose state.json names its session, running", () => {
		const { steps } = fakeIo({
			runClaude: () => launched("woke"),
			readJobRecord: () => ({ state: "working", sessionId: "s-job7" }),
		});
		expect(steps.resumeStopped(LAUNCH, PROMPT, IDS)).toEqual({
			failed: null,
			jobId: "job7",
			sessionId: "s-job7",
			copy: false,
		});
	});

	it("does not count a woken job whose state.json still reads stopped", () => {
		const { steps } = fakeIo({
			runClaude: () => launched("woke"),
			readJobRecord: () => ({ state: "stopped", sessionId: "s-job7" }),
		});
		const r = steps.resumeStopped(LAUNCH, PROMPT, IDS);
		expect(r.failed).toContain("state.json reads stopped");
	});

	it("does not count a woken job whose state.json reads another session", () => {
		const { steps } = fakeIo({
			runClaude: () => launched("woke"),
			readJobRecord: () => ({ state: "working", sessionId: "s-other" }),
		});
		const r = steps.resumeStopped(LAUNCH, PROMPT, IDS);
		expect(r.failed).toContain("session s-other, not s-job7");
	});

	it("carries an overflow session's key to its copy: its settings, no key in its env, the ledger's mark and its marker (#4147, #3701)", () => {
		const { steps, callsTo } = fakeIo({
			env: () => ({
				PATH: "/bin",
				K2: "sk-must-not-pass",
				ANTHROPIC_API_KEY: "sk-must-not-pass",
				CLAUDE_CODE_SESSION_ID: "s-loop",
			}),
			overflowLookup: () => (q) =>
				"sessionId" in q && q.sessionId === "s-job7"
					? ({ allowanceUsd: 50 } as never)
					: null,
		});
		const r = steps.resumeStopped({ ...LAUNCH, keyVar: "K2" }, PROMPT, IDS);
		expect(r).toEqual({
			failed: null,
			jobId: FAKE_COPY,
			sessionId: "s-copy",
			copy: true,
		});
		const [[args, opts]] = callsTo("runClaude") as [
			[string[], { env: NodeJS.ProcessEnv; cwd: string }],
		];
		expect(args).toEqual([
			"--bg",
			"--resume",
			"s-job7",
			"--settings",
			'{"apiKeyHelper":"K2"}',
			PROMPT,
		]);
		expect(opts.env).toEqual({ PATH: "/bin", CLAUDE_CONFIG_DIR: SEAT });
		expect(callsTo("recordLaunch")).toEqual([
			[
				expect.objectContaining({
					issues: [],
					jobId: FAKE_COPY,
					overflow: {
						keyVar: "K2",
						allowanceUsd: 50,
						sessionId: "s-copy",
						copyOf: "s-job7",
					},
				}),
			],
		]);
		expect(callsTo("moveParkedBy")).toEqual([
			[
				"s-job7",
				[7],
				{
					root: ROOT,
					copySessionId: "s-copy",
					job: { seat: SEAT, keyVar: "K2", jobId: FAKE_COPY, cwd: ROOT },
				},
			],
		]);
	});

	it("hands a plan seat's copy its claims and pass markers, recording no ledger row (#2963, #4105)", () => {
		const { steps, callsTo } = fakeIo();
		steps.resumeStopped(LAUNCH, PROMPT, IDS);
		expect(callsTo("runArbiter")).toEqual([
			[ROOT, "release-issue", 7, "s-job7"],
			[ROOT, "claim-issue", 7, "s-copy"],
		]);
		expect(callsTo("movePassMarkers")).toEqual([[ROOT, "s-job7", "s-copy"]]);
		expect(callsTo("recordLaunch")).toEqual([]);
	});

	it("leaves the pass markers where the past id is still live, logging it (#4105)", () => {
		const { steps, lines } = fakeIo({
			movePassMarkers: () => "s-job7 is still live",
		});
		steps.resumeStopped(LAUNCH, PROMPT, IDS);
		expect(lines).toContain(
			"pass markers of s-job7 not moved: s-job7 is still live",
		);
	});
});

describe("moveSession (#3734, #3736)", () => {
	const job = { ...LAUNCH, jobId: "job7", prompt: "/implement 7" } as never;
	const OnKey = { seat: TARGET, keyVar: "K2", allowanceUsd: 40 };

	it("names a transcript it could not copy, resuming nothing", () => {
		const { steps, callsTo } = fakeIo({
			copyTranscript: () => "copying its transcript a to b: EISDIR",
		});
		expect(steps.moveSession(job, { seat: TARGET }, PROMPT, IDS)).toEqual({
			failed: "copying its transcript a to b: EISDIR",
		});
		expect(callsTo("runClaude")).toEqual([]);
	});

	it("stops what may be starting on the target where the resume is not confirmed", () => {
		const { steps, callsTo } = fakeIo({
			runClaude: () => launched("continued", "s-job7"),
			readJobRecord: () => null,
		});
		const r = steps.moveSession(job, { seat: TARGET }, PROMPT, IDS);
		expect(r.failed).toContain("not confirmed");
		expect(callsTo("stop")).toEqual([[TARGET, "s-job7"]]);
	});

	/** The `-n` a move onto `target` passes, its transcript naming the session `name`. */
	const movedName = (name: string | null, target: object = OnKey) => {
		const read: string[] = [];
		const { steps, callsTo } = fakeIo({
			sessionName: (file) => {
				read.push(file);
				return name;
			},
		});
		steps.moveSession(job, target as never, PROMPT, IDS);
		const [[args]] = callsTo("runClaude") as [[string[]]];
		const at = args.indexOf("-n");
		return { name: at < 0 ? null : args[at + 1], read };
	};

	it("names a plan session moved onto a key with the overflow prefix, the name its transcript gives after it (#4395)", () => {
		expect(movedName("Implement 7: a title")).toEqual({
			name: "Overflow · Implement 7: a title",
			read: ["/home/u/.claude3/projects/-home-u-repo/s-job7.jsonl"],
		});
	});

	it("names a session whose transcript gives no name after its prompt, and never prefixes twice (#4395)", () => {
		expect(movedName(null).name).toBe("Overflow · /implement 7");
		expect(movedName("Overflow · Implement 7").name).toBe(
			"Overflow · Implement 7",
		);
	});

	it("leaves a session moved onto a plan seat its own name", () => {
		expect(movedName("Implement 7", { seat: TARGET }).name).toBeNull();
	});

	it("stops the copy and hands it nothing where its ledger row will not write (#3730)", () => {
		const { steps, callsTo } = fakeIo({
			recordLaunch: () => {
				throw new Error("EACCES");
			},
		});
		const r = steps.moveSession(
			job,
			{ seat: SEAT, keyVar: "K2", allowanceUsd: 40 },
			PROMPT,
			IDS,
		);
		expect(r.failed).toContain("not recorded in the dispatch ledger");
		expect(callsTo("stop")).toContainEqual([SEAT, FAKE_COPY]);
		expect(callsTo("runArbiter")).toEqual([]);
		expect(callsTo("moveParkedBy")).toEqual([]);
	});
});
