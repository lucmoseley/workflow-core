// @vitest-environment node
/*
 * The refill loop's resume of a stopped session (lib/refill-resume.js) against
 * lib/resume-io-fake.ts, which resume-io.contract.test.ts holds to the
 * production adapter: what the resume launches and with which key, how it
 * judges the job the launcher named, what a copy is handed, and what a move to
 * another seat or onto a key stops where it fails.
 *
 * Loosen one and a resume can bill the plan for a key's session, count a job
 * still stopped or another session's as resumed, leave a failed move's resume
 * starting, or run a move's job on a key unrecorded.
 */
import { describe, expect, it } from "vitest";
import { FAKE_COPY } from "./bg-resume-fake";
import { resumeSteps } from "./refill-resume.js";
import {
	ANSWERS,
	COPY_SESSION,
	FAULTS,
	fakeResumeIo,
	JOB,
	KEY_VAR,
	type Picks,
	SESSION,
} from "./resume-io-fake";

const SEAT = "/home/u/.claude3";
const TARGET = "/home/u/.claude4";
const ROOT = "/home/u/repo";
const PROMPT = "carry on";
const LAUNCH = { root: ROOT, issues: [7], seat: SEAT };
const IDS = { sessionId: SESSION, cwd: ROOT };

/** The resume steps over the fake serving `picks`, its env `env`, else
 * fakeResumeIo's bare PATH. */
function fakeIo(picks: Picks = {}, env?: NodeJS.ProcessEnv) {
	const fake = fakeResumeIo(picks, env);
	return { ...fake, steps: resumeSteps(fake.io) };
}

describe("resumeStopped", () => {
	it("refuses the --bg --resume where its auth would not bill the subscription, launching nothing (#2236)", () => {
		const { steps, callsTo } = fakeIo({ authRefusal: "refused" });
		expect(steps.resumeStopped(LAUNCH, PROMPT, IDS)).toEqual({
			failed: ANSWERS.authRefusal.refused,
		});
		expect(callsTo("runClaude")).toEqual([]);
	});

	it("reads a launcher line naming no job as a failed resume (#2963)", () => {
		const { steps } = fakeIo({ runClaude: "noJob" });
		expect(steps.resumeStopped(LAUNCH, PROMPT, IDS)).toEqual({
			failed: `the launcher never said what it started: ${ANSWERS.runClaude.noJob.out}`,
		});
	});

	it("counts a job woken in place whose state.json names its session, running", () => {
		const { steps } = fakeIo({ runClaude: "woke", readJobRecord: "working" });
		expect(steps.resumeStopped(LAUNCH, PROMPT, IDS)).toEqual({
			failed: null,
			jobId: JOB,
			sessionId: SESSION,
			copy: false,
		});
	});

	it("does not count a woken job whose state.json still reads stopped", () => {
		const { steps } = fakeIo({ runClaude: "woke", readJobRecord: "stopped" });
		const r = steps.resumeStopped(LAUNCH, PROMPT, IDS);
		expect(r.failed).toContain("state.json reads stopped");
	});

	it("does not count a woken job whose state.json reads another session", () => {
		const { steps } = fakeIo({
			runClaude: "woke",
			readJobRecord: "otherSession",
		});
		const r = steps.resumeStopped(LAUNCH, PROMPT, IDS);
		expect(r.failed).toContain(`session s-other, not ${SESSION}`);
	});

	it("carries an overflow session's key to its copy: its settings, no key in its env, the ledger's mark and its marker (#4147, #3701)", () => {
		const { steps, callsTo } = fakeIo(
			{ overflowLookup: "launched" },
			{
				PATH: "/bin",
				[KEY_VAR]: "sk-must-not-pass",
				ANTHROPIC_API_KEY: "sk-must-not-pass",
				CLAUDE_CODE_SESSION_ID: "s-loop",
			},
		);
		const r = steps.resumeStopped({ ...LAUNCH, keyVar: KEY_VAR }, PROMPT, IDS);
		expect(r).toEqual({
			failed: null,
			jobId: FAKE_COPY,
			sessionId: COPY_SESSION,
			copy: true,
		});
		const [[args, opts]] = callsTo("runClaude") as [
			[string[], { env: NodeJS.ProcessEnv; cwd: string }],
		];
		expect(args).toEqual([
			"--bg",
			"--resume",
			SESSION,
			"--settings",
			ANSWERS.keySettings.settings.settings,
			PROMPT,
		]);
		expect(opts.env).toEqual({ PATH: "/bin", CLAUDE_CONFIG_DIR: SEAT });
		expect(callsTo("recordLaunch")).toEqual([
			[
				expect.objectContaining({
					issues: [],
					jobId: FAKE_COPY,
					overflow: {
						keyVar: KEY_VAR,
						allowanceUsd: 50,
						sessionId: COPY_SESSION,
						copyOf: SESSION,
					},
				}),
			],
		]);
		expect(callsTo("moveParkedBy")).toEqual([
			[
				SESSION,
				[7],
				{
					root: ROOT,
					copySessionId: COPY_SESSION,
					job: { seat: SEAT, keyVar: KEY_VAR, jobId: FAKE_COPY, cwd: ROOT },
				},
			],
		]);
	});

	it("names a key whose settings will not build, launching nothing", () => {
		const { steps, callsTo } = fakeIo({ keySettings: "unreadable" });
		expect(
			steps.resumeStopped({ ...LAUNCH, keyVar: KEY_VAR }, PROMPT, IDS),
		).toEqual({ failed: ANSWERS.keySettings.unreadable.why });
		expect(callsTo("runClaude")).toEqual([]);
	});

	it("hands a plan seat's copy its claims and pass markers, recording no ledger row (#2963, #4105)", () => {
		const { steps, callsTo } = fakeIo();
		steps.resumeStopped(LAUNCH, PROMPT, IDS);
		expect(callsTo("runArbiter")).toEqual([
			[ROOT, "release-issue", 7, SESSION],
			[ROOT, "claim-issue", 7, COPY_SESSION],
		]);
		expect(callsTo("movePassMarkers")).toEqual([[ROOT, SESSION, COPY_SESSION]]);
		expect(callsTo("recordLaunch")).toEqual([]);
	});

	it("leaves the pass markers where the past id is still live, logging it (#4105)", () => {
		const { steps, lines } = fakeIo({ movePassMarkers: "live" });
		steps.resumeStopped(LAUNCH, PROMPT, IDS);
		expect(lines).toContain(
			`pass markers of ${SESSION} not moved: ${ANSWERS.movePassMarkers.live}`,
		);
	});
});

describe("moveSession (#3734, #3736)", () => {
	const job = { ...LAUNCH, jobId: JOB, prompt: "/implement 7" } as never;
	const keyTarget = { seat: TARGET, keyVar: KEY_VAR, allowanceUsd: 40 };

	it("names a transcript it could not copy, resuming nothing", () => {
		const { steps, callsTo } = fakeIo({ copyTranscript: "uncopied" });
		expect(steps.moveSession(job, { seat: TARGET }, PROMPT, IDS)).toEqual({
			failed: ANSWERS.copyTranscript.uncopied,
		});
		expect(callsTo("runClaude")).toEqual([]);
	});

	it("stops what may be starting on the target where the resume is not confirmed", () => {
		const { steps, callsTo } = fakeIo({
			runClaude: "continued",
			readJobRecord: "unread",
			stop: "noJob",
		});
		const r = steps.moveSession(job, { seat: TARGET }, PROMPT, IDS);
		expect(r.failed).toContain("not confirmed");
		expect(callsTo("stop")).toEqual([[TARGET, JOB]]);
	});

	it("stops the job and names the fault where the dispatch ledger will not read (#3730)", () => {
		const { steps, callsTo } = fakeIo({ overflowLookup: "unreadable" });
		const r = steps.moveSession(
			job,
			{ seat: SEAT, keyVar: KEY_VAR, allowanceUsd: 40 },
			PROMPT,
			IDS,
		);
		expect(r.failed).toContain(FAULTS.overflowLookup.unreadable);
		expect(callsTo("stop")).toContainEqual([SEAT, FAKE_COPY]);
		expect(callsTo("runArbiter")).toEqual([]);
	});

	/** The `-n` a move onto `target` passes, its transcript read as `name`. */
	const movedName = (
		name: Picks["sessionName"],
		target: object = keyTarget,
	) => {
		const { steps, callsTo, lines } = fakeIo({ sessionName: name });
		steps.moveSession(job, target as never, PROMPT, IDS);
		const [[args]] = callsTo("runClaude") as [[string[]]];
		const at = args.indexOf("-n");
		return {
			name: at < 0 ? null : args[at + 1],
			read: callsTo("sessionName"),
			lines,
		};
	};

	it("names a plan session moved onto a key with the overflow prefix, the name its transcript gives after it (#4395)", () => {
		expect(movedName("named")).toMatchObject({
			name: "Overflow · Implement 7: a title",
			read: [[`${SEAT}/projects/-home-u-repo/${SESSION}.jsonl`]],
			lines: expect.not.arrayContaining([
				expect.stringContaining("name not read"),
			]),
		});
	});

	it("names a session whose transcript gives no name after its prompt, and never prefixes twice (#4395)", () => {
		expect(movedName("unnamed").name).toBe("Overflow · /implement 7");
		expect(movedName("prefixed").name).toBe("Overflow · Implement 7");
	});

	it("names a session whose transcript will not read after its prompt, logging why (#4395)", () => {
		const r = movedName("unreadable");
		expect(r.name).toBe("Overflow · /implement 7");
		expect(r.lines).toContain(
			`${SESSION}'s name not read, so named after its prompt: ${ANSWERS.sessionName.unreadable.why}`,
		);
	});

	it("leaves a session moved onto a plan seat its own name", () => {
		expect(movedName("named", { seat: TARGET }).name).toBeNull();
	});

	it("stops the copy and hands it nothing where its ledger row will not write (#3730)", () => {
		const { steps, callsTo } = fakeIo({ recordLaunch: "unwritable" });
		const r = steps.moveSession(
			job,
			{ seat: SEAT, keyVar: KEY_VAR, allowanceUsd: 40 },
			PROMPT,
			IDS,
		);
		expect(r.failed).toContain("not recorded in the dispatch ledger");
		expect(callsTo("stop")).toContainEqual([SEAT, FAKE_COPY]);
		expect(callsTo("runArbiter")).toEqual([]);
		expect(callsTo("moveParkedBy")).toEqual([]);
	});
});
